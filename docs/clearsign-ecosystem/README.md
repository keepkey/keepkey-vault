# ClearSign ecosystem coverage and approval pipeline

Objective: cover the entire Pioneer discovery ecosystem and live contract demand,
with audited candidates submitted for approval before certified publication.
The objective remains active. A signed token label is not proof of contract safety
or complete swap/device coverage.

## Evidence as of 2026-09-21

- `assets.jsonl` accounts for every one of 24,087 asset records, with explicit
  blockers and source identity. `summary.json` pins source hashes and totals.
- 7,192 entries are eligible for the current EVM token signer; 16,895 need work.
  Blocker totals overlap. No inventory entry is marked device-verified merely
  because an API can sign its schema.
- Pioneer Discovery's legacy signed bundle is a subset rather than the complete
  inventory: 8,728 token-metadata blobs, 2,933 EVM selector blobs, and 28 Cosmos
  message blobs. `bun run clearsign:verify-pioneer-signatures` recursively
  verifies every declared blob count, SHA-256 payload digest, recoverable
  secp256k1 signature, and the manifest's key-slot-0 public key. The current
  package passes all 11,689 signatures. This proves bundle integrity; current
  chain identity audits and device trust policy remain separate gates.
- Thirteen chain certificates are installed on the live worker. The entire
  existing eligible token snapshot has certificate coverage.
- A persistent Cloudflare D1 control plane is deployed as `keepkey-clearsign-discovery`,
  ID `76d67a28-c9a4-4a45-9c9b-d386c768927a`.
- Worker source: `.worktrees/keepkey-vault-solana-certified/projects/keepkey-vault/clearsign-worker`.
  Deployment `9b38713b-0883-4a23-91c2-8649f7298339` automatically queues valid EVM
  schema misses, identity verification failures, and missing certificates.
- Live proof: Arbitrum USDT `transfer(address,uint256)` produced an unsigned
  OPAQUE response and durable request
  `8489fde370e69bf1196db8ee83b3da0d4192ec85755e9aada75bbab18e839819`.
  The daemon audited it and moved it to `awaiting-approval`; the existing USDT
  approval remains a separate supported shape.
- The complete 24,087-row ledger is imported and marked complete against source
  hash `8d4aacccb93c899c0ed90e46c40298768d4dbcdae54f3004b5959b88c6634a48`.
  Live catalog summary reports 7,192 eligible and 16,895 needing work.
- Request persistence retains only public network/contract/selector/byte-length,
  reason and aggregate timestamps/counts. Retries cannot reset approval state.
  No public API grants approval or writes audit/review evidence.
- Auditors use atomic five-minute leases, hashed lease tokens, bounded retry
  backoff, and immutable evidence hashes. A macOS LaunchAgent
  `com.keepkey.clearsign-auditor` is running and continuously drains requests.
  Evidence with no selector-matched definition is retained as a terminal rejection;
  evidence with a candidate moves to `awaiting-approval`.
- The 16,895 `needs-work` inventory rows now have a separate persistent asset-audit
  lifecycle. Covered inventory cannot be leased. Candidates retain fixed-block
  chain ID, bytecode hash, symbol, decimals, and RPC host evidence, while their
  signing coverage remains `needs-work`. The rate-limited LaunchAgent
  `com.keepkey.clearsign-asset-auditor` audits five EVM assets per minute. Its first
  production batch produced five candidates and safely backed off two contracts
  with noncanonical RPC results. Candidate evidence never grants signing rights.
- Asset candidates use the same two-person cryptographic policy as requested
  contract shapes: distinct authorized semantics and security reviewers sign the
  exact evidence hash, and any signed rejection wins. Approval remains separate
  from `coverage_status`; compilation, device-oracle validation, and publication
  must still succeed. Production currently has no reviewer allowlist, and a live
  unauthorized-review probe was rejected with `REVIEWER_NOT_AUTHORIZED`.
