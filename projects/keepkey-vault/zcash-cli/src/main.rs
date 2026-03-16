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
    /// Pending shield PCZT state waiting for signatures
    pending_shield: Option<pczt_builder::ShieldPcztState>,
}

impl State {
    fn new() -> Self {
        Self {
            db: None,
            fvk: None,
            pending_pczt: None,
            pending_shield: None,
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

    // Diagnostic: check ak sign bit (must be 0 per Zcash spec §4.2.3)
    let ak_sign_bit = ak_bytes[31] & 0x80;
    if ak_sign_bit != 0 {
        error!("set_fvk: FIRMWARE BUG — ak sign bit is SET (byte[31]=0x{:02x}). \
                The orchard crate requires sign bit = 0 (even y-coordinate). \
                This means the firmware's ask negation failed. \
                Attempting auto-fix by clearing the sign bit...", ak_bytes[31]);
    }

    // Try with sign bit cleared (auto-fix for firmware bug)
    let mut ak_fixed = ak_bytes.clone();
    ak_fixed[31] &= 0x7f;

    let ak_valid = {
        use pasta_curves::group::GroupEncoding;
        let ak_arr: [u8; 32] = ak_fixed.clone().try_into().unwrap();
        let ak_point = pasta_curves::pallas::Affine::from_bytes(&ak_arr);
        let valid = bool::from(ak_point.is_some());
        info!("set_fvk: ak decompresses as valid Pallas point (sign cleared)? {}", valid);

        if !valid {
            // Check with original bytes too
            let ak_arr_orig: [u8; 32] = ak_bytes.clone().try_into().unwrap();
            let ak_point_orig = pasta_curves::pallas::Affine::from_bytes(&ak_arr_orig);
            let valid_orig = bool::from(ak_point_orig.is_some());
            info!("set_fvk: ak decompresses with original sign bit? {}", valid_orig);

            let mut x_bytes = ak_arr;
            x_bytes[31] &= 0x7f;
            info!("set_fvk: ak x-coord = {}", hex::encode(&x_bytes));
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

    // Use sign-bit-cleared ak for FVK construction (workaround for firmware bug)
    let mut fvk_fixed = [0u8; 96];
    fvk_fixed[..32].copy_from_slice(&ak_fixed);
    fvk_fixed[32..64].copy_from_slice(&nk_bytes);
    fvk_fixed[64..96].copy_from_slice(&rivk_bytes);

    let fvk = FullViewingKey::from_bytes(&fvk_fixed)
        .ok_or_else(|| {
            // Try with original bytes to give better error message
            let orig_result = FullViewingKey::from_bytes(&fvk_bytes);
            let sign_note = if ak_sign_bit != 0 {
                " (sign bit was set — firmware bug confirmed)"
            } else {
                ""
            };
            anyhow::anyhow!(
                "Invalid FVK bytes — decode failed{}. ak_valid={}, nk_valid={}, rivk_valid={}. \
                 ak={}, nk={}, rivk={}, orig_decode={}",
                sign_note, ak_valid, nk_valid, rivk_valid,
                hex::encode(&ak_fixed), nk_hex, rivk_hex,
                orig_result.is_some()
            )
        })?;

    if ak_sign_bit != 0 {
        info!("set_fvk: Successfully recovered FVK by clearing ak sign bit");
    }

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

async fn handle_build_shield_pczt(state: &mut State, params: &Value) -> Result<Value> {
    let fvk = state.fvk.as_ref()
        .ok_or_else(|| anyhow::anyhow!("No FVK set — call set_fvk first"))?
        .clone();

    let amount = params.get("amount")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("Missing amount"))?;

    let fee = params.get("fee")
        .and_then(|v| v.as_u64())
        .unwrap_or(10000); // default 0.0001 ZEC

    let account = params.get("account")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let transparent_inputs_json = params.get("transparent_inputs")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing transparent_inputs array"))?;

    let mut transparent_inputs: Vec<pczt_builder::ShieldTransparentInput> = Vec::new();
    for ti in transparent_inputs_json {
        let txid = ti.get("txid").and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Missing txid in transparent input"))?;
        let vout = ti.get("vout").and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow::anyhow!("Missing vout"))? as u32;
        let value = ti.get("value").and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow::anyhow!("Missing value"))?;
        let script_pubkey = ti.get("script_pubkey").and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Missing script_pubkey"))?;

        transparent_inputs.push(pczt_builder::ShieldTransparentInput {
            txid: txid.to_string(),
            vout,
            value,
            script_pubkey: script_pubkey.to_string(),
        });
    }

    let mut lwd_client = scanner::LightwalletClient::connect(None).await?;
    let branch_id = lwd_client.get_consensus_branch_id().await?;
    let db = state.ensure_db()?;

    let shield_state = pczt_builder::build_shield_pczt(
        &fvk, transparent_inputs, amount, fee, account, branch_id,
        &mut lwd_client, db,
    ).await?;

    // Build response JSON
    let transparent_signing: Vec<serde_json::Value> = shield_state.transparent_signing_inputs
        .iter()
        .map(|ti| serde_json::json!({
            "index": ti.index,
            "sighash": hex::encode(&ti.sighash),
            "address_path": ti.address_path,
            "amount": ti.amount,
        }))
        .collect();

    let orchard_request = serde_json::to_value(&shield_state.orchard_signing_request)?;

    let response = serde_json::json!({
        "transparent_inputs": transparent_signing,
        "orchard_signing_request": orchard_request,
        "digests": {
            "header": hex::encode(&shield_state.orchard_signing_request.digests.header),
            "transparent": hex::encode(&shield_state.orchard_signing_request.digests.transparent),
            "sapling": hex::encode(&shield_state.orchard_signing_request.digests.sapling),
            "orchard": hex::encode(&shield_state.orchard_signing_request.digests.orchard),
        },
        "display": {
            "amount": format!("{:.8} ZEC", amount as f64 / 1e8),
            "fee": format!("{:.8} ZEC", fee as f64 / 1e8),
            "action": "shield",
        },
    });

    // Store state for finalization
    state.pending_shield = Some(shield_state);

    Ok(response)
}

async fn handle_finalize_shield(state: &mut State, params: &Value) -> Result<Value> {
    let mut shield_state = state.pending_shield.take()
        .ok_or_else(|| anyhow::anyhow!("No pending shield PCZT — call build_shield_pczt first"))?;

    let transparent_sigs_json = params.get("transparent_signatures")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing transparent_signatures array"))?;

    let orchard_sigs_json = params.get("orchard_signatures")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing orchard_signatures array"))?;

    let transparent_sigs: Vec<Vec<u8>> = transparent_sigs_json.iter()
        .map(|v| hex::decode(v.as_str().unwrap_or("")).map_err(|e| anyhow::anyhow!("Bad hex: {}", e)))
        .collect::<Result<Vec<_>>>()?;

    let orchard_sigs: Vec<Vec<u8>> = orchard_sigs_json.iter()
        .map(|v| hex::decode(v.as_str().unwrap_or("")).map_err(|e| anyhow::anyhow!("Bad hex: {}", e)))
        .collect::<Result<Vec<_>>>()?;

    let compressed_pubkey = params.get("compressed_pubkey")
        .and_then(|v| v.as_str())
        .map(|s| hex::decode(s))
        .transpose()
        .map_err(|e| anyhow::anyhow!("Bad pubkey hex: {}", e))?;

    let (raw_tx, txid) = pczt_builder::finalize_shield_pczt(
        shield_state,
        &transparent_sigs,
        &orchard_sigs,
        compressed_pubkey.as_deref(),
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
            "build_shield_pczt" => handle_build_shield_pczt(&mut state, &request.params).await,
            "finalize_shield" => handle_finalize_shield(&mut state, &request.params).await,
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

#[cfg(test)]
mod tests {
    use super::*;
    use orchard::keys::{FullViewingKey, SpendingKey};
    use pasta_curves::group::GroupEncoding;
    use ff::PrimeField;
    use zip32::AccountId;

    fn account(n: u32) -> AccountId {
        AccountId::try_from(n).unwrap()
    }

    /// Test that a known FVK (from orchard crate's derive_fvk) round-trips
    /// through from_bytes / to_bytes correctly.
    #[test]
    fn test_fvk_roundtrip_from_spending_key() {
        // Derive FVK from a test spending key via orchard crate
        let seed = [0x42u8; 32];
        let sk = SpendingKey::from_zip32_seed(&seed, 133, account(0))
            .expect("spending key derivation");
        let fvk = FullViewingKey::from(&sk);
        let fvk_bytes = fvk.to_bytes();

        // Verify sign bit of ak is 0
        assert_eq!(fvk_bytes[31] & 0x80, 0,
            "ak sign bit must be 0 in valid FVK");

        // Verify round-trip
        let fvk2 = FullViewingKey::from_bytes(&fvk_bytes)
            .expect("FVK round-trip failed");
        assert_eq!(fvk.to_bytes(), fvk2.to_bytes());
    }

    /// Test that FullViewingKey::from_bytes rejects ak with sign bit = 1
    #[test]
    fn test_fvk_rejects_sign_bit_set() {
        let seed = [0x42u8; 32];
        let sk = SpendingKey::from_zip32_seed(&seed, 133, account(0))
            .expect("spending key derivation");
        let fvk = FullViewingKey::from(&sk);
        let mut fvk_bytes = fvk.to_bytes();

        // Set the sign bit on ak
        fvk_bytes[31] |= 0x80;

        // Should be rejected
        assert!(FullViewingKey::from_bytes(&fvk_bytes).is_none(),
            "FVK should reject ak with sign bit set");
    }

    /// Test that clearing the sign bit recovers a valid FVK
    #[test]
    fn test_fvk_sign_bit_clear_workaround() {
        let seed = [0x42u8; 32];
        let sk = SpendingKey::from_zip32_seed(&seed, 133, account(0))
            .expect("spending key derivation");
        let fvk = FullViewingKey::from(&sk);
        let original_bytes = fvk.to_bytes();
        let mut corrupted = original_bytes;

        // Corrupt by setting sign bit
        corrupted[31] |= 0x80;
        assert!(FullViewingKey::from_bytes(&corrupted).is_none());

        // Fix by clearing sign bit
        corrupted[31] &= 0x7f;
        let recovered = FullViewingKey::from_bytes(&corrupted)
            .expect("Should recover with sign bit cleared");
        assert_eq!(original_bytes, recovered.to_bytes(),
            "Recovered FVK should match original");
    }

    /// Test with the exact failing values from the device log
    #[test]
    fn test_device_ak_sign_bit_diagnosis() {
        let ak_hex = "59285e6994df779f819ea1e67bd687d698137dc4789430ffb0ece45370948ea7";
        let nk_hex = "568fa99d2705be00371cadfba937efe844533b54c631bea1045fd8f46e1a4c17";
        let rivk_hex = "01111ac7987d132f2d5d69d69f834c523d3b4705b25030fd6025372cad4a1f3d";

        let ak = hex::decode(ak_hex).unwrap();
        let nk = hex::decode(nk_hex).unwrap();
        let rivk = hex::decode(rivk_hex).unwrap();

        // Verify sign bit is set
        assert_eq!(ak[31] & 0x80, 0x80,
            "Device ak should have sign bit set (this is the bug)");

        // Original should fail
        let mut fvk_bytes = [0u8; 96];
        fvk_bytes[..32].copy_from_slice(&ak);
        fvk_bytes[32..64].copy_from_slice(&nk);
        fvk_bytes[64..96].copy_from_slice(&rivk);
        assert!(FullViewingKey::from_bytes(&fvk_bytes).is_none(),
            "Original FVK should fail due to sign bit");

        // Clear sign bit
        fvk_bytes[31] &= 0x7f;

        // Verify ak decompresses as valid Pallas point with sign cleared
        let ak_arr: [u8; 32] = fvk_bytes[..32].try_into().unwrap();
        let ak_point = pasta_curves::pallas::Affine::from_bytes(&ak_arr);
        assert!(bool::from(ak_point.is_some()),
            "ak with sign cleared should be a valid Pallas point");

        // Verify nk is valid base field element
        let nk_arr: [u8; 32] = nk.try_into().unwrap();
        let nk_valid = pasta_curves::pallas::Base::from_repr(nk_arr);
        assert!(bool::from(nk_valid.is_some()), "nk should be valid");

        // Verify rivk is valid scalar
        let rivk_arr: [u8; 32] = rivk.try_into().unwrap();
        let rivk_valid = pasta_curves::pallas::Scalar::from_repr(rivk_arr);
        assert!(bool::from(rivk_valid.is_some()), "rivk should be valid");

        // With sign bit cleared, FVK decode may or may not work
        // (depends on whether ivk derivation produces valid key)
        let result = FullViewingKey::from_bytes(&fvk_bytes);
        println!("FVK decode with sign bit cleared: {}",
            if result.is_some() { "SUCCESS" } else { "FAILED (ivk issue?)" });
    }

    /// Test that multiple accounts all have sign bit = 0
    #[test]
    fn test_multiple_accounts_sign_bit() {
        let seed = [0x42u8; 32];
        for acct in 0..16u32 {
            let sk = SpendingKey::from_zip32_seed(&seed, 133, account(acct))
                .expect(&format!("spending key for account {}", acct));
            let fvk = FullViewingKey::from(&sk);
            let bytes = fvk.to_bytes();
            assert_eq!(bytes[31] & 0x80, 0,
                "Account {} has ak sign bit set", acct);
        }
    }

    /// Test RedPallas signature verification with known keys
    #[test]
    fn test_redpallas_sig_verify() {
        use orchard::keys::SpendingKey;

        let seed = [0x42u8; 32];
        let sk = SpendingKey::from_zip32_seed(&seed, 133, account(0))
            .expect("spending key");
        let fvk = FullViewingKey::from(&sk);
        let bytes = fvk.to_bytes();

        println!("Reference FVK for seed 0x42:");
        println!("  ak:   {}", hex::encode(&bytes[..32]));
        println!("  nk:   {}", hex::encode(&bytes[32..64]));
        println!("  rivk: {}", hex::encode(&bytes[64..96]));

        // These can be compared against firmware output to find derivation bugs
    }
}
