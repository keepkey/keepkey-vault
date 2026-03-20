//! Lightwalletd gRPC client for Zcash chain scanning.
//!
//! Connects to a public lightwalletd server to scan compact blocks,
//! trial-decrypt Orchard notes, persist to wallet DB, track nullifiers,
//! and broadcast transactions.

use anyhow::{Result, Context};
use log::{info, debug};
use tonic::transport::{Channel, ClientTlsConfig};
use tokio_stream::StreamExt;

use orchard::keys::{FullViewingKey, PreparedIncomingViewingKey, Scope};
use orchard::note::ExtractedNoteCommitment;
use orchard::note::Nullifier;
use orchard::note_encryption::{CompactAction, OrchardDomain};
use zcash_note_encryption::{try_compact_note_decryption, try_note_decryption, EphemeralKeyBytes};

use crate::wallet_db::{WalletDb, ScannedNote};

/// A transparent UTXO from lightwalletd.
#[derive(Debug, Clone)]
pub struct TransparentUtxo {
    pub txid: [u8; 32],
    pub output_index: u32,
    pub value: u64,         // zatoshis
    pub script: Vec<u8>,    // scriptPubKey
    pub height: u64,
}

// Generated from proto files
pub mod proto {
    tonic::include_proto!("cash.z.wallet.sdk.rpc");
}

use proto::compact_tx_streamer_client::CompactTxStreamerClient;

const DEFAULT_LWD_SERVER: &str = "https://na.zec.rocks:443";
const FALLBACK_LWD_SERVERS: &[&str] = &[
    "https://sa.zec.rocks:443",
    "https://eu.zec.rocks:443",
    "https://mainnet.lightwalletd.com:9067",
];
// Orchard activated at NU5 height
const ORCHARD_ACTIVATION_HEIGHT: u64 = 1687104;

pub struct LightwalletClient {
    client: CompactTxStreamerClient<Channel>,
}

impl LightwalletClient {
    /// Connect to a lightwalletd gRPC server.
    pub async fn connect(server_url: Option<&str>) -> Result<Self> {
        let servers: Vec<&str> = if let Some(url) = server_url {
            vec![url]
        } else {
            let mut s = vec![DEFAULT_LWD_SERVER];
            s.extend_from_slice(FALLBACK_LWD_SERVERS);
            s
        };

        for url in &servers {
            info!("Trying lightwalletd: {}", url);
            let tls = ClientTlsConfig::new().with_native_roots();
            let endpoint = Channel::from_shared(url.to_string())
                .map_err(|e| anyhow::anyhow!("{}", e))
                .and_then(|c| c.tls_config(tls).map_err(|e| anyhow::anyhow!("{}", e)));
            match endpoint {
                Ok(endpoint) => {
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        endpoint.connect(),
                    ).await {
                        Ok(Ok(channel)) => {
                            let client = CompactTxStreamerClient::new(channel);
                            info!("Connected to lightwalletd: {}", url);
                            return Ok(Self { client });
                        }
                        Ok(Err(e)) => info!("Failed to connect to {}: {}", url, e),
                        Err(_) => info!("Timeout connecting to {}", url),
                    }
                }
                Err(e) => info!("Invalid endpoint {}: {}", url, e),
            }
        }