- Worker deployment `aeabd94a-cdc2-4bc1-8add-f606d97a2a5b` treats malformed
  successful ERC-20 `symbol()` or `decimals()` return bytes as terminal,
  immutable rejection evidence. It pins the chain, block, contract code hash,
  selector, and a hash of each returned value. Transport failures remain
  retriable. This closes the retry loop without accepting malformed metadata.
- Worker deployment `0003bc87-9f1c-45bd-9985-623461738bbf` similarly records
  malformed THORChain denom identities and live pool rows with unusable identity
  fields as block-bound terminal evidence. Valid but temporarily unlisted pools
  and RPC failures still retry. The persistent THORChain auditor was restarted
  onto this code; existing backoff windows are retained rather than bypassed.
- Worker deployment `b4220c12-ad9d-49a3-a73b-cf3263d147cc` adds native
  evidence for Pioneer CACAO and both RUNE network aliases. CACAO is pinned to
  the synchronized `mayachain-mainnet-v1` Tendermint chain and RUNE to the
  synchronized `thorchain-1` chain, including block and app hashes. The
  persistent Cosmos auditor was restarted and retains existing backoff windows.
- The persistent EVM asset auditor now processes 100 rows per cycle after its
  last 120 results completed without transport failures (107 candidates and 13
  terminal evidence rejections). Solana remains capped at 20 rows per cycle to
  preserve public-RPC headroom.
- Solana `token:` inventory now uses the same leased evidence and approval queue.
  The auditor verifies the full mainnet genesis hash, a finalized slot, exact mint
  account hash, token-program owner, data length, decimals, initialization and
  mint/freeze authorities. It does not treat Pioneer symbols as on-chain truth.
  `com.keepkey.clearsign-solana-asset-auditor` runs three mints per minute; its
  first five live mint audits produced valid candidates while coverage remained
  `needs-work`. Native `slip44` rows are excluded from token auditors.
- `com.keepkey.clearsign-source-monitor` hashes the Pioneer assets and denylist
  hourly. The latest observation is stored centrally without source contents or
  credentials. A hash mismatch pauses dynamic discovery signing with
  `DISCOVERY_SOURCE_REVIEW_REQUIRED`; the snapshot must be regenerated, reviewed,
  tested, imported, and deployed before signing resumes. The initial live
  observation matches both deployed hashes, and certified EVM verification passes.
- Asset audit evidence is append-only in `discovery_asset_audits`; the current
  pointer does not replace history. Candidate EVM code and Solana mint evidence is
  scheduled for revalidation every seven days. Claiming a recheck immediately
  resets prior approval to pending, and a changed evidence hash requires fresh
  two-person review. Production backfilled all 83 existing evidence records and
  scheduled all 83 without approving any `needs-work` row. Reviewers can retrieve
  the full history through the authenticated asset-history endpoint.
- Unknown Solana transactions now enqueue one privacy-safe row per instruction:
  program ID, discriminator prefix, data length, and signer/writable privilege
  shape only. The central auditor supports public program identity plus canonical
  Program Metadata/Anchor IDL and pinned registry candidate discovery.
- The first real queued audit, Arbitrum USDT transfer, is awaiting approval with
  one Sourcify candidate and contract+implementation code identities. Two negative
  tests are rejected. A denylisted BSC token briefly exposed a policy-layer gap;
  its row was terminally rejected and deployment now refuses denylisted contracts
  before queue creation (`DISCOVERY_CONTRACT_DENIED`).
- Review code requires two authorized, distinct, signed reviewers with semantics
  and security roles. A signed rejection overrides approvals. No reviewer allowlist
  is provisioned yet, so nothing in the queue can currently become approved.
- ClearSign Studio can now send an already-built canonical review statement to a
  fixed-role reviewer service through the Vault backend. Each role has its own
  service URL and backend-only bearer-token file
  (`CLEARSIGN_SEMANTICS_REVIEW_SIGNER_*` or
  `CLEARSIGN_SECURITY_REVIEW_SIGNER_*`). The backend accepts HTTPS or localhost
  HTTP, refuses embedded credentials and redirects, and verifies that the signer
  returned the exact statement plus a 65-byte recoverable signature. The renderer
  never receives the bearer token or either reviewer private key. Studio can read
  the configured service's public role, key, and fingerprint, validates that
  identity, and fills the review form without manual key copying.
