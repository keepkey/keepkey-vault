//! ZIP-244 Transaction Identifier and Signature Digest computation.
//!
//! Implements the full BLAKE2b-256 digest tree for Zcash v5 transactions
//! as specified in ZIP-244. Used to compute sub-digests that the device
//! combines into the final sighash for on-device spend authorization.

use blake2b_simd::Params;

/// NU5 consensus branch ID (used in tests)
#[allow(dead_code)]
pub const NU5_BRANCH_ID: u32 = 0x37519621;

/// v5 transaction version (with overwintered flag)
const TX_VERSION: u32 = 5 | (1 << 31);

/// v5 version group ID
const VERSION_GROUP_ID: u32 = 0x26A7270A;

/// Precomputed BLAKE2b-256("ZTxIdTranspaHash", "") for shielded-only txs
pub const EMPTY_TRANSPARENT_DIGEST: [u8; 32] = [
    0xc3, 0x3f, 0x2e, 0x95, 0x70, 0x5f, 0xaa, 0xb3,
    0x5f, 0x8d, 0x53, 0x3f, 0xa6, 0x1e, 0x95, 0xc3,
    0xb7, 0xaa, 0xba, 0x07, 0x76, 0xb8, 0x74, 0xa9,
    0xf7, 0x4f, 0xc1, 0x27, 0x84, 0x37, 0x6a, 0x59,
];

/// Precomputed BLAKE2b-256("ZTxIdSaplingHash", "") for Orchard-only txs
pub const EMPTY_SAPLING_DIGEST: [u8; 32] = [
    0x6f, 0x2f, 0xc8, 0xf9, 0x8f, 0xea, 0xfd, 0x94,
    0xe7, 0x4a, 0x0d, 0xf4, 0xbe, 0xd7, 0x43, 0x91,
    0xee, 0x0b, 0x5a, 0x69, 0x94, 0x5e, 0x4c, 0xed,
    0x8c, 0xa8, 0xa0, 0x95, 0x20, 0x6f, 0x00, 0xae,
];

/// All ZIP-244 sub-digests needed for sighash computation.
#[derive(Debug, Clone)]
pub struct Zip244Digests {
    pub header_digest: [u8; 32],
    pub transparent_digest: [u8; 32],
    pub sapling_digest: [u8; 32],
    pub orchard_digest: [u8; 32],
}

