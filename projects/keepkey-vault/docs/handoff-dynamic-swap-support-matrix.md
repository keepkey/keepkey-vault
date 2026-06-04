# Handoff: Dynamic Swap Support Matrix (expand swap routes in UI)

## Problem

The vault's `src/shared/swap-support-matrix.ts` contains six hardcoded `Set<string>` constants (one per swap provider) that gate which assets appear as swappable in the asset picker. When a provider adds a new chain, the vault must ship a release to pick it up. This is the wrong long-term home for provider coverage data.

**Immediate symptom that surfaced this:** Solana USDT and other SPL tokens were not selectable as swap destinations because Solana was missing from `SHAPESHIFT_CHAINS` — even though ShapeShift/LiFi routes thousands of SPL tokens. Fixed by adding Solana to the static set (2026-05-27), but that is the workaround, not the fix.

## What Pioneer built (already shipped)

```
GET /api/v1/swappers/supported-chains
```

Response (live on `api-blue.keepkey.info` after PR #81 merges to develop, available on `localhost:9001` today):

```json
{
  "thorchain":  ["bip122:000000000019d6689c085ae165831e93", "eip155:1", "solana:...", ...],
  "mayachain":  ["bip122:...", "eip155:1", "bip122:00040fe8ec8471911baa1db1266ea15d", ...],
  "relay":      ["eip155:1", "eip155:10", "eip155:56", ...],
  "zeroex":     ["eip155:1", "eip155:10", ...],
  "chainflip":  ["bip122:...", "eip155:1", "solana:...", ...],
  "shapeshift": ["eip155:1", "eip155:10", "solana:...", ...]
}
```

Keys are identical to the `SwapProvider` type in `src/shared/types.ts`. Values are canonical CAIP-2 chain IDs (same encoding the vault already uses).

Verify locally:
```bash
curl http://localhost:9001/api/v1/swappers/supported-chains | jq .
```

## What the vault needs to do

### 1. Add `loadSupportedChains()` to `src/shared/swap-support-matrix.ts`

Add a module-level cache and an async loader. The static sets become fallbacks only:

```typescript
// At the top of swap-support-matrix.ts — add these:

type DynamicChains = Record<SwapProvider, Set<string>>
let dynamicChains: DynamicChains | null = null

/** Fetch provider chain coverage from Pioneer and cache for the session.
 *  Safe to call multiple times — only fetches once.
 *  Falls back silently to the static sets if Pioneer is unreachable. */
export async function loadSupportedChains(pioneerBase: string): Promise<void> {
  if (dynamicChains) return  // already loaded
  try {
    const res = await fetch(`${pioneerBase}/api/v1/swappers/supported-chains`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as Record<string, string[]>
    dynamicChains = {
      thorchain:  new Set(data.thorchain  || []),
      mayachain:  new Set(data.mayachain  || []),
      relay:      new Set(data.relay      || []),
      zeroex:     new Set(data.zeroex     || []),
      chainflip:  new Set(data.chainflip  || []),
      shapeshift: new Set(data.shapeshift || []),
    }
    console.log('[swap-matrix] Dynamic chain coverage loaded from Pioneer')
  } catch (e: any) {
    console.warn('[swap-matrix] Pioneer unreachable — using static fallback:', e.message)
  }
}

/** Exposed for tests only. */
export function _resetDynamicChains(): void { dynamicChains = null }
```

### 2. Update `assessAvailability` to use dynamic data when available

The only change inside `assessAvailability` is replacing the six static `Set` references with a helper that prefers the dynamic map:

```typescript
// Replace the six THORCHAIN_CHAINS.has(chainId) / RELAY_CHAINS.has(chainId) etc.
// with these helpers so the static sets stay as the compile-time fallback:

function has(provider: SwapProvider, chainId: string): boolean {
  if (dynamicChains) return dynamicChains[provider].has(chainId)
  switch (provider) {
    case 'thorchain':  return THORCHAIN_CHAINS.has(chainId)
    case 'mayachain':  return MAYACHAIN_CHAINS.has(chainId)
    case 'relay':      return RELAY_CHAINS.has(chainId)
    case 'zeroex':     return ZEROEX_CHAINS.has(chainId)
    case 'chainflip':  return CHAINFLIP_CHAINS.has(chainId)
    case 'shapeshift': return SHAPESHIFT_CHAINS.has(chainId)
  }
}
```

Then in `assessAvailability`, replace every `THORCHAIN_CHAINS.has(chainId)` with `has('thorchain', chainId)` etc. The token-path checks near the bottom (`RELAY_CHAINS.has(chainId) || ZEROEX_CHAINS.has(chainId) || SHAPESHIFT_CHAINS.has(chainId)`) get the same treatment.

**The `STABLECOIN_TOKENS` set and `THORCHAIN_TOKEN_PREFIXES` array stay static** — those are token-level, not chain-level, and are not served by the endpoint.

### 3. Call `loadSupportedChains()` at startup

In `src/bun/index.ts`, after Pioneer is reachable, call the loader once. It's fire-and-forget because the static fallback handles the cold-start window:

```typescript
import { getPioneerApiBase } from './pioneer'
import { loadSupportedChains } from '../shared/swap-support-matrix'

// Call this wherever the vault initialises swap state.
// Alongside getSwapAssets() in the existing swap init block is fine:
loadSupportedChains(getPioneerApiBase()).catch(() => { /* fallback already handles */ })
```

The simplest safe location is near line ~375 in `index.ts` where `initSwapTracker` is called — paste it just before the `initSwapTracker` block so the matrix is warm before the first picker open.

### 4. No changes needed to `swap-discovery.ts`

`buildAssetEntries` calls `assessAvailability` — once that function reads from dynamic data, the picker automatically surfaces chains Pioneer reports as covered. Zero changes to discovery or the picker components.

## Expected UI impact

Once dynamic chains load, any chain that Pioneer lists under a provider's coverage will show assets as:
- `swappable` — for native assets on covered chains
- `unknown` — for tokens on covered chains (triggers live-quote attempt rather than graying out)

Instead of `unsupported_chain`, which grays the row out with no quote attempt.

**Concrete win:** Solana SPL tokens (USDT, USDC, JUP, JTO, etc.) show as `unknown` under ShapeShift coverage → the picker lets the user select them → a quote attempt runs → ShapeShift/LiFi returns a live quote.

## Files to change

| File | Change |
|---|---|
| `src/shared/swap-support-matrix.ts` | Add `loadSupportedChains()`, `dynamicChains` cache, `has()` helper; update `assessAvailability` to call `has()` |
| `src/bun/index.ts` | Call `loadSupportedChains(getPioneerApiBase())` near swap init |

## Files that do NOT need to change

- `src/bun/swap.ts` — no change
- `src/shared/swap-discovery.ts` — no change
- `src/bun/pioneer.ts` — no change
- Any picker/dialog component — no change

## Pioneer endpoint status

- **PR**: coinmastersguild/pioneer#81 (branch `feat/swappers-supported-chains`, base `develop`)
- **Local test**: `curl http://localhost:9001/api/v1/swappers/supported-chains`
- **Blue (staging)**: `https://api-blue.keepkey.info/api/v1/swappers/supported-chains` (after PR merges)
- **Production**: `https://api.keepkey.info/api/v1/swappers/supported-chains` (after promote)

## Testing checklist

- [ ] `loadSupportedChains` called, logs `Dynamic chain coverage loaded from Pioneer`
- [ ] `assessAvailability('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd...')` returns `{ status: 'unknown' }` (was `unsupported_chain` before)
- [ ] Solana USDC/USDT appear in asset picker with `unknown` status (shows "try a quote" not grayed)
- [ ] Pioneer offline → static sets kick in → no crash, picker still works
- [ ] `_resetDynamicChains()` + `loadSupportedChains('http://localhost:9001')` in unit tests
