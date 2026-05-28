# Handoff: Pioneer CACAO Decimal Fix — Validate & Ship

## What changed and why

**Root cause:** MAYAChain's `/quote/swap` API uses each asset's native decimal precision.
External assets (ETH, BTC, etc.) are normalized to 8 decimal places (`1e8`), but CACAO — the
native MAYAChain asset — uses 10 decimal places (`1e10`).

A previous fix (2026-05-09) hardcoded `MAYA_BASE_UNIT = 1e8` for all assets after observing
that ETH was being sent in `1e18` units (catastrophic slippage). That fix was correct for ETH
but broke CACAO: the quote API received 1/100th the intended CACAO, MAYAChain computed a ~$0
output, and rejected with "Amount too small — outbound fees on the destination chain exceed
the swap output."

**Two-sided bug:**
- Sell side: `1e8` sent for CACAO → MAYAChain sees 2.77 CACAO instead of 277 CACAO
- Buy side: output `expected_amount_out` for CACAO returned in `1e10` units → divided by `1e8`
  → displayed as 100× too many CACAO

## Files changed

### Pioneer — `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer/modules/intergrations/mayachain/src/index.ts`

Lines ~222–243: replaced the hardcoded `MAYA_BASE_UNIT = 1e8` with asset-aware logic.

**Before:**
```typescript
const MAYA_BASE_UNIT = 1e8;
const sellAmountInBaseUnits = Math.floor(parseFloat(quote.sellAmount) * MAYA_BASE_UNIT);
// ...
let amountOutEstimated = (parseInt(quoteFromNode.expected_amount_out) / MAYA_BASE_UNIT).toFixed(BUY_DECIMALS);
let amountOutMin = quoteFromNode.amount_out_min ? (parseInt(quoteFromNode.amount_out_min) / MAYA_BASE_UNIT)...
```

**After:**
```typescript
// CACAO (native MAYAChain asset) uses 1e10; all external assets normalize to 1e8
const SELL_MAYA_UNITS = sellAsset === 'MAYA' ? SELL_BASE_UNIT : 1e8;
const sellAmountInBaseUnits = Math.floor(parseFloat(quote.sellAmount) * SELL_MAYA_UNITS);
// ...
const BUY_MAYA_UNITS = buyAsset === 'MAYA' ? BUY_BASE_UNIT : 1e8;
let amountOutEstimated = (parseInt(quoteFromNode.expected_amount_out) / BUY_MAYA_UNITS).toFixed(BUY_DECIMALS);
let amountOutMin = quoteFromNode.amount_out_min ? (parseInt(quoteFromNode.amount_out_min) / BUY_MAYA_UNITS)...
```

`SELL_BASE_UNIT` and `BUY_BASE_UNIT` are already computed from the existing `BaseDecimal` map
(`MAYA: 10`) at lines 212 and 220. No new constants needed.

`sellAsset` = `quote.sellAsset.split(".")[0]`, so `MAYA.CACAO` → `"MAYA"`.

### Vault — no CACAO workarounds remain
The vault previously had a `÷100` output correction for CACAO in `swap-parsing.ts` (toCaip guard).
That has been removed. The vault now passes amounts and parses outputs uniformly for all assets.

## How to validate

Start Pioneer locally:
```
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer
make start
```

Start vault against local Pioneer (if needed — vault may already point to local):
```
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault
make dev
```

### Test cases

**1. CACAO → ETH (the broken case)**
- Open Swap, pick CACAO as sell, ETH as buy
- Enter ~$40 USD worth of CACAO (~277 CACAO at current prices)
- Expected: quote shows ~$38–40 worth of ETH (after fees), no "Amount too small" error
- Before fix: "Amount too small — outbound fees on the destination chain exceed the swap output"

**2. CACAO → BTC**
- Same as above, different destination
- Expected: reasonable BTC quote proportional to CACAO value

**3. ETH → CACAO (buy-side fix)**
- Pick ETH as sell, CACAO as buy
- Enter 0.01 ETH
- Expected: quote shows ~X CACAO at fair market rate (not 100× inflated)
- Before fix: displayed 100× too many CACAO

**4. ETH → ETH (regression: non-CACAO should be unchanged)**
- Any ETH→BTC or BTC→ETH quote must return the same result as before this change

**5. Large CACAO swap (full balance)**
- User has 335.58 CACAO ($48.47) — try swapping the full balance to ETH
- Expected: ~$44–47 worth of ETH (small MAYAChain fee)
- Before fix: showed $0.44 (1/100th the value) with 99% fee warning

## Regression risk

Low. The only changed logic is in the `sellAmountInBaseUnits` calculation and output parsing
inside the MAYAChain integration. The guard `sellAsset === 'MAYA'` only activates for
`MAYA.CACAO` quotes; all other asset paths are unchanged (`1e8` as before).

The 2026-05-09 comment ("Maya internally normalizes everything to 1e8") was empirically
incorrect for CACAO. The evidence: 335 CACAO ($48) was quoting as $0.44 ETH output — a
100× undercount consistent with 1e8 vs 1e10.