        Err(anyhow::anyhow!("Failed to connect to any lightwalletd server"))
    }

    /// Get the current consensus branch ID from lightwalletd.
    pub async fn get_consensus_branch_id(&mut self) -> Result<u32> {
        let response = self.client
            .get_lightd_info(proto::Empty {})
            .await
            .context("GetLightdInfo failed")?;

        let info = response.into_inner();
        let branch_str = info.consensus_branch_id.trim_start_matches("0x");
        let branch_id = u32::from_str_radix(branch_str, 16)
            .context(format!("Invalid consensus branch ID string: '{}'", info.consensus_branch_id))?;

        info!("Current consensus branch ID: 0x{:08x}", branch_id);
        Ok(branch_id)
    }

    /// Get the current chain tip height.
    pub async fn get_latest_block_height(&mut self) -> Result<u64> {
        let response = self.client
            .get_latest_block(proto::ChainSpec {})
            .await
            .context("GetLatestBlock failed")?;
        Ok(response.into_inner().height)
    }

    /// Broadcast a raw transaction via lightwalletd.
    pub async fn send_transaction(&mut self, raw_tx: &[u8]) -> Result<String> {
        let response = self.client
            .send_transaction(proto::RawTransaction {
                data: raw_tx.to_vec(),
                height: 0,
            })
            .await
            .context("SendTransaction failed")?;

        let send_resp = response.into_inner();
        if send_resp.error_code != 0 {
            return Err(anyhow::anyhow!(
                "Transaction broadcast failed (code {}): {}",
                send_resp.error_code,
                send_resp.error_message
            ));
        }

        info!("Transaction broadcast successfully");
        Ok(send_resp.error_message)
    }

    /// Fetch Orchard subtree roots from lightwalletd.
    /// Returns Vec of (shard_index, root_hash, completing_height).
    pub async fn get_subtree_roots(
        &mut self,
        start_index: u32,
        max_entries: u32,
    ) -> Result<Vec<(u32, [u8; 32], u64)>> {
        let request = proto::GetSubtreeRootsArg {
            start_index,
            shielded_protocol: proto::ShieldedProtocol::Orchard as i32,
            max_entries,
        };

        let mut stream = self.client
            .get_subtree_roots(request)
            .await
            .context("GetSubtreeRoots failed")?
            .into_inner();

        let mut roots = Vec::new();
        let mut index = start_index;
        while let Some(root_result) = stream.next().await {
            let root = root_result.context("Error reading subtree root")?;
            if root.root_hash.len() == 32 {
                let mut hash = [0u8; 32];
                hash.copy_from_slice(&root.root_hash);
                roots.push((index, hash, root.completing_block_height));
                index += 1;
            }
        }

        info!("Fetched {} Orchard subtree roots (start_index={})", roots.len(), start_index);
        Ok(roots)
    }

    /// Get the Orchard tree state (frontier) at a specific block height.
    /// Returns the orchardCommitmentTreeSize from ChainMetadata at that height.
    #[allow(dead_code)]
    pub async fn get_tree_state(&mut self, height: u64) -> Result<(u64, String)> {
        let request = proto::BlockId {
            height,
            hash: vec![],
        };

        let response = self.client
            .get_tree_state(request)
            .await
            .context("GetTreeState failed")?;

        let state = response.into_inner();
        info!("Tree state at height {}: orchard_tree len={}", height, state.orchard_tree.len());
        Ok((state.height, state.orchard_tree))
    }

    /// Get the Orchard anchor (tree root) at the latest block.
    /// Parses the CommitmentTree from lightwalletd's GetTreeState orchardTree field.
    ///
    /// The format is the legacy CommitmentTree serialization:
    ///   Optional<left>:  0x00 (None) or 0x01 + 32 bytes (Some)
    ///   Optional<right>: 0x00 (None) or 0x01 + 32 bytes (Some)
    ///   Vector<Optional<parent>>: compact_size count, then each is 0x00/0x01 + 32 bytes
    ///
    /// Root computation follows incrementalmerkletree::CommitmentTree::root():
    ///   1. Start: combine left and right (or left and empty)
    ///   2. For each parent level: combine parent (or empty) with current
    pub async fn get_orchard_anchor(&mut self, height: u64) -> Result<[u8; 32]> {
        let (_, tree_hex) = self.get_tree_state(height).await?;

        if tree_hex.is_empty() {
            return Err(anyhow::anyhow!("Empty Orchard tree state at height {}", height));
        }

        let tree_bytes = hex::decode(&tree_hex)
            .map_err(|e| anyhow::anyhow!("Invalid tree state hex: {}", e))?;

        info!("Parsing Orchard CommitmentTree ({} bytes) at height {}", tree_bytes.len(), height);

        use orchard::tree::MerkleHashOrchard;
        use incrementalmerkletree::Hashable;

        let data = &tree_bytes[..];
        let len = data.len();
        let mut offset = 0;

        // Helper: read an Optional<32-byte hash> with strict validation.
        // Returns Ok(Some(hash)) for 0x01 tag, Ok(None) for 0x00, Err for anything else.
        let read_optional = |data: &[u8], offset: &mut usize|
            -> Result<Option<MerkleHashOrchard>>
        {
            if *offset >= data.len() {
                return Err(anyhow::anyhow!("CommitmentTree truncated at offset {}", *offset));
            }
            match data[*offset] {
                0x00 => { *offset += 1; Ok(None) }
                0x01 => {
                    *offset += 1;
                    if *offset + 32 > data.len() {
                        return Err(anyhow::anyhow!(
                            "CommitmentTree truncated reading hash at offset {} (need 32, have {})",
                            *offset, data.len() - *offset
                        ));
                    }
                    let mut h = [0u8; 32];
                    h.copy_from_slice(&data[*offset..*offset + 32]);
                    *offset += 32;
                    let hash = MerkleHashOrchard::from_bytes(&h)
                        .into_option()
                        .ok_or_else(|| anyhow::anyhow!(
                            "Invalid MerkleHashOrchard at offset {}: {}",
                            *offset - 32, hex::encode(&h)
                        ))?;
                    Ok(Some(hash))
                }
                tag => Err(anyhow::anyhow!(
                    "Invalid Optional tag 0x{:02x} at offset {} (expected 0x00 or 0x01)",
                    tag, *offset
                )),
            }
        };

        // Read Optional<left>
        let left = read_optional(data, &mut offset)?;

        // Read Optional<right>
        let right = read_optional(data, &mut offset)?;

        // Read Vector<Optional<parent>> — compact_size count, then each Optional
        if offset >= len {
            return Err(anyhow::anyhow!("CommitmentTree truncated reading parents count at offset {}", offset));
        }
        let parents_count = data[offset] as usize;
        offset += 1;
        if parents_count > 32 {
            return Err(anyhow::anyhow!(
                "CommitmentTree parents count {} exceeds max depth 32", parents_count
            ));
        }
        let mut parents: Vec<Option<MerkleHashOrchard>> = Vec::with_capacity(parents_count);
        for i in 0..parents_count {
            let p = read_optional(data, &mut offset)
                .context(format!("Failed reading parent {}/{}", i, parents_count))?;
            parents.push(p);
        }

        if offset != len {
            info!("WARNING: CommitmentTree has {} trailing bytes (offset={}, len={})",
                len - offset, offset, len);
        }

        info!("CommitmentTree: left={}, right={}, {} parents",
            left.is_some(), right.is_some(), parents_count);

        // Compute root following CommitmentTree::root_at_depth logic.
        // Start with the leaf-level pair, then walk up through parents.
        let empty_leaf = MerkleHashOrchard::empty_leaf();

        // Level 0: combine left and right
        let mut current = match (left, right) {
            (Some(l), Some(r)) => {
                MerkleHashOrchard::combine(incrementalmerkletree::Level::from(0), &l, &r)
            }
            (Some(l), None) => {
                MerkleHashOrchard::combine(incrementalmerkletree::Level::from(0), &l, &empty_leaf)
            }
            (None, None) => {
                // Empty tree
                MerkleHashOrchard::combine(incrementalmerkletree::Level::from(0), &empty_leaf, &empty_leaf)
            }
            (None, Some(_)) => {
                return Err(anyhow::anyhow!("Invalid CommitmentTree: right without left"));
            }
        };

        // Levels 1..32: combine with parent or empty
        let mut empty_at_level = MerkleHashOrchard::combine(
            incrementalmerkletree::Level::from(0), &empty_leaf, &empty_leaf,
        );

        for level in 1..32u8 {
            let parent = if (level as usize - 1) < parents.len() {
                parents[level as usize - 1]
            } else {
                None
            };

            current = match parent {
                Some(p) => {
                    // Parent exists = completed left subtree at this level.
                    // Current is the right child.
                    MerkleHashOrchard::combine(
                        incrementalmerkletree::Level::from(level),
                        &p,
                        &current,
                    )
                }
                None => {
                    // No parent = current is the left child, right is empty.
                    MerkleHashOrchard::combine(
                        incrementalmerkletree::Level::from(level),
                        &current,
                        &empty_at_level,
                    )
                }
            };

            empty_at_level = MerkleHashOrchard::combine(
                incrementalmerkletree::Level::from(level),
                &empty_at_level,
                &empty_at_level,
            );
        }

        let anchor_bytes = current.to_bytes();
        info!("Orchard anchor: {}", hex::encode(&anchor_bytes));
        Ok(anchor_bytes)
    }

    /// Fetch compact blocks in a range and extract all Orchard action cmx values.
    /// Returns Vec of (block_height, Vec of (tx_index, Vec of cmx_bytes)).
    pub async fn fetch_block_actions(
        &mut self,
        start_height: u64,
        end_height: u64,
    ) -> Result<Vec<(u64, Vec<(u32, Vec<[u8; 32]>)>)>> {
        let request = proto::BlockRange {
            start: Some(proto::BlockId { height: start_height, hash: vec![] }),
            end: Some(proto::BlockId { height: end_height, hash: vec![] }),
        };

        let mut stream = self.client
            .get_block_range(request)
            .await
            .context("GetBlockRange for actions failed")?
            .into_inner();

        let mut blocks = Vec::new();
        while let Some(block_result) = stream.next().await {
            let block = block_result.context("Error reading compact block")?;
            let mut txs = Vec::new();
            for tx in &block.vtx {
                let mut cmxs = Vec::new();
                for action in &tx.actions {
                    if action.cmx.len() == 32 {
                        let mut cmx = [0u8; 32];
                        cmx.copy_from_slice(&action.cmx);
                        cmxs.push(cmx);
                    }
                }
                if !cmxs.is_empty() {
                    txs.push((tx.index as u32, cmxs));
                }
            }
            blocks.push((block.height, txs));
        }

        let total_actions: usize = blocks.iter()
            .flat_map(|(_, txs)| txs.iter().map(|(_, cmxs)| cmxs.len()))
            .sum();
        info!("Fetched {} blocks with {} total Orchard actions ({} to {})",
            blocks.len(), total_actions, start_height, end_height);
        Ok(blocks)
    }

    /// Get the Orchard commitment tree size at a given block height by fetching
    /// the compact block's ChainMetadata.
    pub async fn get_orchard_tree_size_at(&mut self, height: u64) -> Result<u64> {
        let request = proto::BlockId {
            height,
            hash: vec![],
        };

        let response = self.client
            .get_block(request)
            .await
            .context("GetBlock failed")?;

        let block = response.into_inner();
        let size = block.chain_metadata
            .map(|m| m.orchard_commitment_tree_size as u64)
            .unwrap_or(0);

        debug!("Orchard tree size at height {}: {}", height, size);
        Ok(size)
    }

    /// Fetch transparent UTXOs for a given address via lightwalletd.
    /// Uses the GetAddressUtxos gRPC method.
    pub async fn get_address_utxos(
        &mut self,
        address: &str,
    ) -> Result<Vec<TransparentUtxo>> {
        let request = proto::GetAddressUtxosArg {
            addresses: vec![address.to_string()],
            start_height: 0,
            max_entries: 1000,
        };

        let response = self.client
            .get_address_utxos(request)
            .await
            .context("GetAddressUtxos failed")?;

        let inner = response.into_inner();
        let mut utxos = Vec::new();
        for entry in &inner.address_utxos {
            let mut txid = [0u8; 32];
            if entry.txid.len() == 32 {
                txid.copy_from_slice(&entry.txid);
            }
            utxos.push(TransparentUtxo {
                txid,
                output_index: entry.index as u32,
                value: entry.value_zat as u64,
                script: entry.script.clone(),
                height: entry.height as u64,
            });
        }

        info!("Fetched {} UTXOs for address {}", utxos.len(), address);
        Ok(utxos)
    }

    /// Fetch a full raw transaction by txid via lightwalletd.
    /// Returns the raw transaction bytes.
    pub async fn get_transaction(&mut self, txid: &[u8; 32]) -> Result<Vec<u8>> {
        let request = proto::TxFilter {
            block: None,
            index: 0,
            hash: txid.to_vec(),
        };
        let response = self.client
            .get_transaction(request)
            .await
            .context("GetTransaction failed")?;
        let raw = response.into_inner();
        debug!("Fetched transaction: {} bytes at height {}", raw.data.len(), raw.height);
        Ok(raw.data)
    }

    /// Fetch a full transaction and decrypt the memo for a specific Orchard action.
    /// Returns the raw 512-byte memo if decryption succeeds, or None.
    pub async fn fetch_and_decrypt_memo(
        &mut self,
        txid: &[u8; 32],
        action_index: usize,
        fvk: &FullViewingKey,
    ) -> Result<Option<[u8; 512]>> {
        let raw_tx = self.get_transaction(txid).await?;
        let actions = parse_orchard_actions_from_raw_tx(&raw_tx)?;

        if action_index >= actions.len() {
            return Err(anyhow::anyhow!(
                "Action index {} out of range (tx has {} Orchard actions)",
                action_index, actions.len()
            ));
        }

        let action = &actions[action_index];

        // Try both External and Internal scopes (recipient vs change)
        for scope in &[Scope::External, Scope::Internal] {
            let ivk = fvk.to_ivk(*scope);
            let prepared_ivk = PreparedIncomingViewingKey::new(&ivk);
            let domain = OrchardDomain::for_action(action);

            if let Some((_note, _addr, memo)) = try_note_decryption(&domain, &prepared_ivk, action) {
                return Ok(Some(memo));
            }
        }

        Ok(None)
    }

    /// Scan compact blocks with persistence — saves notes to wallet DB,
    /// tracks nullifiers for spend detection, supports incremental scanning.
    pub async fn scan_with_persistence(
        &mut self,
        fvk: &FullViewingKey,
        db: &WalletDb,
        force_start: Option<u64>,
    ) -> Result<OrchardScanResult> {
        let ivk = fvk.to_ivk(Scope::External);
        let prepared_ivk = PreparedIncomingViewingKey::new(&ivk);

        let tip = self.get_latest_block_height().await?;

        // Determine the saved scan cursor so we can decide whether to update it.
        let saved_height = db.last_scanned_height()?;

        let start = match force_start {
            Some(h) => h,
            None => saved_height
                .map(|h| h + 1)
                .unwrap_or_else(|| {
                    // First scan: start from Orchard activation height to
                    // catch all possible notes. This is slow (~2M blocks)
                    // but necessary to avoid silently missing funds.
                    info!("First scan — starting from Orchard activation height {} (tip={})",
                           ORCHARD_ACTIVATION_HEIGHT, tip);
                    ORCHARD_ACTIVATION_HEIGHT
                }),
        };

        // Only advance the scan cursor when this scan is contiguous with
        // prior coverage.  A "scan from height" that jumps ahead of the
        // cursor would create an un-scanned gap — so in that case we scan
        // but leave the cursor untouched (the user can always do a full
        // scan to close the gap).
        let may_advance_cursor = match (force_start, saved_height) {
            (None, _) => true,                        // normal incremental scan
            (Some(_), None) => true,                  // first scan ever — any start is fine
            (Some(h), Some(saved)) => h <= saved + 1, // contiguous with prior coverage
        };

        if start > tip {
            info!("Already up to date (scanned to {}, tip is {})", start - 1, tip);
            let balance = db.get_balance()?;
            let (_total, unspent) = db.get_note_count()?;
            return Ok(OrchardScanResult {
                total_received: balance,
                notes_found: unspent as u32,
                new_notes: 0,
                blocks_scanned: 0,
                tip_height: tip,
            });
        }

        if !may_advance_cursor {
            info!("Scan-from-height {} is ahead of saved cursor ({}) — scanning but NOT advancing cursor to avoid gap",
                  start, saved_height.unwrap_or(0));
        }

        info!("Scanning blocks {} to {} for Orchard notes...", start, tip);

        let mut new_notes: u32 = 0;
        let mut spent_notes: u32 = 0;
        let mut blocks_scanned: u64 = 0;

        let chunk_size: u64 = 10000;
        let mut current = start;

        while current <= tip {
            let end = std::cmp::min(current + chunk_size - 1, tip);

            let request = proto::BlockRange {
                start: Some(proto::BlockId { height: current, hash: vec![] }),
                end: Some(proto::BlockId { height: end, hash: vec![] }),
            };

            let mut stream = self.client
                .get_block_range(request)
                .await
                .context("GetBlockRange failed")?
                .into_inner();

            while let Some(block_result) = stream.next().await {
                let block = block_result.context("Error reading compact block")?;
                blocks_scanned += 1;

                for tx in &block.vtx {
                    for (action_idx, action) in tx.actions.iter().enumerate() {
                        // Check nullifier — does this action spend one of our notes?
                        if action.nullifier.len() == 32 {
                            let mut nf_bytes = [0u8; 32];
                            nf_bytes.copy_from_slice(&action.nullifier);
                            if db.mark_note_spent(&nf_bytes)? {
                                spent_notes += 1;
                            }
                        }

                        // Try to decrypt — is this action a note to us?
                        if let Some((note, addr)) = try_decrypt_action(action, &prepared_ivk) {
                            let value = note.value().inner();
                            let recipient_bytes = addr.to_raw_address_bytes().to_vec();

                            let nf = note.nullifier(fvk);
                            let mut nf_bytes = [0u8; 32];
                            nf_bytes.copy_from_slice(&nf.to_bytes());

                            let mut rho_bytes = [0u8; 32];
                            rho_bytes.copy_from_slice(&note.rho().to_bytes());

                            let mut rseed_bytes = [0u8; 32];
                            rseed_bytes.copy_from_slice(note.rseed().as_bytes());

                            let mut cmx_bytes = [0u8; 32];
                            cmx_bytes.copy_from_slice(&action.cmx);

                            // Capture txid for later memo backfill
                            let txid = if tx.txid.len() == 32 {
                                let mut arr = [0u8; 32];
                                arr.copy_from_slice(&tx.txid);
                                Some(arr)
                            } else {
                                None
                            };

                            let scanned = ScannedNote {
                                value,
                                recipient: recipient_bytes,
                                rho: rho_bytes,
                                rseed: rseed_bytes,
                                cmx: cmx_bytes,
                                nullifier: nf_bytes,
                                block_height: block.height,
                                tx_index: tx.index as u32,
                                action_index: action_idx as u32,
                                txid,
                                memo: None, // Filled in during backfill (compact blocks lack memos)
                            };

                            if db.insert_note(&scanned)? {
                                new_notes += 1;
                                info!(
                                    "Found note: {} ZAT ({:.8} ZEC) in block {}",
                                    value,
                                    value as f64 / 1e8,
                                    block.height,
                                );
                            }
                        }
                    }
                }
            }

            // Only advance the persisted cursor when scan is contiguous.
            if may_advance_cursor {
                db.set_last_scanned_height(end)?;
            }
            current = end + 1;

            // Log progress every chunk (parsed by sidecar manager for UI)
            let progress = ((end - start + 1) as f64 / (tip - start + 1) as f64) * 100.0;
            info!("Scan progress: {:.1}% ({}/{})", progress, end, tip);
        }

        let balance = db.get_balance()?;
        let (_total, unspent) = db.get_note_count()?;

        info!(
            "Scan complete: {} blocks, {} new notes ({} newly found in range), {} spent, balance: {:.8} ZEC",
            blocks_scanned, unspent, new_notes, spent_notes, balance as f64 / 1e8
        );

        Ok(OrchardScanResult {
            total_received: balance,
            notes_found: unspent as u32,
            new_notes,
            blocks_scanned,
            tip_height: tip,
        })
    }
}

