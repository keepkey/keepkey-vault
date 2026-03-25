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
use incrementalmerkletree::Retention;
use shardtree::{store::memory::MemoryShardStore, ShardTree};

use crate::scanner::LightwalletClient;
use crate::wallet_db::{SpendableNote, WalletDb};
use crate::zip244;

/// ZIP-317 marginal fee per logical action (5000 zatoshis).
const ZIP317_MARGINAL_FEE: u64 = 5000;
/// ZIP-317 grace actions — minimum baseline (2 actions are "free").
const ZIP317_GRACE_ACTIONS: u64 = 2;

/// Compute ZIP-317 fee for an Orchard-only transaction.
/// fee = marginal_fee × max(grace_actions, logical_actions)
/// where logical_actions = max(n_spends, n_outputs) for Orchard.
fn zip317_fee(n_spends: usize, n_outputs: usize) -> u64 {
    let logical_actions = std::cmp::max(n_spends, n_outputs) as u64;
    ZIP317_MARGINAL_FEE * std::cmp::max(ZIP317_GRACE_ACTIONS, logical_actions)
}

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
    _db: &WalletDb,
    memo: Option<String>,
) -> Result<PcztState> {
    let mut rng = OsRng;
    let total_input: u64 = notes.iter().map(|n| n.value).sum();

    // ZIP-317: fee depends on number of Orchard actions.
    // n_outputs = 1 (recipient) + 1 (change) — but we don't know if there's
    // change until we compute it, and change depends on fee. Use a two-pass
    // approach: assume change exists (common case), compute fee, then verify.
    let n_spends = notes.len();
    let n_outputs_with_change = 2usize; // recipient + change
    let fee = zip317_fee(n_spends, n_outputs_with_change);
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

    // Step 1: Determine which shards contain our notes (approximate)
    // Use metadata for a rough position estimate, then fix during tree walk.
    const SHARD_SIZE: u64 = 1 << 16; // 65536
    let mut note_positions: Vec<u64> = vec![0; notes.len()]; // will be set during tree walk
    let mut found_notes = vec![false; notes.len()];
    let mut note_shards: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();

    for (i, spendable) in notes.iter().enumerate() {
        // Rough position estimate from metadata (may be off by a few)
        let approx_pos = if let Some(pos) = spendable.position {
            pos
        } else {
            let tree_size_before = if spendable.block_height > 0 {
                lwd_client.get_orchard_tree_size_at(spendable.block_height - 1).await?
            } else {
                0
            };
            tree_size_before // approximate — action offset within block doesn't matter for shard detection
        };
        note_shards.insert((approx_pos / SHARD_SIZE) as u32);
        info!("Note {}: block={}, approx_shard={}", i, spendable.block_height, approx_pos / SHARD_SIZE);
    }

    // Step 2: Fetch all subtree roots + chain tip height
    let lwd_tip_height = lwd_client.get_latest_block_height().await?;
    let subtree_roots = lwd_client.get_subtree_roots(0, 0).await?;
    let num_shards = subtree_roots.len();
    info!("Chain has {} completed Orchard subtree shards", num_shards);

    if subtree_roots.is_empty() {
        return Err(anyhow::anyhow!("No Orchard subtree roots available from lightwalletd"));
    }

    // Build cmx lookup for detecting note positions during tree walk
    let note_cmx_set: std::collections::HashMap<[u8; 32], usize> = notes.iter().enumerate()
        .map(|(i, n)| (n.cmx, i))
        .collect();
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

    // For shards containing our notes, fetch all leaves and append.
    //
    // CRITICAL: completing_block_height for shard N is the block where the tree
    // size first reached (N+1)*65536. But that block may contain actions that
    // STRADDLE the shard boundary — some actions fill shard N, the rest start
    // shard N+1. We must use orchardCommitmentTreeSize to find the exact leaf
    // position boundary, then include cross-boundary actions from the completing
    // block that belong to the NEXT shard.
    for shard_idx in &note_shards {
        let shard_start_pos = (*shard_idx as u64) * SHARD_SIZE;

        // Determine the block range and how many actions to skip at the start.
        // The previous shard's completing block may contain actions that belong
        // to THIS shard (cross-boundary). We must include them.
        let (fetch_start_height, actions_to_skip) = if *shard_idx == 0 {
            (1687104u64, 0u64) // Orchard activation — no prior shard
        } else {
            let prev_completing = subtree_roots.iter()
                .find(|(idx, _, _)| *idx == shard_idx - 1)
                .map(|(_, _, h)| *h)
                .unwrap_or(1687104);

            let tree_size_before_completing = if prev_completing > 0 {
                lwd_client.get_orchard_tree_size_at(prev_completing - 1).await?
            } else {
                0
            };
            let tree_size_after_completing = lwd_client.get_orchard_tree_size_at(prev_completing).await?;

            let plan = plan_incomplete_shard_fetch(
                prev_completing,
                shard_start_pos,
                tree_size_before_completing,
                tree_size_after_completing,
            );

            info!("Shard {} boundary analysis:", shard_idx);
            info!("  Previous shard completing block: {}", prev_completing);
            info!("  Tree size before completing block: {}", tree_size_before_completing);
            info!("  Tree size after completing block: {}", tree_size_after_completing);
            info!("  Cross-boundary actions for this shard: {}", plan.cross_boundary);

            (plan.fetch_start_height, plan.actions_to_skip)
        };

        let is_complete_shard = subtree_roots.iter().any(|(idx, _, _)| idx == shard_idx);
        let shard_end_height = if is_complete_shard {
            subtree_roots.iter()
                .find(|(idx, _, _)| idx == shard_idx)
                .map(|(_, _, h)| *h)
                .unwrap()
        } else {
            lwd_tip_height // Incomplete shard → use chain tip
        };
        // Upper boundary: for completed shards, stop at exactly shard_end_pos
        // to avoid spilling into shard N+1 when the completing block straddles
        // the boundary. For incomplete shards, no upper limit.
        let shard_end_pos = if is_complete_shard {
            (*shard_idx as u64 + 1) * SHARD_SIZE
        } else {
            u64::MAX
        };

        info!("Fetching leaves for shard {} (heights {} to {}, skip first {} actions, end_pos={})",
            shard_idx, fetch_start_height, shard_end_height, actions_to_skip,
            if shard_end_pos == u64::MAX { "unlimited".to_string() } else { shard_end_pos.to_string() });

        let chunk_size = 10000u64;
        let mut current_pos = shard_start_pos;
        let mut current_height = fetch_start_height;
        let mut global_action_counter = 0u64;
        'block_fetch: while current_height <= shard_end_height {
            let end = std::cmp::min(current_height + chunk_size - 1, shard_end_height);
            let blocks = lwd_client.fetch_block_actions(current_height, end).await?;

            for (block_height, txs) in &blocks {
                for (tx_idx, cmxs) in txs {
                    for (action_idx, cmx_bytes) in cmxs.iter().enumerate() {
                        // Skip actions that belong to the previous shard
                        if global_action_counter < actions_to_skip {
                            global_action_counter += 1;
                            continue;
                        }
                        global_action_counter += 1;

                        // Upper boundary: stop if we've filled this shard
                        if current_pos >= shard_end_pos {
                            info!("Shard {} upper boundary reached at pos {} (block {} tx {} action {})",
                                shard_idx, current_pos, block_height, tx_idx, action_idx);
                            break 'block_fetch;
                        }

                        let cmx = ExtractedNoteCommitment::from_bytes(cmx_bytes);
                        if bool::from(cmx.is_none()) {
                            info!("WARNING: skipping invalid cmx at pos {} block {} tx {} action {}",
                                current_pos, block_height, tx_idx, action_idx);
                            continue;
                        }
                        let leaf = MerkleHashOrchard::from_cmx(&cmx.unwrap());

                        let retention = if let Some(&note_idx) = note_cmx_set.get(cmx_bytes) {
                            note_positions[note_idx] = current_pos;
                            found_notes[note_idx] = true;
                            info!("Note {} found at pos {} (block {} tx {} action {})",
                                note_idx, current_pos, block_height, tx_idx, action_idx);
                            Retention::Marked
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

        let leaves_in_shard = current_pos - shard_start_pos;
        info!("Shard {}: inserted {} leaves (positions {} to {})",
            shard_idx, leaves_in_shard, shard_start_pos, current_pos - 1);
    }

    // Verify leaf count against lightwalletd's tree size
    let expected_tree_size = lwd_client.get_orchard_tree_size_at(lwd_tip_height).await?;
    // Our tree should cover positions 0..(num_shards * SHARD_SIZE - 1) via shard roots
    // plus individually-inserted leaves for the incomplete shard.
    // The total tree size is: (completed shards) * SHARD_SIZE + leaves_in_incomplete_shard
    // which should equal expected_tree_size
    info!("Tree size check: expected={} at tip height {}", expected_tree_size, lwd_tip_height);
    info!("  Completed shards: {} covering positions 0..{}",
        num_shards, (num_shards as u64) * SHARD_SIZE - 1);

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

    if found_notes.iter().any(|found| !found) {
        return Err(anyhow::anyhow!("No note cmxs found during tree walk — notes not in this shard?"));
    }

    // Consensus accepts Orchard anchors at block boundaries, not arbitrary note positions
    // within a block. Checkpoint the fully-built tree at the current chain tip and build
    // all witnesses against that shared anchor.
    let anchor_checkpoint_id = u32::MAX;
    tree.checkpoint(anchor_checkpoint_id)
        .context("Failed to checkpoint Orchard tree at chain tip")?;

    let root = tree.root_at_checkpoint_id(&anchor_checkpoint_id)
        .context("Failed to get Merkle root")?
        .ok_or_else(|| anyhow::anyhow!("Empty Merkle tree — no checkpoint found"))?;
    let computed_anchor_bytes = root.to_bytes();
    info!("ShardTree anchor: {}", hex::encode(&computed_anchor_bytes));

    // Validate against lightwalletd's authoritative tree state at the tip.
    // If the ShardTree reconstruction produced the wrong root, the tx will be
    // rejected with "unknown Orchard anchor" — catch that here instead.
    let expected_anchor = lwd_client.get_orchard_anchor(lwd_tip_height).await
        .context("Failed to fetch authoritative Orchard anchor from lightwalletd")?;
    info!("Expected anchor (lwd tip {}): {}", lwd_tip_height, hex::encode(&expected_anchor));

    if computed_anchor_bytes != expected_anchor {
        info!("ANCHOR MISMATCH — ShardTree root does not match lightwalletd!");
        info!("  ShardTree: {}", hex::encode(&computed_anchor_bytes));
        info!("  Expected:  {}", hex::encode(&expected_anchor));
        info!("  Expected tree size at tip {}: {}", expected_tree_size, lwd_tip_height);
        info!("  Completed shards: {} (covering {} leaves)", num_shards, (num_shards as u64) * SHARD_SIZE);
        info!("  Note shards filled individually: {:?}", note_shards);

        // Diagnostic: check if the completed-shards-only root matches lightwalletd
        // at the completing height of the last completed shard
        if let Some((_, _, last_completing_height)) = subtree_roots.last() {
            match lwd_client.get_orchard_anchor(*last_completing_height).await {
                Ok(anchor_at_last_shard) => {
                    // Build a tree with only completed shard roots (no individual leaves)
                    let mut diag_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
                        ShardTree::new(MemoryShardStore::empty(), 100);
                    for (shard_idx, root_hash, _) in &subtree_roots {
                        let root = MerkleHashOrchard::from_bytes(&root_hash);
                        if bool::from(root.is_none()) { continue; }
                        let addr = incrementalmerkletree::Address::above_position(
                            16.into(),
                            incrementalmerkletree::Position::from((*shard_idx as u64) * SHARD_SIZE),
                        );
                        let _ = diag_tree.insert(addr, root.unwrap());
                    }
                    diag_tree.checkpoint(0u32).unwrap();
                    let diag_root = diag_tree.root_at_checkpoint_id(&0u32).unwrap().unwrap();
                    let diag_bytes = diag_root.to_bytes();
                    info!("  Diagnostic: shards-only root: {}", hex::encode(&diag_bytes));
                    info!("  Diagnostic: lwd root at last shard height {}: {}",
                        last_completing_height, hex::encode(&anchor_at_last_shard));
                    if diag_bytes == anchor_at_last_shard {
                        info!("  → Shard roots are CORRECT. Issue is in incomplete shard leaf data.");
                    } else {
                        info!("  → Shard roots are WRONG. ShardTree insert() is not equivalent to chain tree.");
                    }
                }
                Err(e) => info!("  Diagnostic: could not fetch anchor at shard height: {}", e),
            }
        }

        return Err(anyhow::anyhow!(
            "Orchard anchor mismatch: ShardTree={} vs lightwalletd={}. \
             The tree reconstruction is wrong.",
            hex::encode(&computed_anchor_bytes),
            hex::encode(&expected_anchor),
        ));
    }

    let anchor: Anchor = root.into();
    info!("Anchor verified against lightwalletd: {}", hex::encode(&anchor.to_bytes()));

    // Step 7: Build PCZT bundle — add spends sorted by position
    let mut builder = Builder::new(BundleType::DEFAULT, anchor);

    let mut sorted_notes: Vec<(u64, usize)> = note_positions.iter().enumerate()
        .map(|(i, &pos)| (pos, i)).collect();
    sorted_notes.sort_by_key(|(pos, _)| *pos);

    for &(pos, orig_idx) in &sorted_notes {
        let position = incrementalmerkletree::Position::from(pos);
        let merkle_path = tree.witness_at_checkpoint_id(position, &anchor_checkpoint_id)
            .context(format!("Failed to get Merkle witness for note {} at position {}", orig_idx, pos))?
            .ok_or_else(|| anyhow::anyhow!("No witness for note {} at position {}", orig_idx, pos))?;

        info!("Note {} pos={} anchor_ckpt={}", orig_idx, pos, anchor_checkpoint_id);

        builder.add_spend(fvk.clone(), orchard_notes[orig_idx].clone(), merkle_path.into())
            .map_err(|e| anyhow::anyhow!("Failed to add spend {}: {:?}", orig_idx, e))?;
    }

    // Encode memo per ZIP-302: UTF-8 text zero-padded to 512 bytes,
    // or 0xF6 + zeros for "no memo" (canonical empty).
    let memo_bytes: [u8; 512] = {
        let mut buf = [0u8; 512];
        if let Some(ref text) = memo {
            let bytes = text.as_bytes();
            let len = std::cmp::min(bytes.len(), 512);
            buf[..len].copy_from_slice(&bytes[..len]);
        } else {
            buf[0] = 0xF6; // ZIP-302: "no memo"
        }
        buf
    };

    let ovk = fvk.to_ovk(Scope::External);
    builder.add_output(Some(ovk.clone()), recipient, NoteValue::from_raw(amount), memo_bytes)
        .map_err(|e| anyhow::anyhow!("Failed to add output: {:?}", e))?;

    if change > 0 {
        let change_addr = fvk.address_at(0u32, Scope::Internal);
        let internal_ovk = fvk.to_ovk(Scope::Internal);
        let empty_memo = { let mut m = [0u8; 512]; m[0] = 0xF6; m }; // ZIP-302: "no memo"
        builder.add_output(Some(internal_ovk), change_addr, NoteValue::from_raw(change), empty_memo)
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
    let n_actions = pczt_bundle.actions().len();

    let is_real_spend: Vec<bool> = (0..n_actions)
        .map(|i| pczt_bundle.actions()[i].spend().spend_auth_sig().is_none())
        .collect();
    let signature_plan = plan_orchard_signature_application(&is_real_spend, signatures.len())?;

    info!("Applying {} signatures...", signatures.len());
    debug!("finalize sighash: {}", hex::encode(&sighash));

    for (i, sig_index) in signature_plan.iter().enumerate() {
        let Some(sig_index) = sig_index else {
            info!("Action {}: dummy spend — no device signature in compact mode", i);
            continue;
        };

        let sig_bytes = &signatures[*sig_index];

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

        let rk_arr: [u8; 32] = rk.clone().into();
        info!("Action {} verify: rk={} sighash={} sig_R={} sig_S={}",
            i, hex::encode(&rk_arr), hex::encode(&sighash),
            hex::encode(&sig_bytes[..32]), hex::encode(&sig_bytes[32..]));

        let verify_result = rk.verify(&sighash, &signature);
        if verify_result.is_err() {
            // Log the signing_request sighash that was sent to the device
            info!("MISMATCH: finalize sighash={}", hex::encode(&sighash));
            return Err(anyhow::anyhow!(
                "Signature verification failed for action {}: {:?}", i, verify_result
            ));
        }

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

    // Compute txid per ZIP-244: BLAKE2b("ZcashTxHash_" || branch_id,
    //   header_digest || transparent_digest || sapling_digest || orchard_digest)
    // For pure shielded: transparent_digest = EMPTY, sapling_digest = EMPTY
    let header_digest = zip244::digest_header(branch_id, 0, 0);
    let orchard_digest = zip244::digest_orchard(&authorized_bundle);
    let txid_digests = zip244::Zip244Digests {
        header_digest,
        transparent_digest: zip244::EMPTY_TRANSPARENT_DIGEST,
        sapling_digest: zip244::EMPTY_SAPLING_DIGEST,
        orchard_digest,
    };
    let txid_hash = zip244::compute_sighash(&txid_digests, branch_id);
    let txid = hex::encode(&txid_hash);

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

// ── Hybrid shielding (transparent → Orchard) ────────────────────────────

/// Transparent input for shield PCZT construction.
#[derive(Debug, Clone, Serialize)]
pub struct ShieldTransparentInput {
    pub txid: String,           // hex, 32 bytes (display order)
    pub vout: u32,
    pub value: u64,             // zatoshis
    pub script_pubkey: String,  // hex
}

/// Result of building a shield PCZT.
#[derive(Debug, Serialize)]
pub struct ShieldSigningRequest {
    /// Transparent inputs the device needs to ECDSA-sign
    pub transparent_inputs: Vec<TransparentSigningInput>,
    /// Orchard signing request (existing format)
    pub orchard_signing_request: SigningRequest,
    /// ZIP-244 sub-digests
    pub digests: DigestFields,
    /// Display info for the UI
    pub display: ShieldDisplayInfo,
}

#[derive(Debug, Serialize)]
pub struct TransparentSigningInput {
    pub index: u32,
    #[serde(with = "hex_bytes")]
    pub sighash: Vec<u8>,       // 32-byte per-input sighash
    pub address_path: Vec<u32>, // BIP44 path [44', 133', 0', 0, 0]
    pub amount: u64,            // zatoshis (for display)
}

#[derive(Debug, Serialize)]
pub struct ShieldDisplayInfo {
    pub amount: String,
    pub fee: String,
    pub action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IncompleteShardFetchPlan {
    fetch_start_height: u64,
    actions_to_skip: u64,
    cross_boundary: u64,
}

fn plan_incomplete_shard_fetch(
    last_completed_height: u64,
    shard_start_pos: u64,
    tree_size_before_completing: u64,
    tree_size_after_completing: u64,
) -> IncompleteShardFetchPlan {
    let actions_in_block = tree_size_after_completing.saturating_sub(tree_size_before_completing);
    let actions_in_completed_shard = shard_start_pos.saturating_sub(tree_size_before_completing);
    let cross_boundary = actions_in_block.saturating_sub(actions_in_completed_shard);

    let (fetch_start_height, actions_to_skip) = if cross_boundary > 0 {
        (last_completed_height, actions_in_completed_shard)
    } else {
        (last_completed_height + 1, 0)
    };

    IncompleteShardFetchPlan {
        fetch_start_height,
        actions_to_skip,
        cross_boundary,
    }
}

/// Intermediate state for shield PCZT (between build and finalize).
pub struct ShieldPcztState {
    pub pczt_bundle: orchard::pczt::Bundle,
    pub sighash: [u8; 32],
    pub branch_id: u32,
    pub orchard_signing_request: SigningRequest,
    pub transparent_inputs: Vec<zip244::TransparentInput>,
    pub transparent_outputs: Vec<zip244::TransparentOutput>,
    pub transparent_signing_inputs: Vec<TransparentSigningInput>,
}

/// Build a shield PCZT: transparent inputs → Orchard output.
///
/// Creates an Orchard bundle with output only (builder auto-creates dummy spend),
/// computes ZIP-244 hybrid digests, and returns per-input transparent sighashes.
pub async fn build_shield_pczt(
    fvk: &FullViewingKey,
    transparent_inputs: Vec<ShieldTransparentInput>,
    amount: u64,
    fee: u64,
    account: u32,
    branch_id: u32,
    lwd_client: &mut crate::scanner::LightwalletClient,
    _db: &crate::wallet_db::WalletDb,
) -> Result<ShieldPcztState> {
    let mut rng = OsRng;

    let total_input: u64 = transparent_inputs.iter().map(|i| i.value).sum();
    let change = total_input.checked_sub(amount + fee)
        .ok_or_else(|| anyhow::anyhow!(
            "Insufficient transparent funds: have {} ZAT, need {} ZAT (amount {} + fee {})",
            total_input, amount + fee, amount, fee
        ))?;

    info!("Building shield transaction:");
    info!("  Transparent inputs: {} totaling {} ZAT", transparent_inputs.len(), total_input);
    info!("  Shield amount:  {} ZAT", amount);
    info!("  Fee:            {} ZAT", fee);
    info!("  Change to t1:   {} ZAT", change);

    // Convert transparent inputs to ZIP-244 format
    let mut zip_inputs: Vec<zip244::TransparentInput> = Vec::new();
    for ti in &transparent_inputs {
        let txid_bytes = hex::decode(&ti.txid)?;
        if txid_bytes.len() != 32 {
            return Err(anyhow::anyhow!("Invalid txid length: {}", txid_bytes.len()));
        }
        // Reverse txid from display order to internal byte order
        let mut prevout_hash = [0u8; 32];
        for (i, b) in txid_bytes.iter().enumerate() {
            prevout_hash[31 - i] = *b;
        }
        let script_pubkey = hex::decode(&ti.script_pubkey)?;

        zip_inputs.push(zip244::TransparentInput {
            prevout_hash,
            prevout_index: ti.vout,
            script_pubkey,
            value: ti.value,
            sequence: 0xFFFFFFFF,
        });
    }

    // Build transparent outputs (change back to t1 if needed)
    let mut zip_outputs: Vec<zip244::TransparentOutput> = Vec::new();
    if change > 0 {
        // Change goes back to the first input's scriptPubKey (same t1 address)
        zip_outputs.push(zip244::TransparentOutput {
            value: change,
            script_pubkey: zip_inputs[0].script_pubkey.clone(),
        });
    }

    // Build Orchard bundle with output only (shielding — no spends from Orchard pool).
    // Must use BundleType::DEFAULT (enableSpends=true) because ZIP-225 requires it
    // for non-coinbase transactions.
    //
    // We need a REAL chain anchor for the Halo2 proof to verify.
    // Build a ShardTree from subtree roots to get the current Orchard tree root.
    // For output-only (no real spends), we don't need witnesses — just the root.
    let subtree_roots = lwd_client.get_subtree_roots(0, 0).await?;
    info!("Fetched {} subtree roots for anchor computation", subtree_roots.len());

    // Build a ShardTree with all completed subtree roots, add a checkpoint, get root
    let mut anchor_tree: shardtree::ShardTree<
        shardtree::store::memory::MemoryShardStore<MerkleHashOrchard, u32>, 32, 16
    > = shardtree::ShardTree::new(shardtree::store::memory::MemoryShardStore::empty(), 100);

    for (shard_idx, root_hash, _completing_height) in &subtree_roots {
        let root = MerkleHashOrchard::from_bytes(root_hash);
        if bool::from(root.is_none()) { continue; }
        let addr = incrementalmerkletree::Address::above_position(
            16.into(),
            incrementalmerkletree::Position::from((*shard_idx as u64) * (1 << 16)),
        );
        anchor_tree.insert(addr, root.unwrap())
            .map_err(|e| anyhow::anyhow!("Failed to insert shard root: {:?}", e))?;
    }

    // Also fetch leaves for the incomplete last shard (beyond completed subtrees)
    // to get the CURRENT chain tip anchor (not just completed-shards anchor).
    use incrementalmerkletree::Retention;
    use orchard::note::ExtractedNoteCommitment;

    let last_completed_shard = subtree_roots.len() as u32;
    let last_completed_height = subtree_roots.last()
        .map(|(_, _, h)| *h)
        .unwrap_or(1687104);
    let tip = lwd_client.get_latest_block_height().await?;

    if tip > last_completed_height {
        let shard_start_pos = (last_completed_shard as u64) * (1 << 16);
        let tree_size_before_completing = if last_completed_height > 0 {
            lwd_client.get_orchard_tree_size_at(last_completed_height - 1).await?
        } else {
            0
        };
        let tree_size_after_completing = lwd_client.get_orchard_tree_size_at(last_completed_height).await?;
        let fetch_plan = plan_incomplete_shard_fetch(
            last_completed_height,
            shard_start_pos,
            tree_size_before_completing,
            tree_size_after_completing,
        );

        info!("Incomplete shard {} boundary analysis:", last_completed_shard);
        info!("  Last completed block: {}", last_completed_height);
        info!("  Tree size before completing block: {}", tree_size_before_completing);
        info!("  Tree size after completing block: {}", tree_size_after_completing);
        info!("  Cross-boundary actions for incomplete shard: {}", fetch_plan.cross_boundary);
        info!("Fetching leaves for incomplete shard {} (heights {} to {}, skip first {} actions)",
            last_completed_shard, fetch_plan.fetch_start_height, tip, fetch_plan.actions_to_skip);

        let chunk_size = 10000u64;
        let mut current_pos = shard_start_pos;
        let mut current_height = fetch_plan.fetch_start_height;
        let mut global_action_counter = 0u64;

        while current_height <= tip {
            let end = std::cmp::min(current_height + chunk_size - 1, tip);
            let blocks = lwd_client.fetch_block_actions(current_height, end).await?;

            for (_block_height, txs) in &blocks {
                for (_tx_idx, cmxs) in txs {
                    for cmx_bytes in cmxs {
                        if global_action_counter < fetch_plan.actions_to_skip {
                            global_action_counter += 1;
                            continue;
                        }
                        global_action_counter += 1;

                        let cmx = ExtractedNoteCommitment::from_bytes(cmx_bytes);
                        if bool::from(cmx.is_none()) { continue; }
                        let leaf = MerkleHashOrchard::from_cmx(&cmx.unwrap());
                        anchor_tree.append(leaf, Retention::Ephemeral)
                            .map_err(|e| anyhow::anyhow!("Failed to append leaf: {:?}", e))?;
                        current_pos += 1;
                    }
                }
            }
            current_height = end + 1;
        }

        info!("Incomplete shard: inserted {} leaves", current_pos - shard_start_pos);
    }

    anchor_tree.checkpoint(0u32)
        .map_err(|e| anyhow::anyhow!("Failed to checkpoint anchor tree: {:?}", e))?;

    let tree_root = anchor_tree.root_at_checkpoint_id(&0u32)
        .map_err(|e| anyhow::anyhow!("Failed to get tree root: {:?}", e))?
        .ok_or_else(|| anyhow::anyhow!("Empty tree root"))?;
    let anchor: Anchor = tree_root.into();
    info!("Using Orchard anchor (from chain subtree roots): {}", hex::encode(&anchor.to_bytes()));

    let expected_anchor = lwd_client.get_orchard_anchor(tip).await
        .context("Failed to fetch authoritative Orchard anchor from lightwalletd")?;
    if anchor.to_bytes() != expected_anchor {
        return Err(anyhow::anyhow!(
            "Shield Orchard anchor mismatch: reconstructed={} vs lightwalletd={} at tip {}",
            hex::encode(anchor.to_bytes()),
            hex::encode(expected_anchor),
            tip,
        ));
    }
    info!("Shield Orchard anchor verified against lightwalletd: {}", hex::encode(&expected_anchor));

    let mut builder = Builder::new(BundleType::DEFAULT, anchor);

    let recipient = fvk.address_at(0u32, Scope::External);

    // ZIP-302: canonical "no memo" for self-shielding
    let memo_bytes = { let mut m = [0u8; 512]; m[0] = 0xF6; m };
    let ovk = fvk.to_ovk(Scope::External);
    builder.add_output(Some(ovk), recipient, NoteValue::from_raw(amount), memo_bytes)
        .map_err(|e| anyhow::anyhow!("Failed to add Orchard output: {:?}", e))?;

    let (mut pczt_bundle, _) = builder.build_for_pczt(&mut rng)
        .map_err(|e| anyhow::anyhow!("Failed to build PCZT: {:?}", e))?;

    // Extract effects for digest computation
    let effects_bundle = pczt_bundle.extract_effects::<i64>()
        .map_err(|e| anyhow::anyhow!("Failed to extract effects: {:?}", e))?
        .ok_or_else(|| anyhow::anyhow!("Empty effects bundle"))?;

    // Compute ZIP-244 hybrid digests (real transparent + Orchard)
    let digests = zip244::compute_zip244_digests_hybrid(
        &effects_bundle, &zip_inputs, &zip_outputs, branch_id, 0, 0,
    );

    let sighash = zip244::compute_sighash(&digests, branch_id);

    info!("Hybrid digests computed:");
    info!("  header:      {}", hex::encode(&digests.header_digest));
    info!("  transparent: {}", hex::encode(&digests.transparent_digest));
    info!("  sapling:     {}", hex::encode(&digests.sapling_digest));
    info!("  orchard:     {}", hex::encode(&digests.orchard_digest));
    info!("  sighash:     {}", hex::encode(&sighash));

    // Compute per-input transparent sighashes
    let bip44_path: Vec<u32> = vec![
        0x80000000 + 44, // purpose
        0x80000000 + 133, // coin (ZEC)
        0x80000000,       // account 0
        0,                // external chain
        0,                // address index 0
    ];

    let mut transparent_signing: Vec<TransparentSigningInput> = Vec::new();
    for (i, _input) in zip_inputs.iter().enumerate() {
        let input_sighash = zip244::compute_transparent_sig_hash(
            i,
            &zip_inputs,
            &zip_outputs,
            &digests.orchard_digest,
            &digests.header_digest,
            &digests.sapling_digest,
            branch_id,
        );

        transparent_signing.push(TransparentSigningInput {
            index: i as u32,
            sighash: input_sighash.to_vec(),
            address_path: bip44_path.clone(),
            amount: zip_inputs[i].value,
        });
    }

    // Finalize IO + proof for the Orchard bundle
    pczt_bundle.finalize_io(sighash, &mut rng)
        .map_err(|e| anyhow::anyhow!("IO finalization failed: {:?}", e))?;

    info!("Generating Halo2 proof for shield tx...");
    let pk = ProvingKey::build();
    pczt_bundle.create_proof(&pk, &mut rng)
        .map_err(|e| anyhow::anyhow!("Proof generation failed: {:?}", e))?;
    info!("Proof generated");

    // Extract Orchard signing fields (same as existing build_pczt)
    let n_actions = pczt_bundle.actions().len();
    let mut action_fields: Vec<ActionFields> = Vec::new();

    for i in 0..n_actions {
        let alpha_bytes = pczt_bundle.actions()[i].spend().alpha()
            .map(|a| a.to_repr().to_vec())
            .unwrap_or_else(|| vec![0u8; 32]);
        let cv_net_bytes = pczt_bundle.actions()[i].cv_net().to_bytes().to_vec();
        let is_spend = pczt_bundle.actions()[i].spend().spend_auth_sig().is_none();
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

    let orchard_signing_request = SigningRequest {
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
            to: "Orchard (self-shield)".to_string(),
        },
    };

    Ok(ShieldPcztState {
        pczt_bundle,
        sighash,
        branch_id,
        orchard_signing_request,
        transparent_inputs: zip_inputs,
        transparent_outputs: zip_outputs,
        transparent_signing_inputs: transparent_signing,
    })
}

/// Finalize a shield PCZT: apply transparent + Orchard signatures, serialize hybrid v5 tx.
pub fn finalize_shield_pczt(
    state: ShieldPcztState,
    transparent_signatures: &[Vec<u8>],  // DER ECDSA sigs
    orchard_signatures: &[Vec<u8>],      // 64-byte RedPallas sigs
    compressed_pubkey: Option<&[u8]>,    // 33-byte compressed pubkey for P2PKH scriptSig
) -> Result<(Vec<u8>, String)> {
    let mut rng = OsRng;
    let mut pczt_bundle = state.pczt_bundle;
    let sighash = state.sighash;

    let n_actions = pczt_bundle.actions().len();
    let is_real_spend: Vec<bool> = (0..n_actions)
        .map(|i| pczt_bundle.actions()[i].spend().spend_auth_sig().is_none())
        .collect();
    let signature_plan = plan_orchard_signature_application(&is_real_spend, orchard_signatures.len())?;

    // Apply Orchard signatures
    for (i, sig_index) in signature_plan.iter().enumerate() {
        let Some(sig_index) = sig_index else {
            info!("Action {}: dummy spend — no device signature in compact mode", i);
            continue;
        };
        let sig_bytes = &orchard_signatures[*sig_index];
        if sig_bytes.len() != 64 {
            return Err(anyhow::anyhow!("Invalid Orchard sig length for action {}: {}", i, sig_bytes.len()));
        }

        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(sig_bytes);
        let signature: orchard::primitives::redpallas::Signature<orchard::primitives::redpallas::SpendAuth> = sig_arr.into();

        let rk = pczt_bundle.actions()[i].spend().rk();
        let verify_result = rk.verify(&sighash, &signature);
        if verify_result.is_err() {
            return Err(anyhow::anyhow!("Orchard sig verification failed for action {}", i));
        }

        pczt_bundle.actions_mut()[i]
            .apply_signature(sighash, signature)
            .map_err(|e| anyhow::anyhow!("Failed to apply Orchard sig for action {}: {}", i, e))?;
    }

    // Extract final Orchard bundle
    let unbound_bundle = pczt_bundle.extract::<i64>()
        .map_err(|e| anyhow::anyhow!("Failed to extract bundle: {}", e))?
        .ok_or_else(|| anyhow::anyhow!("Empty bundle after extraction"))?;

    let authorized_bundle = unbound_bundle.apply_binding_signature(sighash, &mut rng)
        .ok_or_else(|| anyhow::anyhow!("Binding signature verification failed"))?;

    // Serialize as hybrid v5 transaction
    let tx_bytes = serialize_v5_hybrid_tx(
        &authorized_bundle,
        &state.transparent_inputs,
        &state.transparent_outputs,
        transparent_signatures,
        state.branch_id,
        compressed_pubkey,
    )?;

    // Compute txid per ZIP-244: BLAKE2b("ZcashTxHash_" || branch_id,
    //   header_digest || transparent_digest(txid ver) || sapling_digest || orchard_digest)
    // Note: txid uses the NON-sig transparent_digest (no hash_type, no txin_sig_digest)
    let header_digest = zip244::digest_header(state.branch_id, 0, 0);
    let transparent_txid_digest = zip244::digest_transparent_txid(
        &state.transparent_inputs,
        &state.transparent_outputs,
    );
    let orchard_digest = zip244::digest_orchard(&authorized_bundle);
    let txid_digests = zip244::Zip244Digests {
        header_digest,
        transparent_digest: transparent_txid_digest,
        sapling_digest: zip244::EMPTY_SAPLING_DIGEST,
        orchard_digest,
    };
    let txid_hash = zip244::compute_sighash(&txid_digests, state.branch_id);
    let txid = hex::encode(&txid_hash);

    info!("Shield tx built: {} bytes, txid: {}", tx_bytes.len(), txid);
    Ok((tx_bytes, txid))
}

fn plan_orchard_signature_application(
    is_real_spend: &[bool],
    signature_count: usize,
) -> Result<Vec<Option<usize>>> {
    let n_actions = is_real_spend.len();
    let n_real_spends = is_real_spend.iter().filter(|&&v| v).count();

    // Shield-wrap case: all spends are dummy (no real Orchard spends).
    // The device may still return signatures (it signs every action it receives),
    // but they're computed with the device's spending key, not the dummy's random
    // key, so they'd fail rk.verify(). Skip them — the correct dummy signatures
    // were already applied by finalize_io().
    if n_real_spends == 0 {
        info!(
            "No real Orchard spends — all {} actions are dummies, skipping {} device signature(s)",
            n_actions, signature_count
        );
        return Ok(vec![None; n_actions]);
    }

    if signature_count == n_actions {
        info!(
            "Applying Orchard signatures in full-action mode: {} signatures for {} actions ({} real spends)",
            signature_count, n_actions, n_real_spends
        );
        // Apply device sigs only to real spends; dummy spends keep their
        // finalize_io() signatures (device sigs use the wrong key for dummies).
        return Ok(is_real_spend.iter().enumerate().map(|(i, &real)| {
            if real { Some(i) } else { None }
        }).collect());
    }

    if signature_count == n_real_spends {
        info!(
            "Applying Orchard signatures in compact-spend mode: {} signatures for {} real spends ({} actions total)",
            signature_count, n_real_spends, n_actions
        );
        let mut next_sig = 0usize;
        return Ok(is_real_spend.iter().map(|&real_spend| {
            if real_spend {
                let current = next_sig;
                next_sig += 1;
                Some(current)
            } else {
                None
            }
        }).collect());
    }

    Err(anyhow::anyhow!(
        "Orchard signature count mismatch: got {} signatures for {} actions ({} real spends)",
        signature_count, n_actions, n_real_spends
    ))
}

/// Serialize a v5 transaction with both transparent and Orchard components.
fn serialize_v5_hybrid_tx(
    bundle: &orchard::Bundle<orchard::bundle::Authorized, i64>,
    transparent_inputs: &[zip244::TransparentInput],
    transparent_outputs: &[zip244::TransparentOutput],
    transparent_signatures: &[Vec<u8>],
    branch_id: u32,
    compressed_pubkey: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let mut tx = Vec::new();

    // Header (v5)
    let version: u32 = 5 | (1 << 31);
    tx.extend_from_slice(&version.to_le_bytes());
    tx.extend_from_slice(&0x26A7270Au32.to_le_bytes()); // version_group_id
    tx.extend_from_slice(&branch_id.to_le_bytes());
    tx.extend_from_slice(&0u32.to_le_bytes()); // lock_time
    tx.extend_from_slice(&0u32.to_le_bytes()); // expiry_height

    // Transparent inputs
    if transparent_signatures.len() < transparent_inputs.len() {
        return Err(anyhow::anyhow!(
            "Not enough transparent signatures: got {} but need {}",
            transparent_signatures.len(), transparent_inputs.len()
        ));
    }
    write_compact_size(&mut tx, transparent_inputs.len() as u64);
    for (i, input) in transparent_inputs.iter().enumerate() {
        tx.extend_from_slice(&input.prevout_hash);
        tx.extend_from_slice(&input.prevout_index.to_le_bytes());

        // P2PKH scriptSig: <push sig_len+1> <DER_sig> <SIGHASH_ALL> <push 33> <compressed_pubkey>
        let sig = &transparent_signatures[i];
        let pubkey = compressed_pubkey
            .ok_or_else(|| anyhow::anyhow!("Compressed pubkey required for P2PKH scriptSig"))?;
        if pubkey.len() != 33 {
            return Err(anyhow::anyhow!("Compressed pubkey must be 33 bytes, got {}", pubkey.len()));
        }

        let mut script_sig = Vec::new();
        // Push DER signature + SIGHASH_ALL byte
        script_sig.push((sig.len() + 1) as u8);
        script_sig.extend_from_slice(sig);
        script_sig.push(0x01); // SIGHASH_ALL
        // Push compressed public key
        script_sig.push(pubkey.len() as u8);
        script_sig.extend_from_slice(pubkey);

        write_compact_size(&mut tx, script_sig.len() as u64);
        tx.extend_from_slice(&script_sig);
        tx.extend_from_slice(&input.sequence.to_le_bytes());
    }

    // Transparent outputs
    write_compact_size(&mut tx, transparent_outputs.len() as u64);
    for output in transparent_outputs {
        tx.extend_from_slice(&(output.value as i64).to_le_bytes());
        write_compact_size(&mut tx, output.script_pubkey.len() as u64);
        tx.extend_from_slice(&output.script_pubkey);
    }

    // Sapling spends (varint 0)
    tx.push(0x00);
    // Sapling outputs (varint 0)
    tx.push(0x00);

    // Orchard bundle (same as shielded-only)
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

    tx.push(bundle.flags().to_byte());
    tx.extend_from_slice(&bundle.value_balance().to_le_bytes());
    tx.extend_from_slice(&bundle.anchor().to_bytes());

    let proof_bytes = bundle.authorization().proof().as_ref();
    write_compact_size(&mut tx, proof_bytes.len() as u64);
    tx.extend_from_slice(proof_bytes);

    for action in bundle.actions() {
        let sig_bytes: [u8; 64] = action.authorization().into();
        tx.extend_from_slice(&sig_bytes);
    }

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

// ── Deshielding (Orchard → transparent) ──────────────────────────────

/// Transparent output for deshield PCZT construction.
#[derive(Debug, Clone, Serialize)]
pub struct DeshieldTransparentOutput {
    pub script_pubkey: String,  // hex
    pub value: u64,             // zatoshis
}

/// Intermediate state for deshield PCZT (between build and finalize).
pub struct DeshieldPcztState {
    pub pczt_bundle: orchard::pczt::Bundle,
    pub sighash: [u8; 32],
    pub branch_id: u32,
    pub orchard_signing_request: SigningRequest,
    pub transparent_outputs: Vec<zip244::TransparentOutput>,
}

/// Build a deshield PCZT: Orchard spends → transparent output.
///
/// Uses the same tree-building + witness extraction as `build_pczt`, but instead
/// of an Orchard recipient output, the value goes to a transparent output.
/// Orchard change (if any) goes back to an internal Orchard address.
pub async fn build_deshield_pczt(
    fvk: &FullViewingKey,
    notes: Vec<SpendableNote>,
    transparent_output: DeshieldTransparentOutput,
    amount: u64,
    account: u32,
    branch_id: u32,
    lwd_client: &mut crate::scanner::LightwalletClient,
    _db: &crate::wallet_db::WalletDb,
) -> Result<DeshieldPcztState> {
    let mut rng = OsRng;
    let total_input: u64 = notes.iter().map(|n| n.value).sum();

    // ZIP-317 fee for a deshield tx:
    // Orchard actions = max(n_spends, n_orchard_outputs) where n_orchard_outputs = change only
    // Transparent logical actions = max(0 inputs, 1 output) = 1
    let n_spends = notes.len();
    let n_orchard_outputs = 1usize; // change output (or dummy pad)
    let orchard_actions = std::cmp::max(n_spends, n_orchard_outputs);
    let transparent_actions = 1usize; // one transparent output
    let logical_actions = orchard_actions + transparent_actions;
    let fee = ZIP317_MARGINAL_FEE * std::cmp::max(ZIP317_GRACE_ACTIONS, logical_actions as u64);

    let change = total_input.checked_sub(amount + fee)
        .ok_or_else(|| anyhow::anyhow!(
            "Insufficient shielded funds: have {} ZAT, need {} ZAT (amount {} + fee {})",
            total_input, amount + fee, amount, fee
        ))?;

    info!("Building deshield transaction:");
    info!("  Inputs:  {} ZAT from {} notes", total_input, notes.len());
    info!("  Amount:  {} ZAT → transparent", amount);
    info!("  Fee:     {} ZAT", fee);
    info!("  Change:  {} ZAT → Orchard", change);

    // Build transparent output
    let script_pubkey_bytes = hex::decode(&transparent_output.script_pubkey)?;
    let transparent_outputs = vec![
        zip244::TransparentOutput {
            value: amount,
            script_pubkey: script_pubkey_bytes,
        },
    ];

    // ── Tree building: reuse exact same pattern as build_pczt ──────────────

    const SHARD_SIZE: u64 = 1 << 16;
    let mut note_positions: Vec<u64> = vec![0; notes.len()];
    let mut found_notes = vec![false; notes.len()];
    let mut note_shards: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();

    for (i, spendable) in notes.iter().enumerate() {
        let approx_pos = if let Some(pos) = spendable.position {
            pos
        } else {
            let tree_size_before = if spendable.block_height > 0 {
                lwd_client.get_orchard_tree_size_at(spendable.block_height - 1).await?
            } else { 0 };
            tree_size_before
        };
        note_shards.insert((approx_pos / SHARD_SIZE) as u32);
        info!("Note {}: block={}, approx_shard={}", i, spendable.block_height, approx_pos / SHARD_SIZE);
    }

    let lwd_tip_height = lwd_client.get_latest_block_height().await?;
    let subtree_roots = lwd_client.get_subtree_roots(0, 0).await?;
    let num_shards = subtree_roots.len();

    if subtree_roots.is_empty() {
        return Err(anyhow::anyhow!("No Orchard subtree roots available from lightwalletd"));
    }

    let note_cmx_set: std::collections::HashMap<[u8; 32], usize> = notes.iter().enumerate()
        .map(|(i, n)| (n.cmx, i))
        .collect();

    let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
        ShardTree::new(MemoryShardStore::empty(), 100);

    // Insert completed shard roots (not containing our notes)
    for (shard_idx, root_hash, completing_height) in &subtree_roots {
        if note_shards.contains(shard_idx) { continue; }
        let root = MerkleHashOrchard::from_bytes(&root_hash);
        if bool::from(root.is_none()) { continue; }
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

        let (fetch_start_height, actions_to_skip) = if *shard_idx == 0 {
            (1687104u64, 0u64)
        } else {
            let prev_completing = subtree_roots.iter()
                .find(|(idx, _, _)| *idx == shard_idx - 1)
                .map(|(_, _, h)| *h)
                .unwrap_or(1687104);
            let tree_size_before_completing = if prev_completing > 0 {
                lwd_client.get_orchard_tree_size_at(prev_completing - 1).await?
            } else { 0 };
            let tree_size_after_completing = lwd_client.get_orchard_tree_size_at(prev_completing).await?;
            let plan = plan_incomplete_shard_fetch(
                prev_completing, shard_start_pos,
                tree_size_before_completing, tree_size_after_completing,
            );
            (plan.fetch_start_height, plan.actions_to_skip)
        };

        let is_complete_shard = subtree_roots.iter().any(|(idx, _, _)| idx == shard_idx);
        let shard_end_height = if is_complete_shard {
            subtree_roots.iter().find(|(idx, _, _)| idx == shard_idx).map(|(_, _, h)| *h).unwrap()
        } else { lwd_tip_height };
        let shard_end_pos = if is_complete_shard {
            (*shard_idx as u64 + 1) * SHARD_SIZE
        } else { u64::MAX };

        info!("Fetching leaves for shard {} (heights {} to {})", shard_idx, fetch_start_height, shard_end_height);

        let chunk_size = 10000u64;
        let mut current_pos = shard_start_pos;
        let mut current_height = fetch_start_height;
        let mut global_action_counter = 0u64;
        'block_fetch: while current_height <= shard_end_height {
            let end = std::cmp::min(current_height + chunk_size - 1, shard_end_height);
            let blocks = lwd_client.fetch_block_actions(current_height, end).await?;

            for (_block_height, txs) in &blocks {
                for (_tx_idx, cmxs) in txs {
                    for cmx_bytes in cmxs.iter() {
                        if global_action_counter < actions_to_skip {
                            global_action_counter += 1;
                            continue;
                        }
                        global_action_counter += 1;
                        if current_pos >= shard_end_pos { break 'block_fetch; }

                        let cmx = orchard::note::ExtractedNoteCommitment::from_bytes(cmx_bytes);
                        if bool::from(cmx.is_none()) { continue; }
                        let leaf = MerkleHashOrchard::from_cmx(&cmx.unwrap());

                        let retention = if let Some(&note_idx) = note_cmx_set.get(cmx_bytes) {
                            note_positions[note_idx] = current_pos;
                            found_notes[note_idx] = true;
                            info!("Note {} found at pos {}", note_idx, current_pos);
                            Retention::Marked
                        } else {
                            Retention::Ephemeral
                        };

                        tree.append(leaf, retention)
                            .context(format!("Failed to append leaf at pos {}", current_pos))?;
                        current_pos += 1;
                    }
                }
            }
            current_height = end + 1;
        }
    }

    // Reconstruct notes
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
            note_recipient, NoteValue::from_raw(spendable.value), rho, rseed,
        ).into_option()
            .ok_or_else(|| anyhow::anyhow!("Failed to reconstruct note {}", i))?;
        orchard_notes.push(note);
    }

    if found_notes.iter().any(|found| !found) {
        return Err(anyhow::anyhow!("Not all note cmxs found during tree walk"));
    }

    // Checkpoint and validate anchor
    let anchor_checkpoint_id = u32::MAX;
    tree.checkpoint(anchor_checkpoint_id).context("Failed to checkpoint")?;
    let root = tree.root_at_checkpoint_id(&anchor_checkpoint_id)
        .context("Failed to get root")?
        .ok_or_else(|| anyhow::anyhow!("Empty Merkle tree"))?;

    let computed_anchor_bytes = root.to_bytes();
    let expected_anchor = lwd_client.get_orchard_anchor(lwd_tip_height).await?;
    if computed_anchor_bytes != expected_anchor {
        return Err(anyhow::anyhow!(
            "Orchard anchor mismatch: computed={} vs expected={}",
            hex::encode(&computed_anchor_bytes), hex::encode(&expected_anchor),
        ));
    }
    let anchor: Anchor = root.into();

    // ── Build PCZT bundle ──────────────────────────────────────────

    let mut builder = Builder::new(BundleType::DEFAULT, anchor);

    let mut sorted_notes: Vec<(u64, usize)> = note_positions.iter().enumerate()
        .map(|(i, &pos)| (pos, i)).collect();
    sorted_notes.sort_by_key(|(pos, _)| *pos);

    for &(pos, orig_idx) in &sorted_notes {
        let position = incrementalmerkletree::Position::from(pos);
        let merkle_path = tree.witness_at_checkpoint_id(position, &anchor_checkpoint_id)
            .context(format!("Failed to get witness for note {} at pos {}", orig_idx, pos))?
            .ok_or_else(|| anyhow::anyhow!("No witness for note {} at pos {}", orig_idx, pos))?;
        builder.add_spend(fvk.clone(), orchard_notes[orig_idx].clone(), merkle_path.into())
            .map_err(|e| anyhow::anyhow!("Failed to add spend {}: {:?}", orig_idx, e))?;
    }

    // Change goes to Orchard (internal)
    if change > 0 {
        let change_addr = fvk.address_at(0u32, Scope::Internal);
        let internal_ovk = fvk.to_ovk(Scope::Internal);
        let empty_memo = { let mut m = [0u8; 512]; m[0] = 0xF6; m };
        builder.add_output(Some(internal_ovk), change_addr, NoteValue::from_raw(change), empty_memo)
            .map_err(|e| anyhow::anyhow!("Failed to add change output: {:?}", e))?;
    }

    let (mut pczt_bundle, _) = builder.build_for_pczt(&mut rng)
        .map_err(|e| anyhow::anyhow!("Failed to build PCZT: {:?}", e))?;

    // ── Compute ZIP-244 digests (hybrid: transparent outputs + Orchard) ──

    let effects_bundle = pczt_bundle.extract_effects::<i64>()
        .map_err(|e| anyhow::anyhow!("Failed to extract effects: {:?}", e))?
        .ok_or_else(|| anyhow::anyhow!("Empty effects bundle"))?;

    let digests = zip244::compute_zip244_digests_hybrid(
        &effects_bundle, &[], &transparent_outputs, branch_id, 0, 0,
    );
    let sighash = zip244::compute_sighash(&digests, branch_id);

    pczt_bundle.finalize_io(sighash, &mut rng)
        .map_err(|e| anyhow::anyhow!("IO finalization failed: {:?}", e))?;

    info!("Generating Halo2 proof for deshield...");
    let pk = ProvingKey::build();
    pczt_bundle.create_proof(&pk, &mut rng)
        .map_err(|e| anyhow::anyhow!("Proof generation failed: {:?}", e))?;
    info!("Proof generated successfully");

    // ── Extract signing fields ──────────────────────────────────────

    let n_actions = pczt_bundle.actions().len();
    let mut action_fields: Vec<ActionFields> = Vec::new();

    for i in 0..n_actions {
        let alpha_bytes = pczt_bundle.actions()[i].spend().alpha()
            .map(|a| a.to_repr().to_vec())
            .unwrap_or_else(|| vec![0u8; 32]);
        let cv_net_bytes = pczt_bundle.actions()[i].cv_net().to_bytes().to_vec();
        let is_spend = pczt_bundle.actions()[i].spend().spend_auth_sig().is_none();
        let value = pczt_bundle.actions()[i].spend().value()
            .map(|v| v.inner()).unwrap_or(0);

        let effects_action = &effects_bundle.actions()[i];
        let nullifier_bytes = effects_action.nullifier().to_bytes().to_vec();
        let cmx_bytes = effects_action.cmx().to_bytes().to_vec();
        let epk_bytes = effects_action.encrypted_note().epk_bytes.as_ref().to_vec();
        let enc = &effects_action.encrypted_note().enc_ciphertext;
        if enc.len() != 580 {
            return Err(anyhow::anyhow!("Invalid enc_ciphertext length: {}", enc.len()));
        }
        let rk_bytes: [u8; 32] = effects_action.rk().into();

        action_fields.push(ActionFields {
            index: i as u32,
            alpha: alpha_bytes,
            cv_net: cv_net_bytes,
            nullifier: nullifier_bytes,
            cmx: cmx_bytes,
            epk: epk_bytes,
            enc_compact: enc[..52].to_vec(),
            enc_memo: enc[52..564].to_vec(),
            enc_noncompact: enc[564..].to_vec(),
            rk: rk_bytes.to_vec(),
            out_ciphertext: effects_action.encrypted_note().out_ciphertext.to_vec(),
            value,
            is_spend,
        });
    }

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
            flags: effects_bundle.flags().to_byte() as u32,
            value_balance: *effects_bundle.value_balance(),
            anchor: effects_bundle.anchor().to_bytes().to_vec(),
        },
        actions: action_fields,
        display: DisplayInfo {
            amount: format!("{:.8} ZEC", amount as f64 / 1e8),
            fee: format!("{:.8} ZEC", fee as f64 / 1e8),
            to: format!("transparent (deshield)"),
        },
    };

    Ok(DeshieldPcztState {
        pczt_bundle,
        sighash,
        branch_id,
        orchard_signing_request: signing_request,
        transparent_outputs,
    })
}

/// Finalize a deshield PCZT: apply Orchard signatures, serialize hybrid v5 tx.
///
/// No transparent signatures needed — deshield has no transparent inputs.
pub fn finalize_deshield_pczt(
    state: DeshieldPcztState,
    orchard_signatures: &[Vec<u8>],
) -> Result<(Vec<u8>, String)> {
    let mut rng = OsRng;
    let mut pczt_bundle = state.pczt_bundle;
    let sighash = state.sighash;

    let n_actions = pczt_bundle.actions().len();
    let is_real_spend: Vec<bool> = (0..n_actions)
        .map(|i| pczt_bundle.actions()[i].spend().spend_auth_sig().is_none())
        .collect();
    let signature_plan = plan_orchard_signature_application(&is_real_spend, orchard_signatures.len())?;

    // Apply Orchard signatures
    for (i, sig_index) in signature_plan.iter().enumerate() {
        let Some(sig_index) = sig_index else {
            info!("Action {}: dummy spend — skipping", i);
            continue;
        };
        let sig_bytes = &orchard_signatures[*sig_index];
        if sig_bytes.len() != 64 {
            return Err(anyhow::anyhow!("Invalid Orchard sig length for action {}: {}", i, sig_bytes.len()));
        }

        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(sig_bytes);
        let signature: orchard::primitives::redpallas::Signature<orchard::primitives::redpallas::SpendAuth> = sig_arr.into();

        let rk = pczt_bundle.actions()[i].spend().rk();
        let verify_result = rk.verify(&sighash, &signature);
        if verify_result.is_err() {
            return Err(anyhow::anyhow!("Orchard sig verification failed for action {}", i));
        }

        pczt_bundle.actions_mut()[i]
            .apply_signature(sighash, signature)
            .map_err(|e| anyhow::anyhow!("Failed to apply sig for action {}: {}", i, e))?;
    }

    // Extract final bundle
    let unbound_bundle = pczt_bundle.extract::<i64>()
        .map_err(|e| anyhow::anyhow!("Failed to extract bundle: {}", e))?
        .ok_or_else(|| anyhow::anyhow!("Empty bundle after extraction"))?;

    let authorized_bundle = unbound_bundle.apply_binding_signature(sighash, &mut rng)
        .ok_or_else(|| anyhow::anyhow!("Binding signature verification failed"))?;

    // Serialize as hybrid v5 tx: no transparent inputs, transparent outputs, Orchard bundle
    let tx_bytes = serialize_v5_hybrid_tx(
        &authorized_bundle,
        &[],   // no transparent inputs
        &state.transparent_outputs,
        &[],   // no transparent signatures
        state.branch_id,
        None,  // no pubkey needed (no transparent inputs)
    )?;

    // Compute txid
    let header_digest = zip244::digest_header(state.branch_id, 0, 0);
    let transparent_txid_digest = zip244::digest_transparent_txid(
        &[],
        &state.transparent_outputs,
    );
    let orchard_digest = zip244::digest_orchard(&authorized_bundle);
    let txid_digests = zip244::Zip244Digests {
        header_digest,
        transparent_digest: transparent_txid_digest,
        sapling_digest: zip244::EMPTY_SAPLING_DIGEST,
        orchard_digest,
    };
    let txid_hash = zip244::compute_sighash(&txid_digests, state.branch_id);
    let txid = hex::encode(&txid_hash);

    info!("Deshield tx built: {} bytes, txid: {}", tx_bytes.len(), txid);
    Ok((tx_bytes, txid))
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{plan_incomplete_shard_fetch, plan_orchard_signature_application, IncompleteShardFetchPlan};
    use incrementalmerkletree::Retention;
    use orchard::tree::MerkleHashOrchard;
    use shardtree::{store::memory::MemoryShardStore, ShardTree};

    /// Generate a deterministic leaf from an index (for testing only).
    fn test_leaf(i: u64) -> MerkleHashOrchard {
        let mut buf = [0u8; 32];
        buf[..8].copy_from_slice(&i.to_le_bytes());
        // This produces a valid Pallas base field element for all small i
        MerkleHashOrchard::from_bytes(&buf).unwrap()
    }

    // ══════════════════════════════════════════════════════════════════════
    // 1. Anchor Correctness — tip checkpoint vs mid-block checkpoint
    // ══════════════════════════════════════════════════════════════════════

    /// The Orchard anchor must come from a checkpoint at the fully-built tree
    /// tip, not at an arbitrary note position within the tree.
    ///
    /// Background: Zcash consensus only recognizes anchors at block boundaries
    /// (the tree root after all actions in a block are appended). If you
    /// checkpoint the tree at a note's position mid-block, the resulting root
    /// will differ from the chain-recognized root and lightwalletd will reject
    /// it with: "unknown Orchard anchor: Root(...)".
    #[test]
    fn test_tip_checkpoint_differs_from_midblock_checkpoint() {
        let n_leaves = 20u64;
        let note_pos = 10u64; // a note in the middle

        // Build tree A: checkpoint at mid-block (the old buggy behavior)
        let mut tree_a: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for i in 0..n_leaves {
            let retention = if i == note_pos {
                Retention::Checkpoint { id: 0u32, marking: incrementalmerkletree::Marking::Marked }
            } else {
                Retention::Ephemeral
            };
            tree_a.append(test_leaf(i), retention).unwrap();
        }
        let root_mid = tree_a.root_at_checkpoint_id(&0u32).unwrap().unwrap();

        // Build tree B: all leaves ephemeral/marked, checkpoint at tip (the fix)
        let mut tree_b: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for i in 0..n_leaves {
            let retention = if i == note_pos {
                Retention::Marked
            } else {
                Retention::Ephemeral
            };
            tree_b.append(test_leaf(i), retention).unwrap();
        }
        tree_b.checkpoint(1u32).unwrap();
        let root_tip = tree_b.root_at_checkpoint_id(&1u32).unwrap().unwrap();

        // The mid-block root must NOT equal the tip root — this is the bug
        assert_ne!(
            root_mid.to_bytes(), root_tip.to_bytes(),
            "Mid-block checkpoint root should differ from tip checkpoint root. \
             If they're equal the tree only has leaves up to the note position, \
             which means the test setup is wrong."
        );
    }

    #[test]
    fn orchard_signature_plan_full_action_all_real() {
        // All actions are real spends: apply one sig per action
        let plan = plan_orchard_signature_application(&[true, true], 2).unwrap();
        assert_eq!(plan, vec![Some(0), Some(1)]);
    }

    /// z2z: 1 real spend + 1 dummy, device returns 2 sigs (one per action).
    /// Must apply sig only to real spend, skip dummy.
    #[test]
    fn orchard_signature_plan_full_action_with_dummy() {
        let plan = plan_orchard_signature_application(&[true, false], 2).unwrap();
        assert_eq!(plan, vec![Some(0), None]);
    }

    /// Same but shuffled — dummy first, real second.
    #[test]
    fn orchard_signature_plan_full_action_dummy_first() {
        let plan = plan_orchard_signature_application(&[false, true], 2).unwrap();
        assert_eq!(plan, vec![None, Some(1)]);
    }

    #[test]
    fn orchard_signature_plan_supports_compact_spend_mode() {
        let plan = plan_orchard_signature_application(&[false, true, false, true], 2).unwrap();
        assert_eq!(plan, vec![None, Some(0), None, Some(1)]);
    }

    #[test]
    fn orchard_signature_plan_rejects_mismatched_counts() {
        let err = plan_orchard_signature_application(&[false, true, false], 2).unwrap_err();
        assert!(err.to_string().contains("signature count mismatch"));
    }

    /// Shield-wrap: 0 real spends, device returns sigs anyway → skip all.
    /// The dummy signatures from finalize_io() are the correct ones.
    #[test]
    fn orchard_signature_plan_skips_all_for_no_real_spends() {
        // Device sent 2 sigs for 2 actions, but both are dummies
        let plan = plan_orchard_signature_application(&[false, false], 2).unwrap();
        assert_eq!(plan, vec![None, None]);
    }

    /// Shield-wrap where device correctly sends 0 Orchard sigs.
    #[test]
    fn orchard_signature_plan_handles_zero_sigs_zero_real_spends() {
        let plan = plan_orchard_signature_application(&[false, false], 0).unwrap();
        assert_eq!(plan, vec![None, None]);
    }

    /// The tip-checkpoint root must be deterministic: inserting the same
    /// leaves in the same order must always produce the same anchor.
    #[test]
    fn test_tip_anchor_is_deterministic() {
        let n_leaves = 50u64;

        let build = || {
            let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
                ShardTree::new(MemoryShardStore::empty(), 100);
            for i in 0..n_leaves {
                tree.append(test_leaf(i), Retention::Ephemeral).unwrap();
            }
            tree.checkpoint(0u32).unwrap();
            tree.root_at_checkpoint_id(&0u32).unwrap().unwrap().to_bytes()
        };

        let root1 = build();
        let root2 = build();
        assert_eq!(root1, root2, "Same leaves must produce same anchor");
    }

    /// Multiple notes scattered across the tree must all get valid witnesses
    /// when using a single tip checkpoint (the correct approach).
    #[test]
    fn test_multiple_notes_witnesses_from_tip_checkpoint() {
        let n_leaves = 100u64;
        let note_positions = vec![5u64, 25, 50, 75, 99]; // scattered

        let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
            ShardTree::new(MemoryShardStore::empty(), 100);

        for i in 0..n_leaves {
            let retention = if note_positions.contains(&i) {
                Retention::Marked
            } else {
                Retention::Ephemeral
            };
            tree.append(test_leaf(i), retention).unwrap();
        }

        // Single checkpoint at the tip
        let ckpt = u32::MAX;
        tree.checkpoint(ckpt).unwrap();

        let root = tree.root_at_checkpoint_id(&ckpt).unwrap().unwrap();
        assert_ne!(root.to_bytes(), [0u8; 32], "Root must not be zero");

        // Every note position must produce a valid witness
        for &pos in &note_positions {
            let position = incrementalmerkletree::Position::from(pos);
            let witness = tree.witness_at_checkpoint_id(position, &ckpt);
            assert!(
                witness.is_ok() && witness.unwrap().is_some(),
                "Note at position {} must have a valid witness from tip checkpoint",
                pos,
            );
        }
    }

    /// A note marked with Retention::Checkpoint at its position produces a
    /// different root than the same tree checkpointed at the tip — this
    /// demonstrates why per-note checkpointing is wrong for Zcash anchors.
    #[test]
    fn test_per_note_checkpoint_root_is_not_chain_root() {
        let n_leaves = 30u64;
        let note_pos = 15u64;

        // Tree with per-note checkpoint (buggy approach)
        let mut tree_buggy: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for i in 0..n_leaves {
            let retention = if i == note_pos {
                Retention::Checkpoint { id: 0u32, marking: incrementalmerkletree::Marking::Marked }
            } else {
                Retention::Ephemeral
            };
            tree_buggy.append(test_leaf(i), retention).unwrap();
        }
        let buggy_root = tree_buggy.root_at_checkpoint_id(&0u32).unwrap().unwrap();

        // The buggy root is computed as if the tree stopped at position 15,
        // with empty subtrees for positions 16-29. The chain's actual root
        // includes all 30 leaves. They must differ.
        //
        // This is the exact failure mode: lightwalletd says
        // "unknown Orchard anchor: Root(...)" because the anchor we sent
        // is not one the chain recognizes.

        // Build the "chain" root (all leaves, checkpoint at end)
        let mut tree_chain: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 32, 16> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for i in 0..n_leaves {
            tree_chain.append(test_leaf(i), Retention::Ephemeral).unwrap();
        }
        tree_chain.checkpoint(0u32).unwrap();
        let chain_root = tree_chain.root_at_checkpoint_id(&0u32).unwrap().unwrap();

        assert_ne!(
            buggy_root.to_bytes(),
            chain_root.to_bytes(),
            "Per-note checkpoint root must differ from chain tip root — \
             this proves the 'unknown Orchard anchor' bug"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. ShardTree insert() + append() mix — reproducer for anchor mismatch
    // ══════════════════════════════════════════════════════════════════════

    /// This is the critical test: does mixing insert() for completed shards
    /// with append() for the incomplete shard produce the same root as
    /// building the entire tree from individual leaves?
    ///
    /// Uses ShardTree<_, 8, 4> (depth 8, shard height 4, 16 leaves/shard)
    /// so we can build the full "reference" tree in the test.
    #[test]
    fn test_insert_shard_roots_plus_append_vs_all_append() {
        use incrementalmerkletree::{Address, Position};

        // 3 complete shards (48 leaves) + 10 leaves in incomplete shard 3 = 58 total
        let shard_size: u64 = 1 << 4; // 16
        let n_complete_shards = 3u64;
        let extra_leaves = 10u64;
        let total_leaves = n_complete_shards * shard_size + extra_leaves;

        // Step 1: Build the reference tree from ALL individual leaves
        let mut ref_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for i in 0..total_leaves {
            ref_tree.append(test_leaf(i), Retention::Ephemeral).unwrap();
        }
        ref_tree.checkpoint(0u32).unwrap();
        let ref_root = ref_tree.root_at_checkpoint_id(&0u32).unwrap().unwrap();

        // Step 2: Compute shard roots for shards 0-2 by building sub-trees
        let mut shard_roots: Vec<[u8; 32]> = Vec::new();
        for shard_idx in 0..n_complete_shards {
            let mut shard_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 4, 4> =
                ShardTree::new(MemoryShardStore::empty(), 100);
            for j in 0..shard_size {
                let leaf_idx = shard_idx * shard_size + j;
                shard_tree.append(test_leaf(leaf_idx), Retention::Ephemeral).unwrap();
            }
            shard_tree.checkpoint(0u32).unwrap();
            let shard_root = shard_tree.root_at_checkpoint_id(&0u32).unwrap().unwrap();
            shard_roots.push(shard_root.to_bytes());
        }

        // Step 3: Build hybrid tree — insert() for completed shards, append() for leaves
        let mut hybrid_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);

        for (shard_idx, root_bytes) in shard_roots.iter().enumerate() {
            let root = MerkleHashOrchard::from_bytes(root_bytes).unwrap();
            let addr = Address::above_position(
                4.into(), // shard height = 4
                Position::from((shard_idx as u64) * shard_size),
            );
            hybrid_tree.insert(addr, root).unwrap();
        }

        // Append individual leaves for the incomplete shard
        for j in 0..extra_leaves {
            let leaf_idx = n_complete_shards * shard_size + j;
            hybrid_tree.append(test_leaf(leaf_idx), Retention::Ephemeral).unwrap();
        }
        hybrid_tree.checkpoint(1u32).unwrap();
        let hybrid_root = hybrid_tree.root_at_checkpoint_id(&1u32).unwrap().unwrap();

        // This is the anchor mismatch bug — if this fails, insert()+append() is broken
        assert_eq!(
            ref_root.to_bytes(),
            hybrid_root.to_bytes(),
            "Hybrid tree (insert shard roots + append leaves) must produce the same \
             root as the reference tree (all individual leaves). If this fails, the \
             ShardTree insert()+append() mix produces wrong anchors — the root cause \
             of 'unknown Orchard anchor' errors."
        );
    }

    #[test]
    fn test_incomplete_shard_fetch_plan_handles_cross_boundary_actions() {
        let shard_start_pos = 760u64 * (1 << 16);
        let tree_size_before_completing = shard_start_pos - 12;
        let tree_size_after_completing = shard_start_pos + 7;

        let plan = plan_incomplete_shard_fetch(
            3265881,
            shard_start_pos,
            tree_size_before_completing,
            tree_size_after_completing,
        );

        assert_eq!(
            plan,
            IncompleteShardFetchPlan {
                fetch_start_height: 3265881,
                actions_to_skip: 12,
                cross_boundary: 7,
            },
            "When the shard-completing block straddles the boundary, we must \
             restart at the completing block and skip only the actions that \
             belong to the completed shard."
        );
    }

    #[test]
    fn test_incomplete_shard_fetch_plan_skips_completing_block_without_cross_boundary() {
        let shard_start_pos = 760u64 * (1 << 16);
        let tree_size_before_completing = shard_start_pos - 20;
        let tree_size_after_completing = shard_start_pos;

        let plan = plan_incomplete_shard_fetch(
            3265881,
            shard_start_pos,
            tree_size_before_completing,
            tree_size_after_completing,
        );

        assert_eq!(
            plan,
            IncompleteShardFetchPlan {
                fetch_start_height: 3265882,
                actions_to_skip: 0,
                cross_boundary: 0,
            },
            "When the completing block exactly ends the prior shard, the \
             incomplete shard must start at the next block with no skipped actions."
        );
    }

    /// Single action crosses the boundary — the degenerate case.
    #[test]
    fn test_incomplete_shard_fetch_plan_single_action_cross_boundary() {
        let shard_start_pos = 100u64 * (1 << 16);
        // Block has 1 action in prior shard and 1 crossing into incomplete shard
        let tree_size_before = shard_start_pos - 1;
        let tree_size_after = shard_start_pos + 1;

        let plan = plan_incomplete_shard_fetch(
            5000000,
            shard_start_pos,
            tree_size_before,
            tree_size_after,
        );

        assert_eq!(plan.fetch_start_height, 5000000);
        assert_eq!(plan.actions_to_skip, 1);
        assert_eq!(plan.cross_boundary, 1);
    }

    /// Completing block starts exactly at the shard boundary — all actions
    /// in the block belong to the new shard.
    #[test]
    fn test_incomplete_shard_fetch_plan_all_actions_cross_boundary() {
        let shard_start_pos = 50u64 * (1 << 16);
        let tree_size_before = shard_start_pos; // prior shard already full before this block
        let tree_size_after = shard_start_pos + 30;

        let plan = plan_incomplete_shard_fetch(
            2000000,
            shard_start_pos,
            tree_size_before,
            tree_size_after,
        );

        assert_eq!(plan.fetch_start_height, 2000000);
        assert_eq!(plan.actions_to_skip, 0, "No actions belong to prior shard");
        assert_eq!(plan.cross_boundary, 30, "All 30 actions cross into incomplete shard");
    }

    /// Empty completing block (no Orchard actions) — should start at next block.
    #[test]
    fn test_incomplete_shard_fetch_plan_empty_completing_block() {
        let shard_start_pos = 10u64 * (1 << 16);
        let tree_size_before = shard_start_pos - 5;
        // tree_size unchanged = no actions in the completing block
        let tree_size_after = tree_size_before;

        let plan = plan_incomplete_shard_fetch(
            1700000,
            shard_start_pos,
            tree_size_before,
            tree_size_after,
        );

        // No actions in the block, so no cross-boundary, start at next block
        assert_eq!(plan.fetch_start_height, 1700001);
        assert_eq!(plan.actions_to_skip, 0);
        assert_eq!(plan.cross_boundary, 0);
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2b. Integration: skipping cross-boundary leaves produces wrong root
    // ══════════════════════════════════════════════════════════════════════

    /// Simulates the actual bug: when a completing block straddles the shard
    /// boundary, skipping the cross-boundary leaves (the old code path)
    /// produces a different tree root than including them (the fix).
    ///
    /// Uses ShardTree<_, 8, 4> (depth 8, shard height 4 = 16 leaves/shard).
    #[test]
    fn test_skipping_cross_boundary_leaves_produces_wrong_root() {
        use incrementalmerkletree::{Address, Position};

        let shard_size: u64 = 1 << 4; // 16
        let n_complete_shards = 2u64;
        // Simulate: completing block for shard 1 has 20 actions total,
        // 12 fill shard 1 and 8 cross into shard 2 (incomplete).
        let cross_boundary_leaves = 8u64;
        let extra_leaves_after = 5u64; // more leaves in blocks after the completing block
        let total_incomplete = cross_boundary_leaves + extra_leaves_after;
        let total_leaves = n_complete_shards * shard_size + total_incomplete;

        // Reference: all leaves via append
        let mut ref_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for i in 0..total_leaves {
            ref_tree.append(test_leaf(i), Retention::Ephemeral).unwrap();
        }
        ref_tree.checkpoint(0u32).unwrap();
        let ref_root = ref_tree.root_at_checkpoint_id(&0u32).unwrap().unwrap();

        // Compute shard roots for completed shards
        let mut shard_roots: Vec<[u8; 32]> = Vec::new();
        for s in 0..n_complete_shards {
            let mut st: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 4, 4> =
                ShardTree::new(MemoryShardStore::empty(), 100);
            for j in 0..shard_size {
                st.append(test_leaf(s * shard_size + j), Retention::Ephemeral).unwrap();
            }
            st.checkpoint(0u32).unwrap();
            shard_roots.push(st.root_at_checkpoint_id(&0u32).unwrap().unwrap().to_bytes());
        }

        // CORRECT tree: insert shard roots + append ALL incomplete shard leaves
        // (including the cross-boundary ones)
        let mut correct_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for (s, root_bytes) in shard_roots.iter().enumerate() {
            let root = MerkleHashOrchard::from_bytes(root_bytes).unwrap();
            let addr = Address::above_position(
                4.into(),
                Position::from((s as u64) * shard_size),
            );
            correct_tree.insert(addr, root).unwrap();
        }
        let incomplete_start = n_complete_shards * shard_size;
        for j in 0..total_incomplete {
            correct_tree.append(test_leaf(incomplete_start + j), Retention::Ephemeral).unwrap();
        }
        correct_tree.checkpoint(1u32).unwrap();
        let correct_root = correct_tree.root_at_checkpoint_id(&1u32).unwrap().unwrap();

        // BUGGY tree: insert shard roots + SKIP cross-boundary leaves
        // (only append leaves from the block AFTER the completing block)
        let mut buggy_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for (s, root_bytes) in shard_roots.iter().enumerate() {
            let root = MerkleHashOrchard::from_bytes(root_bytes).unwrap();
            let addr = Address::above_position(
                4.into(),
                Position::from((s as u64) * shard_size),
            );
            buggy_tree.insert(addr, root).unwrap();
        }
        // Skip the first `cross_boundary_leaves` — this is what the old code did
        for j in cross_boundary_leaves..total_incomplete {
            buggy_tree.append(test_leaf(incomplete_start + j), Retention::Ephemeral).unwrap();
        }
        buggy_tree.checkpoint(2u32).unwrap();
        let buggy_root = buggy_tree.root_at_checkpoint_id(&2u32).unwrap().unwrap();

        // Correct tree must match reference
        assert_eq!(
            ref_root.to_bytes(),
            correct_root.to_bytes(),
            "Correct hybrid tree (with cross-boundary leaves) must match the reference"
        );

        // Buggy tree must NOT match — this is the "unknown Orchard anchor" bug
        assert_ne!(
            ref_root.to_bytes(),
            buggy_root.to_bytes(),
            "Skipping cross-boundary leaves must produce a DIFFERENT (wrong) root — \
             this is the exact 'unknown Orchard anchor' failure mode"
        );
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. ZIP-302 Memo Encoding
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fn test_memo_encoding_text() {
        let memo = Some("Hello, Zcash!".to_string());
        let mut buf = [0u8; 512];
        if let Some(ref text) = memo {
            let bytes = text.as_bytes();
            let len = std::cmp::min(bytes.len(), 512);
            buf[..len].copy_from_slice(&bytes[..len]);
        } else {
            buf[0] = 0xF6;
        }
        assert_eq!(&buf[..13], b"Hello, Zcash!");
        assert_eq!(buf[13], 0); // zero-padded
        assert!(buf[0] < 0xF5, "Text memo first byte must be < 0xF5 per ZIP-302");
    }

    #[test]
    fn test_memo_encoding_empty_is_f6() {
        let memo: Option<String> = None;
        let mut buf = [0u8; 512];
        if let Some(ref text) = memo {
            let bytes = text.as_bytes();
            let len = std::cmp::min(bytes.len(), 512);
            buf[..len].copy_from_slice(&bytes[..len]);
        } else {
            buf[0] = 0xF6;
        }
        assert_eq!(buf[0], 0xF6, "Empty memo must use 0xF6 per ZIP-302");
        assert!(buf[1..].iter().all(|&b| b == 0), "Rest must be zeros");
    }

    #[test]
    fn test_memo_encoding_max_length() {
        let text = "A".repeat(512);
        let memo = Some(text.clone());
        let mut buf = [0u8; 512];
        if let Some(ref text) = memo {
            let bytes = text.as_bytes();
            let len = std::cmp::min(bytes.len(), 512);
            buf[..len].copy_from_slice(&bytes[..len]);
        }
        assert!(buf.iter().all(|&b| b == b'A'), "All 512 bytes should be 'A'");
    }

    #[test]
    fn test_memo_truncation_at_512() {
        let text = "B".repeat(600); // longer than 512
        let bytes = text.as_bytes();
        let len = std::cmp::min(bytes.len(), 512);
        let mut buf = [0u8; 512];
        buf[..len].copy_from_slice(&bytes[..len]);
        assert_eq!(len, 512, "Should truncate to 512");
        assert!(buf.iter().all(|&b| b == b'B'));
    }
}
