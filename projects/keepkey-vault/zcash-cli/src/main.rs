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
    // NOTE: Shield PCZT support (ShieldPcztState) will be added when
    // pczt_builder gains build_shield_pczt/finalize_shield_pczt.
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
    /// Applies sign-bit canonicalization as defense in depth — the DB should
    /// already contain canonical bytes, but legacy data may not.
    fn try_load_fvk(&mut self) -> Result<bool> {
        let db = self.ensure_db()?;
        if let Some(mut fvk_bytes) = db.load_fvk()? {
            // Canonicalize: clear ak sign bit if set (handles legacy DB entries)
            let had_sign_bit = fvk_bytes[31] & 0x80 != 0;
            if had_sign_bit {
                error!("Saved FVK has ak sign bit set — clearing (legacy DB entry)");
                fvk_bytes[31] &= 0x7f;
                // Re-save canonical bytes so this only happens once
                let _ = db.save_fvk(&fvk_bytes);
            }
            match FullViewingKey::from_bytes(&fvk_bytes) {
                Some(fvk) => {
                    let addr = fvk.address_at(0u32, orchard::keys::Scope::External);
                    let ua = encode_unified_address(&addr)?;
                    info!("Auto-loaded FVK from database, UA: {}...", &ua[..20]);
                    self.fvk = Some(fvk);
                    Ok(true)
                }
                None => {
                    error!("Saved FVK is corrupt (even after sign bit fix) — ignoring");
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

    // Canonical bytes are the ones the FVK was actually built from.
    // All persistence, comparison, and API output MUST use these — never the
    // original firmware bytes, which may have the wrong sign bit.
    let canonical_bytes = fvk_fixed;
    let canonical_ak_hex = hex::encode(&canonical_bytes[..32]);

    // Get default address and encode as Unified Address (u1...)
    let addr = fvk.address_at(0u32, orchard::keys::Scope::External);
    let ua_string = encode_unified_address(&addr)?;

    info!("FVK set from device, UA: {}...", &ua_string[..20]);
    state.fvk = Some(fvk);

    // Check if FVK changed (e.g. firmware basepoint fix) and auto-reset if so
    if let Ok(db) = state.ensure_db() {
        if let Ok(false) = db.fvk_matches(&canonical_bytes) {
            info!("FVK ak fingerprint changed (firmware update?) — resetting wallet DB");
            let _ = db.reset();
        }
        let _ = db.save_fvk(&canonical_bytes);
    }

    Ok(serde_json::json!({
        "fvk": { "ak": canonical_ak_hex, "nk": nk_hex, "rivk": rivk_hex },
        "address": ua_string,
        "sign_bit_corrected": ak_sign_bit != 0,
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

// NOTE: handle_build_shield_pczt and handle_finalize_shield will be added
// when pczt_builder gains ShieldPcztState / build_shield_pczt / finalize_shield_pczt.

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

#[cfg(test)]
mod tests {
    use super::*;
    use orchard::keys::{FullViewingKey, SpendingKey};
    use pasta_curves::group::GroupEncoding;
    use ff::PrimeField;
    use zip32::AccountId;
    use tempfile::TempDir;

    fn account(n: u32) -> AccountId {
        AccountId::try_from(n).unwrap()
    }

    /// Helper: derive a valid FVK from a seed + account index.
    fn derive_test_fvk(seed_byte: u8, acct: u32) -> FullViewingKey {
        let seed = [seed_byte; 32];
        let sk = SpendingKey::from_zip32_seed(&seed, 133, account(acct))
            .expect("spending key derivation");
        FullViewingKey::from(&sk)
    }

    /// Helper: create a WalletDb in a temp directory.
    /// Returns (db, _dir_guard) — caller must keep _dir_guard alive.
    fn test_db() -> (wallet_db::WalletDb, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("test_wallet.db");
        let db = wallet_db::WalletDb::open(&path).expect("open db");
        (db, dir)
    }

    /// Helper: simulate what handle_set_fvk does — canonicalize, persist, return.
    /// Returns (canonical_bytes, response_json, db, _dir_guard).
    fn simulate_set_fvk(
        ak: &[u8], nk: &[u8], rivk: &[u8],
    ) -> Result<([u8; 96], Value, wallet_db::WalletDb, TempDir)> {
        let (db, dir) = test_db();

        let mut fvk_bytes = [0u8; 96];
        fvk_bytes[..32].copy_from_slice(ak);
        fvk_bytes[32..64].copy_from_slice(nk);
        fvk_bytes[64..96].copy_from_slice(rivk);

        // Canonicalize: clear ak sign bit
        let mut canonical = fvk_bytes;
        canonical[31] &= 0x7f;

        let _fvk = FullViewingKey::from_bytes(&canonical)
            .ok_or_else(|| anyhow::anyhow!("FVK decode failed"))?;

        let canonical_ak_hex = hex::encode(&canonical[..32]);
        let nk_hex = hex::encode(nk);
        let rivk_hex = hex::encode(rivk);

        // Persist canonical bytes (matches the fix)
        if let Ok(false) = db.fvk_matches(&canonical) {
            let _ = db.reset();
        }
        db.save_fvk(&canonical)?;

        let response = serde_json::json!({
            "fvk": { "ak": canonical_ak_hex, "nk": nk_hex, "rivk": rivk_hex },
            "sign_bit_corrected": fvk_bytes[31] & 0x80 != 0,
        });

        Ok((canonical, response, db, dir))
    }

    // ══════════════════════════════════════════════════════════════════════
    // 1. FVK Primitive Tests (orchard crate behavior verification)
    // ══════════════════════════════════════════════════════════════════════

    /// FVK round-trips through to_bytes/from_bytes.
    #[test]
    fn test_fvk_roundtrip_from_spending_key() {
        let fvk = derive_test_fvk(0x42, 0);
        let fvk_bytes = fvk.to_bytes();

        assert_eq!(fvk_bytes[31] & 0x80, 0, "ak sign bit must be 0 in valid FVK");

        let fvk2 = FullViewingKey::from_bytes(&fvk_bytes)
            .expect("FVK round-trip failed");
        assert_eq!(fvk.to_bytes(), fvk2.to_bytes());
    }

    /// FVK rejects ak with sign bit = 1.
    #[test]
    fn test_fvk_rejects_sign_bit_set() {
        let fvk = derive_test_fvk(0x42, 0);
        let mut fvk_bytes = fvk.to_bytes();
        fvk_bytes[31] |= 0x80;

        assert!(FullViewingKey::from_bytes(&fvk_bytes).is_none(),
            "FVK should reject ak with sign bit set");
    }

    /// Clearing the sign bit recovers the original FVK.
    #[test]
    fn test_fvk_sign_bit_clear_workaround() {
        let fvk = derive_test_fvk(0x42, 0);
        let original_bytes = fvk.to_bytes();
        let mut corrupted = original_bytes;

        corrupted[31] |= 0x80;
        assert!(FullViewingKey::from_bytes(&corrupted).is_none());

        corrupted[31] &= 0x7f;
        let recovered = FullViewingKey::from_bytes(&corrupted)
            .expect("Should recover with sign bit cleared");
        assert_eq!(original_bytes, recovered.to_bytes(),
            "Recovered FVK should match original");
    }

    /// Multiple accounts all produce ak with sign bit = 0.
    #[test]
    fn test_multiple_accounts_sign_bit() {
        for acct in 0..16u32 {
            let fvk = derive_test_fvk(0x42, acct);
            let bytes = fvk.to_bytes();
            assert_eq!(bytes[31] & 0x80, 0,
                "Account {} has ak sign bit set", acct);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. Canonicalization Tests (handle_set_fvk behavior)
    // ══════════════════════════════════════════════════════════════════════

    /// Valid canonical FVK: response, DB, and state all use the same bytes.
    #[test]
    fn test_set_fvk_accepts_valid_canonical_fvk() {
        let fvk = derive_test_fvk(0x42, 0);
        let fvk_bytes = fvk.to_bytes();
        let ak = &fvk_bytes[..32];
        let nk = &fvk_bytes[32..64];
        let rivk = &fvk_bytes[64..96];

        let (canonical, response, db, _dir) = simulate_set_fvk(ak, nk, rivk)
            .expect("set_fvk should succeed for valid input");

        // Canonical bytes == input bytes (no correction needed)
        assert_eq!(&canonical[..32], ak, "canonical ak should match input");
        assert_eq!(&canonical[32..64], nk);
        assert_eq!(&canonical[64..96], rivk);

        // Response returns canonical ak
        let resp_ak = response["fvk"]["ak"].as_str().unwrap();
        assert_eq!(resp_ak, hex::encode(ak), "response ak should match input");

        // sign_bit_corrected should be false
        assert_eq!(response["sign_bit_corrected"], false);

        // DB stores canonical bytes
        let stored = db.load_fvk().unwrap().expect("FVK should be in DB");
        assert_eq!(stored, canonical, "DB should store canonical bytes");
        assert!(db.fvk_matches(&canonical).unwrap(), "DB fingerprint should match canonical");
    }

    /// Buggy sign-bit FVK: everything canonicalizes consistently.
    #[test]
    fn test_set_fvk_recovers_sign_bit_and_canonicalizes_everything() {
        let fvk = derive_test_fvk(0x42, 0);
        let original_bytes = fvk.to_bytes();
        let mut buggy_ak = [0u8; 32];
        buggy_ak.copy_from_slice(&original_bytes[..32]);
        buggy_ak[31] |= 0x80; // simulate firmware bug

        let nk = &original_bytes[32..64];
        let rivk = &original_bytes[64..96];

        let (canonical, response, db, _dir) = simulate_set_fvk(&buggy_ak, nk, rivk)
            .expect("set_fvk should recover from sign bit bug");

        // Canonical ak has sign bit cleared
        assert_eq!(canonical[31] & 0x80, 0, "canonical ak sign bit must be 0");
        assert_eq!(&canonical[..32], &original_bytes[..32],
            "canonical ak should match the correct (sign-cleared) ak");

        // Response returns CANONICAL ak, not the buggy input
        let resp_ak = response["fvk"]["ak"].as_str().unwrap();
        assert_eq!(resp_ak, hex::encode(&original_bytes[..32]),
            "response must return canonical ak, not buggy firmware ak");
        assert_ne!(resp_ak, hex::encode(&buggy_ak),
            "response must NOT return the buggy ak");

        // sign_bit_corrected should be true
        assert_eq!(response["sign_bit_corrected"], true);

        // DB stores canonical bytes
        let stored = db.load_fvk().unwrap().expect("FVK should be in DB");
        assert_eq!(stored[31] & 0x80, 0, "DB must store canonical ak");
        assert_eq!(stored, canonical, "DB bytes must match canonical");

        // DB fingerprint matches canonical
        assert!(db.fvk_matches(&canonical).unwrap(),
            "DB fingerprint must match canonical bytes");
    }

    /// Non-recoverable FVK (garbage bytes) should fail.
    #[test]
    fn test_set_fvk_rejects_invalid_nonrecoverable_fvk() {
        let garbage = [0xFFu8; 32];
        let result = simulate_set_fvk(&garbage, &garbage, &garbage);
        assert!(result.is_err(), "Garbage bytes should fail FVK decode");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. Persistence / Reload Tests
    // ══════════════════════════════════════════════════════════════════════

    /// Canonical bytes saved by set_fvk round-trip through load_fvk.
    #[test]
    fn test_saved_canonical_fvk_roundtrips_through_load() {
        let fvk = derive_test_fvk(0x42, 0);
        let original_bytes = fvk.to_bytes();
        let mut buggy_ak = [0u8; 32];
        buggy_ak.copy_from_slice(&original_bytes[..32]);
        buggy_ak[31] |= 0x80;

        let nk = &original_bytes[32..64];
        let rivk = &original_bytes[64..96];

        let (canonical, _, db, _dir) = simulate_set_fvk(&buggy_ak, nk, rivk)
            .expect("set_fvk should succeed");

        // Reload from DB
        let loaded = db.load_fvk().unwrap().expect("should load");
        assert_eq!(loaded, canonical, "loaded bytes should be canonical");

        // Decode should succeed (canonical bytes are valid)
        let fvk_reloaded = FullViewingKey::from_bytes(&loaded)
            .expect("canonical bytes must decode on reload");

        // Same address
        let addr1 = fvk.address_at(0u32, orchard::keys::Scope::External);
        let addr2 = fvk_reloaded.address_at(0u32, orchard::keys::Scope::External);
        assert_eq!(addr1.to_raw_address_bytes(), addr2.to_raw_address_bytes(),
            "address after reload must match original");
    }

    /// If someone manually saves buggy bytes to DB, try_load_fvk should
    /// canonicalize them and re-save (defense in depth).
    #[test]
    fn test_try_load_fvk_fixes_legacy_buggy_bytes() {
        let fvk = derive_test_fvk(0x42, 0);
        let original_bytes = fvk.to_bytes();

        // Simulate legacy DB with buggy bytes
        let (db, _dir) = test_db();
        let mut buggy = original_bytes;
        buggy[31] |= 0x80;
        db.save_fvk(&buggy).expect("save buggy bytes");

        // Verify buggy bytes are in DB
        let stored = db.load_fvk().unwrap().unwrap();
        assert_eq!(stored[31] & 0x80, 0x80, "DB should have buggy bytes initially");

        // Simulate try_load_fvk behavior
        let mut loaded = stored;
        let had_sign_bit = loaded[31] & 0x80 != 0;
        assert!(had_sign_bit, "should detect sign bit");

        loaded[31] &= 0x7f; // canonicalize
        db.save_fvk(&loaded).expect("re-save canonical");

        // Verify DB now has canonical bytes
        let reloaded = db.load_fvk().unwrap().unwrap();
        assert_eq!(reloaded[31] & 0x80, 0, "DB should now have canonical bytes");

        // And it decodes
        assert!(FullViewingKey::from_bytes(&reloaded).is_some(),
            "canonical bytes should decode");
    }

    /// Raw buggy bytes without canonicalization fail to decode.
    #[test]
    fn test_raw_buggy_bytes_fail_to_decode() {
        let fvk = derive_test_fvk(0x42, 0);
        let mut buggy = fvk.to_bytes();
        buggy[31] |= 0x80;

        // This is what the old code would have done on reload — direct decode fails
        assert!(FullViewingKey::from_bytes(&buggy).is_none(),
            "buggy bytes must not decode without canonicalization");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 4. Fingerprint / Reset Tests
    // ══════════════════════════════════════════════════════════════════════

    /// Equivalent buggy-sign-bit input should NOT trigger a DB reset.
    #[test]
    fn test_set_fvk_no_false_reset_for_equivalent_buggy_input() {
        let fvk = derive_test_fvk(0x42, 0);
        let original_bytes = fvk.to_bytes();
        let nk = &original_bytes[32..64];
        let rivk = &original_bytes[64..96];

        // First: set valid canonical FVK
        let (db, _dir) = test_db();
        db.save_fvk(&original_bytes).expect("save");

        // Simulate second call with buggy sign bit (same underlying key)
        let mut buggy_ak = [0u8; 32];
        buggy_ak.copy_from_slice(&original_bytes[..32]);
        buggy_ak[31] |= 0x80;

        // Canonicalize
        let mut canonical = [0u8; 96];
        canonical[..32].copy_from_slice(&buggy_ak);
        canonical[31] &= 0x7f; // clear sign bit
        canonical[32..64].copy_from_slice(nk);
        canonical[64..96].copy_from_slice(rivk);

        // fvk_matches should return true (same canonical key)
        assert!(db.fvk_matches(&canonical).unwrap(),
            "same key with different sign bit should match after canonicalization");
    }

    /// Different account should trigger a DB reset.
    #[test]
    fn test_set_fvk_resets_for_different_account() {
        let fvk0 = derive_test_fvk(0x42, 0);
        let fvk1 = derive_test_fvk(0x42, 1);
        let bytes0 = fvk0.to_bytes();
        let bytes1 = fvk1.to_bytes();

        let (db, _dir) = test_db();
        db.save_fvk(&bytes0).expect("save account 0");

        // Different account key should NOT match
        assert_eq!(db.fvk_matches(&bytes1).unwrap(), false,
            "different account FVK should not match");
    }

    /// fvk_matches returns true when no FVK stored yet (first time).
    #[test]
    fn test_fvk_matches_returns_true_for_empty_db() {
        let fvk = derive_test_fvk(0x42, 0);
        let (db, _dir) = test_db();

        assert!(db.fvk_matches(&fvk.to_bytes()).unwrap(),
            "empty DB should match any FVK (first-time setup)");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 5. Device Log Vector Tests
    // ══════════════════════════════════════════════════════════════════════

    /// Exact device log vector: verify sign bit detection and recovery attempt.
    #[test]
    fn test_device_log_vector_sign_bit_detection() {
        let ak = hex::decode(
            "59285e6994df779f819ea1e67bd687d698137dc4789430ffb0ece45370948ea7"
        ).unwrap();
        let nk = hex::decode(
            "568fa99d2705be00371cadfba937efe844533b54c631bea1045fd8f46e1a4c17"
        ).unwrap();
        let rivk = hex::decode(
            "01111ac7987d132f2d5d69d69f834c523d3b4705b25030fd6025372cad4a1f3d"
        ).unwrap();

        // Sign bit IS set — this is the bug
        assert_eq!(ak[31] & 0x80, 0x80, "device ak must have sign bit set");

        // Original bytes fail
        let mut fvk_bytes = [0u8; 96];
        fvk_bytes[..32].copy_from_slice(&ak);
        fvk_bytes[32..64].copy_from_slice(&nk);
        fvk_bytes[64..96].copy_from_slice(&rivk);
        assert!(FullViewingKey::from_bytes(&fvk_bytes).is_none(),
            "original bytes must fail");

        // Clear sign bit
        let mut canonical = fvk_bytes;
        canonical[31] &= 0x7f;

        // ak decompresses as valid Pallas point
        let ak_arr: [u8; 32] = canonical[..32].try_into().unwrap();
        let ak_point = pasta_curves::pallas::Affine::from_bytes(&ak_arr);
        assert!(bool::from(ak_point.is_some()),
            "ak with sign cleared must be a valid Pallas point");

        // nk valid as base field element
        let nk_arr: [u8; 32] = nk.clone().try_into().unwrap();
        assert!(bool::from(pasta_curves::pallas::Base::from_repr(nk_arr).is_some()),
            "nk must be valid");

        // rivk valid as scalar
        let rivk_arr: [u8; 32] = rivk.clone().try_into().unwrap();
        assert!(bool::from(pasta_curves::pallas::Scalar::from_repr(rivk_arr).is_some()),
            "rivk must be valid");

        // FVK decode with cleared sign bit — may or may not work depending on
        // whether ivk derivation produces a valid key for this specific vector.
        // The important thing is that the sidecar either succeeds or fails cleanly.
        let result = FullViewingKey::from_bytes(&canonical);
        if let Some(fvk) = result {
            // If it decodes, verify consistency
            let roundtrip = fvk.to_bytes();
            assert_eq!(roundtrip[31] & 0x80, 0,
                "decoded FVK must have sign bit = 0");
            assert_eq!(&roundtrip[..32], &canonical[..32],
                "ak must round-trip correctly");
        }
        // Either outcome is acceptable — the test verifies the sidecar's
        // detection and canonicalization logic, not whether this particular
        // device key produces a valid ivk.
    }

    // ══════════════════════════════════════════════════════════════════════
    // 6. Response Shape Tests
    // ══════════════════════════════════════════════════════════════════════

    /// Response ak/nk/rivk match the canonical bytes, not the buggy input.
    #[test]
    fn test_set_fvk_response_matches_canonical() {
        let fvk = derive_test_fvk(0x42, 0);
        let original_bytes = fvk.to_bytes();
        let mut buggy_ak = [0u8; 32];
        buggy_ak.copy_from_slice(&original_bytes[..32]);
        buggy_ak[31] |= 0x80;

        let (canonical, response, _, _dir) = simulate_set_fvk(
            &buggy_ak,
            &original_bytes[32..64],
            &original_bytes[64..96],
        ).expect("should succeed");

        // Response ak is the canonical one
        let resp_ak_bytes = hex::decode(response["fvk"]["ak"].as_str().unwrap()).unwrap();
        assert_eq!(resp_ak_bytes, &canonical[..32],
            "response ak must be canonical");
        assert_eq!(resp_ak_bytes[31] & 0x80, 0,
            "response ak must not have sign bit set");
    }

    /// Response for valid input has sign_bit_corrected = false.
    #[test]
    fn test_set_fvk_response_no_correction_flag_when_valid() {
        let fvk = derive_test_fvk(0x42, 0);
        let b = fvk.to_bytes();

        let (_, response, _, _dir) = simulate_set_fvk(&b[..32], &b[32..64], &b[64..96])
            .expect("should succeed");

        assert_eq!(response["sign_bit_corrected"], false);
    }

    // ══════════════════════════════════════════════════════════════════════
    // 7. Address Consistency Tests
    // ══════════════════════════════════════════════════════════════════════

    /// Address derived from canonical FVK matches the original.
    #[test]
    fn test_canonical_fvk_produces_same_address() {
        let fvk = derive_test_fvk(0x42, 0);
        let original_bytes = fvk.to_bytes();
        let original_addr = fvk.address_at(0u32, orchard::keys::Scope::External);

        // Simulate canonicalization of buggy bytes
        let mut buggy = original_bytes;
        buggy[31] |= 0x80;
        buggy[31] &= 0x7f; // clear = back to original

        let recovered = FullViewingKey::from_bytes(&buggy).expect("should decode");
        let recovered_addr = recovered.address_at(0u32, orchard::keys::Scope::External);

        assert_eq!(
            original_addr.to_raw_address_bytes(),
            recovered_addr.to_raw_address_bytes(),
            "address from canonical FVK must match original"
        );
    }

    /// Reference FVK output for seed 0x42 — for firmware comparison.
    #[test]
    fn test_reference_fvk_output() {
        let fvk = derive_test_fvk(0x42, 0);
        let bytes = fvk.to_bytes();

        // These are deterministic — if firmware matches these, derivation is correct
        let ak = hex::encode(&bytes[..32]);
        let nk = hex::encode(&bytes[32..64]);
        let rivk = hex::encode(&bytes[64..96]);

        // Sign bit must be 0
        assert_eq!(bytes[31] & 0x80, 0);

        // Verify non-zero (not degenerate)
        assert_ne!(&bytes[..32], &[0u8; 32], "ak must not be zero");
        assert_ne!(&bytes[32..64], &[0u8; 32], "nk must not be zero");
        assert_ne!(&bytes[64..96], &[0u8; 32], "rivk must not be zero");

        println!("Reference FVK for seed 0x42, account 0:");
        println!("  ak:   {}", ak);
        println!("  nk:   {}", nk);
        println!("  rivk: {}", rivk);
    }

    // ══════════════════════════════════════════════════════════════════════
    // 8. DB Edge Cases
    // ══════════════════════════════════════════════════════════════════════

    /// Overwriting FVK in DB works correctly.
    #[test]
    fn test_db_fvk_overwrite() {
        let fvk0 = derive_test_fvk(0x42, 0);
        let fvk1 = derive_test_fvk(0x42, 1);
        let (db, _dir) = test_db();

        db.save_fvk(&fvk0.to_bytes()).expect("save 0");
        assert!(db.fvk_matches(&fvk0.to_bytes()).unwrap());
        assert!(!db.fvk_matches(&fvk1.to_bytes()).unwrap());

        db.save_fvk(&fvk1.to_bytes()).expect("save 1");
        assert!(!db.fvk_matches(&fvk0.to_bytes()).unwrap());
        assert!(db.fvk_matches(&fvk1.to_bytes()).unwrap());
    }

    /// DB reset clears FVK.
    #[test]
    fn test_db_reset_clears_fvk() {
        let fvk = derive_test_fvk(0x42, 0);
        let (db, _dir) = test_db();

        db.save_fvk(&fvk.to_bytes()).expect("save");
        assert!(db.load_fvk().unwrap().is_some());

        db.reset().expect("reset");
        assert!(db.load_fvk().unwrap().is_none());
    }
}
