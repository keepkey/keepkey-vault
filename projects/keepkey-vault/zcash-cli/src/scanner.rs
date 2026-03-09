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
use zcash_note_encryption::{try_compact_note_decryption, EphemeralKeyBytes};

use crate::wallet_db::{WalletDb, ScannedNote};

// Generated from proto files
pub mod proto {
    tonic::include_proto!("cash.z.wallet.sdk.rpc");
}

use proto::compact_tx_streamer_client::CompactTxStreamerClient;

const DEFAULT_LWD_SERVER: &str = "https://na.zec.rocks:443";
// Orchard activated at NU5 height
const ORCHARD_ACTIVATION_HEIGHT: u64 = 1687104;

pub struct LightwalletClient {
    client: CompactTxStreamerClient<Channel>,
}

impl LightwalletClient {
    /// Connect to a lightwalletd gRPC server.
    pub async fn connect(server_url: Option<&str>) -> Result<Self> {
        let url = server_url.unwrap_or(DEFAULT_LWD_SERVER);
        info!("Connecting to lightwalletd: {}", url);

        let tls = ClientTlsConfig::new().with_native_roots();
        let channel = Channel::from_shared(url.to_string())
            .context("Invalid server URL")?
            .tls_config(tls)
            .context("TLS config failed")?
            .connect()
            .await
            .context("Failed to connect to lightwalletd")?;

        let client = CompactTxStreamerClient::new(channel);
        info!("Connected to lightwalletd");
        Ok(Self { client })
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

        let start = match force_start {
            Some(h) => h,
            None => db.last_scanned_height()?
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

        if start > tip {
            info!("Already up to date (scanned to {}, tip is {})", start - 1, tip);
            let balance = db.get_balance()?;
            let (_total, unspent) = db.get_note_count()?;
            return Ok(OrchardScanResult {
                total_received: balance,
                notes_found: unspent as u32,
                blocks_scanned: 0,
                tip_height: tip,
            });
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

            db.set_last_scanned_height(end)?;
            current = end + 1;

            // Log progress
            let progress = ((end - start + 1) as f64 / (tip - start + 1) as f64) * 100.0;
            if blocks_scanned % 10000 == 0 || end == tip {
                info!("Scan progress: {:.1}% ({}/{})", progress, end, tip);
            }
        }

        let balance = db.get_balance()?;
        let (_total, unspent) = db.get_note_count()?;

        info!(
            "Scan complete: {} blocks, {} new notes, {} spent, balance: {:.8} ZEC",
            blocks_scanned, new_notes, spent_notes, balance as f64 / 1e8
        );

        Ok(OrchardScanResult {
            total_received: balance,
            notes_found: unspent as u32,
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
    pub blocks_scanned: u64,
    pub tip_height: u64,
}
