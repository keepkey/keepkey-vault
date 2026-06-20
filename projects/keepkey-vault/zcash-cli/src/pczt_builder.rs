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
    circuit::{ProvingKey, VerifyingKey},
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

/// ZIP-317 fee for a deshield tx (Orchard spends → 1 transparent output, 1 change note).
///
/// Per ZIP-317 §3, `logical_actions` uses the FINAL Orchard `action_count`
/// (post-padding) — not the pre-padding `max(n_spends, n_outputs)`.
/// `BundleType::DEFAULT` pads to a 2-action minimum for the anonymity set,
/// so a 1-spend deshield has 2 orchard actions on chain.
///
/// Underpaying triggers the chain's "Unpaid actions is higher than the limit"
/// mempool rejection even when the orchard proof verifies cleanly — because
/// `unpaid_actions = ceil((expected_fee - actual_fee) / marginal_fee) > 0`.
fn zip317_deshield_fee(n_spends: usize) -> u64 {
    const N_TRANSPARENT_ACTIONS: u64 = 1; // one transparent output
    const N_ORCHARD_OUTPUTS: usize = 1;   // change note
    let orchard_actions = std::cmp::max(2, std::cmp::max(n_spends, N_ORCHARD_OUTPUTS)) as u64;
    let logical_actions = orchard_actions + N_TRANSPARENT_ACTIONS;
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
    // Clear-signing fields (firmware >= 7.15 clear-signing protocol)
    // Only present for output actions (is_spend = false).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,  // hex-encoded 43-byte Orchard receiver (d || pk_d)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rseed: Option<String>,      // hex-encoded 32-byte note randomness seed
}

/// Plaintext Zcash v5 transaction header fields needed by clear-signing firmware.
/// Firmware recomputes the ZIP-244 header digest from these and verifies it matches
/// the provided header_digest before signing.
#[derive(Debug, Serialize)]
pub struct HeaderFields {
    pub tx_version: u32,
    pub version_group_id: u32,
    pub lock_time: u32,
    pub expiry_height: u32,
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
    pub header_fields: HeaderFields,
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
    // sapling omitted — clear-signing firmware rejects sapling_digest if set
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