- ClearSign Studio now opens each candidate's append-only evidence history, copies
  a review bundle, creates the worker's exact canonical review statement and
  SHA-256 digest, and submits the externally signed JSON through a backend-only
  channel. Vault never receives reviewer private keys. Digest parity was checked
  directly against the production worker implementation. A live unauthorized
  submission returned HTTP 422 `REVIEWER_NOT_AUTHORIZED` without changing the
  candidate's pending approval state.
- Contract requests now expose their current immutable audit ID through the
  authenticated queue API. Worker deployment
  `0777990f-ad6c-4588-adc4-f7585c0f26bf` makes the audited shape retrievable in
  Studio without exposing a lease token. Studio displays and copies the evidence,
  builds the separate `KEEPKEY_CLEARSIGN_DISCOVERY_REVIEW_V1` digest, and submits
  externally signed contract reviews through the backend. The live Arbitrum USDT
  transfer request resolves to audit `ec12b337…e442`, evidence hash
  `ae2732e9…3105`, and one candidate definition.
- The live asset backfill has advanced to 187 immutable candidates while all
  16,895 `needs-work` assets remain approval-pending and uncovered. The promotion
  compiler must join a reviewed contract ABI with separately approved current
  token identity evidence before compiling a `TOKEN_AMOUNT` display. Verified
  source for `transfer(address,uint256)` alone does not authenticate a symbol or
  decimals, and therefore cannot publish a named token amount.
- The promotion compiler now implements that join. It requires an approved asset
  candidate, the exact current append-only audit ID and evidence hash, an unexpired
  recheck deadline, matching chain/CAIP/contract, and the same contract bytecode
  hash in both the call audit and token audit. Only then can it emit an unsigned
  firmware-v2 `TOKEN_AMOUNT` artifact. Pending approval, stale evidence, changed
  code, unsupported selectors, and unrenderable symbols fail closed. The output
  remains unsigned and cannot publish itself.
- Worker deployment `d56f0cf0-9e0f-4803-9657-0be6cfccaa8e` adds authenticated
  exact-CAIP lookup, so promotion never depends on a bounded candidate-list page.
  `scripts/clearsign-promotion-planner.ts` now reads approved contract requests,
  fetches both current audits, applies the join, and emits either an unsigned
  artifact or a specific blocker. It never signs or publishes. Its first live run
  correctly reported zero approved contract requests and produced no artifacts.
- `com.keepkey.clearsign-promotion-planner` now runs that planner every five
  minutes and atomically writes
  `~/Library/Application Support/com.keepkey.vault/clearsign-promotion-plan.json`.
  Its first scheduled runs exited 0 with zero approved requests. The job is
  deliberately read-only: a ready plan is still unsigned and cannot mutate the
  signer catalog or worker deployment.
- Local promoted artifact import now requires the certificate's exact compiled
  EVM chain ID, with a real Arbitrum-certificate regression test.
- Worker deployment `05743dd7-5e11-479e-8ef5-3db6a134ce59` adds immutable
  `tron-token-contract` evidence. It binds the exact Pioneer CAIP and Base58
  contract to Tron mainnet, a solid block number/hash, the node-reported code
  hash, and live `symbol()`/`decimals()` results. The persistent read-only auditor
  `com.keepkey.clearsign-tron-asset-auditor` submitted Tron USDT as candidate
  evidence `16bf926d…3449` (`USDT`, 6 decimals). It cannot approve, sign, publish,
  or alter coverage; two distinct authorized reviews are still required.
- Worker deployment `9607bbcb-c9db-426b-a4f1-9c64f10e50c3` adds a dedicated
  `denom` lease class and immutable THORChain pool evidence. The evidence binds
  the legacy Pioneer CAIP to the exact live THORChain pool name, `thorchain-1`,
  a block height/hash, pool status, native-chain decimals, and the protocol's
  separate fixed `thorchain-e8` amount encoding. An initial weaker evidence
  shape was invalidated before review while its append-only history was retained.
  Eleven corrected candidates are pending independent review. Native pools with
  no authoritative native-decimal field, Maya, derived `THOR.*`, and `x/ruji`
  remain pending rather than inheriting Pioneer labels. The recurring read-only
  job is `com.keepkey.clearsign-thorchain-asset-auditor`.
