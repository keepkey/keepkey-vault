//! ZIP-229 transaction-v6 digest helpers for NU6.3 / Ironwood.
//!
//! Transaction v6 keeps the ZIP-244 transparent and Sapling component
//! digests, adds a distinct Ironwood component, and moves Orchard-family
//! anchors from the txid/sighash commitment into the authorizing-data digest.

use blake2b_simd::Params;
use orchard::bundle::{BundleVersion, TxVersion};

use crate::zip244::{self, TransparentInput, TransparentOutput};

pub const NU6_3_BRANCH_ID: u32 = 0x37A5165B;
pub const NU6_3_ACTIVATION_HEIGHT: u64 = 3_428_143;
pub const TX_VERSION: u32 = 6 | (1 << 31);
pub const VERSION_GROUP_ID: u32 = 0xD884B698;

#[derive(Debug, Clone)]
pub struct Zip229Digests {
    pub header_digest: [u8; 32],
    pub transparent_digest: [u8; 32],
    pub sapling_digest: [u8; 32],
    pub orchard_digest: [u8; 32],
    pub ironwood_digest: [u8; 32],
}

fn blake2b_256(personal: &[u8; 16], data: &[u8]) -> [u8; 32] {
    let hash = Params::new().hash_length(32).personal(personal).hash(data);
    hash.as_bytes().try_into().expect("BLAKE2b-256 output")
}

pub fn digest_header(branch_id: u32, lock_time: u32, expiry_height: u32) -> [u8; 32] {
    let mut data = Vec::with_capacity(20);
    data.extend_from_slice(&TX_VERSION.to_le_bytes());
    data.extend_from_slice(&VERSION_GROUP_ID.to_le_bytes());
    data.extend_from_slice(&branch_id.to_le_bytes());
    data.extend_from_slice(&lock_time.to_le_bytes());
    data.extend_from_slice(&expiry_height.to_le_bytes());
    blake2b_256(b"ZTxIdHeadersHash", &data)
}

pub fn empty_orchard_digest() -> [u8; 32] {
    blake2b_256(b"ZTxIdOrchardH_v6", &[])
}

pub fn empty_ironwood_digest() -> [u8; 32] {
    blake2b_256(b"ZTxIdIronwd_H_v6", &[])
}

pub fn digest_bundle_effects<V>(
    bundle: &orchard::Bundle<orchard::bundle::EffectsOnly, V>,
) -> anyhow::Result<[u8; 32]>
where
    V: Copy + Into<i64>,
{
    if bundle.bundle_version() != BundleVersion::ironwood_v3() {
        return Err(anyhow::anyhow!(
            "ZIP-229 Ironwood slot requires an ironwood_v3 bundle"
        ));
    }
    Ok(bundle
        .commitment(TxVersion::V6)
        .map_err(|e| anyhow::anyhow!("Ironwood commitment failed: {}", e))?
        .into())
}

pub fn digest_bundle_authorized(
    bundle: &orchard::Bundle<orchard::bundle::Authorized, i64>,
) -> anyhow::Result<[u8; 32]> {
    if bundle.bundle_version() != BundleVersion::ironwood_v3() {
        return Err(anyhow::anyhow!(
            "ZIP-229 Ironwood slot requires an ironwood_v3 bundle"
        ));
    }
    Ok(bundle
        .commitment(TxVersion::V6)
        .map_err(|e| anyhow::anyhow!("Ironwood commitment failed: {}", e))?
        .into())
}

pub fn compute_digests_hybrid<V>(
    ironwood_bundle: &orchard::Bundle<orchard::bundle::EffectsOnly, V>,
    transparent_inputs: &[TransparentInput],
    transparent_outputs: &[TransparentOutput],
    branch_id: u32,
    lock_time: u32,
    expiry_height: u32,
) -> anyhow::Result<Zip229Digests>
where
    V: Copy + Into<i64>,
{
    Ok(Zip229Digests {
        header_digest: digest_header(branch_id, lock_time, expiry_height),
        transparent_digest: zip244::digest_transparent_sig_for_orchard(
            transparent_inputs,
            transparent_outputs,
        ),
        sapling_digest: zip244::EMPTY_SAPLING_DIGEST,
        orchard_digest: empty_orchard_digest(),
        ironwood_digest: digest_bundle_effects(ironwood_bundle)?,
    })
}

