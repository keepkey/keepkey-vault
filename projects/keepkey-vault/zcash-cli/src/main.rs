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
use log::{info, debug, error};
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
    /// Pending shielded-send PCZT state waiting for signatures
    pending_pczt: Option<pczt_builder::PcztState>,
    /// Pending shield (transparent → Orchard) PCZT state waiting for signatures
    pending_shield_pczt: Option<pczt_builder::ShieldPcztState>,
}

impl State {
    fn new() -> Self {
        Self {
            db: None,
            fvk: None,
            pending_pczt: None,
            pending_shield_pczt: None,
        }
    }

    #[cfg(test)]
    fn with_db(db: wallet_db::WalletDb) -> Self {
        Self {
            db: Some(db),
            fvk: None,
            pending_pczt: None,
            pending_shield_pczt: None,
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
            }
            match FullViewingKey::from_bytes(&fvk_bytes) {
                Some(fvk) => {
                    // Only persist canonical bytes AFTER decode succeeds
                    if had_sign_bit {
                        let _ = db.save_fvk(&fvk_bytes);
                    }
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

    debug!("set_fvk: ak  = {}", ak_hex);
    debug!("set_fvk: nk  = {}", nk_hex);
    debug!("set_fvk: rivk= {}", rivk_hex);

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
        "new_notes": result.new_notes,
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

// ── Shield (transparent → Orchard) IPC handlers ──────────────────────────

async fn handle_build_shield_pczt(state: &mut State, params: &Value) -> Result<Value> {
    let fvk = state.fvk.as_ref()
        .ok_or_else(|| anyhow::anyhow!("No FVK set — call set_fvk first"))?
        .clone();

    let inputs_json = params.get("transparent_inputs")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing transparent_inputs array"))?;

    let mut transparent_inputs: Vec<pczt_builder::ShieldTransparentInput> = Vec::new();
    for inp in inputs_json {
        transparent_inputs.push(pczt_builder::ShieldTransparentInput {
            txid: inp.get("txid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            vout: inp.get("vout").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            value: inp.get("value").and_then(|v| v.as_u64()).unwrap_or(0),
            script_pubkey: inp.get("script_pubkey").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        });
    }

    let amount = params.get("amount")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow::anyhow!("Missing amount"))?;
    let fee = params.get("fee")
        .and_then(|v| v.as_u64())
        .unwrap_or(10000);
    let account = params.get("account")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let mut lwd_client = scanner::LightwalletClient::connect(None).await?;
    let branch_id = lwd_client.get_consensus_branch_id().await?;
    info!("Using consensus branch ID: 0x{:08x}", branch_id);

    let db = state.ensure_db()?;

    let shield_state = pczt_builder::build_shield_pczt(
        &fvk, transparent_inputs, amount, fee, account, branch_id,
        &mut lwd_client, db,
    ).await?;

    // Build the signing request JSON for the TypeScript layer
    let ti_json: Vec<Value> = shield_state.transparent_signing_inputs.iter().map(|ti| {
        serde_json::json!({
            "index": ti.index,
            "sighash": hex::encode(&ti.sighash),
            "address_path": ti.address_path,
            "amount": ti.amount,
        })
    }).collect();

    let orchard_json = serde_json::to_value(&shield_state.orchard_signing_request)
        .unwrap_or_default();

    let signing_request = serde_json::json!({
        "transparent_inputs": ti_json,
        "orchard_signing_request": orchard_json,
        "display": {
            "amount": format!("{:.8} ZEC", amount as f64 / 1e8),
            "fee": format!("{:.8} ZEC", fee as f64 / 1e8),
            "action": "Shield to Orchard"
        }
    });

    // Store state for finalize
    state.pending_shield_pczt = Some(shield_state);

    // Return flat (not nested under "signing_request") — the TS layer
    // accesses buildResult.transparent_inputs directly.
    Ok(signing_request)
}

async fn handle_finalize_shield(state: &mut State, params: &Value) -> Result<Value> {
    let shield_state = state.pending_shield_pczt.take()
        .ok_or_else(|| anyhow::anyhow!("No pending shield PCZT — call build_shield_pczt first"))?;

    let transparent_sigs_json = params.get("transparent_signatures")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing transparent_signatures array"))?;

    let orchard_sigs_json = params.get("orchard_signatures")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("Missing orchard_signatures array"))?;

    let mut transparent_sigs: Vec<Vec<u8>> = Vec::new();
    for sig_val in transparent_sigs_json {
        let sig_hex = sig_val.as_str()
            .ok_or_else(|| anyhow::anyhow!("Transparent signature must be hex string"))?;
        transparent_sigs.push(hex::decode(sig_hex)?);
    }

    let mut orchard_sigs: Vec<Vec<u8>> = Vec::new();
    for sig_val in orchard_sigs_json {
        let sig_hex = sig_val.as_str()
            .ok_or_else(|| anyhow::anyhow!("Orchard signature must be hex string"))?;
        orchard_sigs.push(hex::decode(sig_hex)?);
    }

    // compressed_pubkey is passed alongside transparent sigs for P2PKH scriptSig
    let compressed_pubkey = params.get("compressed_pubkey")
        .and_then(|v| v.as_str())
        .map(|s| hex::decode(s).unwrap_or_default());

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

/// Decode a 512-byte raw Zcash memo per ZIP-302.
/// Returns Some(text) for UTF-8 text memos, None for empty/binary.
fn decode_zip302_memo(raw: &[u8]) -> Option<String> {
    if raw.len() != 512 {
        return None;
    }

    let first_byte = raw[0];

    // 0xF6 = canonical "no memo" per ZIP-302
    if first_byte == 0xF6 {
        return None;
    }

    // 0xF5, 0xF7-0xFF = non-text (binary / reserved)
    if first_byte >= 0xF5 {
        return None;
    }

    // Text memo: strip trailing zeros, decode UTF-8
    let end = raw.iter().rposition(|&b| b != 0).map(|i| i + 1).unwrap_or(0);
    if end == 0 {
        return None; // all zeros — effectively empty
    }

    String::from_utf8(raw[..end].to_vec()).ok()
}

/// Get transaction history with decoded memos.
async fn handle_get_transactions(state: &mut State, _params: &Value) -> Result<Value> {
    let db = state.ensure_db()?;
    let notes = db.get_all_notes()?;

    let txs: Vec<Value> = notes.iter().map(|n| {
        let memo_text = n.memo.as_ref().and_then(|m| decode_zip302_memo(m));
        let txid_hex = n.txid.as_ref().map(|t| hex::encode(t));
        serde_json::json!({
            "id": n.id,
            "value": n.value,
            "block_height": n.block_height,
            "tx_index": n.tx_index,
            "is_spent": n.is_spent,
            "memo": memo_text,
            "nullifier": hex::encode(&n.nullifier),
            "txid": txid_hex,
            "action_index": n.action_index,
        })
    }).collect();

    Ok(serde_json::json!({ "transactions": txs }))
}

/// Fetch full transactions for notes missing memos and decrypt them.
async fn handle_backfill_memos(state: &mut State, _params: &Value) -> Result<Value> {
    let fvk = state.fvk.as_ref()
        .ok_or_else(|| anyhow::anyhow!("No FVK set — call set_fvk first"))?
        .clone();

    let db = state.ensure_db()?;
    let pending = db.get_notes_without_memo()?;

    if pending.is_empty() {
        return Ok(serde_json::json!({ "backfilled": 0 }));
    }

    info!("Backfilling memos for {} notes...", pending.len());

    let mut client = scanner::LightwalletClient::connect(None).await?;
    let mut count = 0u32;

    for (note_id, txid, _height, action_idx) in &pending {
        match client.fetch_and_decrypt_memo(&txid, *action_idx as usize, &fvk).await {
            Ok(Some(memo)) => {
                db.update_note_memo(*note_id, &memo)?;
                count += 1;
                let text = decode_zip302_memo(&memo);
                if let Some(ref t) = text {
                    info!("Note {}: memo = {:?}", note_id, &t[..std::cmp::min(t.len(), 50)]);
                }
            }
            Ok(None) => {
                debug!("Note {}: decryption failed (may be change note)", note_id);
            }
            Err(e) => {
                info!("Failed to backfill memo for note {}: {}", note_id, e);
            }
        }
    }

    info!("Backfilled {} memos", count);
    Ok(serde_json::json!({ "backfilled": count }))
}

/// Diagnostic: cross-validate subtree roots, tree state, and leaf-computed hashes.
/// Exposes the raw bytes at every seam to identify encoding/semantic mismatches.
async fn handle_diagnose_anchor(_state: &mut State, params: &Value) -> Result<Value> {
    use orchard::tree::MerkleHashOrchard;
    use orchard::note::ExtractedNoteCommitment;
    use incrementalmerkletree::{Hashable, Retention};
    use shardtree::{store::memory::MemoryShardStore, ShardTree};

    let shard_idx = params.get("shard_index")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    info!("=== ANCHOR DIAGNOSTIC: shard {} ===", shard_idx);

    let mut client = scanner::LightwalletClient::connect(None).await?;

    // 1. Fetch the specific subtree root
    let subtree_roots = client.get_subtree_roots(shard_idx, 1).await?;
    if subtree_roots.is_empty() {
        return Err(anyhow::anyhow!("No subtree root at index {}", shard_idx));
    }
    let (idx, root_hash, completing_height) = &subtree_roots[0];
    info!("[1] GetSubtreeRoots(index={}):", idx);
    info!("    rootHash (raw hex): {}", hex::encode(root_hash));
    info!("    rootHash (reversed): {}", hex::encode(root_hash.iter().rev().copied().collect::<Vec<_>>()));
    info!("    completingBlockHeight: {}", completing_height);

    // Check if rootHash is a valid Pallas base field element
    let as_merkle = MerkleHashOrchard::from_bytes(root_hash);
    info!("    MerkleHashOrchard::from_bytes valid: {}", bool::from(as_merkle.is_some()));
    if let Some(m) = as_merkle.into_option() {
        info!("    round-trip bytes: {}", hex::encode(m.to_bytes()));
    }

    // 2. Fetch tree state at the completing height
    let (ts_height, tree_hex) = client.get_tree_state(*completing_height).await?;
    info!("[2] GetTreeState(height={}):", completing_height);
    info!("    returned height: {}", ts_height);
    info!("    orchardTree hex length: {} chars ({} bytes decoded)", tree_hex.len(), tree_hex.len() / 2);

    // Compute anchor from tree state
    let anchor_at_completing = client.get_orchard_anchor(*completing_height).await?;
    info!("    tree-state anchor: {}", hex::encode(&anchor_at_completing));

    // 3. Get the tree size at completing height
    let tree_size_at_completing = client.get_orchard_tree_size_at(*completing_height).await?;
    info!("[3] Tree size at completing height {}: {}", completing_height, tree_size_at_completing);
    let shard_size: u64 = 1 << 16; // 65536
    let expected_size = ((*idx as u64) + 1) * shard_size;
    info!("    Expected size (shard {} complete): {}", idx, expected_size);
    info!("    Match: {}", tree_size_at_completing == expected_size);
    if tree_size_at_completing != expected_size {
        info!("    MISMATCH: tree has {} leaves but shard {} should end at position {}",
            tree_size_at_completing, idx, expected_size);
    }

    // 4. Also fetch the previous shard's completing height to know where this shard starts
    let shard_start_height = if *idx > 0 {
        let prev_roots = client.get_subtree_roots(idx - 1, 1).await?;
        if let Some((_, _, prev_completing)) = prev_roots.first() {
            info!("[4] Previous shard {} completing height: {}", idx - 1, prev_completing);
            *prev_completing + 1
        } else {
            1687104 // Orchard activation
        }
    } else {
        1687104
    };

    // 5. Compute the shard hash from individual leaves (fetch compact blocks)
    info!("[5] Computing shard {} hash from individual leaves...", idx);
    info!("    Fetching blocks {} to {}", shard_start_height, completing_height);

    let mut leaf_hashes: Vec<MerkleHashOrchard> = Vec::new();
    let chunk_size = 10000u64;
    let mut current_height = shard_start_height;

    while current_height <= *completing_height {
        let end = std::cmp::min(current_height + chunk_size - 1, *completing_height);
        let blocks = client.fetch_block_actions(current_height, end).await?;
        for (_bh, txs) in &blocks {
            for (_tx_idx, cmxs) in txs {
                for cmx_bytes in cmxs {
                    let cmx = ExtractedNoteCommitment::from_bytes(cmx_bytes);
                    if bool::from(cmx.is_none()) { continue; }
                    leaf_hashes.push(MerkleHashOrchard::from_cmx(&cmx.unwrap()));
                }
            }
        }
        current_height = end + 1;
    }

    info!("    Collected {} leaves from compact blocks", leaf_hashes.len());
    info!("    Expected {} leaves for shard (65536)", shard_size);

    // Log first and last few leaves
    if leaf_hashes.len() >= 3 {
        info!("    leaf[0]: {}", hex::encode(leaf_hashes[0].to_bytes()));
        info!("    leaf[1]: {}", hex::encode(leaf_hashes[1].to_bytes()));
        info!("    leaf[last]: {}", hex::encode(leaf_hashes.last().unwrap().to_bytes()));
    }

    // 6. Compute the subtree hash by building a local Merkle tree
    info!("[6] Computing subtree hash from {} leaves...", leaf_hashes.len());

    // Method A: manual binary Merkle hash at each level
    let mut level_hashes = leaf_hashes.clone();
    // Pad to shard_size with empty leaves
    let empty_leaf = MerkleHashOrchard::empty_leaf();
    while level_hashes.len() < shard_size as usize {
        level_hashes.push(empty_leaf);
    }
    // If we have MORE than shard_size leaves, the shard boundary assumption is wrong
    if level_hashes.len() > shard_size as usize {
        info!("    WARNING: {} leaves exceeds shard size {}", level_hashes.len(), shard_size);
        level_hashes.truncate(shard_size as usize);
    }

    for level in 0..16u8 {
        let mut next_level = Vec::with_capacity(level_hashes.len() / 2);
        for pair in level_hashes.chunks(2) {
            let combined = MerkleHashOrchard::combine(
                incrementalmerkletree::Level::from(level),
                &pair[0],
                if pair.len() > 1 { &pair[1] } else { &empty_leaf },
            );
            next_level.push(combined);
        }
        level_hashes = next_level;
    }

    let computed_subtree_hash = level_hashes[0].to_bytes();
    info!("    Computed subtree hash (manual): {}", hex::encode(&computed_subtree_hash));
    info!("    GetSubtreeRoots rootHash:       {}", hex::encode(root_hash));
    info!("    MATCH: {}", computed_subtree_hash == *root_hash);

    if computed_subtree_hash != *root_hash {
        // Check reversed
        let reversed: Vec<u8> = root_hash.iter().rev().copied().collect();
        let mut rev_arr = [0u8; 32];
        rev_arr.copy_from_slice(&reversed);
        info!("    Match (reversed rootHash): {}", computed_subtree_hash == rev_arr);

        // Check if rootHash is the full tree root at completing_height (not subtree)
        info!("    rootHash == tree-state anchor: {}", *root_hash == anchor_at_completing);
    }

    // Method B: using ShardTree to compute the same thing
    let mut shard_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
        ShardTree::new(MemoryShardStore::empty(), 100);
    let _shard_start_pos = (*idx as u64) * shard_size;
    for (i, leaf) in leaf_hashes.iter().enumerate().take(shard_size as usize) {
        // We need leaves at the correct global positions for ShardTree
        shard_tree.append(*leaf, Retention::Ephemeral)
            .map_err(|e| anyhow::anyhow!("Failed to append leaf {}: {:?}", i, e))?;
    }
    shard_tree.checkpoint(0u32)
        .map_err(|e| anyhow::anyhow!("Failed to checkpoint: {:?}", e))?;
    let shard_tree_root = shard_tree.root_at_checkpoint_id(&0u32)
        .map_err(|e| anyhow::anyhow!("Failed to get root: {:?}", e))?
        .ok_or_else(|| anyhow::anyhow!("Empty root"))?;
    info!("    ShardTree root (leaves at pos 0): {}", hex::encode(shard_tree_root.to_bytes()));
    info!("    NOTE: ShardTree root here is the full depth-32 root with only 1 shard filled,");
    info!("    not the level-16 subtree hash. These are different values.");

    // 7. Summary
    info!("=== DIAGNOSTIC SUMMARY ===");
    info!("  Shard index: {}", idx);
    info!("  Completing height: {}", completing_height);
    info!("  Leaves from compact blocks: {}", leaf_hashes.len());
    info!("  Tree size at completing height: {}", tree_size_at_completing);
    info!("  Computed level-16 subtree hash: {}", hex::encode(&computed_subtree_hash));
    info!("  GetSubtreeRoots rootHash:       {}", hex::encode(root_hash));
    info!("  Tree-state anchor:              {}", hex::encode(&anchor_at_completing));
    let subtree_match = computed_subtree_hash == *root_hash;
    info!("  Subtree hash matches rootHash: {}", subtree_match);
    if !subtree_match {
        info!("  → ROOT CAUSE: GetSubtreeRoots rootHash does NOT equal the");
        info!("    manually-computed level-16 subtree hash from individual leaves.");
        info!("    This means either: (a) rootHash is encoded differently than");
        info!("    MerkleHashOrchard::to_bytes(), (b) it's at a different tree level,");
        info!("    (c) leaves from compact blocks don't match what the chain committed,");
        info!("    or (d) our MerkleHashOrchard::combine() differs from the node.");
    }

    Ok(serde_json::json!({
        "shard_index": idx,
        "completing_height": completing_height,
        "leaves_collected": leaf_hashes.len(),
        "tree_size_at_completing": tree_size_at_completing,
        "computed_subtree_hash": hex::encode(&computed_subtree_hash),
        "get_subtree_roots_hash": hex::encode(root_hash),
        "tree_state_anchor": hex::encode(&anchor_at_completing),
        "subtree_match": subtree_match,
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
            "build_shield_pczt" => handle_build_shield_pczt(&mut state, &request.params).await,
            "finalize_shield" => handle_finalize_shield(&mut state, &request.params).await,
            "broadcast" => handle_broadcast(&mut state, &request.params).await,
            "get_transactions" => handle_get_transactions(&mut state, &request.params).await,
            "backfill_memos" => handle_backfill_memos(&mut state, &request.params).await,
            "diagnose_anchor" => handle_diagnose_anchor(&mut state, &request.params).await,
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

    /// Helper: create a State backed by a temp DB.
    fn test_state() -> (State, TempDir) {
        let (db, dir) = test_db();
        (State::with_db(db), dir)
    }

    /// Helper: build JSON params for handle_set_fvk from raw bytes.
    fn set_fvk_params(ak: &[u8], nk: &[u8], rivk: &[u8]) -> Value {
        serde_json::json!({
            "ak": hex::encode(ak),
            "nk": hex::encode(nk),
            "rivk": hex::encode(rivk),
        })
    }

    /// Helper: call handle_set_fvk on a real State (async wrapper).
    fn call_set_fvk(state: &mut State, ak: &[u8], nk: &[u8], rivk: &[u8]) -> Result<Value> {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(handle_set_fvk(state, &set_fvk_params(ak, nk, rivk)))
    }

    // ══════════════════════════════════════════════════════════════════════
    // 1. FVK Primitive Tests (orchard crate behavior verification)
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_fvk_roundtrip_from_spending_key() {
        let fvk = derive_test_fvk(0x42, 0);
        let fvk_bytes = fvk.to_bytes();
        assert_eq!(fvk_bytes[31] & 0x80, 0, "ak sign bit must be 0 in valid FVK");
        let fvk2 = FullViewingKey::from_bytes(&fvk_bytes).expect("round-trip failed");
        assert_eq!(fvk.to_bytes(), fvk2.to_bytes());
    }

    #[test]
    fn test_fvk_rejects_sign_bit_set() {
        let fvk = derive_test_fvk(0x42, 0);
        let mut fvk_bytes = fvk.to_bytes();
        fvk_bytes[31] |= 0x80;
        assert!(FullViewingKey::from_bytes(&fvk_bytes).is_none(),
            "FVK should reject ak with sign bit set");
    }

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
        assert_eq!(original_bytes, recovered.to_bytes());
    }

    #[test]
    fn test_multiple_accounts_sign_bit() {
        for acct in 0..16u32 {
            let fvk = derive_test_fvk(0x42, acct);
            assert_eq!(fvk.to_bytes()[31] & 0x80, 0,
                "Account {} has ak sign bit set", acct);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. Real handle_set_fvk Tests
    // ══════════════════════════════════════════════════════════════════════

    /// Valid FVK through real handler: state, DB, and response all consistent.
    #[test]
    fn test_handle_set_fvk_valid_canonical() {
        let (mut state, _dir) = test_state();
        let fvk = derive_test_fvk(0x42, 0);
        let b = fvk.to_bytes();

        let response = call_set_fvk(&mut state, &b[..32], &b[32..64], &b[64..96])
            .expect("should succeed");

        // State has FVK
        let state_fvk = state.fvk.as_ref().expect("state.fvk should be set");
        assert_eq!(state_fvk.to_bytes(), b, "state FVK must match input");

        // Response ak matches input (no correction)
        let resp_ak = response["fvk"]["ak"].as_str().unwrap();
        assert_eq!(resp_ak, hex::encode(&b[..32]));
        assert_eq!(response["sign_bit_corrected"], false);

        // Response address matches state FVK address
        let state_addr = state_fvk.address_at(0u32, orchard::keys::Scope::External);
        let state_ua = encode_unified_address(&state_addr).unwrap();
        assert_eq!(response["address"].as_str().unwrap(), state_ua);

        // DB stores canonical bytes
        let db = state.db.as_ref().unwrap();
        let stored = db.load_fvk().unwrap().expect("DB should have FVK");
        assert_eq!(stored, b);
        assert!(db.fvk_matches(&b).unwrap());
    }

    /// Buggy sign-bit FVK through real handler: everything canonicalizes.
    #[test]
    fn test_handle_set_fvk_buggy_sign_bit_canonicalizes() {
        let (mut state, _dir) = test_state();
        let fvk = derive_test_fvk(0x42, 0);
        let original = fvk.to_bytes();
        let mut buggy_ak = [0u8; 32];
        buggy_ak.copy_from_slice(&original[..32]);
        buggy_ak[31] |= 0x80;

        let response = call_set_fvk(&mut state, &buggy_ak, &original[32..64], &original[64..96])
            .expect("should recover");

        // State FVK matches canonical (sign-cleared)
        let state_bytes = state.fvk.as_ref().unwrap().to_bytes();
        assert_eq!(state_bytes[31] & 0x80, 0, "state FVK sign bit must be 0");
        assert_eq!(&state_bytes[..32], &original[..32]);

        // Response returns canonical ak, NOT buggy
        let resp_ak = response["fvk"]["ak"].as_str().unwrap();
        assert_eq!(resp_ak, hex::encode(&original[..32]));
        assert_ne!(resp_ak, hex::encode(&buggy_ak));
        assert_eq!(response["sign_bit_corrected"], true);

        // DB stores canonical bytes
        let db = state.db.as_ref().unwrap();
        let stored = db.load_fvk().unwrap().unwrap();
        assert_eq!(stored[31] & 0x80, 0);
        assert_eq!(&stored[..32], &original[..32]);
    }

    /// Garbage FVK through real handler: state unchanged, error returned.
    #[test]
    fn test_handle_set_fvk_rejects_garbage() {
        let (mut state, _dir) = test_state();
        let garbage = [0xFFu8; 32];
        let result = call_set_fvk(&mut state, &garbage, &garbage, &garbage);
        assert!(result.is_err(), "garbage should fail");
        assert!(state.fvk.is_none(), "state.fvk must remain None on failure");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. Real try_load_fvk Tests
    // ══════════════════════════════════════════════════════════════════════

    /// Canonical bytes in DB: try_load_fvk succeeds.
    #[test]
    fn test_try_load_fvk_canonical_bytes() {
        let (mut state, _dir) = test_state();
        let fvk = derive_test_fvk(0x42, 0);
        let b = fvk.to_bytes();
        state.db.as_ref().unwrap().save_fvk(&b).unwrap();

        let loaded = state.try_load_fvk().expect("should not error");
        assert!(loaded, "should load successfully");

        let state_bytes = state.fvk.as_ref().unwrap().to_bytes();
        assert_eq!(state_bytes, b, "loaded FVK must match stored");
    }

    /// Legacy buggy bytes in DB: try_load_fvk canonicalizes, re-saves, succeeds.
    #[test]
    fn test_try_load_fvk_fixes_legacy_buggy_bytes() {
        let (mut state, _dir) = test_state();
        let fvk = derive_test_fvk(0x42, 0);
        let original = fvk.to_bytes();
        let mut buggy = original;
        buggy[31] |= 0x80;

        // Save buggy bytes (simulates legacy DB)
        state.db.as_ref().unwrap().save_fvk(&buggy).unwrap();
        let stored = state.db.as_ref().unwrap().load_fvk().unwrap().unwrap();
        assert_eq!(stored[31] & 0x80, 0x80, "precondition: buggy bytes in DB");

        // try_load_fvk should canonicalize
        let loaded = state.try_load_fvk().expect("should not error");
        assert!(loaded, "should load successfully after canonicalization");

        // State FVK is canonical
        let state_bytes = state.fvk.as_ref().unwrap().to_bytes();
        assert_eq!(state_bytes[31] & 0x80, 0);
        assert_eq!(state_bytes, original);

        // DB was rewritten with canonical bytes
        let reloaded = state.db.as_ref().unwrap().load_fvk().unwrap().unwrap();
        assert_eq!(reloaded[31] & 0x80, 0, "DB must now have canonical bytes");
        assert_eq!(reloaded, original);
    }

    /// Corrupt bytes in DB (not recoverable even with sign bit fix): try_load_fvk
    /// returns false, does NOT rewrite DB with still-corrupt data.
    #[test]
    fn test_try_load_fvk_corrupt_bytes_no_rewrite() {
        let (mut state, _dir) = test_state();
        let corrupt = [0xFFu8; 96];
        state.db.as_ref().unwrap().save_fvk(&corrupt).unwrap();

        let loaded = state.try_load_fvk().expect("should not error");
        assert!(!loaded, "should fail to load corrupt FVK");
        assert!(state.fvk.is_none(), "state.fvk must remain None");

        // DB bytes should still be the original corrupt bytes (no silent rewrite)
        let stored = state.db.as_ref().unwrap().load_fvk().unwrap().unwrap();
        // The sign bit was cleared in-memory, but since decode failed, it should
        // NOT have been saved back. However, the first 31 bytes are all 0xFF,
        // and only byte[31] changed (0xFF → 0x7F). Check the original wasn't overwritten.
        // Actually: the corrupt bytes have sign bit set (0xFF & 0x80 = 0x80), so
        // try_load_fvk clears it in-memory. Since decode fails, save_fvk is NOT called.
        // DB should still have the original 0xFF bytes.
        assert_eq!(stored[31], 0xFF, "DB must NOT be rewritten when decode fails");
    }

    /// Empty DB: try_load_fvk returns false gracefully.
    #[test]
    fn test_try_load_fvk_empty_db() {
        let (mut state, _dir) = test_state();
        let loaded = state.try_load_fvk().expect("should not error");
        assert!(!loaded);
        assert!(state.fvk.is_none());
    }

    // ══════════════════════════════════════════════════════════════════════
    // 4. End-to-End Persistence Tests (set → reload)
    // ══════════════════════════════════════════════════════════════════════

    /// Set FVK with buggy input → new State → try_load_fvk → same address.
    #[test]
    fn test_e2e_set_fvk_then_reload() {
        let (db, _dir) = test_db();
        let fvk = derive_test_fvk(0x42, 0);
        let original = fvk.to_bytes();
        let mut buggy_ak = [0u8; 32];
        buggy_ak.copy_from_slice(&original[..32]);
        buggy_ak[31] |= 0x80;

        // Session 1: set_fvk with buggy input
        let response = {
            let mut state1 = State::with_db(db);
            let resp = call_set_fvk(&mut state1, &buggy_ak, &original[32..64], &original[64..96])
                .expect("should succeed");
            // DB was written by state1; drop state1 but keep the dir
            resp
        };
        let session1_address = response["address"].as_str().unwrap().to_string();

        // Session 2: fresh State, same DB file
        let db_path = _dir.path().join("test_wallet.db");
        let db2 = wallet_db::WalletDb::open(&db_path).expect("reopen");
        let mut state2 = State::with_db(db2);
        let loaded = state2.try_load_fvk().expect("should load");
        assert!(loaded, "should auto-load from DB");

        // Same FVK, same address
        let state2_fvk = state2.fvk.as_ref().unwrap();
        let addr2 = state2_fvk.address_at(0u32, orchard::keys::Scope::External);
        let ua2 = encode_unified_address(&addr2).unwrap();
        assert_eq!(ua2, session1_address, "address must survive restart");
        assert_eq!(state2_fvk.to_bytes()[31] & 0x80, 0, "sign bit must be 0 after reload");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 5. Fingerprint / Reset Tests (real handler)
    // ══════════════════════════════════════════════════════════════════════

    /// Same key with buggy sign bit does NOT reset DB.
    #[test]
    fn test_handle_set_fvk_no_false_reset_for_equivalent_buggy() {
        let (mut state, _dir) = test_state();
        let fvk = derive_test_fvk(0x42, 0);
        let original = fvk.to_bytes();

        // First call: canonical
        call_set_fvk(&mut state, &original[..32], &original[32..64], &original[64..96])
            .expect("first call");

        // Insert a note so we can detect a reset
        let db = state.db.as_ref().unwrap();
        db.insert_note(&wallet_db::ScannedNote {
            value: 100000,
            recipient: vec![0u8; 43],
            rho: [1u8; 32],
            rseed: [2u8; 32],
            cmx: [3u8; 32],
            nullifier: [4u8; 32],
            block_height: 1000,
            tx_index: 0,
            action_index: 0,
            txid: None,
            memo: None,
        }).unwrap();

        // Second call: same key but with buggy sign bit
        let mut buggy_ak = [0u8; 32];
        buggy_ak.copy_from_slice(&original[..32]);
        buggy_ak[31] |= 0x80;
        call_set_fvk(&mut state, &buggy_ak, &original[32..64], &original[64..96])
            .expect("second call");

        // Note should still be there (no reset)
        let (_, unspent) = state.db.as_ref().unwrap().get_note_count().unwrap();
        assert_eq!(unspent, 1, "note must survive — no false reset");
    }

    /// Different account FVK triggers DB reset.
    #[test]
    fn test_handle_set_fvk_resets_for_different_account() {
        let (mut state, _dir) = test_state();
        let fvk0 = derive_test_fvk(0x42, 0);
        let b0 = fvk0.to_bytes();

        // Set account 0
        call_set_fvk(&mut state, &b0[..32], &b0[32..64], &b0[64..96]).unwrap();

        // Insert a note
        state.db.as_ref().unwrap().insert_note(&wallet_db::ScannedNote {
            value: 100000,
            recipient: vec![0u8; 43],
            rho: [1u8; 32],
            rseed: [2u8; 32],
            cmx: [3u8; 32],
            nullifier: [4u8; 32],
            block_height: 1000,
            tx_index: 0,
            action_index: 0,
            txid: None,
            memo: None,
        }).unwrap();

        // Set account 1 (different key)
        let fvk1 = derive_test_fvk(0x42, 1);
        let b1 = fvk1.to_bytes();
        call_set_fvk(&mut state, &b1[..32], &b1[32..64], &b1[64..96]).unwrap();

        // Note should be gone (reset occurred)
        let (total, _) = state.db.as_ref().unwrap().get_note_count().unwrap();
        assert_eq!(total, 0, "DB must be reset when FVK changes");
    }

    /// fvk_matches returns true for empty DB (first-time setup).
    #[test]
    fn test_fvk_matches_returns_true_for_empty_db() {
        let fvk = derive_test_fvk(0x42, 0);
        let (db, _dir) = test_db();
        assert!(db.fvk_matches(&fvk.to_bytes()).unwrap(),
            "empty DB should match any FVK");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 6. Device Log Vector Tests
    // ══════════════════════════════════════════════════════════════════════

    /// Exact device log vector through real handler — pinned to known outcome.
    /// This vector (ak sign bit set) canonicalizes successfully after clearing
    /// the sign bit. If this test fails, it means a regression in the
    /// canonicalization path or a change in the orchard crate's FVK decoding.
    #[test]
    fn test_handle_set_fvk_device_vector() {
        let ak = hex::decode(
            "59285e6994df779f819ea1e67bd687d698137dc4789430ffb0ece45370948ea7"
        ).unwrap();
        let nk = hex::decode(
            "568fa99d2705be00371cadfba937efe844533b54c631bea1045fd8f46e1a4c17"
        ).unwrap();
        let rivk = hex::decode(
            "01111ac7987d132f2d5d69d69f834c523d3b4705b25030fd6025372cad4a1f3d"
        ).unwrap();

        assert_eq!(ak[31] & 0x80, 0x80, "device ak must have sign bit set");

        let (mut state, _dir) = test_state();
        let response = call_set_fvk(&mut state, &ak, &nk, &rivk)
            .expect("device vector must canonicalize successfully");

        // Response returns canonical ak (sign bit cleared)
        let resp_ak = hex::decode(response["fvk"]["ak"].as_str().unwrap()).unwrap();
        assert_eq!(resp_ak[31] & 0x80, 0, "response ak sign bit must be 0");
        assert_eq!(response["sign_bit_corrected"], true);

        // State FVK is set with canonical bytes
        let state_bytes = state.fvk.as_ref().unwrap().to_bytes();
        assert_eq!(state_bytes[31] & 0x80, 0);

        // DB stores canonical bytes
        let stored = state.db.as_ref().unwrap().load_fvk().unwrap().unwrap();
        assert_eq!(stored[31] & 0x80, 0);

        // Address is a valid Unified Address
        let addr = response["address"].as_str().unwrap();
        assert!(addr.starts_with("u1"), "address must be a Unified Address");
    }

    /// Exact device log vector: component-level validation.
    #[test]
    fn test_device_log_vector_component_validation() {
        let ak = hex::decode(
            "59285e6994df779f819ea1e67bd687d698137dc4789430ffb0ece45370948ea7"
        ).unwrap();
        let nk = hex::decode(
            "568fa99d2705be00371cadfba937efe844533b54c631bea1045fd8f46e1a4c17"
        ).unwrap();
        let rivk = hex::decode(
            "01111ac7987d132f2d5d69d69f834c523d3b4705b25030fd6025372cad4a1f3d"
        ).unwrap();

        // ak with sign cleared decompresses as valid Pallas point
        let mut ak_fixed: [u8; 32] = ak.clone().try_into().unwrap();
        ak_fixed[31] &= 0x7f;
        let ak_point = pasta_curves::pallas::Affine::from_bytes(&ak_fixed);
        assert!(bool::from(ak_point.is_some()), "ak must be valid Pallas point");

        // nk valid as base field element
        let nk_arr: [u8; 32] = nk.try_into().unwrap();
        assert!(bool::from(pasta_curves::pallas::Base::from_repr(nk_arr).is_some()));

        // rivk valid as scalar
        let rivk_arr: [u8; 32] = rivk.try_into().unwrap();
        assert!(bool::from(pasta_curves::pallas::Scalar::from_repr(rivk_arr).is_some()));
    }

    // ══════════════════════════════════════════════════════════════════════
    // 7. Response Shape & Address Consistency
    // ══════════════════════════════════════════════════════════════════════

    /// Response address matches the address derived from the internal FVK.
    #[test]
    fn test_handle_set_fvk_response_address_matches_state() {
        let (mut state, _dir) = test_state();
        let fvk = derive_test_fvk(0x42, 0);
        let b = fvk.to_bytes();

        let response = call_set_fvk(&mut state, &b[..32], &b[32..64], &b[64..96]).unwrap();

        let state_fvk = state.fvk.as_ref().unwrap();
        let addr = state_fvk.address_at(0u32, orchard::keys::Scope::External);
        let ua = encode_unified_address(&addr).unwrap();
        assert_eq!(response["address"].as_str().unwrap(), ua);
    }

    /// Canonical FVK produces same address as original.
    #[test]
    fn test_canonical_fvk_produces_same_address() {
        let fvk = derive_test_fvk(0x42, 0);
        let original_addr = fvk.address_at(0u32, orchard::keys::Scope::External);

        let mut bytes = fvk.to_bytes();
        bytes[31] |= 0x80;
        bytes[31] &= 0x7f; // roundtrip through set/clear = same bytes
        let recovered = FullViewingKey::from_bytes(&bytes).expect("should decode");
        let recovered_addr = recovered.address_at(0u32, orchard::keys::Scope::External);

        assert_eq!(
            original_addr.to_raw_address_bytes(),
            recovered_addr.to_raw_address_bytes(),
        );
    }

    /// Reference FVK output for firmware comparison.
    #[test]
    fn test_reference_fvk_output() {
        let fvk = derive_test_fvk(0x42, 0);
        let bytes = fvk.to_bytes();
        assert_eq!(bytes[31] & 0x80, 0);
        assert_ne!(&bytes[..32], &[0u8; 32], "ak must not be zero");
        assert_ne!(&bytes[32..64], &[0u8; 32], "nk must not be zero");
        assert_ne!(&bytes[64..96], &[0u8; 32], "rivk must not be zero");
    }

    // ══════════════════════════════════════════════════════════════════════
    // 8. DB Edge Cases
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_db_fvk_overwrite() {
        let fvk0 = derive_test_fvk(0x42, 0);
        let fvk1 = derive_test_fvk(0x42, 1);
        let (db, _dir) = test_db();

        db.save_fvk(&fvk0.to_bytes()).unwrap();
        assert!(db.fvk_matches(&fvk0.to_bytes()).unwrap());
        assert!(!db.fvk_matches(&fvk1.to_bytes()).unwrap());

        db.save_fvk(&fvk1.to_bytes()).unwrap();
        assert!(!db.fvk_matches(&fvk0.to_bytes()).unwrap());
        assert!(db.fvk_matches(&fvk1.to_bytes()).unwrap());
    }

    #[test]
    fn test_db_reset_clears_fvk() {
        let fvk = derive_test_fvk(0x42, 0);
        let (db, _dir) = test_db();

        db.save_fvk(&fvk.to_bytes()).unwrap();
        assert!(db.load_fvk().unwrap().is_some());

        db.reset().unwrap();
        assert!(db.load_fvk().unwrap().is_none());
    }
}