- Worker deployment `4c4c7da6-1e04-490b-8f97-c4b0f6ab24b0` adds a separate
  native-asset lease class, block-bound TRX identity evidence, and an authenticated
  review-policy status endpoint. Tron native TRX is pending review as evidence
  `d5212ae5…9bf6`. Production currently reports `ready: false` with zero reviewer
  identities; the live transaction signer has one delegate key and is not silently
  reused as two review roles. Studio now loads candidates from every Pioneer
  namespace and displays this policy blocker. The complete Vault package build
  passes with that status surfaced.
- Worker deployment `9009b586-8239-4cba-8a92-b93d5cd8396d` extends native
  evidence to SOL. It binds `slip44:501` and 9 decimals to the exact Solana
  mainnet genesis hash and a finalized slot. The persistent Solana auditor now
  prioritizes this one native record before continuing the token backfill. Live
  evidence `8b49c095…2c714` is pending review and remains uncovered.
- Worker deployment `454e70e4-64d3-4fcc-8c0b-8d37fd46b87d` adds validated-ledger
  evidence for native XRP. Pioneer carries both the legacy
  `ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144` identity and
  `xrpl:1/slip44:144`; each is audited and reviewed independently while binding
  to XRPL network ID 0, SLIP-44 144, 6 decimals, and the same validated ledger.
  Live evidence hashes are `df66c480…a0d85` and `00baa9a5…2b453`. The recurring
  read-only job is `com.keepkey.clearsign-xrpl-asset-auditor`.
- Worker deployment `0b806340-afe7-45bb-96e5-72a0c02faa33` adds native TON
  evidence. It pins `ton:-239/slip44:607`, workchain `-1`, 9 decimals, and the
  mainnet initialization root/file hashes to a current masterchain block. Live
  evidence `6a11e605…b8724` is pending review. The recurring read-only job is
  `com.keepkey.clearsign-ton-asset-auditor`.
- Worker deployment `80d3f215-de3e-4d8e-8e1a-7ba66456b803` adds block-bound
  BIP-122 native evidence. BTC, BCH, LTC, DOGE, DASH, and ZEC now each have an
  immutable candidate binding the exact genesis-prefix CAIP and SLIP-44 identity
  to a current chain-specific block height/hash. DGB remains pending because the
  configured evidence source does not support it; no static identity was
  substituted. The recurring job is `com.keepkey.clearsign-bip122-asset-auditor`.
- Worker deployment `4970b3e3-52f8-46c5-aa1e-be6efd5cd712` adds native Hive
  evidence. It binds `hive:beeab0de/slip44:1275`, SLIP-44 1275, and 3-decimal
  HIVE to the full mainnet chain ID, the chain-reported HIVE NAI, and a current
  irreversible block. Live evidence `1b5c0e1b…4233a0` is pending review and
  remains uncovered. The recurring job is
  `com.keepkey.clearsign-hive-asset-auditor`.
- Worker deployment `c52cb962-6e1f-400f-92fa-89c8639eefed` adds native Cosmos
  evidence for the chain identities with healthy mainnet RPCs. ATOM evidence
  `432b0965…121e1` binds `cosmoshub-4`, and OSMO evidence
  `ee5f5348…8d363` binds `osmosis-1`; both pin the exact Pioneer CAIP,
  denomination, current block hash, and app hash. THORChain and Maya native
  aliases remain pending while their chain endpoints or Pioneer identities are
  unresolved. The recurring job is `com.keepkey.clearsign-cosmos-asset-auditor`.
