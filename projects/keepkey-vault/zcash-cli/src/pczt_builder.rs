//! Orchard PCZT construction and finalization for hardware wallet signing.
//!
//! Adapted from v10 orchard_send.rs — instead of streaming to device directly,
//! this module outputs a JSON signing request that Electrobun forwards to the
//! KeepKey device, then accepts signatures back for finalization.
//!
//! The sidecar NEVER opens the device — it only does crypto/proving.

use anyhow::{Result, Context};
use log::{info, debug};
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

use crate::scanner::LightwalletClient;
use crate::wallet_db::{SpendableNote, WalletDb};
use crate::zip244;

const DEFAULT_FEE: u64 = 10000; // 0.0001 ZEC

/// Per-action fields needed by the device for signing + digest verification.
#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
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
    pub account: u32,
    pub branch_id: u32,
    #[serde(with = "hex_bytes")]
    pub sighash: Vec<u8>,
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
    pub branch_id: u32,
    pub signing_request: SigningRequest,
}

/// Build a PCZT and extract the signing request.
///
/// Returns a PcztState that can be finalized with device signatures.
/// Now async — fetches real chain data to build a valid Merkle tree anchor.
pub async fn build_pczt(
    fvk: &FullViewingKey,
    notes: Vec<SpendableNote>,
    recipient: Address,
    amount: u64,
    account: u32,
    branch_id: u32,
    lwd_client: &mut LightwalletClient,
    db: &WalletDb,
    memo: Option<String>,
) -> Result<PcztState> {
    let mut rng = OsRng;
    let fee = DEFAULT_FEE;
    let total_input: u64 = notes.iter().map(|n| n.value).sum();
    let change = total_input.checked_sub(amount + fee)
        .ok_or_else(|| anyhow::anyhow!(
            "Insufficient funds: have {} ZAT, need {} ZAT (amount {} + fee {})",
            total_input, amount + fee, amount, fee
        ))?;

    let fvk_bytes = fvk.to_bytes();
    let ak_bytes = &fvk_bytes[..32];
    debug!("FVK ak (first 4 bytes): {}", hex::encode(&ak_bytes[..4]));

    info!("Building Orchard transaction:");
    info!("  Inputs:  {} ZAT from {} notes", total_input, notes.len());
    info!("  Amount:  {} ZAT", amount);
    info!("  Fee:     {} ZAT", fee);
    info!("  Change:  {} ZAT", change);

    // Step 1: Compute note positions in the global commitment tree
    // For each note, we need its absolute position:
    //   position = tree_size_at(block_height - 1) + actions_in_block_before_note
    //
    // tree_size_at(h) comes from CompactBlock.chainMetadata.orchardCommitmentTreeSize at height h,
    // which gives the CUMULATIVE tree size AFTER that block's actions are added.
    // So tree_size_at(h-1) is the size BEFORE block h's actions.

    let mut note_positions: Vec<u64> = Vec::new();

    for (i, spendable) in notes.iter().enumerate() {
        if let Some(pos) = spendable.position {
            info!("Note {} already has position {} (cached)", i, pos);
            note_positions.push(pos);
            continue;
        }

        // Get tree size at the block BEFORE this note's block
        let tree_size_before = if spendable.block_height > 0 {
            lwd_client.get_orchard_tree_size_at(spendable.block_height - 1).await?
        } else {
            0
        };

        // Fetch the note's block to count actions before our note
        let blocks = lwd_client.fetch_block_actions(
            spendable.block_height,
            spendable.block_height,
        ).await?;

        let mut actions_before = 0u64;
        if let Some((_, txs)) = blocks.first() {
            for (tx_idx, cmxs) in txs {
                if *tx_idx < spendable.tx_index {
                    actions_before += cmxs.len() as u64;
                } else if *tx_idx == spendable.tx_index {
                    actions_before += spendable.action_index as u64;
                    break;
                }
            }
        }

        let position = tree_size_before + actions_before;
        info!("Note {}: block={}, tx_idx={}, action_idx={}, tree_before={}, actions_before={}, position={}",
            i, spendable.block_height, spendable.tx_index, spendable.action_index,
            tree_size_before, actions_before, position);

        // Cache the position in the database
        db.update_note_position(spendable.id, position)?;
        note_positions.push(position);
    }

    // Step 2: Determine which shards contain our notes
    // Each level-16 shard contains 2^16 = 65536 leaves
    const SHARD_SIZE: u64 = 1 << 16; // 65536
    let mut note_shards: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for pos in &note_positions {
        note_shards.insert((*pos / SHARD_SIZE) as u32);
    }
    info!("Notes span {} shard(s): {:?}", note_shards.len(), note_shards);

    // Step 3: Fetch all subtree roots
    let subtree_roots = lwd_client.get_subtree_roots(0, 0).await?;
    let num_shards = subtree_roots.len();
    info!("Chain has {} completed Orchard subtree shards", num_shards);

    if subtree_roots.is_empty() {
        return Err(anyhow::anyhow!("No Orchard subtree roots available from lightwalletd"));
    }

    // Step 4: Build position-ordered checkpoint map
    // ShardTree requires checkpoint IDs to be monotonically increasing with position.
    // Sort note positions and assign checkpoint IDs in ascending position order.
    let mut sorted_by_pos: Vec<(u64, usize)> = note_positions.iter()
        .enumerate()
        .map(|(i, &pos)| (pos, i))
        .collect();
    sorted_by_pos.sort_by_key(|(pos, _)| *pos);

    let mut pos_to_checkpoint: std::collections::HashMap<u64, u32> = std::collections::HashMap::new();
    for (ckpt_id, (pos, _)) in sorted_by_pos.iter().enumerate() {
        pos_to_checkpoint.insert(*pos, ckpt_id as u32);
        debug!("Checkpoint {}: position {} (note index {})", ckpt_id, pos, sorted_by_pos[ckpt_id].1);
    }
    let last_checkpoint_id = (notes.len() - 1) as u32;

    // Step 5: Build ShardTree with real chain data
    let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
        ShardTree::new(MemoryShardStore::empty(), 100);

    // For shards NOT containing our notes, insert pre-computed roots
    for (shard_idx, root_hash, completing_height) in &subtree_roots {
        if note_shards.contains(shard_idx) {
            // We need to fill this shard with individual leaves
            continue;
        }

        let root = MerkleHashOrchard::from_bytes(&root_hash);
        if bool::from(root.is_none()) {
            continue;
        }
        let addr = incrementalmerkletree::Address::above_position(
            16.into(),
            incrementalmerkletree::Position::from((*shard_idx as u64) * SHARD_SIZE),
        );
        tree.insert(addr, root.unwrap())
            .map_err(|e| anyhow::anyhow!("Failed to insert shard root {}: {:?}", shard_idx, e))?;
        debug!("Inserted shard {} root (completing_height={})", shard_idx, completing_height);
    }

    // For shards containing our notes, fetch all leaves and append
    for shard_idx in &note_shards {
        let shard_start_pos = (*shard_idx as u64) * SHARD_SIZE;

        // Find the height range for this shard
        let shard_start_height = if *shard_idx == 0 {
            1687104 // Orchard activation height
        } else {
            // The previous shard's completing height + 1
            subtree_roots.iter()
                .find(|(idx, _, _)| *idx == shard_idx - 1)
                .map(|(_, _, h)| *h + 1)
                .unwrap_or(1687104)
        };

        let shard_end_height = subtree_roots.iter()
            .find(|(idx, _, _)| idx == shard_idx)
            .map(|(_, _, h)| *h)
            .unwrap_or_else(|| {
                // This shard is not yet complete — use the latest note's block
                notes.iter().map(|n| n.block_height).max().unwrap_or(0)
            });

        info!("Fetching leaves for shard {} (heights {} to {})", shard_idx, shard_start_height, shard_end_height);

        let chunk_size = 10000u64;
        let mut current_pos = shard_start_pos;
        let mut current_height = shard_start_height;

        while current_height <= shard_end_height {
            let end = std::cmp::min(current_height + chunk_size - 1, shard_end_height);
            let blocks = lwd_client.fetch_block_actions(current_height, end).await?;

            for (block_height, txs) in &blocks {
                for (tx_idx, cmxs) in txs {
                    for (action_idx, cmx_bytes) in cmxs.iter().enumerate() {
                        let cmx = ExtractedNoteCommitment::from_bytes(cmx_bytes);
                        if bool::from(cmx.is_none()) {
                            continue;
                        }
                        let leaf = MerkleHashOrchard::from_cmx(&cmx.unwrap());

                        // Use position-ordered checkpoint IDs (monotonically increasing)
                        let retention = if let Some(&ckpt_id) = pos_to_checkpoint.get(&current_pos) {
                            Retention::Checkpoint {
                                id: ckpt_id,
                                marking: Marking::Marked,
                            }
                        } else {
                            Retention::Ephemeral
                        };

                        tree.append(leaf, retention)
                            .context(format!("Failed to append leaf at position {} (block {} tx {} action {})",
                                current_pos, block_height, tx_idx, action_idx))?;

                        current_pos += 1;
                    }
                }
            }

            current_height = end + 1;
        }

        info!("Shard {}: inserted {} leaves", shard_idx, current_pos - shard_start_pos);
    }

    // Step 6: Reconstruct notes and get anchor + witnesses
    let mut orchard_notes: Vec<Note> = Vec::new();
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

        orchard_notes.push(note);
    }

    let root = tree.root_at_checkpoint_id(&last_checkpoint_id)
        .context("Failed to get Merkle root")?
        .ok_or_else(|| anyhow::anyhow!("Empty Merkle tree — no checkpoint found"))?;
    let anchor: Anchor = root.into();
    info!("Computed anchor: {}", hex::encode(&anchor.to_bytes()));

    // Step 7: Build PCZT bundle
    let mut builder = Builder::new(BundleType::DEFAULT, anchor);

    for (i, note) in orchard_notes.iter().enumerate() {
        let position = incrementalmerkletree::Position::from(note_positions[i]);
        let merkle_path = tree.witness_at_checkpoint_id(position, &last_checkpoint_id)
            .context(format!("Failed to get Merkle witness for note {} at position {}", i, note_positions[i]))?
            .ok_or_else(|| anyhow::anyhow!("No witness for note {} at position {}", i, note_positions[i]))?;

        builder.add_spend(fvk.clone(), note.clone(), merkle_path.into())
            .map_err(|e| anyhow::anyhow!("Failed to add spend {}: {:?}", i, e))?;
    }

    // Encode memo: UTF-8 text zero-padded to 512 bytes (Zcash memo field spec)
    let memo_bytes: [u8; 512] = {
        let mut buf = [0u8; 512];
        if let Some(ref text) = memo {
            let bytes = text.as_bytes();
            let len = std::cmp::min(bytes.len(), 512);
            buf[..len].copy_from_slice(&bytes[..len]);
        }
        buf
    };

    let ovk = fvk.to_ovk(Scope::External);
    builder.add_output(Some(ovk.clone()), recipient, NoteValue::from_raw(amount), memo_bytes)
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

    let digests = zip244::compute_zip244_digests_effects(&effects_bundle, branch_id, 0, 0);
    let sighash = zip244::compute_sighash(&digests, branch_id);

    // ── DEBUG: Log all digest components ──
    debug!("DEBUG sighash:     {}", hex::encode(&sighash));
    debug!("DEBUG header:      {}", hex::encode(&digests.header_digest));
    debug!("DEBUG transparent: {}", hex::encode(&digests.transparent_digest));
    debug!("DEBUG sapling:     {}", hex::encode(&digests.sapling_digest));
    debug!("DEBUG orchard:     {}", hex::encode(&digests.orchard_digest));

    // Log effects rk before randomization
    for (i, action) in effects_bundle.actions().iter().enumerate() {
        let rk_bytes: [u8; 32] = action.rk().into();
        debug!("DEBUG effects_rk[{}]: {}", i, hex::encode(&rk_bytes));
    }

    // Step 4: Finalize IO
    pczt_bundle.finalize_io(sighash, &mut rng)
        .map_err(|e| anyhow::anyhow!("IO finalization failed: {:?}", e))?;

    // Log PCZT rk after randomization + alpha
    for (i, action) in pczt_bundle.actions().iter().enumerate() {
        let rk = action.spend().rk();
        let rk_arr: [u8; 32] = rk.clone().into();
        debug!("DEBUG pczt_rk[{}]:    {}", i, hex::encode(&rk_arr));
        if let Some(alpha) = action.spend().alpha() {
            debug!("DEBUG alpha[{}]:      {}", i, hex::encode(&alpha.to_repr()));
        } else {
            debug!("DEBUG alpha[{}]:      NONE (dummy action)", i);
        }
    }

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
        // After finalize_io(), dummy spends already have spend_auth_sig set
        // (signed by finalize_io with their dummy_sk). Real spends have
        // spend_auth_sig=None, waiting for the device signature.
        // alpha().is_some() is NOT reliable — builder sets alpha for ALL actions.
        let is_spend = pczt_bundle.actions()[i].spend().spend_auth_sig().is_none();
        let value = pczt_bundle.actions()[i].spend().value()
            .map(|v| v.inner())
            .unwrap_or(0);

        let effects_action = &effects_bundle.actions()[i];
        let nullifier_bytes = effects_action.nullifier().to_bytes().to_vec();
        let cmx_bytes = effects_action.cmx().to_bytes().to_vec();
        let epk_bytes = effects_action.encrypted_note().epk_bytes.as_ref().to_vec();
        let enc = &effects_action.encrypted_note().enc_ciphertext;
        if enc.len() != 580 {
            return Err(anyhow::anyhow!(
                "Invalid enc_ciphertext length for action {}: expected 580, got {}",
                i, enc.len()
            ));
        }
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
        account,
        branch_id,
        sighash: sighash.to_vec(),
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
        branch_id,
        signing_request,
    })
}

