//! Orchard PCZT construction and finalization for hardware wallet signing.
//!
//! Adapted from v10 orchard_send.rs — instead of streaming to device directly,
//! this module outputs a JSON signing request that Electrobun forwards to the
//! KeepKey device, then accepts signatures back for finalization.
//!
//! The sidecar NEVER opens the device — it only does crypto/proving.

use anyhow::{Result, Context};
use log::info;
use rand::rngs::OsRng;
use serde::Serialize;

use orchard::{
    builder::{Builder, BundleType},
    circuit::ProvingKey,
    keys::{FullViewingKey, Scope},
    note::{ExtractedNoteCommitment, RandomSeed, Rho},
    tree::MerkleHashOrchard,
    value::NoteValue,
    Note, Address, Anchor,
};
use orchard::primitives::redpallas::{self, SpendAuth};
use ff::PrimeField;
use incrementalmerkletree::{Marking, Retention};
use shardtree::{store::memory::MemoryShardStore, ShardTree};

use crate::wallet_db::SpendableNote;
use crate::zip244;

const NU5_BRANCH_ID: u32 = 0x37519621;
const DEFAULT_FEE: u64 = 10000; // 0.0001 ZEC

/// Per-action fields needed by the device for signing + digest verification.
#[derive(Debug, Clone, Serialize)]
pub struct ActionFields {
    pub index: u32,
    #[serde(with = "hex_bytes")]
    pub alpha: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub cv_net: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub nullifier: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub cmx: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub epk: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub enc_compact: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub enc_memo: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub enc_noncompact: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub rk: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub out_ciphertext: Vec<u8>,
    pub value: u64,
    pub is_spend: bool,
}

/// The signing request sent to Electrobun, which forwards fields to the device.
#[derive(Debug, Serialize)]
pub struct SigningRequest {
    pub n_actions: u32,
    pub digests: DigestFields,
    pub bundle_meta: BundleMeta,
    pub actions: Vec<ActionFields>,
    pub display: DisplayInfo,
}

#[derive(Debug, Serialize)]
pub struct DigestFields {
    #[serde(with = "hex_bytes")]
    pub header: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub transparent: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub sapling: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub orchard: Vec<u8>,
}

#[derive(Debug, Serialize)]
pub struct BundleMeta {
    pub flags: u32,
    pub value_balance: i64,
    #[serde(with = "hex_bytes")]
    pub anchor: Vec<u8>,
}

#[derive(Debug, Serialize)]
pub struct DisplayInfo {
    pub amount: String,
    pub fee: String,
    pub to: String,
}

/// Hex-encoded bytes serializer for serde
mod hex_bytes {
    use serde::Serializer;
    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }
}

/// Intermediate state between build_pczt and finalize — holds the PCZT bundle
/// and metadata needed to apply signatures.
pub struct PcztState {
    pub pczt_bundle: orchard::pczt::Bundle,
    pub sighash: [u8; 32],
    pub signing_request: SigningRequest,
}