/// Try to trial-decrypt a compact Orchard action.
fn try_decrypt_action(
    action: &proto::CompactOrchardAction,
    prepared_ivk: &PreparedIncomingViewingKey,
) -> Option<(orchard::Note, orchard::Address)> {
    if action.nullifier.len() != 32
        || action.cmx.len() != 32
        || action.ephemeral_key.len() != 32
        || action.ciphertext.len() != 52
    {
        return None;
    }

    let nf_arr: [u8; 32] = action.nullifier.clone().try_into().ok()?;
    let nullifier = Nullifier::from_bytes(&nf_arr);
    if nullifier.is_none().into() {
        return None;
    }

    let cmx_arr: [u8; 32] = action.cmx.clone().try_into().ok()?;
    let cmx = ExtractedNoteCommitment::from_bytes(&cmx_arr);
    if cmx.is_none().into() {
        return None;
    }

    let ek_arr: [u8; 32] = action.ephemeral_key.clone().try_into().ok()?;
    let ephemeral_key = EphemeralKeyBytes(ek_arr);

    let enc_ciphertext: [u8; 52] = action.ciphertext.clone().try_into().ok()?;

    let compact = CompactAction::from_parts(
        nullifier.unwrap(),
        cmx.unwrap(),
        ephemeral_key,
        enc_ciphertext,
    );

    let domain = OrchardDomain::for_compact_action(&compact);

    try_compact_note_decryption(&domain, prepared_ivk, &compact)
}

