# Handoff: Pioneer DeFi position `type` so the vault can dedupe app-tokens

**Repo:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`
**Consumer PR:** keepkey-vault #260 (`feat/tx-custom-fees`) — DeFi positions folded into `ChainBalance`
**Related (closed):** keepkey-vault #253 (superseded by #260)
**Server PR that shipped `includeDefi`:** `coinmastersguild/pioneer#121`
**Date:** 2026-06-19

---

## ✅ STATUS: Pioneer side DELIVERED on `develop` (2026-06-19) — now a vault TODO

The Pioneer changes below are implemented and live-verified; they ship in the next
release. Two commits on `develop` (not yet released):

- `e5abf59c0` feat(portfolio): per-position DeFi entries with `type` + `appTokenAddress`
- `8d1d160e5` fix(zapper): select `AppTokenPositionBalance` underlying in contract positions
  (so contract-position underlyings — e.g. Morpheus SUPPLIED stETH — actually appear in `tokens[]`)

**Two contract changes from the original ask — read before wiring the vault:**

1. **Entries are now PER-POSITION, not per-app.** A single app can hold both an
   app-token and a contract-position (Aave aToken supply + variable debt), so each
   position is its own entry and the app (`protocol`/`displayName`/`icon`) rides
   along as a grouping label. **Consequence for the vault: there can be MULTIPLE
   `defiPositions[]` entries with the same `(pubkey, protocol, networkId)`.** The
   current client dedup keyed on that tuple would collapse them — key on the
   position instead (e.g. `(pubkey, protocol, networkId, type, appTokenAddress)` or
   just treat each entry independently). `balanceUsd` is now per-position; summing a
   `(pubkey, protocol, networkId)` group recovers the old app total.
2. **`type` + `appTokenAddress` are top-level fields on each entry** (not nested).
   `appTokenAddress` is present only for `type: "app-token"`.

Verified live (flipcrooked.eth `0x5746396d…`): `lido` → app-token, suppress stETH;
`gnosis` → app-token, suppress WXDAI; `morpheus` → contract-position, suppress nothing
(its supplied stETH appears in `tokens[]` for display but is NOT double-counted).

---

## TL;DR

`POST /api/v1/portfolio` with `includeDefi: true` returns `defiPositions[]`, and the vault
now folds those into the dashboard. But each position's `tokens[]` are the protocol's
**underlyings** (LP legs, the native-ETH zero address), **not** the wallet-held token. With
only that, the vault cannot tell an **app-token** position (the wallet literally holds the
protocol token, e.g. stETH = the Lido position) from a **contract/LP** position (underlyings
locked in a contract, not in the wallet).

Because it can't tell them apart, the vault stopped suppressing wallet tokens entirely
(address-only suppression was hiding real, sendable balances — e.g. liquid WETH that is also
an LP underlying). The cost: **app-token positions double-count** — stETH shows once as a
wallet ERC-20 and again inside the Lido position's USD, inflating the chain total.

**Ask:** have the server tag each position with its Zapper `type` and, for app-tokens, the
**app-token contract address itself** (the thing held in the wallet). Then the vault can
suppress exactly the wallet token that is the position — and nothing else.

---

## Delivered response shape (on `develop`; deploys next release)

```jsonc
// POST /api/v1/portfolio  { pubkeys:[{caip,pubkey}], includeDefi:true }
// → defiPositions[]: ONE ENTRY PER POSITION
{
  "pubkey": "0x5746396d...d238",
  "type": "app-token",                          // ← NEW: drives dedup
  "appTokenAddress": "0xae7ab965...d7fe84",      // ← NEW: present only for app-token; the wallet-held token to suppress
  "protocol": "lido",                            // grouping LABEL (may repeat across entries)
  "displayName": "Lido",
  "label": "stETH",                              // ← NEW: per-position displayProps label (optional)
  "network": "Ethereum",
  "networkId": "eip155:1",
  "balanceUsd": 999.31,                          // ← now PER-POSITION
  "icon": "https://.../lido.png",
  "tokens": [                                    // display metadata; underlyings for contract-positions
    { "networkId": "eip155:1", "address": "0xae7ab965...d7fe84", "symbol": "stETH" }
  ]
}
// A contract-position entry (Morpheus) has NO appTokenAddress; its tokens[] are
// supplied/locked underlyings (NOT wallet-held) — suppress nothing for it.
```

The vault maps this in `projects/keepkey-vault/src/bun/index.ts` (`ServerDefiPosition`
interface + the `getBalances`/`getBalance` merge).

## What the vault does with it