pub fn compute_sighash(digests: &Zip229Digests, branch_id: u32) -> [u8; 32] {
    let mut personal = [0u8; 16];
    personal[..12].copy_from_slice(b"ZcashTxHash_");
    personal[12..].copy_from_slice(&branch_id.to_le_bytes());

    let mut data = Vec::with_capacity(160);
    data.extend_from_slice(&digests.header_digest);
    data.extend_from_slice(&digests.transparent_digest);
    data.extend_from_slice(&digests.sapling_digest);
    data.extend_from_slice(&digests.orchard_digest);
    data.extend_from_slice(&digests.ironwood_digest);
    blake2b_256(&personal, &data)
}

pub fn compute_transparent_sig_hash(
    input_index: usize,
    inputs: &[TransparentInput],
    outputs: &[TransparentOutput],
    digests: &Zip229Digests,
    branch_id: u32,
) -> [u8; 32] {
    let input = &inputs[input_index];
    let mut per_input_data = Vec::new();
    per_input_data.extend_from_slice(&input.prevout_hash);
    per_input_data.extend_from_slice(&input.prevout_index.to_le_bytes());
    per_input_data.extend_from_slice(&(input.value as i64).to_le_bytes());
    write_compact_size(&mut per_input_data, input.script_pubkey.len() as u64);
    per_input_data.extend_from_slice(&input.script_pubkey);
    per_input_data.extend_from_slice(&input.sequence.to_le_bytes());
    let txin_sig_digest = blake2b_256(b"Zcash___TxInHash", &per_input_data);

    let mut transparent_sig_data = Vec::new();
    transparent_sig_data.push(0x01); // SIGHASH_ALL
    transparent_sig_data.extend_from_slice(&zip244::digest_transparent_prevouts(inputs));
    transparent_sig_data.extend_from_slice(&zip244::digest_transparent_amounts(inputs));
    transparent_sig_data.extend_from_slice(&zip244::digest_transparent_scripts(inputs));
    transparent_sig_data.extend_from_slice(&zip244::digest_transparent_sequence(inputs));
    transparent_sig_data.extend_from_slice(&zip244::digest_transparent_outputs(outputs));
    transparent_sig_data.extend_from_slice(&txin_sig_digest);

    let transparent_digest = blake2b_256(b"ZTxIdTranspaHash", &transparent_sig_data);
    let per_input = Zip229Digests {
        header_digest: digests.header_digest,
        transparent_digest,
        sapling_digest: digests.sapling_digest,
        orchard_digest: digests.orchard_digest,
        ironwood_digest: digests.ironwood_digest,
    };
    compute_sighash(&per_input, branch_id)
}

pub fn compute_txid(
    ironwood_digest: [u8; 32],
    inputs: &[TransparentInput],
    outputs: &[TransparentOutput],
    branch_id: u32,
    lock_time: u32,
    expiry_height: u32,
) -> [u8; 32] {
    compute_sighash(
        &Zip229Digests {
            header_digest: digest_header(branch_id, lock_time, expiry_height),
            transparent_digest: zip244::digest_transparent_txid(inputs, outputs),
            sapling_digest: zip244::EMPTY_SAPLING_DIGEST,
            orchard_digest: empty_orchard_digest(),
            ironwood_digest,
        },
        branch_id,
    )
}

fn write_compact_size(buf: &mut Vec<u8>, n: u64) {
    if n < 253 {
        buf.push(n as u8);
    } else if n <= u16::MAX as u64 {
        buf.push(253);
        buf.extend_from_slice(&(n as u16).to_le_bytes());
    } else if n <= u32::MAX as u64 {
        buf.push(254);
        buf.extend_from_slice(&(n as u32).to_le_bytes());
    } else {
        buf.push(255);
        buf.extend_from_slice(&n.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pool_digests_are_domain_separated() {
        assert_ne!(empty_orchard_digest(), empty_ironwood_digest());
        assert_eq!(
            empty_orchard_digest(),
            blake2b_256(b"ZTxIdOrchardH_v6", &[])
        );
        assert_eq!(
            empty_ironwood_digest(),
            blake2b_256(b"ZTxIdIronwd_H_v6", &[])
        );
    }

    #[test]
    fn v6_header_commits_to_v6_group_id() {
        let digest = digest_header(NU6_3_BRANCH_ID, 0, 0);
        assert_ne!(digest, zip244::digest_header(NU6_3_BRANCH_ID, 0, 0));
    }
}