pub struct OrchardScanResult {
    pub total_received: u64,
    pub notes_found: u32,
    /// Notes newly discovered in this scan range (not previously in DB).
    pub new_notes: u32,
    pub blocks_scanned: u64,
    pub tip_height: u64,
}

// ── Raw v5 transaction parsing for full memo decryption ────────────────

use orchard::Action;
use orchard::note::TransmittedNoteCiphertext;
use orchard::primitives::redpallas::{self, SpendAuth};
use orchard::value::ValueCommitment;

/// Read a Bitcoin-style compact size from a byte slice.
/// Returns (value, bytes_consumed).
fn read_compact_size(data: &[u8]) -> Result<(u64, usize)> {
    if data.is_empty() {
        return Err(anyhow::anyhow!("Unexpected end of data reading compact size"));
    }
    match data[0] {
        0..=252 => Ok((data[0] as u64, 1)),
        253 => {
            if data.len() < 3 { return Err(anyhow::anyhow!("Short compact size (fd)")); }
            Ok((u16::from_le_bytes([data[1], data[2]]) as u64, 3))
        }
        254 => {
            if data.len() < 5 { return Err(anyhow::anyhow!("Short compact size (fe)")); }
            Ok((u32::from_le_bytes([data[1], data[2], data[3], data[4]]) as u64, 5))
        }
        255 => {
            if data.len() < 9 { return Err(anyhow::anyhow!("Short compact size (ff)")); }
            Ok((u64::from_le_bytes([data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8]]), 9))
        }
    }
}