Top-level fields on each entry:

| Field | Type | Purpose |
|---|---|---|
| `type` | `"app-token" \| "contract-position"` | App-token ⇒ the wallet holds the protocol token; contract-position ⇒ underlyings are locked away. (Unknown Zapper types are normalized to `contract-position`.) |
| `appTokenAddress` | `string` (present only for app-tokens) | The contract of the token the wallet actually holds (e.g. stETH `0xae7a…84`). Match against `TokenBalance.caip` and suppress **only** that token. |

The *correct* dedup:

- `type === "app-token"` → suppress the wallet `TokenBalance` whose contract === `appTokenAddress`
  (one token, exact match). Fold the position USD in → no double-count.
- `type === "contract-position"` → suppress nothing (underlyings aren't in the wallet). Fold
  the position USD in → it's net-new value, correct.

Do **not** reuse `tokens[]` (underlyings) for suppression — that's what caused the hidden-funds
bug the vault reverted.

⚠️ **Re-key the client dedup.** With per-position entries, `(pubkey, protocol, networkId)` is no
longer unique (Aave supply + debt, multi-pool LPs). Treat each entry independently or key on
`(pubkey, protocol, networkId, type, appTokenAddress)` so positions aren't collapsed.

## Where it changed (Pioneer — DONE)

- `services/pioneer-server/src/controllers/balance.controller.ts` — the `includeDefi`
  aggregation now emits per-position entries with `type`/`appTokenAddress`/`label`
  (`DefiPositionEntry` interface updated alongside).
- `modules/intergrations/zapper/src/index.ts` — added the `AppTokenPositionBalance` inner
  fragment so contract-position underlyings carry an address (previously dropped, which is
  why Morpheus's stETH was missing from `tokens[]`).

## Secondary (optional, not blocking)

The server returns the **full** multi-network DeFi list for an address on every chunked
`/portfolio` request, so a reused EVM address (Account #0 on ETH/OP/Base/Arb/…) yields the
same positions once per chunk. The vault dedupes client-side by `(pubkey, protocol, networkId)`,
so this is handled — but scoping each chunk's `defiPositions` to the requested networks would
shrink the payload and remove the redundancy at the source.

## Verify (live)

```bash
KEY="vault:<any-uuid>"   # vault self-registers vault:<uuid> keys
ADDR=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045   # vitalik — 62 positions

# raw upstream (source of truth)
curl -s "https://api.keepkey.info/api/v1/zapper/apps/$ADDR" | jq '.[0].node'

# merged endpoint the vault consumes — check for new type/appTokenAddress fields
curl -s -X POST "https://api.keepkey.info/api/v1/portfolio" \
  -H "Content-Type: application/json" -H "Authorization: $KEY" \
  -d "{\"pubkeys\":[{\"caip\":\"eip155:1/slip44:60\",\"pubkey\":\"$ADDR\"}],\"includeDefi\":true}" \
  | jq '.defiPositions[0]'
```

A good app-token test wallet: any address holding **stETH** (Lido). It surfaces a
`type:"app-token"` Lido position whose `appTokenAddress` is the stETH contract — the vault
suppresses the wallet's stETH row instead of double-counting it. `flipcrooked.eth`
(`0x5746396dfE7025190a7775df94b6E89310DDd238`) is the canonical fixture: Lido (app-token) +
Gnosis (app-token) + Morpheus (contract-position).

⚠️ **Cache caveat when verifying after deploy:** `ZapperCache` has `enableTTL:false` and
`forceRefresh` does NOT bust it (the base cache reads the stored value first). Addresses cached
before the release keep the OLD shape until the 24h stale refresh — clear first to verify
fresh: `GET /api/v1/zapper/clear/{addr}?dataType=apps_v2` (and `…?dataType=apps` for the
`/zapper/apps` view).

## Done-when

- [x] **Pioneer:** `defiPositions[]` entries are per-position and carry `type` (+ `appTokenAddress`
  for app-tokens). On `develop` (`e5abf59c0`, `8d1d160e5`); typecheck clean; live-verified.
- [ ] **Release:** merged to `develop` → blue → green; verify via the curl above on a stETH
  wallet (clear the apps_v2 cache key first, see caveat).
- [ ] **Vault:** re-enable targeted suppression in `index.ts` (`getBalances` + `getBalance`) —
  suppress the single wallet token matching `appTokenAddress` for app-token positions only;
  suppress nothing for contract-positions. Re-key the client dedup off the per-position entries
  (see ⚠️ above). Removal commit to reverse-engineer the hook points: keepkey-vault `6237981b`.