    // Extend the tree past the last COMPLETED shard up to the chain tip by
    // appending the final incomplete shard's leaves as frontier-only
    // (Ephemeral). Without this the tree stops at the last completed shard
    // boundary while the anchor at lwd_tip_height covers every commitment up
    // to the tip — so the locally reconstructed root can't be computed at the
    // tip checkpoint ("Failed to get Merkle root") / mismatches lightwalletd.
    //
    // Skip when our notes are already in that incomplete shard: the per-note
    // loop above walks it to the tip (shard_end_pos = u64::MAX), so a second
    // pass here would double-append. This mirrors build_deshield_pczt.
    let last_completed_shard = num_shards as u32;
    let last_completed_height = subtree_roots.last().map(|(_, _, h)| *h).unwrap_or(1687104);
    if !note_shards.contains(&last_completed_shard) && lwd_tip_height > last_completed_height {
        let shard_start_pos = (last_completed_shard as u64) * SHARD_SIZE;
        let tree_size_before_completing = if last_completed_height > 0 {
            lwd_client.get_orchard_tree_size_at(last_completed_height - 1).await?
        } else { 0 };
        let tree_size_after_completing = lwd_client.get_orchard_tree_size_at(last_completed_height).await?;
        let plan = plan_incomplete_shard_fetch(
            last_completed_height, shard_start_pos,
            tree_size_before_completing, tree_size_after_completing,
        );
        info!(
            "Extending tree past shard {} to chain tip (heights {} to {}, skip {} actions)",
            last_completed_shard, plan.fetch_start_height, lwd_tip_height, plan.actions_to_skip,
        );

        let chunk_size = 10000u64;
        let mut current_pos = shard_start_pos;
        let mut current_height = plan.fetch_start_height;
        let mut global_action_counter = 0u64;
        while current_height <= lwd_tip_height {
            let end = std::cmp::min(current_height + chunk_size - 1, lwd_tip_height);
            let blocks = lwd_client.fetch_block_actions(current_height, end).await?;

            for (_block_height, txs) in &blocks {
                for (_tx_idx, cmxs) in txs {
                    for cmx_bytes in cmxs.iter() {
                        if global_action_counter < plan.actions_to_skip {
                            global_action_counter += 1;
                            continue;
                        }
                        global_action_counter += 1;

                        let cmx = ExtractedNoteCommitment::from_bytes(cmx_bytes);
                        if bool::from(cmx.is_none()) { continue; }
                        let leaf = MerkleHashOrchard::from_cmx(&cmx.unwrap());
                        // Ephemeral: frontier-only, present so the locally
                        // reconstructed root reflects the chain tip.
                        tree.append(leaf, Retention::Ephemeral)
                            .context(format!("Failed to append frontier leaf at pos {}", current_pos))?;
                        current_pos += 1;
                    }
                }
            }
            current_height = end + 1;
        }
        info!("Frontier extension done: tree size now {}", current_pos);
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
        // Firmware uses value to verify the OUTPUT note commitment (cmx = commit(recipient, value, rseed, rho)).
        // Always send output.value(), not spend.value().
        let value = pczt_bundle.actions()[i].output().value()
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

        // Every Orchard action has a spend+output pair. The PCZT stores plaintext
        // recipient+rseed in the output fields — read them directly, same as build_shield_pczt.
        let out = pczt_bundle.actions()[i].output();
        let orchard_recipient = out.recipient().as_ref().map(|addr| hex::encode(addr.to_raw_address_bytes()));
        let orchard_rseed = out.rseed().as_ref().map(|rs| hex::encode(rs.as_bytes()));
        if orchard_recipient.is_none() {
            debug!("Action {} output has no recipient in PCZT — dummy output", i);
        }

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
            recipient: orchard_recipient,
            rseed: orchard_rseed,
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
            orchard: digests.orchard_digest.to_vec(),
        },
        header_fields: HeaderFields {
            tx_version: 5,
            version_group_id: 0x26A7270A,
            lock_time: 0,
            expiry_height: 0,
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
    pub sighash: Vec<u8>,       // 32-byte per-input sighash (kept for finalize; firmware computes own)
    pub address_path: Vec<u32>, // BIP44 path [44', 133', 0', 0, 0]
    pub amount: u64,            // zatoshis
    // Plaintext fields for clear-signing firmware (firmware >= 7.15 clear-signing protocol)
    pub prevout_txid: String,   // hex-encoded 32-byte txid (internal/LE byte order)
    pub prevout_index: u32,
    pub sequence: u32,
    pub script_pubkey: String,  // hex-encoded scriptPubKey
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
    for (i, input) in zip_inputs.iter().enumerate() {
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
            amount: input.value,
            prevout_txid: hex::encode(input.prevout_hash),
            prevout_index: input.prevout_index,
            sequence: input.sequence,
            script_pubkey: hex::encode(&input.script_pubkey),
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

    // Extract Orchard signing fields
    let n_actions = pczt_bundle.actions().len();
    let mut action_fields: Vec<ActionFields> = Vec::new();

    for i in 0..n_actions {
        let alpha_bytes = pczt_bundle.actions()[i].spend().alpha()
            .map(|a| a.to_repr().to_vec())
            .unwrap_or_else(|| vec![0u8; 32]);
        let cv_net_bytes = pczt_bundle.actions()[i].cv_net().to_bytes().to_vec();
        let is_spend = pczt_bundle.actions()[i].spend().spend_auth_sig().is_none();
        // For output actions (is_spend=false), the note value is in output().value().
        // spend().value() is the dummy-spend value (always 0) — reading it for outputs
        // causes "Orchard note commitment mismatch" because firmware recomputes cmx
        // from recipient + value + rseed + nullifier.
        let value = if is_spend {
            pczt_bundle.actions()[i].spend().value().map(|v| v.inner()).unwrap_or(0)
        } else {
            pczt_bundle.actions()[i].output().value().map(|v| v.inner()).unwrap_or(0)
        };

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

        // For output actions, read recipient + rseed directly from the PCZT output fields.
        // The PCZT builder stores these in plaintext — no decryption needed.
        let (orchard_recipient, orchard_rseed) = if !is_spend {
            let out = pczt_bundle.actions()[i].output();
            let r = out.recipient().as_ref().map(|addr| hex::encode(addr.to_raw_address_bytes()));
            let s = out.rseed().as_ref().map(|rs| hex::encode(rs.as_bytes()));
            if r.is_none() { debug!("PCZT output action {} has no recipient field", i); }
            if s.is_none() { debug!("PCZT output action {} has no rseed field", i); }
            (r, s)
        } else {
            (None, None)
        };

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
            recipient: orchard_recipient,
            rseed: orchard_rseed,
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
            orchard: digests.orchard_digest.to_vec(),
        },
        header_fields: HeaderFields {
            tx_version: 5,
            version_group_id: 0x26A7270A,
            lock_time: 0,
            expiry_height: 0,
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

    // In-process proof verification — catches circuit constraint violations BEFORE broadcast.
    // If this fails, the chain would reject with "could not validate orchard proof".
    let vk = VerifyingKey::build();
    authorized_bundle.verify_proof(&vk)
        .map_err(|e| anyhow::anyhow!("Local Orchard proof verification FAILED (would be rejected on-chain): {:?}", e))?;
    info!("Local Orchard proof verification: PASSED");

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

    // ── DIAGNOSTIC: orchard digest consistency check ─────────────────────
    // The Orchard digest in the effects_bundle sighash MUST equal the Orchard digest
    // from the authorized_bundle. Any change introduced by finalize_io (which should
    // not exist per the orchard crate spec) would cause the binding sig and spend auth
    // sigs to be bound to a different Orchard digest than what's serialized on-chain.
    //
    // NOTE: for hybrid (shield) transactions, state.sighash (S.2 form, includes amounts
    // and scripts) intentionally differs from txid_hash (T.1 form). They are computing
    // different things. What must match is the Orchard digest component.
    info!("Orchard sighash (S.2 form, for Orchard binding+spend auth sigs): {}", hex::encode(&state.sighash));
    info!("Txid (T.1 form, transaction identifier): {}", hex::encode(&txid_hash));
    let effects_orchard_digest: [u8; 32] = state.orchard_signing_request.digests.orchard
        .as_slice().try_into().unwrap_or([0u8; 32]);
    if effects_orchard_digest != orchard_digest {
        log::error!("ORCHARD DIGEST MISMATCH: finalize_io changed ciphertext/actions — binding sig sighash is inconsistent with serialized tx");
        log::error!("  Orchard digest in effects sighash (for binding sig): {}", hex::encode(&effects_orchard_digest));
        log::error!("  Orchard digest from authorized bundle (on-chain):    {}", hex::encode(&orchard_digest));
    } else {
        info!("Orchard digest: MATCH — binding sig sighash is consistent with authorized bundle");
    }
    // ── END sighash check ─────────────────────────────────────────────────

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

    let n_spends = notes.len();
    let fee = zip317_deshield_fee(n_spends);

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

    // Extend the local tree past the last completed shard up to the chain
    // tip, mirroring the shield path's incomplete-shard fetch (lines ~998-1063).
    // Without this, the tree only reflects state at the end of the last
    // shard containing a spent note — but the chain's anchor at lwd_tip_height
    // includes every commitment after that, so the locally-computed root
    // can never match `get_orchard_anchor(lwd_tip_height)` and the build
    // fails with "Orchard anchor mismatch".
    //
    // Skip this when our notes are already in the latest incomplete shard;
    // that shard's per-note loop above already walks to the tip (shard_end_pos
    // = u64::MAX, shard_end_height = lwd_tip_height), so a second pass here
    // would double-append leaves.
    let last_completed_shard = subtree_roots.len() as u32;
    let last_completed_height = subtree_roots.last().map(|(_, _, h)| *h).unwrap_or(1687104);
    if !note_shards.contains(&last_completed_shard) && lwd_tip_height > last_completed_height {
        let shard_start_pos = (last_completed_shard as u64) * SHARD_SIZE;
        let tree_size_before_completing = if last_completed_height > 0 {
            lwd_client.get_orchard_tree_size_at(last_completed_height - 1).await?
        } else { 0 };
        let tree_size_after_completing = lwd_client.get_orchard_tree_size_at(last_completed_height).await?;
        let plan = plan_incomplete_shard_fetch(
            last_completed_height, shard_start_pos,
            tree_size_before_completing, tree_size_after_completing,
        );
        info!(
            "Extending tree past shard {} to chain tip (heights {} to {}, skip {} actions)",
            last_completed_shard, plan.fetch_start_height, lwd_tip_height, plan.actions_to_skip,
        );

        let chunk_size = 10000u64;
        let mut current_pos = shard_start_pos;
        let mut current_height = plan.fetch_start_height;
        let mut global_action_counter = 0u64;
        while current_height <= lwd_tip_height {
            let end = std::cmp::min(current_height + chunk_size - 1, lwd_tip_height);
            let blocks = lwd_client.fetch_block_actions(current_height, end).await?;

            for (_block_height, txs) in &blocks {
                for (_tx_idx, cmxs) in txs {
                    for cmx_bytes in cmxs.iter() {
                        if global_action_counter < plan.actions_to_skip {
                            global_action_counter += 1;
                            continue;
                        }
                        global_action_counter += 1;

                        let cmx = orchard::note::ExtractedNoteCommitment::from_bytes(cmx_bytes);
                        if bool::from(cmx.is_none()) { continue; }
                        let leaf = MerkleHashOrchard::from_cmx(&cmx.unwrap());
                        // Ephemeral: we never need to spend these — they're frontier-only,
                        // present so the locally-reconstructed root reflects the chain tip.
                        tree.append(leaf, Retention::Ephemeral)
                            .context(format!("Failed to append frontier leaf at pos {}", current_pos))?;
                        current_pos += 1;
                    }
                }
            }
            current_height = end + 1;
        }
        info!("Frontier extension done: tree size now {}", current_pos);
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
            recipient: None,
            rseed: None,
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
            orchard: digests.orchard_digest.to_vec(),
        },
        header_fields: HeaderFields {
            tx_version: 5,
            version_group_id: 0x26A7270A,
            lock_time: 0,
            expiry_height: 0,
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

    /// ZIP-317 §3 + BundleType::DEFAULT padding. The chain counts orchard
    /// actions post-padding; we must too, otherwise mempool rejects with
    /// "Unpaid actions is higher than the limit" even though the orchard
    /// proof verifies. Regression: production deshield broadcast for
    /// (1 spend, 0.001 ZEC out, 0.0262 change) hit this with the old
    /// pre-padding fee of 10000 ZAT — the chain wanted 15000.
    #[test]
    fn test_zip317_deshield_fee_post_padding() {
        use super::zip317_deshield_fee;
        // 1 real spend + 1 change → padded to 2 actions + 1 transparent = 3 logical.
        assert_eq!(zip317_deshield_fee(1), 15_000);
        // 2 real spends + 1 change → max(2, max(2,1)) = 2 actions + 1 transparent = 3.
        assert_eq!(zip317_deshield_fee(2), 15_000);
        // 3 real spends + 1 change → 3 actions + 1 transparent = 4 logical.
        assert_eq!(zip317_deshield_fee(3), 20_000);
        // 5 real spends + 1 change → 5 actions + 1 transparent = 6 logical.
        assert_eq!(zip317_deshield_fee(5), 30_000);
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

    // ══════════════════════════════════════════════════════════════════════
    // 4. Witness re-derivation — proves witness_at_checkpoint_id returns a
    //    path that actually reconstructs the tree's root when applied to its
    //    leaf. The chain's Orchard verifier checks this same invariant; if
    //    our tests assert it, we'll catch "could not validate orchard proof"
    //    failures locally instead of after a device confirm + Halo2 prove +
    //    broadcast round-trip.
    //
    //    Existing tests only assert that witness_at_checkpoint_id returns
    //    `Some(_)` — that's necessary but not sufficient. A path can exist
    //    but be wrong.
    // ══════════════════════════════════════════════════════════════════════

    /// Helper: extract a witness for `pos` against `ckpt`, then verify that
    /// applying the path to the leaf at that position re-computes the tree's
    /// root at the same checkpoint. Panics with a descriptive message if the
    /// witness exists but is wrong (the dangerous case the original tests
    /// missed). Generic over tree dimensions so tests can use small trees
    /// (`<_, 8, 4>` = 16 leaves/shard) for fast `cargo test` runs while
    /// still exercising the same code paths as production (`<_, 32, 16>`).
    fn assert_witness_recomputes_root<S, const DEPTH: u8, const SHARD_HEIGHT: u8>(
        tree: &mut ShardTree<S, DEPTH, SHARD_HEIGHT>,
        pos: u64,
        leaf: MerkleHashOrchard,
        ckpt: u32,
        ctx: &str,
    ) where
        S: shardtree::store::ShardStore<H = MerkleHashOrchard, CheckpointId = u32>,
        S::Error: std::fmt::Debug,
    {
        let position = incrementalmerkletree::Position::from(pos);
        let path = tree
            .witness_at_checkpoint_id(position, &ckpt)
            .unwrap_or_else(|e| panic!("[{}] witness query at pos {} failed: {:?}", ctx, pos, e))
            .unwrap_or_else(|| panic!("[{}] no witness for pos {}", ctx, pos));
        let computed = path.root(leaf);
        let expected = tree
            .root_at_checkpoint_id(&ckpt)
            .unwrap()
            .unwrap_or_else(|| panic!("[{}] tree root unavailable at ckpt {}", ctx, ckpt));
        assert_eq!(
            computed.to_bytes(),
            expected.to_bytes(),
            "[{}] witness for pos {} does NOT recompute tree root — \
             this is the silent failure mode the chain reports as 'could not validate orchard proof'",
            ctx,
            pos,
        );
    }

    // Tests below use ShardTree<_, 8, 4> (depth 8, shard height 4 = 16 leaves
    // per shard, 256 leaves total max) — same approach as the existing tree
    // tests in this file. Production uses <_, 32, 16> (65k leaves/shard) but
    // the witness invariant we're checking is identical at any depth, and
    // shrinking dimensions takes `cargo test` from minutes to milliseconds.

    /// Sanity: witness for a marked leaf in a tree of all-appended leaves
    /// must verify against the tree's root.
    #[test]
    fn test_witness_recomputes_root_pure_append() {
        let n_leaves = 50u64;
        let note_pos = 20u64;
        let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for i in 0..n_leaves {
            let retention = if i == note_pos { Retention::Marked } else { Retention::Ephemeral };
            tree.append(test_leaf(i), retention).unwrap();
        }
        let ckpt = u32::MAX;
        tree.checkpoint(ckpt).unwrap();
        assert_witness_recomputes_root(&mut tree, note_pos, test_leaf(note_pos), ckpt, "pure_append");
    }

    /// Mirrors the deshield builder's tree shape: insert N-1 completed shard
    /// roots, walk shard N from leaves marking the note, no frontier. This
    /// is the case where notes live in the latest incomplete shard.
    #[test]
    fn test_witness_recomputes_root_incomplete_shard_with_marked_note() {
        use incrementalmerkletree::{Address, Position};

        let shard_size: u64 = 1 << 4; // 16
        let n_complete_shards = 3u64;
        let leaves_in_incomplete = 10u64;
        let note_pos = n_complete_shards * shard_size + 5; // mid-incomplete

        // Insert completed-shard roots
        let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        for s in 0..n_complete_shards {
            let mut sub: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 4, 4> =
                ShardTree::new(MemoryShardStore::empty(), 100);
            for j in 0..shard_size {
                sub.append(test_leaf(s * shard_size + j), Retention::Ephemeral).unwrap();
            }
            sub.checkpoint(0u32).unwrap();
            let root = sub.root_at_checkpoint_id(&0u32).unwrap().unwrap();
            let addr = Address::above_position(4.into(), Position::from(s * shard_size));
            tree.insert(addr, root).unwrap();
        }

        // Walk shard N's leaves, marking the note when we hit it
        let incomplete_start = n_complete_shards * shard_size;
        for i in 0..leaves_in_incomplete {
            let pos = incomplete_start + i;
            let retention = if pos == note_pos { Retention::Marked } else { Retention::Ephemeral };
            tree.append(test_leaf(pos), retention).unwrap();
        }

        let ckpt = u32::MAX;
        tree.checkpoint(ckpt).unwrap();
        assert_witness_recomputes_root(&mut tree, note_pos, test_leaf(note_pos), ckpt, "incomplete_shard");
    }

    /// User's exact case (deshield Orchard → transparent):
    ///   - Notes in shards we walk fully (Marked)
    ///   - Plus an Ephemeral frontier extension past the last note-bearing
    ///     shard up to chain tip
    ///
    /// Asserts:
    ///   1. Tree root after extension equals what a single all-append walk
    ///      would produce (anchor sanity)
    ///   2. The marked note's witness recomputes that root
    ///
    /// If (1) passes but (2) fails, the bug is in how ShardTree handles
    /// witness extraction for marked notes when an Ephemeral frontier sits
    /// above them. That's exactly the failure pattern we hit in production.
    #[test]
    fn test_witness_recomputes_root_after_frontier_extension() {
        use incrementalmerkletree::{Address, Position};

        let shard_size: u64 = 1 << 4; // 16
        let n_complete_shards = 2u64;
        let leaves_in_walked_shard = shard_size; // shard 2 is also "complete" but contains our note
        let frontier_extension = 12u64;
        let note_pos = 2 * shard_size + 7;

        // Reference: build everything via plain append
        let mut ref_tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);
        let total = n_complete_shards * shard_size + leaves_in_walked_shard + frontier_extension;
        for i in 0..total {
            let retention = if i == note_pos { Retention::Marked } else { Retention::Ephemeral };
            ref_tree.append(test_leaf(i), retention).unwrap();
        }
        let ref_ckpt = u32::MAX;
        ref_tree.checkpoint(ref_ckpt).unwrap();
        let ref_root = ref_tree.root_at_checkpoint_id(&ref_ckpt).unwrap().unwrap();

        // Production: insert completed-shard roots, walk note-bearing shard,
        // then ephemeral frontier extension (mirrors build_deshield_pczt).
        let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);

        for s in 0..n_complete_shards {
            let mut sub: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 4, 4> =
                ShardTree::new(MemoryShardStore::empty(), 100);
            for j in 0..shard_size {
                sub.append(test_leaf(s * shard_size + j), Retention::Ephemeral).unwrap();
            }
            sub.checkpoint(0u32).unwrap();
            let root = sub.root_at_checkpoint_id(&0u32).unwrap().unwrap();
            let addr = Address::above_position(4.into(), Position::from(s * shard_size));
            tree.insert(addr, root).unwrap();
        }

        let walked_start = n_complete_shards * shard_size;
        for i in 0..leaves_in_walked_shard {
            let pos = walked_start + i;
            let retention = if pos == note_pos { Retention::Marked } else { Retention::Ephemeral };
            tree.append(test_leaf(pos), retention).unwrap();
        }

        let frontier_start = walked_start + leaves_in_walked_shard;
        for i in 0..frontier_extension {
            tree.append(test_leaf(frontier_start + i), Retention::Ephemeral).unwrap();
        }

        let ckpt = u32::MAX;
        tree.checkpoint(ckpt).unwrap();
        let prod_root = tree.root_at_checkpoint_id(&ckpt).unwrap().unwrap();

        // Invariant 1: production tree root must match the reference (anchor sanity)
        assert_eq!(
            prod_root.to_bytes(),
            ref_root.to_bytes(),
            "Tree built via insert+walk+frontier-extension must match all-append reference",
        );

        // Invariant 2: witness for the marked note must recompute that root
        assert_witness_recomputes_root(&mut tree, note_pos, test_leaf(note_pos), ckpt, "frontier_extension");
    }

    /// Two marked notes — one in a shard we walk (well-confirmed),
    /// one in the frontier-extended region (recently mined). The frontier
    /// extension uses Retention::Ephemeral; this test verifies that the
    /// older marked note's witness still recomputes the root despite the
    /// ephemeral leaves above it.
    #[test]
    fn test_witness_recomputes_root_two_marked_notes_split() {
        use incrementalmerkletree::{Address, Position};

        let shard_size: u64 = 1 << 4; // 16
        let n_complete_shards = 2u64;
        let walked_leaves = shard_size;
        let frontier_extension = 8u64;
        let walked_note_pos = n_complete_shards * shard_size + 6;

        let mut tree: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 8, 4> =
            ShardTree::new(MemoryShardStore::empty(), 100);

        for s in 0..n_complete_shards {
            let mut sub: ShardTree<MemoryShardStore<MerkleHashOrchard, u32>, 4, 4> =
                ShardTree::new(MemoryShardStore::empty(), 100);
            for j in 0..shard_size {
                sub.append(test_leaf(s * shard_size + j), Retention::Ephemeral).unwrap();
            }
            sub.checkpoint(0u32).unwrap();
            let root = sub.root_at_checkpoint_id(&0u32).unwrap().unwrap();
            let addr = Address::above_position(4.into(), Position::from(s * shard_size));
            tree.insert(addr, root).unwrap();
        }

        let walked_start = n_complete_shards * shard_size;
        for i in 0..walked_leaves {
            let pos = walked_start + i;
            let retention = if pos == walked_note_pos { Retention::Marked } else { Retention::Ephemeral };
            tree.append(test_leaf(pos), retention).unwrap();
        }

        let frontier_start = walked_start + walked_leaves;
        for i in 0..frontier_extension {
            tree.append(test_leaf(frontier_start + i), Retention::Ephemeral).unwrap();
        }

        let ckpt = u32::MAX;
        tree.checkpoint(ckpt).unwrap();

        assert_witness_recomputes_root(
            &mut tree, walked_note_pos, test_leaf(walked_note_pos), ckpt,
            "split: walked note",
        );
    }
}

// ── v5 transaction round-trip tests ───────────────────────────────────────
//
// Production private sends and shield txs broadcast successfully, but deshield
// (orchard spends → transparent output) fails at broadcast with "could not
// validate orchard proof" — even though the per-action redpallas signature
// and the orchard binding signature both verify locally before serialization.
//
// One way that pattern can occur: the bytes we hand to lightwalletd parse to a
// transaction whose canonical txid / digests differ from what we computed
// internally. That would produce a bundle whose embedded Halo2 public inputs
// disagree with what the chain extracts from the wire, so consensus rejects
// the proof.
//
// These tests round-trip our v5 serializers through `zcash_primitives`'
// canonical reader and check (a) the bytes parse, (b) per-action Orchard
// fields survive the round-trip, and (c) our computed txid matches what
// `Transaction::read` reconstructs.
//
// `roundtrip_v5_shielded_only` is a canary — production private sends use this
// path successfully, so it MUST pass. If it doesn't, the test infra (synthetic
// bundle, fixture bytes, comparison helpers) is what's broken.
//
// `roundtrip_v5_hybrid_shield` exercises the `inputs=[real], outputs=[]`
// direction that production shield uses successfully — also expected to pass.
//
// `roundtrip_v5_hybrid_deshield` exercises `inputs=[], outputs=[real]` — the
// unique combination only deshield uses. If a serializer or zip244 digest bug
// is direction-specific, this is where it shows up.

#[cfg(test)]
mod roundtrip_v5_tests {
    use super::{serialize_v5_hybrid_tx, serialize_v5_shielded_tx};
    use crate::zip244::{
        self, Zip244Digests, EMPTY_SAPLING_DIGEST, EMPTY_TRANSPARENT_DIGEST,
        TransparentInput, TransparentOutput,
    };
    use nonempty::NonEmpty;
    use orchard::{
        bundle::{Authorized, Flags},
        note::{ExtractedNoteCommitment, Nullifier, TransmittedNoteCiphertext},
        primitives::redpallas,
        value::ValueCommitment,
        Action, Anchor, Proof,
    };
    use zcash_primitives::transaction::Transaction;
    // zcash_primitives 0.19 pins zcash_protocol 0.4; its `Transaction::read`
    // signature wants that exact BranchId. Our crate also depends on
    // zcash_protocol 0.7 (used elsewhere). Pull the 0.4 alias here.
    use zcash_protocol_v04::consensus::BranchId;

    /// NU5 consensus branch id. Picked because deshield txs ship under NU5+
    /// rules and `Transaction::read` for v5 ignores the branch_id parameter
    /// anyway — what matters is matching the value encoded in the tx header.
    const NU5_BRANCH_ID: u32 = 0xc2d6_d0b4;

    // ── Test vector bytes ────────────────────────────────────────────────
    // Pulled from `orchard-0.12.0/src/test_vectors/note_encryption.rs` TV[0].
    // Real, on-curve Pallas points known to round-trip through the canonical
    // reader. We only need on-curve-ness — the values themselves are
    // arbitrary for serialization tests.

    const TV_CV_NET: [u8; 32] = [
        0xdd, 0xba, 0x24, 0xf3, 0x9f, 0x70, 0x8e, 0xd7, 0xa7, 0x48, 0x57, 0x13, 0x71, 0x11,
        0x42, 0xc2, 0x38, 0x51, 0x38, 0x15, 0x30, 0x2d, 0xf0, 0xf4, 0x83, 0x04, 0x21, 0xa6,
        0xc1, 0x3e, 0x71, 0x01,
    ];
    const TV_NF_OLD: [u8; 32] = [
        0xc5, 0x96, 0xfb, 0xd3, 0x2e, 0xbb, 0xcb, 0xad, 0xae, 0x60, 0xd2, 0x85, 0xc7, 0xd7,
        0x5f, 0xa8, 0x36, 0xf9, 0xd2, 0xfa, 0x86, 0x10, 0x0a, 0xb8, 0x58, 0xea, 0x2d, 0xe1,
        0xf1, 0x1c, 0x83, 0x06,
    ];
    const TV_CMX: [u8; 32] = [
        0xa5, 0x70, 0x6f, 0x3d, 0x1b, 0x68, 0x8e, 0x9d, 0xc6, 0x34, 0xee, 0xe4, 0xe6, 0x5b,
        0x02, 0x8a, 0x43, 0xee, 0xae, 0xd2, 0x43, 0x5b, 0xea, 0x2a, 0xe3, 0xd5, 0x16, 0x05,
        0x75, 0xc1, 0x1a, 0x3b,
    ];
    const TV_EPK: [u8; 32] = [
        0xad, 0xdb, 0x47, 0xb6, 0xac, 0x5d, 0xfc, 0x16, 0x55, 0x89, 0x23, 0xd3, 0xa8, 0xf3,
        0x76, 0x09, 0x5c, 0x69, 0x5c, 0x04, 0x7c, 0x4e, 0x32, 0x66, 0xae, 0x67, 0x69, 0x87,
        0xf7, 0xe3, 0x13, 0x81,
    ];
    const TV_C_OUT: [u8; 80] = [
        0xcb, 0xdf, 0x68, 0xa5, 0x7f, 0xb4, 0xa4, 0x6f, 0x34, 0x60, 0xff, 0x22, 0x7b, 0xc6,
        0x18, 0xda, 0xe1, 0x12, 0x29, 0x45, 0xb3, 0x80, 0xc7, 0xe5, 0x49, 0xcf, 0x4a, 0x6e,
        0x8b, 0xf3, 0x75, 0x49, 0xba, 0xe1, 0x89, 0x1f, 0xd8, 0xd1, 0xa4, 0x94, 0x4f, 0xdf,
        0x41, 0x0f, 0x07, 0x02, 0xed, 0xa5, 0x44, 0x2f, 0x0e, 0xa0, 0x1a, 0x5d, 0xf0, 0x12,
        0xa0, 0xae, 0x4d, 0x84, 0xed, 0x79, 0x80, 0x33, 0x28, 0xbd, 0x1f, 0xd5, 0xfa, 0xc7,
        0x19, 0x21, 0x6a, 0x77, 0x6d, 0xe6, 0x4f, 0xd1, 0x67, 0xdb,
    ];

    /// 580-byte enc_ciphertext from TV[0]. Initialized at runtime to keep the
    /// const table small; the orchard reader doesn't validate its contents.
    fn tv_c_enc() -> [u8; 580] {
        let raw: &[u8] = &[
            0x1a, 0x9a, 0xdb, 0x14, 0x24, 0x98, 0xe3, 0xdc, 0xc7, 0x6f, 0xed, 0x77, 0x86, 0x14,
            0xdd, 0x31, 0x6c, 0x02, 0xfb, 0xb8, 0xba, 0x92, 0x44, 0xae, 0x4c, 0x2e, 0x32, 0xa0,
            0x7d, 0xae, 0xec, 0xa4, 0x12, 0x26, 0xb9, 0x8b, 0xfe, 0x74, 0xf9, 0xfc, 0xb2, 0x28,
            0xcf, 0xc1, 0x00, 0xf3, 0x18, 0x0f, 0x57, 0x75, 0xec, 0xe3, 0x8b, 0xe7, 0xed, 0x45,
            0xd9, 0x40, 0x21, 0xf4, 0x40, 0x1b, 0x2a, 0x4d, 0x75, 0x82, 0xb4, 0x28, 0xd4, 0x9e,
            0xc7, 0xf5, 0xb5, 0xa4, 0x98, 0x97, 0x3e, 0x60, 0xe3, 0x8e, 0x74, 0xf5, 0xc3, 0xe5,
            0x77, 0x82, 0x7c, 0x38, 0x28, 0x57, 0xd8, 0x16, 0x6b, 0x54, 0xe6, 0x4f, 0x66, 0xef,
            0x5c, 0x7e, 0x8c, 0x9b, 0xaa, 0x2a, 0x3f, 0xa9, 0xe3, 0x7d, 0x08, 0x77, 0x17, 0xd5,
            0xe9, 0x6b, 0xc2, 0xf7, 0x3d, 0x03, 0x14, 0x50, 0xdc, 0x24, 0x32, 0xba, 0x49, 0xd8,
            0xb7, 0x4d, 0xb2, 0x13, 0x09, 0x9e, 0xa9, 0xba, 0x04, 0xeb, 0x63, 0xb6, 0x57, 0x4d,
            0x46, 0xc0, 0x3c, 0xe7, 0x90, 0x0d, 0x4a, 0xc4, 0xbb, 0x18, 0x8e, 0xe9, 0x03, 0x0d,
            0x7f, 0x69, 0xc8, 0x95, 0xa9, 0x4f, 0xc1, 0x82, 0xf2, 0x25, 0xa9, 0x4f, 0x0c, 0xde,
            0x1b, 0x49, 0x88, 0x68, 0x71, 0xa3, 0x76, 0x34, 0x1e, 0xa9, 0x41, 0x71, 0xbe, 0xfd,
            0x95, 0xa8, 0x30, 0xfa, 0x18, 0x40, 0x70, 0x97, 0xdc, 0xa5, 0x11, 0x02, 0x54, 0x63,
            0xd4, 0x37, 0xe9, 0x69, 0x5c, 0xaa, 0x07, 0x9a, 0x2f, 0x68, 0xcd, 0xc7, 0xf2, 0xc1,
            0x32, 0x67, 0xbf, 0xf4, 0x19, 0x51, 0x37, 0xfa, 0x89, 0x53, 0x25, 0x2a, 0x81, 0xb2,
            0xaf, 0xa1, 0x58, 0x2b, 0x9b, 0xfb, 0x4a, 0xc9, 0x60, 0x37, 0xed, 0x29, 0x91, 0xd3,
            0xcb, 0xc7, 0xd5, 0x4a, 0xff, 0x6e, 0x62, 0x1b, 0x06, 0xa7, 0xb2, 0xb9, 0xca, 0xf2,
            0x95, 0x5e, 0xfa, 0xf4, 0xea, 0x8e, 0xfc, 0xfd, 0x02, 0x3a, 0x3c, 0x17, 0x48, 0xdf,
            0x3c, 0xbd, 0x43, 0xe0, 0xb9, 0xa8, 0xb0, 0x94, 0x56, 0x88, 0xd5, 0x20, 0x56, 0xc1,
            0xd1, 0x6e, 0xea, 0x37, 0xe7, 0x98, 0xba, 0x31, 0xdc, 0x3e, 0x5d, 0x49, 0x52, 0xbd,
            0x51, 0xec, 0x76, 0x9d, 0x57, 0x88, 0xb6, 0xe3, 0x5f, 0xe9, 0x04, 0x2b, 0x95, 0xd4,
            0xd2, 0x17, 0x81, 0x40, 0x0e, 0xaf, 0xf5, 0x86, 0x16, 0xad, 0x56, 0x27, 0x96, 0x63,
            0x6a, 0x50, 0xb8, 0xed, 0x6c, 0x7f, 0x98, 0x1d, 0xc7, 0xba, 0x81, 0x4e, 0xff, 0x15,
            0x2c, 0xb2, 0x28, 0xa2, 0xea, 0xd2, 0xf8, 0x32, 0x66, 0x2f, 0xa4, 0xa4, 0xa5, 0x07,
            0x97, 0xb0, 0xf8, 0x5b, 0x62, 0xd0, 0x8b, 0x1d, 0xd2, 0xd8, 0xe4, 0x3b, 0x4a, 0x5b,
            0xfb, 0xb1, 0x59, 0xed, 0x57, 0x8e, 0xf7, 0x47, 0x5d, 0xe0, 0xad, 0xa1, 0x3e, 0x17,
            0xad, 0x87, 0xcc, 0x23, 0x05, 0x67, 0x2b, 0xcc, 0x55, 0xa8, 0x88, 0x13, 0x17, 0xfd,
            0xc1, 0xbf, 0xc4, 0x59, 0xb6, 0x8b, 0x2d, 0xf7, 0x0c, 0xad, 0x37, 0x70, 0xed, 0x0f,
            0xd0, 0x2d, 0x64, 0xb9, 0x6f, 0x2b, 0xbf, 0x6f, 0x8f, 0x63, 0x2e, 0x86, 0x6c, 0xa5,
            0xd1, 0x96, 0xd2, 0x48, 0xad, 0x05, 0xc3, 0xde, 0x64, 0x41, 0x48, 0xa8, 0x0b, 0x51,
            0xad, 0xa9, 0x5b, 0xd0, 0x8d, 0x73, 0xcd, 0xbb, 0x45, 0x26, 0x4f, 0x3b, 0xd1, 0x13,
            0x83, 0x5b, 0x46, 0xf9, 0xbe, 0x7b, 0x6d, 0x23, 0xa4, 0x3b, 0xdd, 0xfe, 0x1e, 0x74,
            0x08, 0xc9, 0x70, 0x31, 0xe1, 0xa8, 0x21, 0x4b, 0xab, 0x46, 0x39, 0x10, 0x44, 0xb7,
            0x00, 0xd3, 0x8f, 0x51, 0x92, 0xc5, 0x7f, 0xe6, 0xf8, 0x71, 0x59, 0xb5, 0x55, 0x12,
            0x09, 0x4e, 0x29, 0xd2, 0xce, 0xba, 0xb8, 0x68, 0xc8, 0xf1, 0xad, 0xba, 0xd5, 0x70,
            0x77, 0xcb, 0xeb, 0x5e, 0x69, 0x65, 0x85, 0x82, 0xbf, 0x98, 0xd1, 0x9d, 0x64, 0xf4,
            0x4b, 0x0d, 0x50, 0xc7, 0xe2, 0x20, 0x9a, 0xb3, 0xfc, 0x56, 0xb4, 0xf4, 0x09, 0x12,
            0x3a, 0xae, 0xb0, 0x26, 0x3a, 0x22, 0x45, 0x1b, 0xc1, 0x4e, 0xd7, 0x56, 0xd0, 0x48,
            0x38, 0x5a, 0xed, 0xbb, 0x86, 0xa8, 0x46, 0x77, 0xbb, 0x2d, 0x21, 0xc5, 0x2c, 0xc9,
            0x49, 0x41, 0x47, 0xbf, 0x0f, 0xb1, 0x02, 0x74, 0x52, 0x82, 0x99, 0x09, 0x09, 0x72,
            0x62, 0x28, 0x18, 0x6e, 0x02, 0xc8,
        ];
        let mut buf = [0u8; 580];
        buf.copy_from_slice(raw);
        buf
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /// One synthetic Orchard action with on-curve Pallas points + arbitrary sig.
    fn synthetic_action() -> Action<redpallas::Signature<redpallas::SpendAuth>> {
        let cv_net = ValueCommitment::from_bytes(&TV_CV_NET).unwrap();
        let nf = Nullifier::from_bytes(&TV_NF_OLD).unwrap();
        // `rk` is a randomized SpendAuth verification key — same compressed-Pallas
        // encoding as a Nullifier, so a valid nf byte string is also valid as rk.
        let rk = redpallas::VerificationKey::<redpallas::SpendAuth>::try_from(TV_NF_OLD)
            .expect("TV nf bytes must round-trip as a redpallas SpendAuth VerificationKey");
        let cmx = ExtractedNoteCommitment::from_bytes(&TV_CMX).unwrap();
        let encrypted_note = TransmittedNoteCiphertext {
            epk_bytes: TV_EPK,
            enc_ciphertext: tv_c_enc(),
            out_ciphertext: TV_C_OUT,
        };
        let spend_auth_sig: redpallas::Signature<redpallas::SpendAuth> = [0xab; 64].into();
        Action::from_parts(nf, rk, cmx, encrypted_note, cv_net, spend_auth_sig)
    }

    fn synthetic_bundle(n_actions: usize, value_balance: i64)
        -> orchard::Bundle<Authorized, i64>
    {
        assert!(n_actions >= 1);
        let actions: Vec<_> = (0..n_actions).map(|_| synthetic_action()).collect();
        let actions_ne = NonEmpty::from_vec(actions).unwrap();
        let flags = Flags::from_byte(0x03).unwrap();
        let anchor = Anchor::from_bytes(TV_CMX).unwrap();
        let proof = Proof::new(vec![0u8; 1500]);
        let binding_sig: redpallas::Signature<redpallas::Binding> = [0xcd; 64].into();
        let auth = Authorized::from_parts(proof, binding_sig);
        orchard::Bundle::from_parts(actions_ne, flags, value_balance, anchor, auth)
    }

    /// Recompute the txid the way `finalize_pczt` (shielded-only) does.
    fn our_txid_shielded(bundle: &orchard::Bundle<Authorized, i64>, branch_id: u32) -> [u8; 32] {
        let digests = Zip244Digests {
            header_digest: zip244::digest_header(branch_id, 0, 0),
            transparent_digest: EMPTY_TRANSPARENT_DIGEST,
            sapling_digest: EMPTY_SAPLING_DIGEST,
            orchard_digest: zip244::digest_orchard(bundle),
        };
        zip244::compute_sighash(&digests, branch_id)
    }

    /// Recompute the txid the way `finalize_shield_pczt` / `finalize_deshield_pczt`
    /// do (hybrid path with non-empty transparent component).
    fn our_txid_hybrid(
        bundle: &orchard::Bundle<Authorized, i64>,
        inputs: &[TransparentInput],
        outputs: &[TransparentOutput],
        branch_id: u32,
    ) -> [u8; 32] {
        let digests = Zip244Digests {
            header_digest: zip244::digest_header(branch_id, 0, 0),
            transparent_digest: zip244::digest_transparent_txid(inputs, outputs),
            sapling_digest: EMPTY_SAPLING_DIGEST,
            orchard_digest: zip244::digest_orchard(bundle),
        };
        zip244::compute_sighash(&digests, branch_id)
    }

    // Note on cross-version comparison: `zcash_primitives 0.19` pins
    // `orchard 0.10`, while we directly depend on `orchard 0.12`. The two
    // `orchard::Bundle` types are distinct in the type system (different crate
    // versions), so we can't pass our 0.12 bundle to a comparator that takes
    // the 0.10 bundle the parser returns. Fortunately, txid = BLAKE2b(header
    // || transparent_digest || sapling_digest || orchard_digest), so any
    // per-action byte divergence shows up as an `orchard_digest` divergence
    // → txid mismatch — making the txid assertion sufficient. If we ever need
    // field-level diagnostics on failure, collect `cv_net().to_bytes()` etc.
    // into `Vec<[u8; 32]>` on each side (raw bytes have no version skew).

    fn p2pkh_script(hash160: [u8; 20]) -> Vec<u8> {
        let mut s = Vec::with_capacity(25);
        s.extend_from_slice(&[0x76, 0xa9, 0x14]); // OP_DUP OP_HASH160 PUSH20
        s.extend_from_slice(&hash160);
        s.extend_from_slice(&[0x88, 0xac]); // OP_EQUALVERIFY OP_CHECKSIG
        s
    }

    // ── Tests ────────────────────────────────────────────────────────────

    /// Canary — the all-orchard path that production private sends use.
    /// Production confirms these on-chain, so this MUST pass.
    #[test]
    fn roundtrip_v5_shielded_only() {
        let bundle = synthetic_bundle(1, 0);
        let tx_bytes = serialize_v5_shielded_tx(&bundle, NU5_BRANCH_ID).unwrap();

        let parsed = Transaction::read(&tx_bytes[..], BranchId::Nu5)
            .expect("canonical reader must accept our v5 shielded tx bytes");
        assert!(parsed.orchard_bundle().is_some(), "orchard bundle present in parsed tx");
        assert_eq!(
            parsed.orchard_bundle().unwrap().actions().len(),
            bundle.actions().len(),
            "orchard action count round-tripped",
        );

        let ours = our_txid_shielded(&bundle, NU5_BRANCH_ID);
        assert_eq!(
            *parsed.txid().as_ref(), ours,
            "shielded txid mismatch — our zip244 digests disagree with the canonical reference"
        );
    }

    /// Hybrid with transparent INPUTS and no outputs — the direction that
    /// production shield uses successfully. Expected to pass.
    #[test]
    fn roundtrip_v5_hybrid_shield() {
        let bundle = synthetic_bundle(1, 100_000);
        let inputs = vec![TransparentInput {
            prevout_hash: [0x11; 32],
            prevout_index: 0,
            value: 105_000,
            script_pubkey: p2pkh_script([0xde; 20]),
            sequence: 0xffff_ffff,
        }];
        // 71-byte synthetic DER signature payload (the +1 SIGHASH_ALL byte is
        // appended by serialize_v5_hybrid_tx itself).
        let synth_sig = vec![0u8; 71];
        let synth_pubkey = [0x02u8; 33];
        let tx_bytes = serialize_v5_hybrid_tx(
            &bundle, &inputs, &[], &[synth_sig], NU5_BRANCH_ID, Some(&synth_pubkey),
        ).unwrap();

        let parsed = Transaction::read(&tx_bytes[..], BranchId::Nu5)
            .expect("canonical reader must accept our v5 hybrid (shield) bytes");
        let parsed_transparent = parsed.transparent_bundle()
            .expect("transparent bundle present");
        assert_eq!(parsed_transparent.vin.len(), 1, "exactly one transparent input");
        assert_eq!(parsed_transparent.vout.len(), 0, "no transparent outputs");
        assert_eq!(
            parsed.orchard_bundle().expect("orchard bundle present").actions().len(),
            bundle.actions().len(),
            "orchard action count round-tripped",
        );

        let ours = our_txid_hybrid(&bundle, &inputs, &[], NU5_BRANCH_ID);
        assert_eq!(
            *parsed.txid().as_ref(), ours,
            "shield txid mismatch — txid digest differs from canonical even though \
             production shield works on-chain (test infra bug?)"
        );
    }

    /// Hybrid with no transparent INPUTS and one transparent OUTPUT — the
    /// unique combination only deshield uses. Production fails at broadcast
    /// with "could not validate orchard proof" on this shape. If the bug is
    /// in our serializer or zip244 digest computation, this test will pin it
    /// down at field level.
    #[test]
    fn roundtrip_v5_hybrid_deshield() {
        let bundle = synthetic_bundle(1, -190_000);
        let outputs = vec![TransparentOutput {
            value: 185_000,
            script_pubkey: p2pkh_script([0xbe; 20]),
        }];
        let tx_bytes = serialize_v5_hybrid_tx(
            &bundle, &[], &outputs, &[], NU5_BRANCH_ID, None,
        ).unwrap();

        let parsed = Transaction::read(&tx_bytes[..], BranchId::Nu5)
            .expect("canonical reader must accept our v5 hybrid (deshield) bytes");
        let parsed_transparent = parsed.transparent_bundle()
            .expect("transparent bundle present");
        assert_eq!(parsed_transparent.vin.len(), 0, "no transparent inputs");
        assert_eq!(parsed_transparent.vout.len(), 1, "exactly one transparent output");
        let parsed_out = &parsed_transparent.vout[0];
        assert_eq!(u64::from(parsed_out.value), outputs[0].value, "vout value");
        assert_eq!(parsed_out.script_pubkey.0, outputs[0].script_pubkey, "vout script");
        assert_eq!(
            parsed.orchard_bundle().expect("orchard bundle present").actions().len(),
            bundle.actions().len(),
            "orchard action count round-tripped",
        );

        let ours = our_txid_hybrid(&bundle, &[], &outputs, NU5_BRANCH_ID);
        assert_eq!(
            *parsed.txid().as_ref(), ours,
            "deshield txid mismatch — our serializer or zip244 digest disagrees \
             with the canonical reference; this is the bug deshield broadcasts hit"
        );
    }
}

/// Batch-validate a saved live transaction using orchard 0.10.2's BatchValidator.
///
/// This test documents the root cause of "could not validate orchard proof":
/// the saved transaction was built with the T.1 sighash (wrong — the network
/// uses the S.2 form for shield txs with non-empty vin). BatchValidator PASSES
/// with T.1 because the sigs were created under T.1. But the network's
/// BatchValidator would compute S.2 and FAIL.
///
/// New transactions built after the compute_zip244_digests_hybrid fix (S.2 form)
/// will have sigs under S.2 and will pass both local and network verification.
///
/// To run: `cargo test batch_validate -- --nocapture --ignored`
#[cfg(test)]
mod batch_validate_test {
    use zcash_primitives::transaction::Transaction;
    use zcash_protocol_v04::consensus::BranchId;

    const NU5_BRANCH_ID_LE: [u8; 4] = 0xc2d6d0b4u32.to_le_bytes();

    /// Verify the SAVED transaction's Orchard bundle is valid under the T.1 sighash
    /// it was built with. This PASSES locally because sigs match T.1. The same
    /// bundle FAILS on-chain because Zebra uses S.2 for shield transactions.
    #[test]
    #[ignore]
    fn batch_validate_saved_shield_tx_t1_passes() {
        use rand::rngs::OsRng;
        use orchard_v010::bundle::BatchValidator;
        use orchard_v010::circuit::VerifyingKey;

        let hex_path = "/tmp/shield_tx_9c240769e2089bdf.hex";
        let hex = match std::fs::read_to_string(hex_path) {
            Ok(s) => s,
            Err(e) => { eprintln!("SKIP: cannot read {}: {}", hex_path, e); return; }
        };
        let raw = hex::decode(hex.trim()).expect("valid hex");

        // T.1 sighash (old buggy form, equals txid). Sigs in this tx were created with T.1.
        let mut sighash_arr = [0u8; 32];
        sighash_arr.copy_from_slice(
            &hex::decode("9c240769e2089bdf6045f4aba2b2d7028a70c05e33ad7e11a02f1b2ece92a1c1").unwrap()
        );

        let mut parse_bytes = raw;
        if parse_bytes.len() >= 12 { parse_bytes[8..12].copy_from_slice(&NU5_BRANCH_ID_LE); }
        let parsed = Transaction::read(&parse_bytes[..], BranchId::Nu5)
            .expect("zcash_primitives must parse our v5 hybrid tx");
        let ob = parsed.orchard_bundle().expect("orchard bundle present");
        println!("anchor: {}", hex::encode(ob.anchor().to_bytes()));

        let mut validator = BatchValidator::new();
        validator.add_bundle(ob, sighash_arr);
        let result = validator.validate(&VerifyingKey::build(), OsRng);
        println!("BatchValidator (T.1 sighash): {}", if result { "PASS" } else { "FAIL" });
        assert!(result, "Expected PASS: sigs in saved tx were created with T.1");
    }
}
