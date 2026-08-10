# Handoff: "Build TX now" — spend directly from an uncommon-path audit find

**Date:** 2026-07-02
**State:** audit discovery of uncommon paths WORKS end-to-end (device-verified
tonight on a real LTC case). What's missing is the last mile: a funded
uncommon-path row should offer a **spend/sweep button right there**, not just
"send to support".

## What already works (don't rebuild)

All landed on the working tree 2026-07-02 (rides in v1.4.10):

- `utxoAccountScriptPaths` (`src/bun/chain-scan.ts`) — per-account xpub set now
  includes the chain's own receive convention AND (for LTC) the legacy
  **p2wpkh-on-BIP44** branch. Shared by getBalances (bulk), getBalance
  (single-chain), buildTx, auditScanUtxoAccounts, addUtxoAccount. Unit tests in
  `__tests__/chain-scan.test.ts`.
- **Account-level finds are already spendable**: audit "track" →
  `addUtxoAccount` persists all 4 xpubs to `cached_pubkeys` (PK device/chain/
  path; the p2wpkh-on-44 entry is appended LAST so it wins the upsert on the
  shared 44' path) → `buildTx` merges cached xpubs into `allXpubs`, and
  `txbuilder/utxo.ts` rewrites per-input `addressNList` from the UTXO's source
  xpub tag (`_sourceAccountPath`, line ~552). **Device-verified tonight**:
  account-1 LTC tracked and merged into the portfolio.
- `AuditKnownPaths.tsx` — "Scan uncommon paths" grid for LTC (scheme list
  `LTC_KNOWN_SCHEMES`: uncommon p2wpkh-on-44, standard 44-p2pkh, standard
  84-p2wpkh). Address-level, via `auditScanPaths` (accepts `scriptType`).
  Funded rows flow into the support handoff + the `?audit=` GET param
  (`docs/handoff-support-audit-get-param.md`).

## The feature

On every FUNDED row in `AuditKnownPaths` (and `AuditCustomPath` results), add a
**"Build TX now"** button that sweeps that specific address's UTXOs to the
user's standard receive address (chain default path, account 0). Flow:

1. Row context: `path: number[]`, `scriptType`, `address`, balance.
2. Fetch UTXOs address-level: `pioneer.ListUnspent({ network, xpub: address })`
   — Pioneer's ListUnspent accepts plain addresses too (the sweep-engine
   already relies on this; see `src/bun/sweep-engine.ts` line ~207).
3. Build inputs with EXPLICIT `addressNList = [...path]` (full 5-element path
   of the found address) and the row's `scriptType`. This bypasses the
   xpub/account machinery entirely — no tracking or cache rows needed.
4. One output: the chain's standard receive address (derive fresh at
   `chain.defaultPath`), minus fee. It's a sweep: no change output.
5. Fee: reuse `estimateUtxoFee` rates (`txbuilder/utxo.ts`); Zcash ZIP-317
   floor logic if this ever generalizes past LTC.
6. Sign via existing `btcSignTx` path, broadcast via existing broadcast RPC,
   then trigger the single-chain refresh (`getBalance`) so the balance lands.

### Reuse candidates, in order of laziness

1. **`sweep-engine.ts`** — the audit-adjacent sweep subsystem already builds
   single-address sweeps for the seed-recovery flow. Check whether
   `buildSweepTx` (or equivalent) takes (address, path, scriptType, dest) —
   if yes, this feature is mostly UI + one RPC.
   ⚠️ Memory notes say part of the OLD audit sweep (`auditScanBtc`/`auditSweep`)
   is dead code scheduled for deletion — verify which half is alive (the
   SweepDialog path is the live one).
2. `buildUtxoTx` with `allXpubs: [{ xpub: <address>, scriptType, accountPath:
   path.slice(0,3) }]` — works today IF Pioneer ListUnspent returns per-UTXO
   `path`s for a plain address query (it returns the address's own UTXOs; the
   input rewrite then rebuilds `addressNList` from `_sourceAccountPath` + the
   blockbook path tail). Confirm the tail (change/index) is right for
   address-level queries — if blockbook omits `path` for plain addresses, the
   `!input.path` fallback in `utxo.ts` (~line 566) uses `[...accountPath, 0, 0]`
   which is CORRECT only for 0/0 finds — pass the full found path instead.

### UI

- `AuditKnownPaths` row: next to "explorer ↗" on funded rows, add
  `Build TX now` (gold). Confirm dialog: from-address, amount (minus est. fee),
  destination (default = standard receive, editable), then device confirm.
- Same button on funded `AuditCustomPath` results (`pushCustom` rows).
- Hidden wallets: allowed (it's a spend, not a persistence) — but never write
  anything to `cached_pubkeys`.
- After broadcast: show txid + explorer link; push `balance-updated`.

### Gotchas from tonight's diagnostic session (read before coding)

- **Device swap mid-session poisons assumptions.** The operator swaps physical
  KeepKeys constantly (Testerb2 / Deivce715r2 / main / Zcash2…). Capture
  `engine.wallet` at scan time and bail if it changes before sign
  (`auditScanUtxoAccounts` has the pattern: `captured !== engine.wallet`).
  A "Build TX now" button MUST re-verify the found address derives from the
  CURRENTLY connected device before building (derive path → compare address;
  it's one device call and prevents signing with the wrong wallet).
- **SLIP-132 version bytes ARE the script type** for blockbook/Pioneer. An
  account key queried as `Ltub/xpub` yields p2pkh addresses; as `zpub`,
  p2wpkh. That mismatch was tonight's root bug — don't reintroduce it.
- **Honesty rules**: a thrown balance/UTXO lookup is "couldn't verify", never
  0. Broadcast failures must surface verbatim.
- The audit report `?audit=` GET param + robust clipboard copy are in
  `AuditDialog.tsx` (`buildHandoff`/`copyHandoff`); a "Build TX now" result
  (txid) would be a good addition to that payload (v2 field).

## Verification (device)

Live test fixture already on-chain (Testerb2 device, standard wallet):
- `m/44'/2'/0'/0/0` p2wpkh `ltc1q5f772…` ≈ 0.0064 LTC (uncommon branch)
- `m/84'/2'/0'/0/0` p2wpkh `ltc1qqt9x…` ≈ 0.0032 LTC (standard BIP84)
- `m/44'/2'/1'/0/0` p2wpkh `ltc1q8sn04…` ≈ 0.0127 LTC (tracked account 1)

Acceptance: "Scan uncommon paths" → funded row → Build TX now → device shows
the sweep → broadcast succeeds → funds land on the BIP84 receive address →
LTC balance reflects it after refresh.
