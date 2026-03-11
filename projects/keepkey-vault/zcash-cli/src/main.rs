//! Zcash CLI sidecar for KeepKey Vault v11.
//!
//! Communicates with Electrobun via NDJSON (newline-delimited JSON) over stdin/stdout.
//! Handles chain scanning, PCZT construction, Halo2 proving, and transaction finalization.
//! NEVER opens the KeepKey device — Electrobun owns USB exclusively.

mod wallet_db;
mod zip244;
mod scanner;
mod pczt_builder;

use anyhow::Result;
use log::{info, error};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Write};

use orchard::keys::FullViewingKey;
use zcash_address::unified::{self, Container, Encoding};
use zcash_protocol::consensus::NetworkType;

/// Global state persisted across IPC commands within a single sidecar session.
struct State {
    db: Option<wallet_db::WalletDb>,
    fvk: Option<FullViewingKey>,
    /// Pending PCZT state waiting for signatures
    pending_pczt: Option<pczt_builder::PcztState>,
}

impl State {
    fn new() -> Self {
        Self {
            db: None,
            fvk: None,
            pending_pczt: None,
        }
    }

    fn ensure_db(&mut self) -> Result<&wallet_db::WalletDb> {
        if self.db.is_none() {
            self.db = Some(wallet_db::WalletDb::open_default()?);
        }
        Ok(self.db.as_ref().unwrap())
    }

    /// Try to load a previously saved FVK from the database.
    fn try_load_fvk(&mut self) -> Result<bool> {
        let db = self.ensure_db()?;
        if let Some(fvk_bytes) = db.load_fvk()? {
            match FullViewingKey::from_bytes(&fvk_bytes) {
                Some(fvk) => {
                    let addr = fvk.address_at(0u32, orchard::keys::Scope::External);
                    let ua = encode_unified_address(&addr)?;
                    info!("Auto-loaded FVK from database, UA: {}...", &ua[..20]);
                    self.fvk = Some(fvk);
                    Ok(true)
                }
                None => {
                    error!("Saved FVK is corrupt — ignoring");
                    Ok(false)
                }
            }
        } else {
            Ok(false)
        }
    }
}

// ── IPC Message Types ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct IpcRequest {
    cmd: String,
    #[serde(default)]
    _req_id: Option<u64>,
    #[serde(flatten)]
    params: Value,
}

#[derive(Serialize)]
struct IpcResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    _req_id: Option<u64>,
    #[serde(flatten)]
    data: Value,
}

fn ok_response_with_id(data: Value, req_id: Option<u64>) -> IpcResponse {
    IpcResponse { ok: true, _req_id: req_id, data }
}

fn err_response_with_id(msg: &str, req_id: Option<u64>) -> IpcResponse {
    IpcResponse {
        ok: false,
        _req_id: req_id,
        data: serde_json::json!({ "error": msg }),
    }
}

/// Encode an Orchard address as a Zcash Unified Address (Bech32m, `u1...`).
fn encode_unified_address(addr: &orchard::Address) -> Result<String> {
    let raw = addr.to_raw_address_bytes();
    let receiver = unified::Receiver::Orchard(raw);
    let ua = unified::Address::try_from_items(vec![receiver])
        .map_err(|e| anyhow::anyhow!("Failed to build Unified Address: {:?}", e))?;
    Ok(ua.encode(&NetworkType::Main))
}

