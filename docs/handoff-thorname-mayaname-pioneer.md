# Handoff: Pioneer support for THORName / MAYAName registration

**For:** a Pioneer agent (`/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`)
**Consumer:** keepkey-vault-v11 "Register Name" feature on the THORChain/Maya asset page.
**Date:** 2026-06-05

## Context

Vault is adding a feature (peer to cosmos staking) to register a THORName (THORChain)
and MAYAName (Maya). Registration itself is just a `MsgDeposit` with a structured memo,
signed on-device and broadcast — Vault already does both of those through Pioneer
(`GetAccountInfo`, `broadcastTx`) for swaps, so **registration needs nothing new from
Pioneer**.

What Pioneer *should* own is the two **read** concerns, so Vault never talks to
`thornode`/`mayanode` REST directly (those endpoints are fragile — see the ninerealms
migration that broke 25+ Pioneer files; we don't want that fragility re-introduced in
the Vault Bun process):

1. **Name resolution / availability** — is `<name>` taken? who owns it? when does it expire? what aliases does it hold?
2. **Registration cost quote** — live `register_fee`, `fee_per_block`, `blocks_per_year`, and current block height so Vault can compute "X RUNE for N years" and an absolute expiry block.

If you'd rather Vault hit the nodes directly for v1, say so and we'll inline it — but the
preference is to keep all external node I/O in Pioneer.

## Requested endpoints

Mirror the existing Pioneer method style (the ones Vault already calls:
`GetAccountInfo`, `GetStakingPositions`, `GetPortfolioBalances`, `broadcastTx`).

### 1. `GetName({ network, name })`

- `network`: `'thorchain' | 'mayachain'`
- `name`: the requested label (regex `^[a-zA-Z0-9+_-]+$`, ≤30 chars)
- Backed by:
  - THOR: `GET {thornode}/thorchain/thorname/{name}`
  - Maya: `GET {mayanode}/mayachain/mayaname/{name}`
- Response (normalize both chains to one shape):
  ```ts
  {
    found: boolean,            // false ⇒ name is free (node returned 404/not-found)
    name: string,
    owner?: string,            // THOR/MAYA bech32 owner address
    expireBlockHeight?: number,
    aliases?: { chain: string; address: string }[],
    preferredAsset?: string,   // e.g. "BTC.BTC" or "" 
  }
  ```
- **404 from the node must map to `{ found: false }`, not an error** — that's the
  "available" signal the UI keys on.

### 2. `GetNameRegistrationQuote({ network })`

Returns live constants + current height so Vault can price the deposit and compute expiry.

- Backed by:
  - THOR: `{thornode}/thorchain/network` (`tns_register_fee_rune`, `tns_fee_per_block_rune`), `{thornode}/thorchain/constants` (`BlocksPerYear`), `{thornode}/thorchain/lastblock` (current height).
  - Maya: `{mayanode}/mayachain/constants` (`TNSRegisterFee`, `TNSFeePerBlock`, `BlocksPerYear`), `{mayanode}/mayachain/lastblock`.
- Response (amounts in **base units** — RUNE 1e8, CACAO 1e10 — let Vault scale with `chain.decimals`):
  ```ts
  {
    registerFeeBase: string,    // one-time, non-refundable
    feePerBlockBase: string,    // rent per block
    blocksPerYear: number,      // 5256000
    currentBlockHeight: number, // for absolute-expiry math
  }
  ```

### (Optional, nice-to-have) `GetNamesForAddress({ network, address })`

List names already owned by the connected address, so the UI can show "Your names"
without the user typing one in. THORNode/MAYANode don't index this directly, so this may
require Midgard or an indexer — **skip for v1** if it's expensive; the lookup-by-name
flow is enough to ship.

## Memo format Vault will build (for your reference — you don't build this)

THORChain: `~:name:chain:address:owner:preferredAsset:expiry` (fields after `address` optional; empty fields kept as `::`).
Maya adds `:affiliateBps:subaffiliate:subaffiliateBps`.
v1 Vault sends a minimal `~:NAME:THOR:<thoraddr>` / `~:NAME:MAYA:<mayaaddr>`, owner defaults to signer.

## Acceptance

- `GetName` returns `{ found:false }` for an unregistered label and full owner/expiry/aliases for a registered one, on both chains.
- `GetNameRegistrationQuote` returns non-zero `registerFeeBase`/`feePerBlockBase` matching the live node constants (THOR ≈ 10 RUNE register; Maya ≈ 10 CACAO register).
- Both work against the same node config Pioneer already uses for swaps (no new secrets).
- Report the exact Pioneer method names + param/response shapes back so Vault can wire `rpc-schema.ts`.

---

## ✅ IMPLEMENTED (Pioneer side) — 2026-06-05

PR: `coinmastersguild/pioneer#95` (`feat/thorname-mayaname-reads` → `develop`).
Optional `GetNamesForAddress` was **skipped** for v1 as suggested. No new secrets, no package publish.

### Wire `rpc-schema.ts` to these

| OperationId | HTTP | Body | Response |
|---|---|---|---|
| `GetName` | `POST /api/v1/names/lookup` | `{ network, name }` | `{ data: NameInfo }` |
| `GetNameRegistrationQuote` | `POST /api/v1/names/registration-quote` | `{ network }` | `{ data: NameRegistrationQuote }` |

- `network`: `'thorchain' | 'mayachain'` (aliases `'thor'`/`'maya'` also accepted).
- `name`: `^[a-zA-Z0-9+_-]+$`, ≤30 chars (validated server-side).
- **Note the `{ data: ... }` envelope** — both responses are wrapped in `data` (matches `GetStakingPositions`).

```ts
interface NameInfo {
  found: boolean;            // false ⇒ available
  name: string;
  owner?: string;            // bech32 (thor1…/maya1…)
  expireBlockHeight?: number;
  aliases?: { chain: string; address: string }[];
  preferredAsset?: string;   // "" when unset
}
interface NameRegistrationQuote {
  registerFeeBase: string;   // base units — RUNE 1e8 / CACAO 1e10 (scale with chain.decimals)
  feePerBlockBase: string;
  blocksPerYear: number;     // 5256000
  currentBlockHeight: number;
}
```

### Verified live (acceptance met)
- THOR `ss` / Maya `ssmaya` → `found:true` with owner + `expireBlockHeight` + aliases (THOR `ss` also has `preferredAsset: "ETH.USDC-0X…"`).
- Unregistered label → `{ found:false }` on **both** chains. ⚠️ Implementation note: **THORChain returns HTTP 500** (`"…doesn't exist…"`) for unregistered, **Maya returns HTTP 404** — Pioneer normalizes both to `found:false`, so Vault just reads `found`.
- Quote: THOR `registerFeeBase:"1000000000"` (10 RUNE) / `feePerBlockBase:"20"`; Maya `registerFeeBase:"100000000000"` (10 CACAO) / `feePerBlockBase:"2000"`; `blocksPerYear:5256000`; live `currentBlockHeight`.

Expiry math for the UI: `expiryBlock = currentBlockHeight + (registerFeeBase consumed once) … years = (expireBlockHeight - currentBlockHeight) / blocksPerYear`. Cost for N years ≈ `registerFeeBase + feePerBlockBase * blocksPerYear * N` (base units).
