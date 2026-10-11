# State of the system

What is true now, per subsystem, and what not to re-propose. Decisions and
their history are in `docs/DECISIONS.md`; update both when anything changes.
Where the code lives and what comes next: `docs/HANDOFF-2026-10-04.md`.
Last updated 2026-10-05 (D-022 release train, 7.16 completion board).

Status words: **code** (written) · **wired** (reachable from the real entry
point) · **deployed** (live or flashed) · **verified** (passed on hardware in
a real user journey).

## Signing policy

- The one rule (D-007): native decode signs; 7.15 needs AdvancedMode for
  anything else; 7.16 signs KeepKey-certified payloads without AdvancedMode.
  AdvancedMode is session-only, cleared at boot and lock.
- Unlimited `approve` is reviewed, not refused (D-010). Open: unlimited
  EIP-2612/DAI permits are still refused.
- Do not re-propose: a per-gate decision list; asking a user to enable
  AdvancedMode as a workaround.

## ClearSign

- Model (D-018): no live signing. Recipes, names, token identities and
  Uniswap decoder entries are signed offline and served as static files;
  the device decodes the values. Desktop shows a richer host-side preview
  as advice.
- Trust chain (D-004): offline root on a KeepKey → per-chain delegate
  certificate (Ethereum, Solana, Base 8453, Arbitrum 42161; expiry
  2026-12-31) → delegate `a9531b9d` on the ClearSign worker.
- Formats on the device (7.16): v2 and 0x05 schemas (device-decoded),
  0x06 names, KKSOLSC1 Solana schemas. 0x07 Uniswap decoder: being restored
  with clean-up and split routes (D-018). Per-transaction v1 stays out of
  the certified tier.
- Live service: `https://keepkey-clearsign.bithighlander.workers.dev`
  (`projects/keepkey-vault/clearsign-worker`). Deploy only from a pushed
  commit (`make clearsign-worker-deploy`).
- Next: offline ceremony signing of the catalog; delegate key off
  Cloudflare (D-018).
- Generic engine: the on-device ERC-7730 interpreter already on 7.16
  (`lib/firmware/erc7730_*.c`, compiler `keepkeylib/erc7730_compiler.py`).
  Certified programs still require AdvancedMode (`fsm_msg_ethereum.h:1120`,
  `:1210`), a bug against D-007. Extend it; do not design a new decoder.
