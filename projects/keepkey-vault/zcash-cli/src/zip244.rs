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
#[allow(dead_code)]
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
#[allow(dead_code)]
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

    fn hex_to_array(s: &str) -> [u8; 32] {
        let bytes = hex::decode(s).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        arr
    }
}
