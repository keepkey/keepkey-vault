# Handoff: Signing History over REST

## TL;DR

Signing history is now available via authenticated REST. Use it to debug the 7.14 EIP-712 regression (see [incident-7.14-eip712-regression.md](incident-7.14-eip712-regression.md)) — and any future signing regression — without UI involvement.

## Endpoints

Both require auth (paired-app API key, same as `/api/portfolio/:id`).

### `GET /api/v1/activity`

List recent signed/broadcast/swap operations, newest first. Filterable.

Query parameters (all optional):

| Param          | Example                            | Notes                                              |
|----------------|------------------------------------|----------------------------------------------------|
| `route`        | `/eth/sign-typed-data`             | Exact REST route match                             |
| `activityType` | `sign` \| `broadcast` \| `swap`    | What was logged                                    |
| `txid`         | `0xabc…`                           | Exact match                                        |
| `chain`        | `ETH`                              | Chain symbol                                       |
| `since`        | `1714000000000`                    | Unix ms, inclusive lower bound                     |
| `until`        | `1714086400000`                    | Unix ms, inclusive upper bound                     |
| `limit`        | `50` (default `100`, max `500`)    |                                                    |
| `offset`       | `0`                                | For pagination                                     |

Response:
```json
{ "entries": [{ "id": 423, "method": "POST", "route": "/eth/sign-typed-data", "timestamp": 1714000000000, "durationMs": 4231, "status": 200, "appName": "uniswap.org", "requestBody": { "addressNList": [...], "typedData": {...} }, "responseBody": { "signature": "0x..." }, "chain": "ETH", "activityType": "sign" }, ...], "count": 1 }
```

### `GET /api/v1/activity/:id`

Single entry with full request/response bodies. Returns 404 if not found, 400 on bad id.

## Workflow: debug a failing sign

1. Trigger the failing operation on the vault. (Approve on device.)
2. Pull the most recent `eth/sign-typed-data` entry:
   ```bash
   curl -s -H "x-api-key: $KEEPKEY_API_KEY" \
     'http://localhost:1646/api/v1/activity?route=/eth/sign-typed-data&limit=1' | jq
   ```
3. The full `requestBody.typedData` (domain + types + primaryType + message) and `responseBody.signature` are inline. Hand off to `tests/evm-eip712/uniswap-permit-prod.js` (offline half) to recover the address.
4. If the signature doesn't recover to the device's ETH address, the vault produced a bad sig. Diff host-computed digest vs firmware to localize.

## What is and isn't logged

**Logged** (in the `api_log` SQLite table):
- All REST sign endpoints (`/eth/sign*`, `/utxo/sign*`, `/cosmos/sign*`, `/solana/sign*`, etc.)
- RPC `broadcastTx` operations (txid + chain)
- RPC `executeSwap` operations
- Body sizes are not currently truncated — full typed data and full Solana message bytes are persisted as JSON.

**Not logged** (intentional — privacy):
- Anything originating from a passphrase / hidden-wallet session. The `engine.isPassphraseWallet` guard at `src/bun/index.ts:584` skips DB writes for those.
- Read-only ops (address derivation, getFeatures, etc.) — they go through the same `onApiLog` callback but aren't tagged with `activityType`, so they'll appear in unfiltered `findApiLogs` but are filtered out by `activityType=sign`.

## Limits & retention

- Ring buffer: max 5000 rows. Pruned probabilistically (~1% of inserts trigger a `DELETE … WHERE id NOT IN (… LIMIT 5000)`).
- Indexed on `timestamp DESC` and `activity_type`.

## Where the code lives

| Concern              | File                              |
|----------------------|-----------------------------------|
| Schema / helpers     | `src/bun/db.ts`                   |
| Logging hook         | `src/bun/index.ts` (`onApiLog`)   |
| REST routes          | `src/bun/rest-api.ts`             |
| Persisted shape      | `src/shared/types.ts` (`ApiLogEntry`) |

## Build-out ideas (not in this PR)

- Add `requestBody.summary` / `responseBody.summary` fields server-side (e.g., extract `to`, `value`, `chainId` for ETH; `signerAddress`, `chain_id` for Cosmos) so list views don't have to download full payloads. Keep full body on `/:id`.
- Add a CSV / JSONL export endpoint for offline replay against a reference signer.
- Add a `replay` flag on the entry view that reconstructs the exact device call (no signing, just shape verification).
- Tag entries by app fingerprint (origin + paired-app id) so per-app regressions are filterable.