/// Build a PCZT and extract the signing request.
///
/// Returns a PcztState that can be finalized with device signatures.
pub fn build_pczt(
    fvk: &FullViewingKey,
    notes: Vec<SpendableNote>,
    recipient: Address,
    amount: u64,
    account: u32,
) -> Result<PcztState> {
    let mut rng = OsRng;
    let fee = DEFAULT_FEE;
    let total_input: u64 = notes.iter().map(|n| n.value).sum();
    let change = total_input.checked_sub(amount + fee)
        .ok_or_else(|| anyhow::anyhow!(
            "Insufficient funds: have {} ZAT, need {} ZAT (amount {} + fee {})",
            total_input, amount + fee, amount, fee
        ))?;

    info!("Building Orchard transaction:");
    info!("  Inputs:  {} ZAT from {} notes", total_input, notes.len());
    info!("  Amount:  {} ZAT", amount);
    info!("  Fee:     {} ZAT", fee);
    info!("  Change:  {} ZAT", change);

    // Step 1: Reconstruct notes and build Merkle tree
    let mut orchard_notes: Vec<Note> = Vec::new();
    let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
        ShardTree::new(MemoryShardStore::empty(), 100);

    for (i, spendable) in notes.iter().enumerate() {
        let recipient_arr: [u8; 43] = spendable.recipient.clone().try_into()
            .map_err(|_| anyhow::anyhow!("Invalid recipient bytes for note {}", i))?;
        let note_recipient = Address::from_raw_address_bytes(&recipient_arr)
            .into_option()
            .ok_or_else(|| anyhow::anyhow!("Invalid Orchard address for note {}", i))?;

        let rho = Rho::from_bytes(&spendable.rho)
            .into_option()
            .ok_or_else(|| anyhow::anyhow!("Invalid rho for note {}", i))?;

        let rseed = RandomSeed::from_bytes(spendable.rseed, &rho)
            .into_option()
            .ok_or_else(|| anyhow::anyhow!("Invalid rseed for note {}", i))?;

        let note = Note::from_parts(
            note_recipient,
            NoteValue::from_raw(spendable.value),
            rho,
            rseed,
        ).into_option()
            .ok_or_else(|| anyhow::anyhow!("Failed to reconstruct note {}", i))?;

        let cmx: ExtractedNoteCommitment = note.commitment().into();
        let leaf = MerkleHashOrchard::from_cmx(&cmx);
        tree.append(
            leaf,
            Retention::Checkpoint {
                id: i as u32,
                marking: Marking::Marked,
            },
        ).context("Failed to append to Merkle tree")?;

        orchard_notes.push(note);
    }

    let last_checkpoint = (notes.len() - 1) as u32;
    let root = tree.root_at_checkpoint_id(&last_checkpoint)
        .context("Failed to get Merkle root")?
        .ok_or_else(|| anyhow::anyhow!("Empty Merkle tree"))?;
    let anchor: Anchor = root.into();

    // Step 2: Build PCZT bundle
    let mut builder = Builder::new(BundleType::DEFAULT, anchor);

    for (i, note) in orchard_notes.iter().enumerate() {
        let position = incrementalmerkletree::Position::from(i as u64);
        let merkle_path = tree.witness_at_checkpoint_id(position, &last_checkpoint)
            .context("Failed to get Merkle witness")?
            .ok_or_else(|| anyhow::anyhow!("No witness for note {}", i))?;

        builder.add_spend(fvk.clone(), note.clone(), merkle_path.into())
            .map_err(|e| anyhow::anyhow!("Failed to add spend {}: {:?}", i, e))?;
    }

    let ovk = fvk.to_ovk(Scope::External);
    builder.add_output(Some(ovk.clone()), recipient, NoteValue::from_raw(amount), [0u8; 512])
        .map_err(|e| anyhow::anyhow!("Failed to add output: {:?}", e))?;

    if change > 0 {
        let change_addr = fvk.address_at(0u32, Scope::Internal);
        let internal_ovk = fvk.to_ovk(Scope::Internal);
        builder.add_output(Some(internal_ovk), change_addr, NoteValue::from_raw(change), [0u8; 512])
            .map_err(|e| anyhow::anyhow!("Failed to add change output: {:?}", e))?;
    }

    let (mut pczt_bundle, _) = builder.build_for_pczt(&mut rng)
        .map_err(|e| anyhow::anyhow!("Failed to build PCZT: {:?}", e))?;

    // Step 3: Compute ZIP-244 digests
    let effects_bundle = pczt_bundle.extract_effects::<i64>()
        .map_err(|e| anyhow::anyhow!("Failed to extract effects: {:?}", e))?
        .ok_or_else(|| anyhow::anyhow!("Empty effects bundle"))?;

    let digests = zip244::compute_zip244_digests_effects(&effects_bundle, NU5_BRANCH_ID, 0, 0);
    let sighash = zip244::compute_sighash(&digests, NU5_BRANCH_ID);

    // Step 4: Finalize IO
    pczt_bundle.finalize_io(sighash, &mut rng)
        .map_err(|e| anyhow::anyhow!("IO finalization failed: {:?}", e))?;

    // Step 5: Generate Halo2 proof
    info!("Generating Halo2 proof (this may take a while on first run)...");
    let pk = ProvingKey::build();
    pczt_bundle.create_proof(&pk, &mut rng)
        .map_err(|e| anyhow::anyhow!("Proof generation failed: {:?}", e))?;
    info!("Proof generated successfully");

    // Step 6: Extract signing fields
    let n_actions = pczt_bundle.actions().len();
    let mut action_fields: Vec<ActionFields> = Vec::new();

    for i in 0..n_actions {
        let alpha_bytes = pczt_bundle.actions()[i].spend().alpha()
            .map(|a| a.to_repr().to_vec())
            .unwrap_or_else(|| vec![0u8; 32]);

        let cv_net_bytes = pczt_bundle.actions()[i].cv_net().to_bytes().to_vec();
        let is_spend = pczt_bundle.actions()[i].spend().value().is_some();
        let value = pczt_bundle.actions()[i].spend().value()
            .map(|v| v.inner())
            .unwrap_or(0);

        let effects_action = &effects_bundle.actions()[i];
        let nullifier_bytes = effects_action.nullifier().to_bytes().to_vec();
        let cmx_bytes = effects_action.cmx().to_bytes().to_vec();
        let epk_bytes = effects_action.encrypted_note().epk_bytes.as_ref().to_vec();
        let enc = &effects_action.encrypted_note().enc_ciphertext;
        let enc_compact = enc[..52].to_vec();
        let enc_memo = enc[52..564].to_vec();
        let enc_noncompact = enc[564..].to_vec();
        let rk_bytes: [u8; 32] = effects_action.rk().into();
        let out_ciphertext = effects_action.encrypted_note().out_ciphertext.to_vec();

        action_fields.push(ActionFields {
            index: i as u32,
            alpha: alpha_bytes,
            cv_net: cv_net_bytes,
            nullifier: nullifier_bytes,
            cmx: cmx_bytes,
            epk: epk_bytes,
            enc_compact,
            enc_memo,
            enc_noncompact,
            rk: rk_bytes.to_vec(),
            out_ciphertext,
            value,
            is_spend,
        });
    }

    let orchard_flags = effects_bundle.flags().to_byte() as u32;
    let orchard_value_balance: i64 = *effects_bundle.value_balance();
    let orchard_anchor_bytes = effects_bundle.anchor().to_bytes();

    let signing_request = SigningRequest {
        n_actions: n_actions as u32,
        digests: DigestFields {
            header: digests.header_digest.to_vec(),
            transparent: digests.transparent_digest.to_vec(),
            sapling: digests.sapling_digest.to_vec(),
            orchard: digests.orchard_digest.to_vec(),
        },
        bundle_meta: BundleMeta {
            flags: orchard_flags,
            value_balance: orchard_value_balance,
            anchor: orchard_anchor_bytes.to_vec(),
        },
        actions: action_fields,
        display: DisplayInfo {
            amount: format!("{:.8} ZEC", amount as f64 / 1e8),
            fee: format!("{:.8} ZEC", fee as f64 / 1e8),
            to: format!("(account {})", account),
        },
    };

    Ok(PcztState {
        pczt_bundle,
        sighash,
        signing_request,
    })
}

