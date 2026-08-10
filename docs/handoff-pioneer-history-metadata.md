# Handoff → Pioneer: complete transaction metadata in `GetTransactionHistory`

**For:** Pioneer server / API team
**From:** keepkey-vault-v11 (activity history)
**Date:** 2026-06-14

## Summary

`GetTransactionHistory` returns rich, normalized per-tx metadata for **blockbook-backed
chains** (UTXO + EVM) but returns **sparse** data for several other families (Solana
observed; likely Cosmos/THOR/Maya/XRP/TON as well). The vault's activity history and the
transaction-detail panel render whatever Pioneer provides, so these chains show
transactions with **no amount, no fee, and a permanent false "Unconfirmed" badge**.

We've mitigated the false-negative on the client (see "Client mitigations already
shipped" below), but the **amount / fee / confirmation data genuinely does not exist in
the response** for these chains — that part needs a server change.

## How the vault consumes the response

```
pioneer.GetTransactionHistory({ queries: [{ pubkey, caip }] })
  → { data: { histories: [ { transactions: [ TX, ... ] } ] } }
```

For each `TX` the vault reads (see `src/bun/activity-history.ts` `normalizeMeta`):

| Field used        | Purpose in UI                                  |
|-------------------|------------------------------------------------|
| `txid` / `hash`   | identity, explorer link                        |
| `timestamp`       | "x ago" / full date                            |
| `direction`       | Sent / Received classification                 |
| `value`           | **Amount** (base units; client converts)       |
| `fee`             | **Fee**                                        |
| `confirmations`   | confirmation badge (count / Confirmed)         |
| `blockHeight`     | Block row                                      |
| `from[]` / `to[]` | counterparty addresses                         |

## The gap (observed)

**Blockbook chains (BTC, ETH, …)** — full set present: `value`, `fee`, `confirmations`,
`blockHeight`, `from[]`, `to[]`. Works great.

**Solana (SOL)** — a `history` tx comes back with effectively only `txid` (+ timestamp).
Missing: `value`, `fee`, `confirmations`, `blockHeight`, and usable `from`/`to`. Result
in the UI before mitigation: a row with the txid where the amount should be, and a red
"Unconfirmed" badge on a tx that finalized ~48 minutes earlier.

We strongly suspect the same sparseness on the other non-blockbook families
(Cosmos/THOR/Maya/XRP/TON) — please audit those alongside Solana.

## Ask

For **every** chain `GetTransactionHistory` supports, normalize each `transaction` to
include, when the underlying explorer/RPC exposes it:

- `value` — net amount moved for this address, **base units**, signed if possible
  (negative = outbound), consistent with the blockbook path.
- `fee` — base units.
- `confirmations` — integer. If the source only exposes finalized/slot data, derive it
  (`tip - txSlot`) or return a sentinel that clearly means "finalized" — **do not omit it
  such that the client must guess**. (Absent is read as "unknown", not 0; see below.)
- `blockHeight` / slot.
- `from` / `to` — address arrays, same shape as blockbook (`["addr", …]`).

This brings non-blockbook chains to parity with the blockbook path so the vault can show
amount, fee, and an accurate confirmation state for all history.

## Client mitigations already shipped (so you can see the contrast)

These are in the vault now and do **not** depend on the server change — they just stop the
client from lying when data is absent:

1. **Absent `confirmations` → `undefined`, not `0`.** A tx in the *history* endpoint is
   on-chain by definition, so defaulting a missing field to 0 ("Unconfirmed", red) is a
   false negative. We now render *no* confirmation badge when the field is absent. A real
   mempool tx that arrives as an explicit `0` is preserved and still shows "Unconfirmed".
   (`src/bun/activity-history.ts` `normalizeMeta`.)
2. **Capture `from`/`to`** from the response (previously discarded) so received/historical
   txs show counterparties when the server provides them.
3. For **in-app sends**, the vault now persists its own amount/fee/recipient at broadcast
   time, so those show regardless of server history. This is a stopgap — it does nothing
   for received txs or sends made on other devices, which is exactly why the server-side
   completeness matters.

## Verification

Once the server change lands, pick a Solana account with known history and confirm each
`transaction` in `GetTransactionHistory` carries `value`, `fee`, `confirmations`,
`blockHeight`, `from`, `to`. The vault needs no further change to render them — it already
reads these fields.
