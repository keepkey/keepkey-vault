# Decisions

Append-only log of product and architecture decisions for KeepKey firmware,
KeepKey Desktop and the ClearSign service. A decision is never edited away:
when it changes, add a new entry and mark the old one
`SUPERSEDED by D-xxx`. `docs/STATE.md` summarises the decisions that are
active now.

Before proposing a design, search this file for the topic, quote the active
decision, and say why the proposal does not reopen a superseded or rejected
one.

Peer comparison for these decisions (Trezor, Ledger):
`docs/research/hw-wallet-comparison-20261004.md`.

Format: `D-NNN` · date · status · decision · why · evidence.

---

## ClearSign

**D-001** · 2026-06-29 · SUPERSEDED by D-002, then reinstated as D-009
Per-transaction descriptions ("Insight", metadata v1): the host sends a
signed description bound to the transaction hash; the device checks the hash
against the digest it signs (`signed_metadata_enforce`). Runtime signers
only, behind AdvancedMode, additive (the raw review still follows).
Evidence: firmware PR #257; hardware-verified 2026-08-15 with a provider's
live server.

**D-002** · 2026-07-03 · SUPERSEDED by D-004
KeepKey runs no hot per-transaction signer for everyone's traffic. Reusable
schemas (v2), signed offline, where the device decodes each argument from the
calldata it signs. Pioneer `/descriptors/sign` was removed.
Clarified by D-004: this never meant "no per-transaction signing anywhere".