- Worker deployment `5a6bc45c-57af-45af-808a-e88214da1a34` completes the
  BIP-122 native evidence set with DigiByte. Candidate evidence
  `24ef4f49…f1a7e5` binds the DGB genesis-prefix CAIP and SLIP-44 20 identity to
  a live height/hash pair from the DigiByte explorer. All seven Pioneer BIP-122
  native rows now have immutable evidence candidates pending review.
- The sole Pioneer `binance` row, `binance:bnb-beacon-chain/slip44:60`, is
  explicitly denied as `network-retired-no-new-blocks`. BNB Chain's official
  Fusion documentation records that Beacon Chain stopped at block 385,251,927
  and no longer accepts transactions. The complete 24,087-row inventory was
  reimported after this classification; production reports the row as denied,
  with both audit and approval status rejected. It is not eligible for a
  fabricated live-signing candidate.
- Inventory schema v2 content-addresses the normalized 24,087 rows together
  with all four input hashes and inventory policy version. Classification-only
  changes can no longer reuse the unchanged Pioneer asset-file hash. Production
  completed policy-v2 inventory run
  `6a08ceb8ebeacc2ab4fc7f1ef9dfdc211a4a61f9023545fcd725adc806c0ee3e`.
- Inventory policy v3 denies the case-invalid duplicate Solana mainnet CAIP
  instead of retrying it forever. Production completed content-addressed run
  `835a14ccf538d08743eb06c7a0e8cf0945ca82bb76655bf588bbbad68678c053`:
  7,192 eligible, 16,893 needs-work, and 2 denied.
- Worker deployment `25691bc6-224e-4eef-8245-263e6fae3330` records contracts
  whose standard ERC-20 metadata calls conclusively revert as terminal
  `metadata-unavailable` evidence. It pins the chain, block, bytecode hash,
  selector-specific JSON-RPC error code and error hash; transport failures and
  rate limits still retry. Production proof asset
  `eip155:1/erc20:0x084b…8928f` is now rejected under evidence
  `a3e7b987…9779b` instead of cycling indefinitely.
- Persistent backfill throughput is now 50 EVM assets and 20 Solana mints per
  minute. Live bounded benchmarks completed 20 EVM rows in 8.8 seconds and,
  after caching the verified Solana genesis/finalized slot for 30 seconds, 20
  Solana rows in 5.5 seconds without a 429. Every mint remains pinned to the
  reported finalized slot; caching removes redundant chain-state reads rather
  than weakening evidence. At the measured rate, the current EVM and Solana
  queues should drain in roughly four hours if public RPC health holds.
- Worker deployment `c109d13e-e31b-4973-b846-15382f4af03d` publishes backfill
  health in `/v1/catalog`: immediately ready rows, scheduled retries, active and
  stale leases, latest audit time, and grouped pending error classes. The live
  endpoint currently reports zero stale leases. This makes a stopped auditor or
  growing failure class observable without direct D1 access.
- The live contract-demand queue contains one review-ready request: Arbitrum
  USDT `transfer(address,uint256)` (`0xa9059cbb`, 68 bytes), audit
  `ec12b337…e442`, evidence `ae2732e9…3105`. The auditor pinned the USDT proxy
  and implementation code hashes and found an exact Sourcify ABI candidate. It
  remains awaiting the two distinct authorized review signatures; evidence is
  not silently promoted into signing authority.
- `../keepkey-clearsign-server/src/review-server.ts` now provides the missing
  fixed-role signing transport for those reviews. Each authenticated instance
  accepts only one configured role and public key, rejects stale or ambiguous
  statements, enforces a private key file with no group/other permissions, and
  returns a recoverable signature over the worker's exact canonical digest.
  Transaction-delegate keys are never selected automatically. Two distinct
  human-assigned key files and production `CLEARSIGN_REVIEWERS_JSON`
  provisioning are still required before review policy becomes ready.

## Remaining delivery requirements

1. Provision two authorized human reviewer public keys in the production worker's
   `CLEARSIGN_REVIEWERS_JSON`: one semantics reviewer and one distinct security
   reviewer. Studio's evidence inspection, digest construction, and signed-review
   submission path is connected; production intentionally has no authorized
   reviewers yet.