/// Parse a recipient address string into an Orchard Address.
///
/// Supports:
///   - Unified Address (`u1...`) — extracts the Orchard receiver
///   - Transparent (`t1...`) — returns error (deshielding not yet supported)
///   - Raw hex (86 chars = 43 bytes) — legacy/debug path
fn parse_recipient_address(addr: &str) -> Result<orchard::Address> {
    let trimmed = addr.trim();

    // Unified Address (u1...)
    if trimmed.starts_with("u1") {
        let (network, ua) = unified::Address::decode(trimmed)
            .map_err(|e| anyhow::anyhow!("Invalid Unified Address: {:?}", e))?;
        if network != NetworkType::Main {
            return Err(anyhow::anyhow!("Expected mainnet address, got {:?}", network));
        }
        // Look for the Orchard receiver
        for receiver in ua.items() {
            if let unified::Receiver::Orchard(raw) = receiver {
                return orchard::Address::from_raw_address_bytes(&raw)
                    .into_option()
                    .ok_or_else(|| anyhow::anyhow!("Corrupt Orchard receiver in UA"));
            }
        }
        return Err(anyhow::anyhow!("Unified Address has no Orchard receiver — cannot send from shielded pool"));
    }

    // Transparent address (t1... / t3...)
    if trimmed.starts_with("t1") || trimmed.starts_with("t3") {
        return Err(anyhow::anyhow!(
            "Deshielding (Orchard → transparent) is not yet supported. \
             Please send to a Unified Address (u1...) that contains an Orchard receiver."
        ));
    }

    // Raw hex fallback (43 bytes = 86 hex chars)
    let bytes = hex::decode(trimmed)
        .map_err(|_| anyhow::anyhow!("Invalid address — expected u1... (Unified) or t1... (transparent)"))?;
    let arr: [u8; 43] = bytes.try_into()
        .map_err(|_| anyhow::anyhow!("Raw hex address must be 43 bytes (86 hex chars)"))?;
    orchard::Address::from_raw_address_bytes(&arr)
        .into_option()
        .ok_or_else(|| anyhow::anyhow!("Invalid raw Orchard address bytes"))
}

// ── Command handlers ───────────────────────────────────────────────────

async fn handle_derive_fvk(state: &mut State, params: &Value) -> Result<Value> {
    let seed_hex = params.get("seed_hex")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing seed_hex"))?;
    let account = params.get("account")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let seed_bytes = hex::decode(seed_hex)?;

    // Derive Orchard FVK from seed using ZIP-32
    use orchard::keys::SpendingKey;
    let account_id = zip32::AccountId::try_from(account)
        .map_err(|_| anyhow::anyhow!("Invalid account index: {}", account))?;
    let sk = SpendingKey::from_zip32_seed(&seed_bytes, 133, account_id)
        .map_err(|_| anyhow::anyhow!("Invalid seed for ZIP-32 derivation"))?;
    let fvk = FullViewingKey::from(&sk);

    // Get default address and encode as Unified Address (u1...)
    let addr = fvk.address_at(0u32, orchard::keys::Scope::External);
    let ua_string = encode_unified_address(&addr)?;

    // Store FVK for later use + persist to DB
    state.fvk = Some(fvk.clone());
    let fvk_bytes = fvk.to_bytes();
    let _ = state.ensure_db().and_then(|db| db.save_fvk(&fvk_bytes));

    let ak = hex::encode(&fvk_bytes[..32]);
    let nk = hex::encode(&fvk_bytes[32..64]);
    let rivk = hex::encode(&fvk_bytes[64..96]);

    Ok(serde_json::json!({
        "fvk": { "ak": ak, "nk": nk, "rivk": rivk },
        "address": ua_string,
    }))
}