**D-003** · 2026-07-28 · ACTIVE
Never persist ClearSign signers to flash. Loaded signers are RAM-only and
need a device confirmation each session. A rogue persisted signer would
suppress the raw-data review. (Firmware PR #322 closed.)

**D-004** · 2026-08-15 · ACTIVE
Trust chain: an offline root key on a KeepKey certifies per-chain delegate
keys; a delegate signs descriptions. A provider may live-sign its own
transactions under its own certified key. Custody of the root is 1-of-1
(decisions #376 D1); no freshness anchor in 7.15 (D2).
Evidence: `docs/spec-clearsign-certificate-chains.md` (firmware), roadmap
#369, decisions #376.

**D-005** · 2026-08-21 · SUPERSEDED by D-009
Firmware `e44e4999d`: refuse v1 inside the certified envelope (a delegate
could label any calldata). Made without a decision entry and contrary to the
D-004 roadmap ("delegation exists for per-transaction v1"). The ClearSign
server kept building certified per-transaction descriptions on this basis
(keepkey-clearsign-server `14ad811`, 2026-09-25) that every 7.16 build
refused.

**D-006** · 2026-10-02 · ACTIVE
Human-readable review standard for every certified entry: who, what, why,
limit. Text classes: FACT (decoded by the device), VOUCHED (signed by
KeepKey), CLAIMED (the provider's words). No certified entry ships without
its expected screens reviewed first (`clearsign-worker/EXPECTED-SCREENS.md`).

**D-007** · 2026-10-03 · ACTIVE · the one signing rule
1. Firmware decodes it natively: sign, no AdvancedMode.
2. 7.15 (no KeepKey trust root): everything else needs AdvancedMode; with it
   on, a provider's description is shown together with the blind-sign
   information.
3. 7.16: a KeepKey-certified payload that verifies: no AdvancedMode.
   Anything else behaves as 7.15.
A refusal with no AdvancedMode path is a bug. Never ask a user to enable
AdvancedMode as a workaround for a missing clear-sign entry.

**D-008** · 2026-10-03 · SUPERSEDED by D-009, reinstated by D-018
On-device Uniswap Universal Router decoder (metadata 0x07,
`uniswap_ur.c`). Built without reference to D-001/D-004/D-005. Each new
app shape (clean-up sweeps, split routes, V4) needed new firmware, and 7.16
had no flash left. Code kept in firmware history at `5c6b81c04`.

**D-009** · 2026-10-04 · SUPERSEDED by D-018 (was owner-confirmed; firmware `b59c909c0`, reverted)
Dapp descriptions are authored off-device by the ClearSign service and
streamed to the device; the device does not grow a decoder per dapp.
- Remove the 0x07 decoder (done: firmware `8bfa4ca16`).
- Admit certified per-transaction descriptions (v1 in the 0x03 envelope),
  bound to the transaction hash. Any ETH the transaction moves keeps the
  device's own amount screen.
- Trade-off accepted: v1 values are the delegate's words, not decoded facts.
  A stolen delegate key could mislabel a transaction it signs; expiry is the
  certificate's (2026-12-31).
- Supersedes SRS-7.16 R-1.4 and §5 ("per-transaction text in 7.17") on this
  point. The SRS lives on the firmware fork's `alpha` branch and needs a
  matching amendment.
- Serving: the certified per-transaction route from keepkey-clearsign-server
  `14ad811` moves into the canonical ClearSign worker, using its full
  Universal Router decoder (incl. V4); anything not fully explained is
  declined (422 OPAQUE).

**D-018** · 2026-10-04 · ACTIVE (item 3's V4 clause amended by D-019) · no live signing
Owner decision, after the trust analysis of D-009: no online key decides
what the device shows.
1. Per-transaction descriptions stay out of the certified tier (revert
   `b59c909c0`; the `e44e4999d` gate is back).
2. A CAL-like program: recipes (v2/0x05), names (0x06), token identities and
   Uniswap decoder entries are signed offline in a ceremony and published as
   static files. The delegate key comes off Cloudflare; the service only
   serves pre-signed entries.
3. The on-device Uniswap Universal Router decoder (0x07) is restored, with
   the clean-up step (leftover ETH back to the shown recipient) and split
   routes (two swaps of the same pair). About 94% of the Uniswap app's swaps
   on Base. V4 stays on the AdvancedMode path; a streaming V4 decoder is a
   separate later project.
4. KeepKey Desktop gets a full host-side Uniswap preview (all shapes incl.
   V4, token lookups, simulated balance changes). It is advice, labelled as
   checked on this computer; the device screen is the final word.
Why: with per-transaction text a stolen delegate key, a bad deploy or a
decoder bug makes the device show false amounts; with device decoding they
can only mislabel. Ledger and Trezor both keep the device deriving the
values (docs/research/hw-wallet-comparison-20261004.md).
Do not re-propose: an online per-transaction signer for the certified tier.

**D-019** · 2026-10-04 · ACTIVE (buffer clause amended by D-021) · Uniswap V4 in 7.16 through the 0x07 decoder
Owner decision. Amends D-018 item 3 ("V4 stays on the AdvancedMode path").
- Add a `V4_SWAP` (0x10) step to the existing on-device Universal Router
  decoder (`uniswap_ur.c` `decode_step()`): the common action shapes,
  measured from real Base traffic before coding. The device shows the same
  guarantees as V2/V3: pay at most X (settle), receive at least Y (take),
  recipient, native ETH for `address(0)`, and the hooks address when non-zero.
  Unknown actions fail closed (blind/AdvancedMode path), as unknown V3 shapes do.
- Within the existing 1,472-byte `ur_calldata` buffer: the decoder already
  buffers the initial chunk plus streamed chunks and decodes once complete.
  Calldata above the buffer stays blind; streaming beyond it is the later
  project D-018 named.
- Prerequisite: free RAM by sharing the Uniswap buffer (handoff step 6); V4
  adds parse state, not a buffer. Report flash and RAM.
Why: small trades route V4. A 3 USDC → ETH swap on Base on 2026-10-04 was
`V4_SWAP, UNWRAP_WETH` (1,434 bytes of calldata, fits the buffer) while
300 USDC swaps the same day were V3; D-018's "~94% of swaps" does not hold
for small trades. V4 hooks do not weaken the shown guarantees: the router
enforces the settle maximum and take minimum whatever a hook does. Peers:
Ledger's Uniswap plugin has no V4 commands and does not cover the current
Base router; Trezor's "select swap functions" (2.11.1) does not document V4.
Evidence: `unittests/firmware/uniswap_ur.cpp` `V4SwapsAreNotDecoded` (the
test to invert), `uniswap_ur_vectors.h` `v4_rejected()`, `signed_metadata.c`
`SIGNED_METADATA_UR_MAX_CALLDATA 1472`.

**D-021** · 2026-10-04 · ACTIVE · the Universal Router decoder streams; the 1,472-byte buffer goes
Owner decision, from measured traffic. Amends D-019's "within the buffer".
1,000 recent calls to the Base router the Uniswap app uses (`0xd614…9c40`,
UR 2.1.2, all callers): 740 decodable today (V2/V3 subset), 256 contain
`V4_SWAP` (118 fit the 1,472 B buffer, 138 do not; V4 calldata median
1,658 B, p90 2,330 B, max 5,754 B), 4 other unsupported. V4 actions: 265 of
276 swap commands are `SWAP_EXACT_IN > SETTLE > TAKE` or
`SETTLE > SWAP_EXACT_IN > TAKE` (multi-hop exact-in even for one pool;
SETTLE/TAKE, not the _ALL variants); 9 exact-out, 2 with TAKE_PORTION.
50 of 256 touch a non-zero hooks address. Mixed V3+V4 routes are common.
- Rewrite `uniswap_ur.c` as a streaming decoder on the ERC-7730 interpreter's
  ABI stream primitives (`erc7730_abi_stream.c`): commands are parsed as the
  calldata chunks arrive; equivalence with today's decoder on every existing
  vector is required before anything new is added. Then remove the static
  `ur_calldata[1472]` buffer (this is also the RAM fix the handoff asked for).
- Then add V4: SWAP_EXACT_IN / SWAP_EXACT_OUT with SETTLE / TAKE /
  TAKE_PORTION, hooks shown, combined with the split-route and clean-up
  logic. Unknown actions still fail closed.
Target: ~99% of swaps on this router decodable (vs 74% today, 86% with a
buffer-bound V4 step). Evidence and reproduction: the classifier and sample
saved with the vector tooling (`scripts/uniswap/`).

**D-020** · 2026-10-04 · ACTIVE · 7.17 direction: extend the ERC-7730 interpreter, not a new decoder
Owner-agreed direction. The generic engine is the on-device ERC-7730
interpreter (`erc7730_*.c`); 7.16 ships it as is (catalog, AdvancedMode fix
per D-007, Across `depositV3` descriptor). For 7.17, extend it with:
embedded calldata (ERC-7730 `calldata` format: multicall, Safe, aggregators),
a command-stream type (opcode bytes + `bytes[]` inputs, each opcode decoded by
its own sub-descriptor), and descriptor-level constraints and summaries
(`value == arg`, sums, recipient-not-signer flags). Then decide from coverage
numbers whether the Universal Router can move from `0x07` C to descriptors.
Why: ERC-7730 cannot express command streams, and Uniswap's safety comes from
cross-step reasoning (net limits across wrap/swap/unwrap/sweep, router-held
balances, split routes), which a field-by-field descriptor cannot show today.
Do not re-propose: a separate new generic decoder.

## Signing policy

**D-010** · 2026-10-03 · ACTIVE
Unlimited ERC-20 `approve` is reviewed ("an UNLIMITED amount"), not
refused. Dapps such as Uniswap's Permit2 approve offer no cap.
Open inconsistency: unlimited EIP-2612/DAI permits are still refused in the
streamed EIP-712 path (7.16 exempts canonical Permit2 only). Trezor and
Ledger show "Unlimited" and allow it.

**D-011** · 2026-10-03 · ACTIVE
An accepted PIN renews the idle deadline (firmware `note_pin_accepted`).
Host traffic alone never renews it. Issue #946.

## Firmware size

**D-012** · 2026-08-04 · ACTIVE (dropped by the develop re-author, restored
2026-10-04)
Device builds route `snprintf` to newlib's integer-only engine
(`-Dsnprintf=sniprintf -Dvsnprintf=vsniprintf`, about −22 KB). `%llu` works.
Distinct from `nano.specs`, which lacks `%lld` and stays rejected.
Firmware `f166150c0`, restored on the 7.16 line as `bfa30f97b`.

**D-013** · 2026-10-03 · ACTIVE
Link firmware against the size bootloader 2.1.4 actually installs:
655,321 bytes (upload frame = 38-byte prefix + image, must be < 0xA0000).
Firmware `2ebc75cc6`.

**D-014** · 2026-10-04 · ACTIVE
ERC-20 token table: stablecoins, plus the tokens the coins table and test
fixtures still require (owner: "leave whatever tokens needed"). The majors
list and the address-order filler go; everything else is described by
signed ClearSign metadata (the direction of
`docs/security/token-table-retirement.md`, firmware, 2026-08-14).
Supersedes the 500-row budget of `token_policy.py`.

**D-015** · 2026-10-04 · ACTIVE
Zcash Orchard stays in the default firmware image (`KK_ZCASH_PRIVACY` on).

## Process

**D-022** · 2026-10-05 · ACTIVE · release train: finish 7.16 on the fork, upstream 7.15 in reviewed blocks
Owner decision.
1. Finish ALL 7.16 work on the fork first (SOP order: singular PRs into fork
   `develop`, CI green, `release/7.16.0-rcN` cut after each merge), so the
   whole stack is proven before anything goes upstream.
2. Then upstream only 7.15 (the next audit and signing flow), not 7.16.
3. Upstream PRs are blocks of at most 20,000 changed lines, and each must
   get a Copilot review with no changes requested before it is offered for
   human review.
Why: users are on 7.14.1 (2026-06-05); 7.14.x patches, 7.15 (rc29,
2026-08-13) and 7.16 were all stacked on the same upstream review gate
(python-keepkey #197, device-protocol #112). Proving 7.16 end to end on the
fork first gives confidence in the full stack; small, pre-reviewed blocks
keep upstream review in days, not weeks.

**D-016** · 2026-10-04 · ACTIVE
`docs/STATE.md` and this file are the single source of truth. Every session
reads them before designing and updates them when a decision changes. A
re-author or backport lists the fixes it must carry and checks each one
landed (D-012 was lost this way).

**D-017** · standing · ACTIVE
Never delete branches after merging; PRs stay open as history; every PR pins
the HEAD of the single canonical upstream PR (python-keepkey #197,
device-protocol #112); upstream merges and pushes to canonical branches need
the owner's explicit OK.