- Uniswap V4 (D-019, D-021): **code** on fork branch `feat/716-ur-streaming`
  (`51f85368e`, off `162bc884f`). Streaming decoder, 1,472 B buffer removed;
  V4 SWAP_EXACT_IN/OUT + SETTLE/TAKE/TAKE_PORTION, every hook shown, hookData
  refused, V4 accepted only for UR 2.1.2 `0xd614…9c40` (layout verified from
  the deployed source; UR 2.0's V4 layout differs). `ur_summarize` is now a
  token-flow check (identical reviews for all 969 previously reviewed calls;
  fixes an unwrap-minimum unit defect). 990/1,000 sample calls reviewed (was
  740). Flash 636,860 B, RAM reserve 17,336 B; 976 unit tests pass (same 7
  base failures). Not yet wired (Desktop REST + emulator) or verified on
  hardware. Needs: human review of the token-flow rules; vault parity
  (Desktop V4 preview, worker 0x07 entry for 0xd614 on 8453 with paid +
  delivered tokens, <= 4 tokens).
- 7.17 (D-020): extend the ERC-7730 interpreter (embedded calldata,
  command streams, constraints and summaries); then decide whether the
  Universal Router moves to descriptors.
- Do not re-propose: persisting signers to flash (D-003); an online
  per-transaction signer for the certified tier (D-018); a new generic
  decoder (the ERC-7730 interpreter exists; extend it, D-020).

## Firmware size and memory (7.16 test line)

- Flash limit 655,321 bytes (D-013). After the integer printf (D-012) and
  removing the decoder: about 23 KB free (measured 632,284 B before the
  removal).
- SRAM reserve minimum 16,384 B; the CI budget allows at most +256 B per
  change without review.
- Next: token table to stablecoins plus the tokens the coins table and
  tests require (D-014).
- Do not re-propose: `nano.specs` (no `%lld`); removing the ed25519 base
  table; merging the AES implementations.

## 7.16 EVM release target (owner-agreed 2026-10-04)

Bar: the common EVM actions on the major chains sign without blind signing
and without AdvancedMode for anything we support.

| # | Area | Scope | State |
|---|---|---|---|
| 1 | One rule (D-007) | certified ERC-7730 programs sign without AdvancedMode (`fsm_msg_ethereum.h:1120`, `:1210`) | bug, to fix |
| 2 | Uniswap | 0x07 streaming decoder: V2/V3 + clean-up + split routes + V4 (D-019, D-021), ~99% of Base router calls | in progress |
| 3 | Tokens | ERC-20 transfer/approve from signed token identities; "unlimited" at >= 2^255 | threshold fix |
| 4 | Permits | Permit2 approve wording (not "Uniswap"); PermitSingle token names on Base/Arbitrum; EIP-2612/DAI unlimited allowed with a warning | Ledger-comparison fixes |
| 5 | Catalog | ERC-7730 registry compiled + human-reviewed per chain; Across `depositV3` descriptor | pipeline exists |
| 6 | Names | 0x06 records: Permit2, Universal Routers, Across SpokePools | extend entries |
| 7 | Trust | catalog signed offline, delegate key off Cloudflare (D-018 item 2) | gates the release |

Chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche
(+ Unichain if traffic justifies). Mostly certificate scopes and catalog
entries, not firmware; confirm chain names/symbols per chain.
Next (7.17): streaming V4 above the buffer, UniswapX and Permit2 batch
descriptors, long-tail chains, the D-020 interpreter extensions.
Gates: every journey verified on hardware through Desktop; flash and RAM
per change (limit 655,321 B); release hygiene from the handoff; land through
the block SOP on the fork.

## 7.16 completion board (D-022: finish on the fork first)

Firmware PRs into fork `develop`, in this order; cut `release/7.16.0-rcN`
after each merge (SOP: one PR at a time, CI green, pins = #197/#112 heads).

| ID | Work | Owner | Status |
|---|---|---|---|
| F-A | D-018 Uniswap decoder restore (`feat/716-uniswap-clearsign-20261003`, 12 commits) | Claude | PR BitHighlander/keepkey-firmware#947 (lint, cppcheck, builds, unit, btc-only integration green; full integration + report gates failing, to investigate) |
| F-B | Streaming decoder + V4 (`feat/716-ur-streaming`, +5 on F-A) | Claude | PR #948 (stacked on #947; F-A fixes merged in; 976 unit pass) |
| F-C | D-007: certified ERC-7730 programs sign without AdvancedMode (`fsm_msg_ethereum.h:1120`, `:1210`) | Claude | PR #950 (stacked on #948): certified tier no longer reads AdvancedMode; 4 gates admit certified; lowest tier of outer/inner wins; 980 unit pass; flash 637,228 B |
| F-D | EIP-712 permits: UNLIMITED at >= 2^255; EIP-2612/DAI unlimited allowed with a warning; PermitSingle token names from signed identities (Base/Arbitrum) | Claude | PR #949 (stacked on #948): 983 unit pass; flash 638,124 B, RAM reserve 17,152 B; 2 python-keepkey emulator tests need updating (pin #197, owner OK) |
| F-F | Address-book ClearSign (certified contact labels for plain sends): port alpha `f12f9e1d9` into 7.16 (never ported; vault already attaches proofs for >= 7.16.0, owner's setting is on with a 10-contact certification) | Claude | PR BitHighlander/keepkey-firmware#951 (stacked on #948): 6 alpha commits ported; send shows "Send X to <label>" + "Contact Address"; never for approvals/contract calls/with contract metadata; vault format byte-identical, owner's stored certification verifies (no re-certify); 989 unit pass; flash +2,944 B |
| V-D | In-app swap ClearSign (owner priority): in-app card used its own report path (P1 for everything); Relay `depositErc20` had no catalog entry | Claude | vault `bfb7adf4f` on feature-clearsign: shared report builder; Relay depositErc20 0x05 entries per reviewed token + depositNative on Base/Arbitrum (live only after worker deploy + owner screen review + ceremony) |
| F-E | D-014 stablecoin token table: python-keepkey `3791441` is not in canonical #197 (pinned head builds 351 tokens) | Owner OK (push to canonical PR, D-017) | blocked |
| V-A | Vault: Permit2 approve wording (not "Uniswap"); USDT0 provenance text; "SIGNED" badge verifies signatures | Claude | to do |
| V-B | Catalog: ERC-7730 registry compiled + human-reviewed per chain; Across `depositV3` descriptor (after F-C) | Claude + owner review | to do |
| V-C | Chain certificates: Optimism, Polygon, BNB, Avalanche (+ Unichain?) | Owner (ceremony) | to do |
| T-A | Offline catalog signing; delegate key off Cloudflare (D-018 item 2) | Owner (ceremony) + Claude (tooling) | to do |
| Q-A | Emulator runs through Desktop REST for every journey | Claude | to do |
| Q-B | Hardware journeys re-run on a CI-built RC image (not local test-key builds) | Owner + Claude | after F-D |
| Q-C | Human review of the token-flow `ur_summarize` | Owner | to do |
| H-A | Hygiene: hdwallet PR for the EIP-712 decode fix (`401068f4`); #465 `TransportTimeoutError`; PIN-failure wipe decision; #860 timer | mixed | open |

Then (D-022 item 2): upstream 7.15 only, in <= 20k-line blocks, each
Copilot-clean before human review.

## Releases and branches

- Firmware: develop flow on the fork; block PRs onto develop; canonical pins
  python-keepkey #197 head and device-protocol #112 head (D-017).
- Never commit test keys, the test-key swap or test images. Keys live in
  `~/.keepkey-testkeys`, images in `~/keepkey-test-images`.

## User journeys

| Journey | Status | Notes |
|---|---|---|
| Uniswap on Base: approve to Permit2 | verified 2026-10-03 | certified approve, no AdvancedMode |
| Uniswap on Base: Permit2 signature | verified 2026-10-03 | after hdwallet fix `401068f4` |
| Uniswap on Base: swap (V2/V3) | blocked | waits on the restored decoder (D-018); 162bc884f flashed 2026-10-04, hardware run pending |
| Uniswap on Base: swap (V4) | verified 2026-10-04 | test image `51f85368e` (sha256 `3be740a7…9125`), Desktop `1128801d0`, AdvancedMode off: 3 USDC → 0.0011005 ETH, `V4_SWAP, UNWRAP_WETH`, 1,434 B, tx `0xb16ef655e2fa943ff9d60e33b15af9d7824b4dd8a13c0c285c080340a2572f77` (Base block 52190719). V3 regression on the same image verified: 100 USDC → ETH, `V3_SWAP_EXACT_IN, UNWRAP_WETH`, tx `0x72fbbafa2d79fd3bf1e93e75883c56d7ce96aad142382e0f0481fdaa1bc14b51`. Native ETH in verified: 0.003 ETH → 8.168538 USDC, `WRAP_ETH, V3_SWAP_EXACT_IN`, tx `0x0fd319b6b3ebc3967f88d429dd07c458707a4b1a2209976e3b208896b9db8e02`. Token to token verified: 5 USDC → 0.00005792 cbBTC (8 decimals), `V3_SWAP_EXACT_IN`, tx `0x70bd282e1a7948c994cf3ef352619da78dd92324d0a4fa8fbd97faf3f38a809b`. First-time Permit2 journey verified (cbBTC → ETH): certified approve to Permit2 (tx `0x92facb863277e054c23b8ef13476404cb0fbd6409efe22e109bcf1bc6acd8acc`), PermitSingle EIP-712 signature, swap `PERMIT2_PERMIT, V3_SWAP_EXACT_IN, UNWRAP_WETH` (tx `0x41e187a81693f1a6714a427f9d7b10a50046085fb1e7199579ccf596a65cbf09`). Observed: Uniswap stayed on "Approving" after the approve was mined (extension returned the mined hash); reopening the review continued. Open: whether the PermitSingle screen named cbBTC (owner to confirm). Not yet: emulator run through Desktop REST, a hooked pool (the sample's hooked pools are an ETH/WETH router hook and uncertified tokens; covered by the firmware's end-to-end test of real call 0x0179d8f1) |
| Pump.fun buy/sell (PumpSwap) | verified 2026-10-02 | |
| Relay ETH ⇄ Solana | verified 2026-07-28 | |
| PIN unlock after idle | verified 2026-10-03 | D-011 |