/// Accept a FullViewingKey directly from the device (no seed needed).
/// The device exports {ak, nk, rivk} as hex strings (32 bytes each, 96 total).
async fn handle_set_fvk(state: &mut State, params: &Value) -> Result<Value> {
    let ak_hex = params.get("ak")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing ak"))?;
    let nk_hex = params.get("nk")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing nk"))?;
    let rivk_hex = params.get("rivk")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing rivk"))?;

    let ak_bytes = hex::decode(ak_hex)?;
    let nk_bytes = hex::decode(nk_hex)?;
    let rivk_bytes = hex::decode(rivk_hex)?;

    if ak_bytes.len() != 32 || nk_bytes.len() != 32 || rivk_bytes.len() != 32 {
        return Err(anyhow::anyhow!("Each FVK component must be 32 bytes"));
    }

    // Reconstruct the 96-byte FVK encoding: ak || nk || rivk
    let mut fvk_bytes = [0u8; 96];
    fvk_bytes[..32].copy_from_slice(&ak_bytes);
    fvk_bytes[32..64].copy_from_slice(&nk_bytes);
    fvk_bytes[64..96].copy_from_slice(&rivk_bytes);

    info!("set_fvk: ak  = {}", ak_hex);
    info!("set_fvk: nk  = {}", nk_hex);
    info!("set_fvk: rivk= {}", rivk_hex);

    // Diagnostic: try decompressing ak as a Pallas point
    let ak_valid = {
        use pasta_curves::group::GroupEncoding;
        let ak_arr: [u8; 32] = ak_bytes.clone().try_into().unwrap();
        let ak_point = pasta_curves::pallas::Affine::from_bytes(&ak_arr);
        let valid = bool::from(ak_point.is_some());
        info!("set_fvk: ak decompresses as valid Pallas point? {}", valid);

        if !valid {
            // Check: is the x-coord on the curve? (x^3 + 5 must be a QR)
            let mut x_bytes = ak_arr;
            x_bytes[31] &= 0x7f; // clear sign bit
            info!("set_fvk: ak x-coord (sign cleared) = {}", hex::encode(&x_bytes));

            // Also verify SpendAuth basepoint bytes are valid
            let spendauth_bytes: [u8; 32] = [
                0x63, 0xc9, 0x75, 0xb8, 0x84, 0x72, 0x1a, 0x8d,
                0x0c, 0xa1, 0x70, 0x7b, 0xe3, 0x0c, 0x7f, 0x0c,
                0x5f, 0x44, 0x5f, 0x3e, 0x7c, 0x18, 0x8d, 0x3b,
                0x06, 0xd6, 0xf1, 0x28, 0xb3, 0x23, 0x55, 0xb7,
            ];
            let sa_point = pasta_curves::pallas::Affine::from_bytes(&spendauth_bytes);
            let sa_valid = bool::from(sa_point.is_some());
            info!("set_fvk: SpendAuth basepoint decompresses? {}", sa_valid);
        }
        valid
    };

    // Diagnostic: validate each FVK component individually
    let nk_valid = {
        use ff::PrimeField;
        let nk_arr: [u8; 32] = nk_bytes.clone().try_into().unwrap();
        let nk_field = pasta_curves::pallas::Base::from_repr(nk_arr);
        let valid = bool::from(nk_field.is_some());
        info!("set_fvk: nk valid as Pallas base field element? {}", valid);
        valid
    };
    let rivk_valid = {
        use ff::PrimeField;
        let rivk_arr: [u8; 32] = rivk_bytes.clone().try_into().unwrap();
        let rivk_scalar = pasta_curves::pallas::Scalar::from_repr(rivk_arr);
        let valid = bool::from(rivk_scalar.is_some());
        info!("set_fvk: rivk valid as Pallas scalar? {}", valid);
        valid
    };

    let fvk = FullViewingKey::from_bytes(&fvk_bytes)
        .ok_or_else(|| anyhow::anyhow!(
            "Invalid FVK bytes — decode failed. ak_valid={}, nk_valid={}, rivk_valid={}. \
             ak={}, nk={}, rivk={}",
            ak_valid, nk_valid, rivk_valid, ak_hex, nk_hex, rivk_hex
        ))?;

    // Get default address and encode as Unified Address (u1...)
    let addr = fvk.address_at(0u32, orchard::keys::Scope::External);
    let ua_string = encode_unified_address(&addr)?;

    info!("FVK set from device, UA: {}...", &ua_string[..20]);
    state.fvk = Some(fvk);

    // Check if FVK changed (e.g. firmware basepoint fix) and auto-reset if so
    if let Ok(db) = state.ensure_db() {
        if let Ok(false) = db.fvk_matches(&fvk_bytes) {
            info!("FVK ak fingerprint changed (firmware update?) — resetting wallet DB");
            let _ = db.reset();
        }
        let _ = db.save_fvk(&fvk_bytes);
    }

    Ok(serde_json::json!({
        "fvk": { "ak": ak_hex, "nk": nk_hex, "rivk": rivk_hex },
        "address": ua_string,
    }))
}