/// Apply device signatures to the PCZT and produce the final v5 transaction bytes.
pub fn finalize_pczt(
    mut pczt_bundle: orchard::pczt::Bundle,
    sighash: [u8; 32],
    branch_id: u32,
    signatures: &[Vec<u8>],
) -> Result<(Vec<u8>, String)> {
    let mut rng = OsRng;

    info!("Applying {} signatures...", signatures.len());
    debug!("DEBUG finalize sighash: {}", hex::encode(&sighash));

    for (i, sig_bytes) in signatures.iter().enumerate() {
        // Check if this action is a real spend or a dummy (output-only).
        // Dummy spends were already signed by finalize_io — skip them.
        // After finalize_io(), dummies have spend_auth_sig=Some, real spends have None.
        let is_spend = pczt_bundle.actions()[i].spend().spend_auth_sig().is_none();
        if !is_spend {
            info!("Action {}: dummy spend (already signed by finalize_io) — skipping device sig", i);
            continue;
        }

        if sig_bytes.len() != 64 {
            return Err(anyhow::anyhow!(
                "Invalid signature length for action {}: expected 64, got {}",
                i, sig_bytes.len()
            ));
        }

        info!("Action {}: real spend — applying device signature", i);

        let rk = pczt_bundle.actions()[i].spend().rk();
        let rk_arr: [u8; 32] = rk.clone().into();
        debug!("  rk:      {}", hex::encode(&rk_arr));
        debug!("  sighash: {}", hex::encode(&sighash));
        debug!("  sig_R:   {}", hex::encode(&sig_bytes[..32]));
        debug!("  sig_S:   {}", hex::encode(&sig_bytes[32..]));
        if let Some(alpha) = pczt_bundle.actions()[i].spend().alpha() {
            debug!("  alpha:   {}", hex::encode(&alpha.to_repr()));
        }

        // Manual reddsa verify before apply_signature
        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(sig_bytes);
        let signature: redpallas::Signature<SpendAuth> = sig_arr.into();

        let verify_result = rk.verify(&sighash, &signature);
        info!("  manual verify: {:?}", verify_result);

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
    let tx_bytes = serialize_v5_shielded_tx(&authorized_bundle, branch_id)?;

    // Compute txid
    use blake2b_simd::Params;
    let mut txid_personal = [0u8; 16];
    txid_personal[..12].copy_from_slice(b"ZcashTxHash_");
    txid_personal[12..16].copy_from_slice(&branch_id.to_le_bytes());
    let txid_hash = Params::new()
        .hash_length(32)
        .personal(&txid_personal)
        .hash(&tx_bytes);
    let txid = hex::encode(txid_hash.as_bytes());

    info!("Transaction built: {} bytes, txid: {}", tx_bytes.len(), txid);
    Ok((tx_bytes, txid))
}

/// Serialize an authorized Orchard bundle as a v5 Zcash transaction.
fn serialize_v5_shielded_tx(
    bundle: &orchard::Bundle<orchard::bundle::Authorized, i64>,
    branch_id: u32,
) -> Result<Vec<u8>> {
    let mut tx = Vec::new();

    // Header (v5)
    let version: u32 = 5 | (1 << 31);
    tx.extend_from_slice(&version.to_le_bytes());

    // version_group_id for v5
    tx.extend_from_slice(&0x26A7270Au32.to_le_bytes());

    // consensus_branch_id
    tx.extend_from_slice(&branch_id.to_le_bytes());

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
