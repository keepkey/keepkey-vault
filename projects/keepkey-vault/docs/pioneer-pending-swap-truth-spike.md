# Pioneer Pending Swap Truth Spike

Date: 2026-05-12

## Scope

This handoff is only for Pioneer `/api/v1/swaps/pending/{txHash}` truth handling after the Mayachain router quote fix. The router quote patch is working locally on `localhost:9001`; the remaining issue is status/outbound truth for existing Maya swaps.

The endpoint must stop treating Maya Midgard terminal actions as stale reconstructed `pending` rows, and it must distinguish refunds from successful swaps.

## Local Test Environment

Base URL tested:

```sh
export PIONEER_BASE='http://localhost:9001'
```

Swagger responded:

```text
https://localhost:9001/api/v1
```

Quote shape test passed for `ETH -> ZEC`:

```json
{
  "integration": "mayachain",
  "router": "0xe3985E6b61b814F7Cdb188766562ba71b446B46d",
  "inbound": "0x6a16f961e24e6e90bd9f950f768dc42a7f305664",
  "recipientAddress": "0xe3985E6b61b814F7Cdb188766562ba71b446B46d",
  "routerAddress": "0xe3985E6b61b814F7Cdb188766562ba71b446B46d",
  "vaultAddress": "0x6a16f961e24e6e90bd9f950f768dc42a7f305664",
  "memo": "=:ZEC.ZEC:t1gwwyCfbRMyQdwo8xXrMGDj3ZqVjhsHWTh"
}
```

That confirms the original EOA-targeting bug is fixed in the local Pioneer runtime.

## Current Failure Matrix

| Inbound txid | Midgard truth | Local Pioneer result | Desired Pioneer result |
| --- | --- | --- | --- |
| `7CE15ACD233EA4DFEC386B45BBB347906E41E366D9C4DB95E735ED88F87BD42D` | `type=refund`, outbound refund `633F6EF365333E51CA5D315DAF787507663F6C8FC371C511C99D4B9266E5F6DD`, asset `ETH.ETH` | `status=completed`, outbound hash present | `status=refunded`, outbound refund hash present, refund reason preserved |
| `A9260E10AE66DF46C4EE4128A664B41736DBD845D07041F67DE278F9CEF25A46` | `type=swap`, `status=success`, outbound `17AB8000BBD3CB951C83F917C5A93282C259F281CC284FBC5665BB226089609A`, asset `ETH.USDC-...` | `status=completed`, outbound hash present | OK, or normalized to the API's chosen terminal success status |
| `B5D885DD95C46149909619CB56D218652FC4F217FA7BAA1ED8D7CC2BFB2897AE` | `type=swap`, `status=success`, outbound `ACCB9E7230252E2440BEE46173CA347B73EF10190E2B6766D6644D5BA28C708C`, asset `ZEC.ZEC` | `status=pending`, outbound hash null | `status=completed`, outbound hash present |

The status calls needed a 60 second curl timeout. A 20 second timeout produced no response body. That is a separate latency issue worth tracking, but correctness comes first.

## Repro Commands

Quote shape:

```sh
curl -sS --max-time 20 -X POST "$PIONEER_BASE/api/v1/quote" \
  -H 'Content-Type: application/json' \
  -d '{
    "sellAsset":"eip155:1/slip44:60",
    "sellAmount":"0.01",
    "buyAsset":"bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133",
    "recipientAddress":"t1gwwyCfbRMyQdwo8xXrMGDj3ZqVjhsHWTh",
    "senderAddress":"0x141d9959cae3853b035000490c03991eb70fc4ac",
    "slippage":1
  }' | jq '.[] | {
    integration,
    swapper:.quote.swapper,
    router:.quote.router,
    inbound:(.quote.inbound_address // .quote.inboundAddress),
    recipientAddress:.quote.txs[0].txParams.recipientAddress,
    routerAddress:.quote.txs[0].txParams.routerAddress,
    vaultAddress:.quote.txs[0].txParams.vaultAddress,
    memo:.quote.txs[0].txParams.memo
  }'
```

Pending-swap truth:

```sh
for tx in \
  7CE15ACD233EA4DFEC386B45BBB347906E41E366D9C4DB95E735ED88F87BD42D \
  A9260E10AE66DF46C4EE4128A664B41736DBD845D07041F67DE278F9CEF25A46 \
  B5D885DD95C46149909619CB56D218652FC4F217FA7BAA1ED8D7CC2BFB2897AE
do
  curl -sS --max-time 60 "$PIONEER_BASE/api/v1/swaps/pending/$tx?rescan=true" \
    | jq '{
      txHash,
      status,
      integration,
      sellAsset,
      buyAsset,
      outboundTxHash:(.thorchainData.outboundTxHash // .mayachainData.outboundTxHash // .outboundTxHash),
      updatedAt,
      error
    }'
done
```

Midgard ground truth:

```sh
curl -sS 'https://midgard.mayachain.info/v2/actions?txid=B5D885DD95C46149909619CB56D218652FC4F217FA7BAA1ED8D7CC2BFB2897AE' \
  | jq '{
    count,
    type:.actions[0].type,
    status:.actions[0].status,
    inTx:.actions[0].in[0].txID,
    outTx:.actions[0].out[0].txID,
    outAsset:.actions[0].out[0].coins[0].asset,
    outAmount:.actions[0].out[0].coins[0].amount
  }'
```

## Implementation Plan

### 1. Add a Maya Midgard Classifier Helper

Add a small pure helper in Pioneer near the pending-swap lookup code, or in a reusable swap-status module:

```ts
type MayaActionClassification =
  | { status: 'pending'; outboundTxHash?: undefined; outboundAsset?: undefined; outboundAmountBaseUnits?: undefined; refundReason?: undefined }
  | { status: 'completed'; outboundTxHash: string; outboundAsset: string; outboundAmountBaseUnits: string; refundReason?: undefined }
  | { status: 'refunded'; outboundTxHash: string; outboundAsset: string; outboundAmountBaseUnits: string; refundReason?: string }
  | { status: 'unknown' }
```

Rules:

- Query `https://midgard.mayachain.info/v2/actions?txid=<UPPERCASE_TXID_WITHOUT_0X>`.
- If no actions are returned, classify `unknown`.
- If `action.type === 'refund'`:
  - `status = 'refunded'` unless the action itself is still pending.
  - outbound hash is `action.out[0].txID`.
  - outbound asset and amount come from `action.out[0].coins[0]`.
  - refund reason comes from `action.metadata.refund.reason`, after stripping the `MidgardBadUTF8EncodedBase64:` prefix if present.
- If `action.type === 'swap'`:
  - if `action.status === 'success'` and `action.out[0]` exists, classify terminal completed.
  - if no outbound exists yet, classify pending.
- Do not infer outbound chain from the user's intended `buyAsset`; use the actual Midgard outbound coin asset.

### 2. Use The Classifier In `GET /swaps/pending/{txHash}`

When the row is Mayachain, or when the txid is found in Maya Midgard:

- Run the classifier during `?rescan=true`.
- Also run it for stale cached rows whose status is `pending` and integration is `mayachain`.
- If classifier returns terminal truth, overwrite the reconstructed row fields before returning.

Persist at least:

- `status`
- outbound tx hash
- outbound asset CAIP/symbol/network where possible
- outbound amount base units and display amount
- refund reason for refunds
- `updatedAt`

### 3. Fix Stale Pending Overwrite

The `B5D885...` response proves the endpoint can reconstruct the sell/buy assets but does not replace the stale pending status with Midgard's terminal outbound. The overwrite path must not exit early just because a Mongo row already exists.

Expected behavior:

- Existing row + `?rescan=true` means "trust current chain/protocol truth over cached status."
- Existing pending Mayachain row with Midgard success should become completed.
- Existing pending Mayachain row with Midgard refund should become refunded.
- Existing completed row with Midgard refund should become refunded.

### 4. Normalize Status Vocabulary

Swagger has historically mentioned `success`, while the local endpoint returns `completed`.

Pick one canonical API status and make it consistent:

- If keeping current endpoint behavior, use `completed`.
- If aligning to existing schema enums, use `success`.

Vault can map either, but Pioneer should not mix `success`, `completed`, and `fullfilled` for the same state in different paths.

### 5. Add Regression Tests

Use fixtures copied from Vault #149 or fetched snapshots:

- `maya-refund-eth-to-zec-7ce1.json`
- `maya-completed-zec-to-usdc-a926.json`
- `maya-completed-eth-to-zec-b5d885.json`

Tests should assert:

- `7CE15...` classifies as refunded with outbound `633F6E...`.
- `A9260...` classifies as completed/success with outbound `17AB80...`.
- `B5D885...` classifies as completed/success with outbound `ACCB9E...`.
- An existing pending row is overwritten on `rescan=true`.
- An existing completed row is overwritten to refunded when Midgard says refund.

## Acceptance Criteria

Local `localhost:9001` should return:

```text
7CE15...BD42D  -> refunded, outbound 633F6EF365333E51CA5D315DAF787507663F6C8FC371C511C99D4B9266E5F6DD
A9260...25A46  -> completed/success, outbound 17AB8000BBD3CB951C83F917C5A93282C259F281CC284FBC5665BB226089609A
B5D885...897AE -> completed/success, outbound ACCB9E7230252E2440BEE46173CA347B73EF10190E2B6766D6644D5BA28C708C
```

The endpoint should respond under 20 seconds for these three known txids.

## Vault Dependency

Vault PR #149 already protects the UI by asking Maya Midgard directly and rendering terminal truth locally. This Pioneer work is still needed because:

- external clients use `/swaps/pending/{txHash}` as the canonical status endpoint;
- Vault debug/audit views compare local truth with Pioneer truth;
- stale Pioneer pending rows create confusing tracker output and make completed swaps look stuck.

Once Pioneer passes the acceptance curls above, Vault #149 can treat Pioneer as consistent with its local Midgard truth pass.