/// BLAKE2b-256 with a 16-byte personalization string.
fn blake2b_256(personal: &[u8; 16], data: &[u8]) -> [u8; 32] {
    let hash = Params::new()
        .hash_length(32)
        .personal(personal)
        .hash(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(hash.as_bytes());
    out
}

/// Compute the ZIP-244 header digest.
pub fn digest_header(
    branch_id: u32,
    lock_time: u32,
    expiry_height: u32,
) -> [u8; 32] {
    let mut data = Vec::with_capacity(20);
    data.extend_from_slice(&TX_VERSION.to_le_bytes());
    data.extend_from_slice(&VERSION_GROUP_ID.to_le_bytes());
    data.extend_from_slice(&branch_id.to_le_bytes());
    data.extend_from_slice(&lock_time.to_le_bytes());
    data.extend_from_slice(&expiry_height.to_le_bytes());
    blake2b_256(b"ZTxIdHeadersHash", &data)
}

/// Compute the ZIP-244 orchard digest from an authorized Orchard bundle.
pub fn digest_orchard(bundle: &orchard::Bundle<orchard::bundle::Authorized, i64>) -> [u8; 32] {
    let (compact_hash, memos_hash, noncompact_hash) =
        compute_orchard_action_hashes(bundle);

    let mut data = Vec::with_capacity(32 * 3 + 1 + 8 + 32);
    data.extend_from_slice(&compact_hash);
    data.extend_from_slice(&memos_hash);
    data.extend_from_slice(&noncompact_hash);
    data.push(bundle.flags().to_byte());
    data.extend_from_slice(&bundle.value_balance().to_le_bytes());
    data.extend_from_slice(&bundle.anchor().to_bytes());

    blake2b_256(b"ZTxIdOrchardHash", &data)
}

/// Compute the three orchard action sub-hashes (compact, memos, noncompact).
fn compute_orchard_action_hashes(
    bundle: &orchard::Bundle<orchard::bundle::Authorized, i64>,
) -> ([u8; 32], [u8; 32], [u8; 32]) {
    let mut compact_data = Vec::new();
    let mut memos_data = Vec::new();
    let mut noncompact_data = Vec::new();

    for action in bundle.actions() {
        // Compact: nf(32) || cmx(32) || epk(32) || enc[0..52]
        compact_data.extend_from_slice(&action.nullifier().to_bytes());
        compact_data.extend_from_slice(&action.cmx().to_bytes());
        compact_data.extend_from_slice(action.encrypted_note().epk_bytes.as_ref());
        compact_data.extend_from_slice(&action.encrypted_note().enc_ciphertext[..52]);

        // Memos: enc[52..564]
        memos_data.extend_from_slice(&action.encrypted_note().enc_ciphertext[52..564]);

        // Noncompact: cv_net(32) || rk(32) || enc[564..](16) || out_ciphertext(80)
        noncompact_data.extend_from_slice(&action.cv_net().to_bytes());
        noncompact_data.extend_from_slice(&<[u8; 32]>::from(action.rk()));
        noncompact_data.extend_from_slice(&action.encrypted_note().enc_ciphertext[564..]);
        noncompact_data.extend_from_slice(&action.encrypted_note().out_ciphertext);
    }

    let compact_hash = blake2b_256(b"ZTxIdOrcActCHash", &compact_data);
    let memos_hash = blake2b_256(b"ZTxIdOrcActMHash", &memos_data);
    let noncompact_hash = blake2b_256(b"ZTxIdOrcActNHash", &noncompact_data);

    (compact_hash, memos_hash, noncompact_hash)
}

/// Compute the orchard digest from an EffectsOnly bundle (before finalization).
pub fn digest_orchard_effects<V>(
    bundle: &orchard::Bundle<orchard::bundle::EffectsOnly, V>,
) -> [u8; 32]
where
    V: Copy + Into<i64>,
{
    let mut compact_data = Vec::new();
    let mut memos_data = Vec::new();
    let mut noncompact_data = Vec::new();

    for action in bundle.actions() {
        compact_data.extend_from_slice(&action.nullifier().to_bytes());
        compact_data.extend_from_slice(&action.cmx().to_bytes());
        compact_data.extend_from_slice(action.encrypted_note().epk_bytes.as_ref());
        compact_data.extend_from_slice(&action.encrypted_note().enc_ciphertext[..52]);

        memos_data.extend_from_slice(&action.encrypted_note().enc_ciphertext[52..564]);

        noncompact_data.extend_from_slice(&action.cv_net().to_bytes());
        noncompact_data.extend_from_slice(&<[u8; 32]>::from(action.rk()));
        noncompact_data.extend_from_slice(&action.encrypted_note().enc_ciphertext[564..]);
        noncompact_data.extend_from_slice(&action.encrypted_note().out_ciphertext);
    }

    let compact_hash = blake2b_256(b"ZTxIdOrcActCHash", &compact_data);
    let memos_hash = blake2b_256(b"ZTxIdOrcActMHash", &memos_data);
    let noncompact_hash = blake2b_256(b"ZTxIdOrcActNHash", &noncompact_data);

    let mut orchard_data = Vec::with_capacity(32 * 3 + 1 + 8 + 32);
    orchard_data.extend_from_slice(&compact_hash);
    orchard_data.extend_from_slice(&memos_hash);
    orchard_data.extend_from_slice(&noncompact_hash);
    orchard_data.push(bundle.flags().to_byte());
    orchard_data.extend_from_slice(&(*bundle.value_balance()).into().to_le_bytes());
    orchard_data.extend_from_slice(&bundle.anchor().to_bytes());

    blake2b_256(b"ZTxIdOrchardHash", &orchard_data)
}

/// Compute ZIP-244 digests from an EffectsOnly bundle (before finalization).
pub fn compute_zip244_digests_effects<V>(
    bundle: &orchard::Bundle<orchard::bundle::EffectsOnly, V>,
    branch_id: u32,
    lock_time: u32,
    expiry_height: u32,
) -> Zip244Digests
where
    V: Copy + Into<i64>,
{
    Zip244Digests {
        header_digest: digest_header(branch_id, lock_time, expiry_height),
        transparent_digest: EMPTY_TRANSPARENT_DIGEST,
        sapling_digest: EMPTY_SAPLING_DIGEST,
        orchard_digest: digest_orchard_effects(bundle),
    }
}

// ── Transparent digest computation (ZIP-244 §4.5-4.10) ────────────────

/// Transparent input for ZIP-244 digest computation.
#[derive(Debug, Clone)]
pub struct TransparentInput {
    pub prevout_hash: [u8; 32],   // txid (internal byte order)
    pub prevout_index: u32,
    pub script_pubkey: Vec<u8>,   // for the UTXO being spent
    pub value: u64,               // zatoshis
    pub sequence: u32,            // typically 0xFFFFFFFF
}

/// Transparent output for ZIP-244 digest computation.
#[derive(Debug, Clone)]
pub struct TransparentOutput {
    pub value: u64,
    pub script_pubkey: Vec<u8>,
}

/// BLAKE2b-256("ZTxIdPrevoutHash", concat(prevout_hash || prevout_index))
pub fn digest_transparent_prevouts(inputs: &[TransparentInput]) -> [u8; 32] {
    let mut data = Vec::new();
    for input in inputs {
        data.extend_from_slice(&input.prevout_hash);
        data.extend_from_slice(&input.prevout_index.to_le_bytes());
    }
    blake2b_256(b"ZTxIdPrevoutHash", &data)
}

/// BLAKE2b-256("ZTxIdAmountsHash", concat(value_i64_LE))
pub fn digest_transparent_amounts(inputs: &[TransparentInput]) -> [u8; 32] {
    let mut data = Vec::new();
    for input in inputs {
        // ZIP-244 specifies amounts as i64 LE
        data.extend_from_slice(&(input.value as i64).to_le_bytes());
    }
    blake2b_256(b"ZTxTrAmountsHash", &data)
}

/// BLAKE2b-256("ZTxIdScriptsHash", concat(compact_size || script_pubkey))
pub fn digest_transparent_scripts(inputs: &[TransparentInput]) -> [u8; 32] {
    let mut data = Vec::new();
    for input in inputs {
        write_compact_size_to(&mut data, input.script_pubkey.len() as u64);
        data.extend_from_slice(&input.script_pubkey);
    }
    blake2b_256(b"ZTxTrScriptsHash", &data)
}

/// BLAKE2b-256("ZTxIdSequencHash", concat(sequence))
pub fn digest_transparent_sequence(inputs: &[TransparentInput]) -> [u8; 32] {
    let mut data = Vec::new();
    for input in inputs {
        data.extend_from_slice(&input.sequence.to_le_bytes());
    }
    blake2b_256(b"ZTxIdSequencHash", &data)
}

/// BLAKE2b-256("ZTxIdOutputsHash", concat(value || compact_size || script_pubkey))
pub fn digest_transparent_outputs(outputs: &[TransparentOutput]) -> [u8; 32] {
    let mut data = Vec::new();
    for output in outputs {
        data.extend_from_slice(&(output.value as i64).to_le_bytes());
        write_compact_size_to(&mut data, output.script_pubkey.len() as u64);
        data.extend_from_slice(&output.script_pubkey);
    }
    blake2b_256(b"ZTxIdOutputsHash", &data)
}

/// Compute the full transparent digest for txid computation (ZIP-244 §4.5).
/// This is the NON-sig version: prevouts || amounts || scripts || sequences || outputs.
/// No hash_type byte, no txin_sig_digest. Used in the txid (NOT in sighash).
pub fn digest_transparent_txid(inputs: &[TransparentInput], outputs: &[TransparentOutput]) -> [u8; 32] {
    if inputs.is_empty() && outputs.is_empty() {
        return EMPTY_TRANSPARENT_DIGEST;
    }

    let prevouts = digest_transparent_prevouts(inputs);
    let amounts = digest_transparent_amounts(inputs);
    let scripts = digest_transparent_scripts(inputs);
    let sequences = digest_transparent_sequence(inputs);
    let outputs_hash = digest_transparent_outputs(outputs);

    // ZIP-244 §4.5: txid transparent_digest has NO hash_type byte
    let mut data = Vec::with_capacity(32 * 5);
    data.extend_from_slice(&prevouts);
    data.extend_from_slice(&amounts);
    data.extend_from_slice(&scripts);
    data.extend_from_slice(&sequences);
    data.extend_from_slice(&outputs_hash);

    blake2b_256(b"ZTxIdTranspaHash", &data)
}

/// Compute the per-input transparent sighash for SIGHASH_ALL (ZIP-244 §4.10).
///
/// This is the value each transparent input needs the device to ECDSA-sign.
pub fn compute_transparent_sig_hash(
    input_index: usize,
    inputs: &[TransparentInput],
    outputs: &[TransparentOutput],
    orchard_digest: &[u8; 32],
    header_digest: &[u8; 32],
    sapling_digest: &[u8; 32],
    branch_id: u32,
) -> [u8; 32] {
    let hash_type: u8 = 0x01; // SIGHASH_ALL

    // Transparent digests (shared across inputs)
    let prevouts = digest_transparent_prevouts(inputs);
    let amounts = digest_transparent_amounts(inputs);
    let scripts = digest_transparent_scripts(inputs);
    let sequences = digest_transparent_sequence(inputs);
    let outputs_hash = digest_transparent_outputs(outputs);

    // Per-input data
    let input = &inputs[input_index];

    let mut personal = [0u8; 16];
    personal[..12].copy_from_slice(b"ZcashTxHash_");
    personal[12..16].copy_from_slice(&branch_id.to_le_bytes());

    // ZIP-244 §4.10: Per-input data is hashed separately into txin_sig_digest
    let mut per_input_data = Vec::new();
    per_input_data.extend_from_slice(&input.prevout_hash);
    per_input_data.extend_from_slice(&input.prevout_index.to_le_bytes());
    per_input_data.extend_from_slice(&(input.value as i64).to_le_bytes());
    write_compact_size_to(&mut per_input_data, input.script_pubkey.len() as u64);
    per_input_data.extend_from_slice(&input.script_pubkey);
    per_input_data.extend_from_slice(&input.sequence.to_le_bytes());

    let txin_sig_digest = blake2b_256(b"Zcash___TxInHash", &per_input_data);

    // transparent_sig_digest = BLAKE2b("ZTxIdTranspaHash",
    //   hash_type || prevouts || amounts || scripts || sequences || outputs || txin_sig_digest)
    let mut transparent_sig_data = Vec::new();
    transparent_sig_data.push(hash_type);
    transparent_sig_data.extend_from_slice(&prevouts);
    transparent_sig_data.extend_from_slice(&amounts);
    transparent_sig_data.extend_from_slice(&scripts);
    transparent_sig_data.extend_from_slice(&sequences);
    transparent_sig_data.extend_from_slice(&outputs_hash);
    transparent_sig_data.extend_from_slice(&txin_sig_digest);

    let transparent_sig_digest = blake2b_256(b"ZTxIdTranspaHash", &transparent_sig_data);

    // Final sighash = BLAKE2b(personal, header || transparent_sig || sapling || orchard)
    let mut sighash_data = Vec::with_capacity(128);
    sighash_data.extend_from_slice(header_digest);
    sighash_data.extend_from_slice(&transparent_sig_digest);
    sighash_data.extend_from_slice(sapling_digest);
    sighash_data.extend_from_slice(orchard_digest);

    blake2b_256(&personal, &sighash_data)
}

/// Compute the transparent_sig_digest for Orchard spend authorization (ZIP-244 §4.7).
///
/// For Orchard spend auth in hybrid (transparent + Orchard) transactions, the sighash
/// uses transparent_sig_digest — NOT the txid transparent_digest. Per ZIP-244 §4.6-4.7,
/// the signature digest includes hash_type (SIGHASH_ALL = 0x01) and an empty
/// txin_sig_digest, both absent from the txid transparent_digest.
///
/// When there are no transparent inputs/outputs, transparent_sig_digest equals the
/// txid transparent_digest (both are the hash of empty data).
pub fn digest_transparent_sig_for_orchard(
    inputs: &[TransparentInput],
    outputs: &[TransparentOutput],
) -> [u8; 32] {
    if inputs.is_empty() && outputs.is_empty() {
        return EMPTY_TRANSPARENT_DIGEST;
    }

    let hash_type: u8 = 0x01; // SIGHASH_ALL (ZIP-244 convention for Orchard)

    let prevouts = digest_transparent_prevouts(inputs);
    let amounts = digest_transparent_amounts(inputs);
    let scripts = digest_transparent_scripts(inputs);
    let sequences = digest_transparent_sequence(inputs);
    let outputs_hash = digest_transparent_outputs(outputs);

    // Empty txin_sig_digest: no specific transparent input being signed (ZIP-244 §4.10)
    let txin_sig_digest = blake2b_256(b"Zcash___TxInHash", &[]);

    let mut data = Vec::new();
    data.push(hash_type);
    data.extend_from_slice(&prevouts);
    data.extend_from_slice(&amounts);
    data.extend_from_slice(&scripts);
    data.extend_from_slice(&sequences);
    data.extend_from_slice(&outputs_hash);
    data.extend_from_slice(&txin_sig_digest);

    blake2b_256(b"ZTxIdTranspaHash", &data)
}

/// Compute ZIP-244 digests for a hybrid (transparent + Orchard) transaction.
///
/// The transparent_digest field contains the transparent_sig_digest (ZIP-244 §4.7),
/// NOT the txid transparent_digest (§4.5), because it feeds into compute_sighash()
/// which produces the Orchard spend authorization sighash.
pub fn compute_zip244_digests_hybrid<V>(
    bundle: &orchard::Bundle<orchard::bundle::EffectsOnly, V>,
    transparent_inputs: &[TransparentInput],
    transparent_outputs: &[TransparentOutput],
    branch_id: u32,
    lock_time: u32,
    expiry_height: u32,
) -> Zip244Digests
where
    V: Copy + Into<i64>,
{
    Zip244Digests {
        header_digest: digest_header(branch_id, lock_time, expiry_height),
        transparent_digest: digest_transparent_sig_for_orchard(transparent_inputs, transparent_outputs),
        sapling_digest: EMPTY_SAPLING_DIGEST,
        orchard_digest: digest_orchard_effects(bundle),
    }
}

/// Helper: write compact size to a buffer (same as Bitcoin varint).
fn write_compact_size_to(buf: &mut Vec<u8>, n: u64) {
    if n < 253 {
        buf.push(n as u8);
    } else if n <= 0xFFFF {
        buf.push(253);
        buf.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n <= 0xFFFFFFFF {
        buf.push(254);
        buf.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        buf.push(255);
        buf.extend_from_slice(&n.to_le_bytes());
    }
}

/// Compute the final sighash from sub-digests.
pub fn compute_sighash(digests: &Zip244Digests, branch_id: u32) -> [u8; 32] {
    let mut personal = [0u8; 16];
    personal[..12].copy_from_slice(b"ZcashTxHash_");
    personal[12..16].copy_from_slice(&branch_id.to_le_bytes());

    let mut data = Vec::with_capacity(128);
    data.extend_from_slice(&digests.header_digest);
    data.extend_from_slice(&digests.transparent_digest);
    data.extend_from_slice(&digests.sapling_digest);
    data.extend_from_slice(&digests.orchard_digest);

    blake2b_256(&personal, &data)
}

/// Compute orchard digest from raw action data (hex strings).
/// Used by the IPC layer to compute digests from JSON fields.
#[allow(dead_code)]
pub fn digest_orchard_from_raw(
    actions: &[crate::pczt_builder::ActionFields],
    flags: u8,
    value_balance: i64,
    anchor: &[u8; 32],
) -> [u8; 32] {
    let mut compact_data = Vec::new();
    let mut memos_data = Vec::new();
    let mut noncompact_data = Vec::new();

    for action in actions {
        compact_data.extend_from_slice(&action.nullifier);
        compact_data.extend_from_slice(&action.cmx);
        compact_data.extend_from_slice(&action.epk);
        compact_data.extend_from_slice(&action.enc_compact);

        memos_data.extend_from_slice(&action.enc_memo);

        noncompact_data.extend_from_slice(&action.cv_net);
        noncompact_data.extend_from_slice(&action.rk);
        noncompact_data.extend_from_slice(&action.enc_noncompact);
        noncompact_data.extend_from_slice(&action.out_ciphertext);
    }

    let compact_hash = blake2b_256(b"ZTxIdOrcActCHash", &compact_data);
    let memos_hash = blake2b_256(b"ZTxIdOrcActMHash", &memos_data);
    let noncompact_hash = blake2b_256(b"ZTxIdOrcActNHash", &noncompact_data);

    let mut orchard_data = Vec::with_capacity(32 * 3 + 1 + 8 + 32);
    orchard_data.extend_from_slice(&compact_hash);
    orchard_data.extend_from_slice(&memos_hash);
    orchard_data.extend_from_slice(&noncompact_hash);
    orchard_data.push(flags);
    orchard_data.extend_from_slice(&value_balance.to_le_bytes());
    orchard_data.extend_from_slice(anchor);

    blake2b_256(b"ZTxIdOrchardHash", &orchard_data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_transparent_digest() {
        let computed = blake2b_256(b"ZTxIdTranspaHash", &[]);
        assert_eq!(computed, EMPTY_TRANSPARENT_DIGEST);
    }

    #[test]
    fn test_empty_sapling_digest() {
        let computed = blake2b_256(b"ZTxIdSaplingHash", &[]);
        assert_eq!(computed, EMPTY_SAPLING_DIGEST);
        assert_eq!(
            hex::encode(computed),
            "6f2fc8f98feafd94e74a0df4bed74391ee0b5a69945e4ced8ca8a095206f00ae"
        );
    }

    /// Header digest for NU5 with lock_time=0, expiry=0.
    /// This tests our digest_header implementation: BLAKE2b-256("ZTxIdHeadersHash",
    /// TX_VERSION || VERSION_GROUP_ID || branch_id || lock_time || expiry_height).
    #[test]
    fn test_header_digest_nu5_zero() {
        let header = digest_header(NU5_BRANCH_ID, 0, 0);
        // Deterministic: pin to actual computed value for regression detection
        assert_eq!(
            hex::encode(header),
            "dfcd0a6d70786faba06c9ef3057323a3d527c71e074e366cf5fa40f928561de1"
        );
    }

    /// Full sighash from known sub-digests.
    #[test]
    fn test_sighash_from_known_digests() {
        // Use the actual header digest from our implementation
        let header = digest_header(NU5_BRANCH_ID, 0, 0);
        let digests = Zip244Digests {
            header_digest: header,
            transparent_digest: EMPTY_TRANSPARENT_DIGEST,
            sapling_digest: hex_to_array("6f2fc8f98feafd94e74a0df4bed74391ee0b5a69945e4ced8ca8a095206f00ae"),
            orchard_digest: hex_to_array("0ee1912a92e13f43e2511d9c0a12ab26c165391eefc7311e382d752806e6cb8a"),
        };
        let sighash = compute_sighash(&digests, NU5_BRANCH_ID);
        // Deterministic: pin for regression detection
        assert_eq!(
            hex::encode(sighash),
            "de2842f330598b04d5943f21cff20dec95bf064a7dbb5ada343d1251cd6beb2a"
        );
    }

    /// ZIP-244 §4.7: transparent_sig_digest ≠ transparent_digest when inputs exist.
    /// The sig version includes hash_type + empty txin_sig_digest that the txid version omits.
    #[test]
    fn test_transparent_sig_digest_differs_from_txid_digest() {
        let inputs = vec![TransparentInput {
            prevout_hash: [0xAA; 32],
            prevout_index: 0,
            script_pubkey: vec![0x76, 0xa9, 0x14, /* 20 zero bytes */ 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0x88, 0xac],
            value: 100_000,
            sequence: 0xFFFFFFFF,
        }];
        let outputs = vec![TransparentOutput {
            value: 90_000,
            script_pubkey: vec![0x76, 0xa9, 0x14, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0x88, 0xac],
        }];

        let txid_digest = digest_transparent_txid(&inputs, &outputs);
        let sig_digest = digest_transparent_sig_for_orchard(&inputs, &outputs);

        assert_ne!(
            txid_digest, sig_digest,
            "transparent_sig_digest must differ from transparent_digest when inputs exist"
        );
    }

    /// When there are no transparent inputs/outputs, both digests are EMPTY_TRANSPARENT_DIGEST.
    #[test]
    fn test_transparent_sig_digest_equals_txid_for_empty() {
        let sig_digest = digest_transparent_sig_for_orchard(&[], &[]);
        assert_eq!(sig_digest, EMPTY_TRANSPARENT_DIGEST);
    }

    fn hex_to_array(s: &str) -> [u8; 32] {
        let bytes = hex::decode(s).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        arr
    }
}