/// Apply device signatures to the PCZT and produce the final v5 transaction bytes.
pub fn finalize_pczt(
    mut pczt_bundle: orchard::pczt::Bundle,
    sighash: [u8; 32],
    signatures: &[Vec<u8>],
) -> Result<(Vec<u8>, String)> {
    let mut rng = OsRng;

    info!("Applying {} signatures...", signatures.len());

    for (i, sig_bytes) in signatures.iter().enumerate() {
        if sig_bytes.len() != 64 {
            return Err(anyhow::anyhow!(
                "Invalid signature length for action {}: expected 64, got {}",
                i, sig_bytes.len()
            ));
        }

        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(sig_bytes);

        let signature: redpallas::Signature<SpendAuth> = sig_arr.into();

        pczt_bundle.actions_mut()[i]
            .apply_signature(sighash, signature)
            .map_err(|e| anyhow::anyhow!("Failed to apply signature for action {}: {}", i, e))?;
    }

    // Extract final bundle
    let unbound_bundle = pczt_bundle.extract::<i64>()
        .map_err(|e| anyhow::anyhow!("Failed to extract bundle: {}", e))?
        .ok_or_else(|| anyhow::anyhow!("Empty bundle after extraction"))?;

    // Apply binding signature
    let authorized_bundle = unbound_bundle.apply_binding_signature(sighash, &mut rng)
        .ok_or_else(|| anyhow::anyhow!("Binding signature verification failed"))?;

    // Serialize as v5 transaction
    let tx_bytes = serialize_v5_shielded_tx(&authorized_bundle)?;

    // Compute txid (double SHA256 of tx bytes, reversed)
    use blake2b_simd::Params;
    let txid_hash = Params::new()
        .hash_length(32)
        .personal(b"ZcashTxHash_\x21\x96\x51\x37") // NU5 branch
        .hash(&tx_bytes);
    let txid = hex::encode(txid_hash.as_bytes());

    info!("Transaction built: {} bytes, txid: {}", tx_bytes.len(), txid);
    Ok((tx_bytes, txid))
}

