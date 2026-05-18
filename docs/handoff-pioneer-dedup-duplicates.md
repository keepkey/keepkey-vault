# Handoff: Pioneer `GetPortfolioBalances` Duplicate Token Entries

**Date**: 2026-05-15  
**Severity**: P1 — wastes bandwidth, slows every portfolio load, forces vault to do client-side dedup  
**Vault workaround**: `projects/keepkey-vault/src/bun/index.ts` dedupes both `tokensByChainId` and `evmTokensByOwner` after every Pioneer response — see commits on `develop` branch.

---

## What the bug looks like

Pioneer returns the same `(caip, pubkey)` pair multiple times in a single `GetPortfolioBalances` response:

```
DOG  0xafb89a09d82fbde58f18ac6437b3fc81724e4df6  48.3084  $0.02  ← dup 1
DOG  0xafb89a09d82fbde58f18ac6437b3fc81724e4df6  48.3084  $0.02  ← dup 2
PRO  0xef743df8eda497bcf1977393c401a636518dd630  100.380  $0.01  ← appears 6×
WETH 0x4200000000000000000000000000000000000006  0.000003 $0.01  ← dup 1
WETH 0x4200000000000000000000000000000000000006  0.000003 $0.01  ← dup 2
```

Identical amounts confirm these are not multiple addresses with the same balance — they are the **same entry emitted multiple times** by the same upstream source.

---

## Where the bug lives

**File**: `services/pioneer-server/src/controllers/balance.controller.ts`  
**Method**: `GetPortfolioBalances` (lines 267–1289)

The method calls **five upstream sources in sequence**, each with its own dedup guard:

| Source | Dedup key | Problem |
|--------|-----------|---------|
| Balance cache | `caip::pubkey` | Built once at line ~395; later additions are invisible to it |
| Zapper | `caip::pubkey` | Built from `responses` snapshot before Zapper entries are added |
| Unchained | `caip` **only** | Drops legitimate holdings for address B if address A already has the same CAIP |
| SPL tokens | `caip` only | Same over-broad dedup |
| TRC-20 | `caip` only | Same |
| Extra contracts | `caip::pubkey` | Correct key, but again a snapshot |

**Root cause**: Each source builds its exclusion set from a **snapshot** of `responses` at that moment. Entries added by the *same* source after the snapshot are not visible to the check. When Zapper (or any source) iterates over multiple addresses and emits the same token for the same address twice, the second emission is not caught.

There is **no final dedup pass** before the response is returned.

---

## The fix — one pass at the end

Add a single dedup pass at the very end of `GetPortfolioBalances`, just before the return statement. This catches everything regardless of which upstream source caused the duplicate:

```typescript
// ── Final dedup: normalize caip+pubkey keys and keep the first (best-data) entry ──
// Each upstream source has its own in-flight dedup, but snapshot timing means
// the same (caip, pubkey) pair can appear multiple times in `responses`.
const finalSeen = new Map<string, typeof responses[0]>()
for (const entry of responses) {
  const key = `${(entry.caip || '').toLowerCase()}::${(entry.pubkey || '').toLowerCase()}`
  if (!finalSeen.has(key)) {
    finalSeen.set(key, entry)
  } else {
    // Keep the entry with the more recent fetchedAt (freshest data wins)
    const existing = finalSeen.get(key)!
    if ((entry.fetchedAt ?? 0) > (existing.fetchedAt ?? 0)) {
      finalSeen.set(key, entry)
    }
  }
}
const deduped = [...finalSeen.values()]
if (deduped.length !== responses.length) {
  console.warn(`[GetPortfolioBalances] dedup removed ${responses.length - deduped.length} duplicate entries`)
}
// Replace responses with deduped array before building final return value
responses = deduped  // or however responses feeds the return shape
```

Adjust the variable name to match what `responses` is called locally at the end of the function (it may be `allBalances` or similar — check around line 1250).

---

## Secondary fix — normalize Unchained dedup key

The Unchained dedup (lines ~877, 931) uses `caip` only:

```typescript
const existingCaips = new Set(responses.map((r: any) => r.caip));
if (existingCaips.has(assetCaip)) continue;  // BUG: drops address B if address A has same token
```

This causes false drops: if address A's USDT was already added from Zapper, address B's USDT (different pubkey, different balance) gets silently discarded. Change to `caip::pubkey`:

```typescript
const existingKeys = new Set(responses.map((r: any) => `${(r.caip||'').toLowerCase()}::${(r.pubkey||'').toLowerCase()}`))
const entryKey = `${assetCaip.toLowerCase()}::${pubkey.toLowerCase()}`
if (existingKeys.has(entryKey)) continue;
```

Apply the same change to SPL (line ~1032) and TRC-20 (line ~1128) dedup guards.

---

## Acceptance criteria

1. A single `GetPortfolioBalances` call with 5 EVM pubkeys returns **zero duplicate `(caip, pubkey)` pairs**
2. Two different pubkeys that legitimately both hold USDT each appear **once** with their own balance
3. Response payload is measurably smaller (each PRO duplicate above is an extra ~300 bytes × N addresses × polling frequency)

---

## Related vault-side workaround (remove after Pioneer fix)

Once Pioneer is clean, remove the dedup passes in the vault:

- `getBalances` path: `tokensByChainId` dedup (~line 1922) and `evmTokensByOwner` dedup (~line 1945)
- `getBalance` path: `evmTokensByOwner` dedup (~line 2438)

All in `projects/keepkey-vault/src/bun/index.ts` on the `develop` branch.
