# Handoff: Pioneer leaks Blockchair's `block_id: -1` mempool sentinel into swap records

## Problem

A BTC swap that was still **unconfirmed in the mempool** displayed `Block #-1` in the
vault swap dialog (with the input tx clearly mined into "block −1").

- Tx: `94ccbc7783ea19874cd1921bf27287031ae4c1a0058d5bfec169bd1a7eaa6875`
  (genuinely unconfirmed at the time — https://mempool.space/tx/94ccbc7783ea19874cd1921bf27287031ae4c1a0058d5bfec169bd1a7eaa6875)

### Root cause

Blockchair (Pioneer's UTXO tx-data backend) reports `block_id: -1` for any transaction
that is still in the mempool. Pioneer copies that value straight into the swap record's
`blockchainTxData.blockNumber`, so the vault receives `blockNumber: -1` for an unconfirmed
input and renders it literally as `Block #-1`.

`-1` is **not a valid block height** — it is Blockchair's "not yet mined" sentinel. Some
other UTXO backends use `0` for the same state. A real block height is always `>= 1`.

The vault must not call chain explorers itself to discover where a tx landed — all swap
tx-data flows through Pioneer's swap record. This is Pioneer's to surface correctly.

## What Pioneer needs to do

When normalizing Blockchair (and any other UTXO backend) tx data into the swap record's
`blockchainTxData`, treat a non-positive `block_id` / `block_height` as **unconfirmed** and
omit `blockNumber` entirely (leave it `null`/absent) rather than passing `-1` through.

Concretely, wherever Pioneer maps the Blockchair response:

```
// Blockchair: data[txid].transaction.block_id  ==  -1  while in mempool
const blockId = blockchair?.transaction?.block_id
const blockNumber = (typeof blockId === 'number' && blockId > 0) ? blockId : undefined
```

Apply the same `> 0` guard to any other UTXO source (BTC/LTC/DOGE/BCH/DASH/ZEC) so the
swap record never carries a sentinel as a real height. If `blockNumber` is omitted, the
vault correctly treats the input as not-yet-mined.

### Where to look

- Pioneer's UTXO tx-status / blockchain-tx-data path (the code that builds
  `swap.blockchainTxData` from Blockchair). Likely in **pioneer-discovery** or the
  swap-tracking service in **pioneer-server** that enriches swap records.
- Grep Pioneer for `block_id`, `blockchair`, and `blockchainTxData`.

## Vault-side mitigation already shipped (defensive, not a substitute)

The vault was patched to ignore non-positive block numbers so existing bad records and any
future leak render as "unconfirmed" instead of `Block #-1`. These are belt-and-suspenders;
the authoritative fix belongs in Pioneer.

- `src/bun/swap-tracker.ts` — only adopts `blockchainTxData.blockNumber` when `> 0`.
- `src/mainview/components/SwapDialog.tsx` — three state-set sites (live snapshot, push
  update, resume seed) guard `> 0`. Needed because a `-1` already persisted in the local
  swap DB is never overwritten (the write-path only updates on real values).
- `src/mainview/components/SwapHistoryDialog.tsx` — guards `> 0` when reading the persisted
  record directly.

## Verification

After the Pioneer fix:
- An unconfirmed UTXO swap input should have **no** `Inbound Block` row in the vault swap
  dialog (the row only appears once a real height arrives).
- Once the input confirms, the real height should appear and be clickable on the explorer.
- Confirm Blockchair's mempool response (`block_id: -1`) for an in-flight tx no longer
  produces a `blockNumber` in the swap record returned to the vault.
