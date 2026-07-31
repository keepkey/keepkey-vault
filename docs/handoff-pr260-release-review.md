# Handoff: PR #260 release review — custom fees + DeFi + wallet selector

**Branch:** `feat/tx-custom-fees` → `develop` (PR #260)
**Repo:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault`
**Vault version:** `1.4.4` (NOT bumped — see Open Decisions)
**Date:** 2026-06-19
**Supersedes / folds in:** #253 (closed), #263 (closed)

---

## ⚠️ Release gate — read first

There is **one known DeFi-accuracy gap** that landed because the Pioneer server
changed its contract *after* this branch's DeFi merge was written. **Decide before
release:** fix now (recommended) or ship with the gap documented.

Pioneer now returns DeFi **per-position** (a single app can emit several entries —
Aave supply + debt — each its own row) and adds top-level `type` +
`appTokenAddress` (see `docs/handoff-pioneer-defi-position-type.md`, "DELIVERED"
section). The vault was written against the *old* per-app contract, so:

1. **Dedup key is now too coarse → undercount.** `getBalances` dedupes by
   `(pubkey, protocol, networkId)`. With per-position entries, two real positions
   in the same app collapse to one, dropping USD from the chain total.
   → Fix: key on the position (`+ type + appTokenAddress`) or drop client dedup if
   the server now scopes per chunk.
2. **Suppression is OFF → stETH-class double-count.** We removed address-only
   suppression (it hid liquid funds). Now that `appTokenAddress` exists, re-enable
   **targeted** suppression: for `type === "app-token"`, hide the one wallet token
   whose contract === `appTokenAddress`; for `contract-position`, hide nothing.
   → Removes the documented double-count without re-introducing the hidden-funds bug.

Both are localized to the DeFi merge in `src/bun/index.ts` (`getBalances` +
`getBalance`) plus the `ServerDefiPosition` interface. Est. small. Verify against
flipcrooked.eth (`0x5746396d…`): lido → app-token (suppress stETH), gnosis →
app-token (suppress WXDAI), morpheus → contract-position (suppress nothing).

---

## What's in PR #260

Three feature areas, one branch:

### 1. Custom + preset send fees
- Restores slow/normal/fast presets to **EVM + Cosmos** sends (were UTXO-only).
- Free-form custom fee: EVM gas price (gwei) + gas limit (legacy-only); UTXO sat/vByte.
- Custom EVM gas limit clamped up to intrinsic gas (`21000 + memo calldata`) so a
  deep-link memo can't build an under-gassed tx.
- Normal preset wired via UI button values (fixes unreachable-Normal); backend
  thresholds untouched ⇒ **swap fees unchanged**.

### 2. DeFi positions in ChainBalance (additive)
- `getBalances`/`getBalance` send `includeDefi:true`; positions folded into chain
  totals and rendered in a dedicated panel (AssetPage + Dashboard drill view).
- **No token suppression** (current state) — a position's `tokens[]` are protocol
  underlyings, not wallet duplicates. Additive only. (Re-enable per release gate.)
- Chunk dedup `(pubkey, protocol, networkId)` (needs the per-position fix above).
- Single-chain refresh filters positions to the refreshed chain's `networkId`.
- DB persists `defi_positions_json`; drilled donut + stacked-bar breakdowns include
  per-protocol DeFi slices so visual totals reconcile.

### 3. Wallet selector
- Navbar LogoTile dropdown to switch wallets.
- Watch-only hardening: wallet selector + asset-page + staking all block signing
  paths when watch-only (incl. cached watch-only wallets that have an address).

---

## Review findings already resolved (2 audit rounds)

| Sev | Finding | Status |
|---|---|---|
| High | Single-chain cross-network DeFi leak | Fixed — filter by `chain.id` |
| High | Token suppression hid liquid funds (LP WETH, native-ETH 0x0) | Fixed — suppression removed |
| High | Chunked DeFi positions 3× duplicated | Fixed — dedup (key needs per-position update) |
| High | Watch-only staking could sign | Fixed — `watchOnly || !address` |
| High | PR body/type comments claimed suppression while code double-counts | Fixed — docs aligned |
| Med | Custom EVM gas limit could under-gas a memo tx | Fixed — clamp to intrinsic |
| Med | Empty scoped DeFi fell back to legacy address-wide RPC | Fixed — pass `?? []` |
| Med | Drilled breakdowns excluded DeFi → totals didn't reconcile | Fixed — DeFi slices added |

## Outstanding (the release gate, above)
- [ ] Per-position dedup key + `ServerDefiPosition.{type,appTokenAddress}`
- [ ] Re-enable app-token-only suppression
- [ ] Live re-verify on flipcrooked.eth (app-token suppress; contract-position keep)

---

## Verification status
- Typecheck: **0 project errors** (`npx tsc --noEmit --skipLibCheck`; only the
  pre-existing ambient `minimatch` TS2688 the Makefile preflight filters).
- Live Pioneer `includeDefi` confirmed returning real data (vitalik.eth, 62 positions).
- **Device smoke: PENDING** — custom-fee sends (EVM/Cosmos/UTXO), swap-fee
  regression, wallet-switch, watch-only signing blocks.

## Open decisions
1. **Version bump?** Branch is `1.4.4`. #263's `1.4.5` bump was deliberately *not*
   cherry-picked (version bumps belong in a release PR, not a feature PR to develop).
2. **Fix the DeFi gap in this PR vs a fast-follow?** Recommended: in this PR — it's
   small and the gap is a user-visible $ inaccuracy.

## Branch commits (develop..HEAD)
```
56aba3af docs: update Pioneer DeFi position-type handoff to delivered contract
829d645f fix(watch-only,defi): staking guard, scoped-defi fallback, breakdown reconcile
c64cb2fa fix(build): mark pioneer-discovery external so CI bundling works
59f76965 fix(db): persist defi_positions_json in balances cache
7932a046 fix(asset-page): seal off every signing path when watchOnly
d00162ed fix(wallet-selector): block signing in watch-only mode; disambiguate labels
0c023821 fix(wallet-selector): correct icon import path
1f5abae9 feat(nav): wallet-selector dropdown on the navbar LogoTile
2c94f653 fix(dashboard): plumb defiPositions through getEffectiveBalance
59c6cf49 fix(portfolio): render DeFi panel on dashboard drill
67c5be49 fix(portfolio): dedupe chunked DeFi positions; align docs with no-suppression
6237981b fix(portfolio,evm): address DeFi + custom-fee review findings
fee802b8 feat(send): custom + preset fees for EVM and Cosmos sends
+ (DeFi base cherry-picked from #253: 5186040c, b26ab6ff)
```