/// Parse a v5 Zcash transaction and extract Orchard actions with full ciphertext.
/// This allows `try_note_decryption` to recover the 512-byte memo field.
///
/// v5 layout:
///   header (4+4+4+4+4 = 20 bytes)
///   transparent inputs/outputs (variable)
///   sapling spends/outputs (variable)
///   orchard actions (variable — what we want)
pub fn parse_orchard_actions_from_raw_tx(raw: &[u8]) -> Result<Vec<Action<()>>> {
    if raw.len() < 20 {
        return Err(anyhow::anyhow!("Transaction too short: {} bytes", raw.len()));
    }

    let version = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]);
    if version != 0x80000005 {
        return Err(anyhow::anyhow!("Not a v5 transaction (version=0x{:08x})", version));
    }

    // Skip: version(4) + version_group_id(4) + branch_id(4) + lock_time(4) + expiry(4) = 20
    let mut offset = 20;

    // Skip transparent inputs
    let (n_vin, sz) = read_compact_size(&raw[offset..])?;
    offset += sz;
    for _ in 0..n_vin {
        // prevout (32 txid + 4 index) + compact_size script + script + sequence(4)
        offset = offset.checked_add(36)
            .filter(|&o| o <= raw.len())
            .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping prevout at offset {}", offset))?;
        let (script_len, sz) = read_compact_size(&raw[offset..])?;
        offset = offset.checked_add(sz).and_then(|o| o.checked_add(script_len as usize)).and_then(|o| o.checked_add(4))
            .filter(|&o| o <= raw.len())
            .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping input script at offset {}", offset))?;
    }

    // Skip transparent outputs
    let (n_vout, sz) = read_compact_size(&raw[offset..])?;
    offset += sz;
    for _ in 0..n_vout {
        offset = offset.checked_add(8)
            .filter(|&o| o <= raw.len())
            .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping output value at offset {}", offset))?;
        let (script_len, sz) = read_compact_size(&raw[offset..])?;
        offset = offset.checked_add(sz).and_then(|o| o.checked_add(script_len as usize))
            .filter(|&o| o <= raw.len())
            .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping output script at offset {}", offset))?;
    }

    // Skip sapling spends (nSpendsSapling)
    let (n_sapling_spends, sz) = read_compact_size(&raw[offset..])?;
    offset += sz;

    // Skip sapling outputs (nOutputsSapling)
    let (n_sapling_outputs, sz) = read_compact_size(&raw[offset..])?;
    offset += sz;

    // Skip Sapling bundle (v5 layout: spends, outputs, value_balance, anchor, proofs, sigs)
    // v5 sapling spend: cv(32) + nullifier(32) + rk(32) = 96 bytes
    offset = (n_sapling_spends as usize).checked_mul(96).and_then(|n| offset.checked_add(n))
        .filter(|&o| o <= raw.len())
        .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping sapling spends at offset {}", offset))?;
    // v5 sapling output: cv(32) + cmu(32) + epk(32) + enc_ciphertext(580) + out_ciphertext(80) = 756 bytes
    offset = (n_sapling_outputs as usize).checked_mul(756).and_then(|n| offset.checked_add(n))
        .filter(|&o| o <= raw.len())
        .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping sapling outputs at offset {}", offset))?;

    if n_sapling_spends > 0 || n_sapling_outputs > 0 {
        // valueBalanceSapling: 8 bytes (present if either count > 0)
        offset = offset.checked_add(8)
            .filter(|&o| o <= raw.len())
            .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping sapling value balance at offset {}", offset))?;
    }
    if n_sapling_spends > 0 {
        // Sapling anchor: 32 bytes (present if spends > 0)
        offset = offset.checked_add(32)
            .filter(|&o| o <= raw.len())
            .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping sapling anchor at offset {}", offset))?;
    }
    // Spend proofs: 192 bytes per spend (Groth16)
    offset = (n_sapling_spends as usize).checked_mul(192).and_then(|n| offset.checked_add(n))
        .filter(|&o| o <= raw.len())
        .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping sapling spend proofs at offset {}", offset))?;
    // Spend auth sigs: 64 bytes per spend
    offset = (n_sapling_spends as usize).checked_mul(64).and_then(|n| offset.checked_add(n))
        .filter(|&o| o <= raw.len())
        .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping sapling spend sigs at offset {}", offset))?;
    // Output proofs: 192 bytes per output (Groth16)
    offset = (n_sapling_outputs as usize).checked_mul(192).and_then(|n| offset.checked_add(n))
        .filter(|&o| o <= raw.len())
        .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping sapling output proofs at offset {}", offset))?;
    if n_sapling_spends > 0 || n_sapling_outputs > 0 {
        // Binding sig: 64 bytes
        offset = offset.checked_add(64)
            .filter(|&o| o <= raw.len())
            .ok_or_else(|| anyhow::anyhow!("Offset overflow/OOB skipping sapling binding sig at offset {}", offset))?;
    }

    // Now parse Orchard actions
    let (n_orchard_actions, sz) = read_compact_size(&raw[offset..])?;
    offset += sz;

    if n_orchard_actions == 0 {
        return Ok(Vec::new());
    }

    let mut actions: Vec<Action<()>> = Vec::with_capacity(n_orchard_actions as usize);

    for _ in 0..n_orchard_actions {
        if offset + 820 > raw.len() {
            return Err(anyhow::anyhow!(
                "Not enough bytes for Orchard action at offset {} (need 820, have {})",
                offset, raw.len() - offset
            ));
        }

        // cv_net: 32 bytes
        let mut cv_bytes = [0u8; 32];
        cv_bytes.copy_from_slice(&raw[offset..offset + 32]);
        offset += 32;

        // nullifier: 32 bytes
        let mut nf_bytes = [0u8; 32];
        nf_bytes.copy_from_slice(&raw[offset..offset + 32]);
        offset += 32;

        // rk: 32 bytes
        let mut rk_bytes = [0u8; 32];
        rk_bytes.copy_from_slice(&raw[offset..offset + 32]);
        offset += 32;

        // cmx: 32 bytes
        let mut cmx_bytes = [0u8; 32];
        cmx_bytes.copy_from_slice(&raw[offset..offset + 32]);
        offset += 32;

        // epk: 32 bytes
        let mut epk_bytes = [0u8; 32];
        epk_bytes.copy_from_slice(&raw[offset..offset + 32]);
        offset += 32;

        // enc_ciphertext: 580 bytes
        let mut enc_ciphertext = [0u8; 580];
        enc_ciphertext.copy_from_slice(&raw[offset..offset + 580]);
        offset += 580;

        // out_ciphertext: 80 bytes
        let mut out_ciphertext = [0u8; 80];
        out_ciphertext.copy_from_slice(&raw[offset..offset + 80]);
        offset += 80;

        // Construct Action<()>
        let nf = Nullifier::from_bytes(&nf_bytes);
        if bool::from(nf.is_none()) { continue; }

        let cmx = ExtractedNoteCommitment::from_bytes(&cmx_bytes);
        if bool::from(cmx.is_none()) { continue; }

        let cv_net = ValueCommitment::from_bytes(&cv_bytes);
        if bool::from(cv_net.is_none()) { continue; }

        let rk: redpallas::VerificationKey<SpendAuth> = match rk_bytes.try_into() {
            Ok(k) => k,
            Err(_) => continue,
        };

        let encrypted_note = TransmittedNoteCiphertext {
            epk_bytes,
            enc_ciphertext,
            out_ciphertext,
        };

        let action = Action::from_parts(
            nf.unwrap(),
            rk,
            cmx.unwrap(),
            encrypted_note,
            cv_net.unwrap(),
            (),
        );
        actions.push(action);
    }

    debug!("Parsed {} Orchard actions from raw tx ({} bytes)", actions.len(), raw.len());
    Ok(actions)
}