2. Connect approved central audits to the existing promotion/compiler/device-oracle
   gate and server publication. Arbitrary
   caller-generated reviewer signatures must not grant production signing rights.
   Approval must bind the exact evidence, compiler artifact and policy version.
3. ClearSign Studio now reads the central inventory, contract queue, asset-audit
   counts, and evidence candidates through a backend-only RPC without exposing the
   operator bearer to the renderer. Merge Vault's local demand queue into central
   status and add remaining chain-family demand.
4. Continue the active EVM backfill and add auditors for non-EVM inventory.
   Resolve metadata conflicts with chain evidence; implement
   honest device formatting for unsupported symbols. Do not silently relabel assets.
5. Extend firmware/runtime coverage for Solana token instructions, other chain
   families, typed data, dynamic ABI/protocol calls, native paths and contract
   identities. Record unsupported formats until implemented and verified.
6. Add ongoing source refresh, code/proxy-change invalidation,
   revocation, certificate renewal, abuse controls and queue service monitoring.
   The current queue has a 100,000-entry cap, not a full anti-abuse system.
7. Verify deployed artifacts against live state and firmware review transcripts.
   Complete the user's live Uniswap replay with USDT and full identity/address
   evidence on every screen; certificate provisioning alone does not prove this.

## Operations

Run worker commands from the production source directory above. Read pending
requests with `wrangler d1 execute keepkey-clearsign-discovery --remote --config
clearsign-worker/wrangler.toml --command "SELECT * FROM discovery_requests WHERE
status='pending' ORDER BY first_seen_at LIMIT 100" --json`.

Schema migrations are under `clearsign-worker/migrations/`. Audit submission and
review verification are deployed; reviewer provisioning, device-oracle promotion,
and publication remain pending.

For asset review, open ClearSign Studio → Evidence, inspect a candidate, and copy
its immutable review bundle. Enter the authorized compressed secp256k1 reviewer
public key, choose the assigned role and decision, and build the statement. Sign
the displayed 32-byte SHA-256 digest in the approved external reviewer-key system,
then paste only the resulting 65-byte recoverable signature into the generated
JSON. Studio checks the selected CAIP and current evidence hash before submitting;
the worker repeats those checks, recovers the signer, enforces its configured role,
and requires the second distinct role before approval. Never paste a private key
or seed into Studio.
The EVM, Solana, Tron, THORChain, and Maya asset auditors are
`projects/keepkey-vault/scripts/clearsign-asset-auditor.ts`,
`clearsign-solana-asset-auditor.ts`, `clearsign-tron-asset-auditor.ts`, and
`clearsign-thorchain-asset-auditor.ts`, `clearsign-mayachain-asset-auditor.ts`,
`clearsign-xrpl-asset-auditor.ts`, and `clearsign-hive-asset-auditor.ts`, plus
`clearsign-cosmos-asset-auditor.ts`;
their stdout/stderr are under
`~/Library/Application Support/com.keepkey.vault/`.
Denom workers request network-scoped leases. This prevents THORChain from
claiming Maya rows and binds `cosmos:mayachain-mainnet-v1/denom:maya` to the
live `maya` bank supply and `MAYA.MAYA` pool identity. Nonnumeric SLIP-44
aliases such as `slip44:maya` are denied by inventory policy rather than
retried as native assets.
Queue data is not signing authorization. Never point deployment at the separate
keyless prototype worker in the main checkout.

Inventory command, from repository root:

```sh
bun projects/keepkey-vault/scripts/clearsign-ecosystem-inventory.ts \
  ../pioneer/modules/pioneer/pioneer-discovery/src/generatedAssetData.json \
  ../pioneer/modules/pioneer/pioneer-discovery/src/denylist.json \
  .worktrees/keepkey-vault-solana-certified/projects/keepkey-vault/clearsign-worker/src/evm-discovery-snapshot.json \
  docs/clearsign-ecosystem/live-catalog.json docs/clearsign-ecosystem
```

The generator rejects source hashes that differ from the signer snapshot. Refresh
the saved live catalog before regenerating certificate coverage.
