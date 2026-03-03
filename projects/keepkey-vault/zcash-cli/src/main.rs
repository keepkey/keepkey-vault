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
use zcash_address::unified::{self, Encoding};
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
}

// ── IPC Message Types ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct IpcRequest {
    cmd: String,
    #[serde(flatten)]
    params: Value,
}

#[derive(Serialize)]
struct IpcResponse {
    ok: bool,
    #[serde(flatten)]
    data: Value,
}

fn ok_response(data: Value) -> IpcResponse {
    IpcResponse { ok: true, data }
}

fn err_response(msg: &str) -> IpcResponse {
    IpcResponse {
        ok: false,
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

    // Store FVK for later use
    state.fvk = Some(fvk.clone());

    let fvk_bytes = fvk.to_bytes();
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

    let fvk = FullViewingKey::from_bytes(&fvk_bytes)
        .ok_or_else(|| anyhow::anyhow!("Invalid FVK bytes — decoding failed"))?;

    // Get default address and encode as Unified Address (u1...)
    let addr = fvk.address_at(0u32, orchard::keys::Scope::External);
    let ua_string = encode_unified_address(&addr)?;

    info!("FVK set from device, UA: {}...", &ua_string[..20]);
    state.fvk = Some(fvk);

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

    let db = state.ensure_db()?;

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

    // Parse recipient address
    let recipient_bytes = hex::decode(recipient_str)
        .map_err(|_| anyhow::anyhow!("Invalid recipient hex"))?;
    let recipient_arr: [u8; 43] = recipient_bytes.try_into()
        .map_err(|_| anyhow::anyhow!("Recipient must be 43 bytes"))?;
    let recipient = orchard::Address::from_raw_address_bytes(&recipient_arr)
        .into_option()
        .ok_or_else(|| anyhow::anyhow!("Invalid Orchard address"))?;

    // Get spendable notes
    let db = state.ensure_db()?;
    let notes = db.get_spendable_notes()?;
    if notes.is_empty() {
        return Err(anyhow::anyhow!("No spendable notes — scan first"));
    }

    // Build PCZT
    let pczt_state = pczt_builder::build_pczt(&fvk, notes, recipient, amount, account)?;

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

    // Send ready signal
    {
        let mut out = stdout.lock();
        let ready = serde_json::json!({"ok": true, "ready": true, "version": "0.1.0"});
        serde_json::to_writer(&mut out, &ready).ok();
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
                let resp = err_response(&format!("Invalid JSON: {}", e));
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
            Ok(data) => ok_response(data),
            Err(e) => {
                error!("Command {} failed: {}", request.cmd, e);
                err_response(&e.to_string())
            }
        };

        let mut out = stdout.lock();
        serde_json::to_writer(&mut out, &response).ok();
        writeln!(out).ok();
        out.flush().ok();
    }

    info!("zcash-cli sidecar exiting");
}
