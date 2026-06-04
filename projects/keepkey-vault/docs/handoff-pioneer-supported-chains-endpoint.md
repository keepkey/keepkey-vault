# Handoff: Pioneer `/swappers/supported-chains` endpoint

## Problem

The vault's `swap-support-matrix.ts` contains a hardcoded static set of chains per swap provider (THORChain, Mayachain, Relay, 0x, ChainFlip, ShapeShift). Every time a provider adds chain coverage, a vault release is required to pick it up.

Immediate symptom: Solana USDT/SPL tokens were not selectable as destinations because the static matrix did not include Solana under ShapeShift — even though LiFi (ShapeShift's underlying solver) supports thousands of SPL tokens. Fixed in vault by adding Solana to `SHAPESHIFT_CHAINS`, but this is the wrong long-term home for that knowledge.

## What Pioneer needs to build

### Endpoint

```
GET /api/v1/swappers/supported-chains
```

### Response shape

```json
{
  "thorchain":  ["bip122:000000000019d6689c085ae165831e93", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", ...],
  "mayachain":  ["bip122:000000000019d6689c085ae165831e93", "eip155:1", ...],
  "relay":      ["eip155:1", "eip155:10", "eip155:56", ...],
  "zeroex":     ["eip155:1", "eip155:10", ...],
  "chainflip":  ["bip122:000000000019d6689c085ae165831e93", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", ...],
  "shapeshift": ["eip155:1", "eip155:10", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", ...]
}
```

Keys are the same provider identifiers the vault already uses (`SwapProvider` type in `src/shared/types.ts`). Values are CAIP-2 chain IDs.

Chains should be expressed in the canonical encoding the vault expects (see `CHAIN_CAIP2_ALIASES` in vault's `swap-support-matrix.ts` for the normalization table — TRON is `tron:0x2b6653dc`, not base58).

### Semantics

- A chain in the list = "native asset on this chain is routable by this provider"
- A chain in the list = "tokens on this chain should be attempted via quote" (the vault's `unknown` path)
- Absence = vault marks the asset `unsupported_chain` / `unsupported_token` and shows it grayed out

Pioneer does not need to enumerate individual tokens — the vault already handles the `unknown` → live-quote flow. This is chain-level coverage only.

### Caching

The vault will fetch this on startup (or on first picker open) and cache in memory for the session. A stale-while-revalidate strategy is fine; the data changes rarely. 5-minute TTL is sufficient.

## What the vault will do with it

Once the endpoint exists, vault's `assessAvailability` in `swap-support-matrix.ts` replaces its hardcoded `Set<string>` constants with the fetched data. The static sets become a compile-time fallback only (used if Pioneer is unreachable at startup).

```typescript
// swap-support-matrix.ts — after migration
let dynamicChains: Record<SwapProvider, Set<string>> | null = null

export async function loadSupportedChains() {
  const res = await fetch(`${PIONEER_URL}/api/v1/swappers/supported-chains`)
  const data = await res.json()
  dynamicChains = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, new Set(v as string[])])
  ) as Record<SwapProvider, Set<string>>
}
```

## Why this matters

- ShapeShift/LiFi expands Solana, Sui, Aptos coverage → vault picks it up on next pioneer-server deploy, zero vault release required
- ChainFlip adds a new chain → same
- THORChain deprecates a pool → pioneer removes it from the response → vault stops offering it

## Current workaround (vault `swap-support-matrix.ts`)

Solana added to `SHAPESHIFT_CHAINS` manually (2026-05-27). This is the stop-gap until the endpoint exists.

## Files to reference

- Vault static matrix: `projects/keepkey-vault/src/shared/swap-support-matrix.ts`
- Vault types: `projects/keepkey-vault/src/shared/types.ts` (`SwapProvider`)
- Vault discovery: `projects/keepkey-vault/src/shared/swap-discovery.ts` (`assessAvailability` call site)
