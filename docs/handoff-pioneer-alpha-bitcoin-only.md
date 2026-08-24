# Handoff: Pioneer requirements for alpha Bitcoin-only testing

Date: 2026-08-23

From: Vault BTC-only audit

To: Pioneer server/client owner

Vault PR: #425 (`fix/alpha-bitcoin-only-api-boundary`)

Pioneer source inspected: `release/v1.3.155` at `2b76a1ac6`

Do not add a `bitcoinOnly` mode to Pioneer. Firmware identity and feature
restriction belong to Vault. In Pioneer mode, the device makes ordinary Bitcoin
mainnet or testnet requests. In self-hosted mode, Vault bypasses Pioneer for
mainnet and fails closed on testnet; offline mode blocks every network. Its
runtime guard rejects accidental BTC mainnet and testnet calls.

Pioneer changes are still required before the whole advertised Bitcoin-only
surface can be called ready.

## Live contract evidence

These unauthenticated probes were run against the deployed service on
2026-08-23. They contain no wallet data:

| Probe | Production result | Why it matters |
|---|---|---|
| mainnet `fee-rate` | HTTP 200, numeric `fastest/fast/average`, no unit | mainnet works, but the unit is implicit |
| testnet `fee-rate` | HTTP 400 `Unsupported UTXO networkId` | advertised Bitcoin testnet is not implemented |
| malformed xpub `ListUnspent` | HTTP 200 `[]` | invalid input is indistinguishable from an empty wallet |
| malformed xpub `GetPubkeyInfo` | HTTP 200 `{success:false}` | application failure is hidden behind HTTP success |
| malformed txid `LookupUtxoTx` | HTTP 200 `{success:false}` | not-found/error transport semantics are ambiguous |

Mainnet and testnet fee probes produced the same results on
`api-blue.keepkey.info`. Preserve equivalent probes as deployment smoke tests.

## P0: support Bitcoin testnet consistently

Vault and Bitcoin-only firmware both expose Bitcoin testnet:

- network: `bip122:000000000933ea01ad0ee984209779ba`
- asset: `bip122:000000000933ea01ad0ee984209779ba/slip44:1`
- extended keys: `tpub` (and script-specific testnet forms where supported)

Pioneer's `UTXO_NETWORKS` and broadcast network map currently contain Bitcoin
mainnet but not testnet. Add one canonical testnet mapping and use it for:

- `ListUnspent`
- `GetPubkeyInfo`
- `GetFeeRate` / `GetFeeRateByNetwork`
- `LookupUtxoTx`
- `Broadcast`
- portfolio balances and transaction history for the testnet asset CAIP

If there is no production testnet indexer, return an explicit unsupported or
service-unavailable error. Do not return an empty wallet.

## P0: failures must not masquerade as valid empty data

The UTXO, fee, pubkey-info, lookup, and broadcast controllers commonly catch an
upstream exception and return HTTP 200 with `{success:false,error}`. Cold history
can also end its 30-second wait with `success:true`, `transactions:[]`, and
`loading:true`.

Use transport status and a stable error body:

- 400 for malformed or unsupported network/xpub/txid/hex;
- 404 only for a transaction that is genuinely absent;
- 502/503 for indexer, node, queue, or Redis failure;
- 202 with `loading:true` is acceptable for asynchronous cold history, but 200
  with an empty transaction array must mean a completed, authoritative empty
  result.

This distinction is safety-relevant: an empty UTXO set hides spendable funds;
missing address tokens can make a host reuse index 0; synthetic fallback fees
can materially alter a transaction.

Vault PR #425 now also fails closed on Pioneer `{success:false}`, malformed
UTXO responses, missing fee rates, and missing address-token data. That protects
the current client but does not replace a correct server contract.

## P0: freeze the BTC money-path response contract

Return these fields consistently through the generated Pioneer client:

```text
ListUnspent -> [{ txid, vout, value, path, address?, hex? }]
GetPubkeyInfo -> { tokens: [{ path, transfers, name? }], ... }
GetFeeRate -> { slow, average, fast|fastest, unit: "sat/vB" }
LookupUtxoTx -> { success: true, data: { txid, hex, ... } }
Broadcast -> { success: true, txid }
```

`value` must be an integer number of satoshis. `path` must be the full BIP32
path belonging to the UTXO. Legacy P2PKH signing requires the complete raw
previous transaction hex, not just its txid or selected output.

The generated operation is `LookupUtxoTx`; do not rename it silently. Vault
PR #425 accepts both that name and the older `UtxoLookup` alias during migration
and now unwraps the server's nested lookup response.

Fee units must be explicit. Vault still recognizes the legacy sat/kB shape by
magnitude for compatibility, but a heuristic is not an acceptable permanent
money-path contract.

## P1: history and discovery completion semantics

For mainnet and testnet xpub/zpub/ypub/tpub account queries:

- a cold cache must enqueue and await the indexer or return explicit `loading`;
- `forceRefresh=true` must not silently degrade to a completed empty history;
- pagination must preserve `caip`, `pubkey`, `page`, and completion state;
- `GetPubkeyInfo.tokens` must include every used receive/change address with
  its exact path and positive transfer count;
- an upstream response with transactions but no token/path detail is an error,
  not change index 0.

## Acceptance gate

Run against the exact alpha Pioneer candidate, not only mocks:

1. Mainnet and testnet CAIP forms reach the intended node/indexer for every
   listed operation; unknown `bip122:*` returns non-2xx.
2. A funded BIP44, BIP49, BIP84, and BIP86 account returns exact integer-satoshi
   UTXOs and full derivation paths.
3. A legacy UTXO returns complete raw previous-transaction hex and the txid of
   that hex matches the requested txid.
4. Fee response declares `sat/vB`; `slow <= average <= fast/fastest`; no default
   success response is emitted when every estimator is unavailable.
5. Cold and forced history for a known-used key return transactions or explicit
   in-progress/error state, never authoritative empty success.
6. Missing Blockbook token detail and simulated Redis/indexer/node outages are
   visible failures.
7. Broadcast a disposable testnet transaction, assert the returned txid, then
   repeat it and define the idempotent/already-known behavior.
8. Capture status code and JSON for every case as the handback evidence.

No Pioneer deployment is required for the first alpha physical pass if testing
only Bitcoin mainnet on a healthy Pioneer backend. Testnet and degraded-backend
claims remain blocked until this gate passes.