async fn handle_scan(state: &mut State, params: &Value) -> Result<Value> {
    let fvk = state.fvk.as_ref()
        .ok_or_else(|| anyhow::anyhow!("No FVK set — call derive_fvk first"))?
        .clone();

    let start_height = params.get("start_height")
        .and_then(|v| v.as_u64());
    let full_rescan = params.get("full_rescan")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let db = state.ensure_db()?;

    // Full rescan: clear DB scan progress so scanner starts from Orchard activation
    if full_rescan {
        info!("Full rescan requested — clearing scan progress");
        db.clear_scan_progress()?;
    }

    let mut client = scanner::LightwalletClient::connect(None).await?;
    let result = client.scan_with_persistence(&fvk, db, start_height).await?;

    Ok(serde_json::json!({
        "balance": result.total_received,
        "notes_found": result.notes_found,
        "blocks_scanned": result.blocks_scanned,
        "synced_to": result.tip_height,
    }))
}

async fn handle_balance(state: &mut State, _params: &Value) -> Result<Value> {
    let db = state.ensure_db()?;
    let balance = db.get_balance()?;
    let (total, unspent) = db.get_note_count()?;

    Ok(serde_json::json!({
        "confirmed": balance,
        "pending": 0,
        "notes_total": total,
        "notes_unspent": unspent,
    }))
}

async fn handle_build_pczt(state: &mut State, params: &Value) -> Result<Value> {
    let fvk = state.fvk.as_ref()
        .ok_or_else(|| anyhow::anyhow!("No FVK set — call derive_fvk first"))?
        .clone();

    let recipient_str = params.get("recipient")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing recipient"))?;
    let amount = params.get("amount")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("Missing amount"))?;
    let account = params.get("account")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    // Parse optional memo (UTF-8 text, max 512 bytes)
    let memo = params.get("memo")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Parse recipient address — supports UA (u1...), transparent (t1...), or raw hex
    let recipient = parse_recipient_address(recipient_str)?;

    // Get spendable notes
    let db = state.ensure_db()?;
    let notes = db.get_spendable_notes()?;
    if notes.is_empty() {
        return Err(anyhow::anyhow!("No spendable notes — scan first"));
    }

    // Query current consensus branch ID from lightwalletd
    let mut lwd_client = scanner::LightwalletClient::connect(None).await?;
    let branch_id = lwd_client.get_consensus_branch_id().await?;
    info!("Using consensus branch ID: 0x{:08x}", branch_id);

    // Build PCZT with real chain tree data
    let pczt_state = pczt_builder::build_pczt(
        &fvk, notes, recipient, amount, account, branch_id,
        &mut lwd_client, db, memo,
    ).await?;

    let signing_request = serde_json::to_value(&pczt_state.signing_request)?;

    // Store the PCZT state for finalization
    state.pending_pczt = Some(pczt_state);

    Ok(serde_json::json!({
        "signing_request": signing_request,
    }))
}

async fn handle_finalize(state: &mut State, params: &Value) -> Result<Value> {
    let pczt_state = state.pending_pczt.take()
        .ok_or_else(|| anyhow::anyhow!("No pending PCZT — call build_pczt first"))?;

    let sigs_json = params.get("signatures")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing signatures array"))?;

    let mut signatures: Vec<Vec<u8>> = Vec::new();
    for sig_val in sigs_json {
        let sig_hex = sig_val.as_str()
            .ok_or_else(|| anyhow::anyhow!("Signature must be hex string"))?;
        let sig_bytes = hex::decode(sig_hex)?;
        signatures.push(sig_bytes);
    }

    let (raw_tx, txid) = pczt_builder::finalize_pczt(
        pczt_state.pczt_bundle,
        pczt_state.sighash,
        pczt_state.branch_id,
        &signatures,
    )?;

    Ok(serde_json::json!({
        "raw_tx": hex::encode(&raw_tx),
        "txid": txid,
    }))
}