/// Serialize an authorized Orchard bundle as a v5 Zcash transaction.
fn serialize_v5_shielded_tx(
    bundle: &orchard::Bundle<orchard::bundle::Authorized, i64>,
) -> Result<Vec<u8>> {
    let mut tx = Vec::new();

    // Header (v5)
    let version: u32 = 5 | (1 << 31);
    tx.extend_from_slice(&version.to_le_bytes());

    // version_group_id for v5
    tx.extend_from_slice(&0x26A7270Au32.to_le_bytes());

    // consensus_branch_id (NU5)
    tx.extend_from_slice(&NU5_BRANCH_ID.to_le_bytes());

    // lock_time
    tx.extend_from_slice(&0u32.to_le_bytes());

    // expiry_height
    tx.extend_from_slice(&0u32.to_le_bytes());

    // Transparent inputs (varint 0)
    tx.push(0x00);
    // Transparent outputs (varint 0)
    tx.push(0x00);

    // Sapling spends (varint 0)
    tx.push(0x00);
    // Sapling outputs (varint 0)
    tx.push(0x00);

    // Orchard bundle
    let n_actions = bundle.actions().len();
    write_compact_size(&mut tx, n_actions as u64);

    for action in bundle.actions() {
        tx.extend_from_slice(&action.cv_net().to_bytes());
        tx.extend_from_slice(&action.nullifier().to_bytes());
        tx.extend_from_slice(&<[u8; 32]>::from(action.rk()));
        tx.extend_from_slice(&action.cmx().to_bytes());
        tx.extend_from_slice(action.encrypted_note().epk_bytes.as_ref());
        tx.extend_from_slice(&action.encrypted_note().enc_ciphertext);
        tx.extend_from_slice(&action.encrypted_note().out_ciphertext);
    }

    // Orchard flags
    tx.push(bundle.flags().to_byte());

    // valueBalanceOrchard (i64, 8 bytes LE)
    tx.extend_from_slice(&bundle.value_balance().to_le_bytes());

    // anchor (32 bytes)
    tx.extend_from_slice(&bundle.anchor().to_bytes());

    // proof length + proof bytes
    let proof_bytes = bundle.authorization().proof().as_ref();
    write_compact_size(&mut tx, proof_bytes.len() as u64);
    tx.extend_from_slice(proof_bytes);

    // spend_auth_sig for each action
    for action in bundle.actions() {
        let sig_bytes: [u8; 64] = action.authorization().into();
        tx.extend_from_slice(&sig_bytes);
    }

    // binding_sig
    let binding_sig_bytes: [u8; 64] = bundle.authorization().binding_signature().into();
    tx.extend_from_slice(&binding_sig_bytes);

    Ok(tx)
}

fn write_compact_size(buf: &mut Vec<u8>, n: u64) {
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