async fn handle_broadcast(_state: &mut State, params: &Value) -> Result<Value> {
    let raw_tx_hex = params.get("raw_tx")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing raw_tx"))?;

    let raw_tx = hex::decode(raw_tx_hex)?;

    let mut client = scanner::LightwalletClient::connect(None).await?;
    let txid = client.send_transaction(&raw_tx).await?;

    Ok(serde_json::json!({
        "txid": txid,
    }))
}

// ── Main IPC loop ──────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info")
    )
    // Log to stderr so stdout stays clean for NDJSON IPC
    .target(env_logger::Target::Stderr)
    .init();

    info!("zcash-cli sidecar starting");

    let mut state = State::new();
    let stdin = io::stdin();
    let stdout = io::stdout();

    // Try to auto-load FVK from database
    let has_fvk = match state.try_load_fvk() {
        Ok(loaded) => loaded,
        Err(e) => { error!("Failed to auto-load FVK: {}", e); false }
    };

    // Build ready signal with FVK status
    let ready_data = if has_fvk {
        let fvk = state.fvk.as_ref().unwrap();
        let addr = fvk.address_at(0u32, orchard::keys::Scope::External);
        let ua = encode_unified_address(&addr).unwrap_or_default();
        let fvk_bytes = fvk.to_bytes();
        serde_json::json!({
            "ok": true, "ready": true, "version": "0.1.0",
            "fvk_loaded": true,
            "address": ua,
            "fvk": {
                "ak": hex::encode(&fvk_bytes[..32]),
                "nk": hex::encode(&fvk_bytes[32..64]),
                "rivk": hex::encode(&fvk_bytes[64..96]),
            }
        })
    } else {
        serde_json::json!({"ok": true, "ready": true, "version": "0.1.0", "fvk_loaded": false})
    };

    // Send ready signal
    {
        let mut out = stdout.lock();
        serde_json::to_writer(&mut out, &ready_data).ok();
        writeln!(out).ok();
        out.flush().ok();
    }

    for line_result in stdin.lock().lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                error!("stdin read error: {}", e);
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let request: IpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = err_response_with_id(&format!("Invalid JSON: {}", e), None);
                let mut out = stdout.lock();
                serde_json::to_writer(&mut out, &resp).ok();
                writeln!(out).ok();
                out.flush().ok();
                continue;
            }
        };

        info!("Received command: {}", request.cmd);

        let result = match request.cmd.as_str() {
            "derive_fvk" => handle_derive_fvk(&mut state, &request.params).await,
            "set_fvk" => handle_set_fvk(&mut state, &request.params).await,
            "scan" => handle_scan(&mut state, &request.params).await,
            "balance" => handle_balance(&mut state, &request.params).await,
            "build_pczt" => handle_build_pczt(&mut state, &request.params).await,
            "finalize" => handle_finalize(&mut state, &request.params).await,
            "broadcast" => handle_broadcast(&mut state, &request.params).await,
            "ping" => Ok(serde_json::json!({"pong": true})),
            "quit" => {
                info!("Received quit command");
                break;
            }
            other => Err(anyhow::anyhow!("Unknown command: {}", other)),
        };

        let response = match result {
            Ok(data) => ok_response_with_id(data, request._req_id),
            Err(e) => {
                error!("Command {} failed: {}", request.cmd, e);
                err_response_with_id(&e.to_string(), request._req_id)
            }
        };

        let mut out = stdout.lock();
        serde_json::to_writer(&mut out, &response).ok();
        writeln!(out).ok();
        out.flush().ok();
    }

    info!("zcash-cli sidecar exiting");
}
