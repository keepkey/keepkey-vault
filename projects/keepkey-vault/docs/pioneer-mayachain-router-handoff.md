# Pioneer Mayachain Router And Status Handoff

Date: 2026-05-11

## Current State

- Vault PR: `keepkey/keepkey-vault#149`
  - Branch: `fix/swap-truth-pass`
  - Base: `develop`
  - Current head after rebase: `6eea49a8`
  - State: draft, mergeable.
- Pioneer PR: `coinmastersguild/pioneer#52`
  - Title: `fix(mayachain): surface router + inbound on EVM quote (no more EOA-target refunds)`
  - State: merged to `develop`.
  - CI built `pioneer-server`, `pioneer-watchtower`, and `pioneer-cache-worker`.
  - Deploy jobs were skipped, so production `https://api.keepkey.info` still needs explicit verification.

Vault #149 fixes local truth rendering by trusting Maya Midgard for terminal swap outcome. Pioneer still needs verification and likely one follow-up: `/swaps/pending/{txHash}` currently reconstructs completed/refunded Maya swaps as `pending`.

## Incident Summary

Maya EVM quotes nested the router and vault under:

- `quote.txs[0].txParams.routerAddress`
- `quote.txs[0].txParams.vaultAddress`

Vault quote parsing reads:

- `quote.router`
- `quote.inbound_address` / `quote.inboundAddress`
- `quote.txs[0].txParams.recipientAddress`

Because those fields were missing, Vault fell back to treating the EOA inbound vault as the router. It built `depositWithExpiry(...)` calldata and sent it to the EOA. Mayanode then observed binary calldata as if it were a UTF-8 memo and refunded with `invalid tx type`.

Known live txids:

- Broken before Pioneer fix:
  - Inbound: `7CE15ACD233EA4DFEC386B45BBB347906E41E366D9C4DB95E735ED88F87BD42D`
  - Result: Maya `type=refund`
  - Refund outbound: `633F6EF365333E51CA5D315DAF787507663F6C8FC371C511C99D4B9266E5F6DD`
  - Refund asset: `ETH.ETH`
- Successful after local Pioneer fix:
  - Inbound: `B5D885DD95C46149909619CB56D218652FC4F217FA7BAA1ED8D7CC2BFB2897AE`
  - Result: Maya `type=swap`, `status=success`
  - Outbound: `ACCB9E7230252E2440BEE46173CA347B73EF10190E2B6766D6644D5BA28C708C`
  - Outbound asset: `ZEC.ZEC`
- Known-good completed fixture:
  - Inbound: `A9260E10AE66DF46C4EE4128A664B41736DBD845D07041F67DE278F9CEF25A46`
  - Result: Maya `type=swap`, `status=success`
  - Outbound: `17AB8000BBD3CB951C83F917C5A93282C259F281CC284FBC5665BB226089609A`
  - Outbound asset: `ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48`

## Pioneer Work Plan

### 1. Verify #52 Is Present In The Runtime Branch

In `modules/intergrations/mayachain/src/index.ts`, confirm:

- EVM Maya quotes set top-level `output.router`.
- EVM Maya quotes set `output.inbound_address` and `output.inboundAddress`.
- `txParams.recipientAddress` mirrors the router.
- `txParams.routerAddress` remains the router.
- `txParams.vaultAddress` remains the inbound vault address.
- Missing inbound router throws at quote time.
- ARB inbound lookup uses the Maya chain name for ARB, not a hard-coded ETH inbound.

Acceptance:

- A Mayachain ETH to ZEC quote cannot return with an empty router.
- Vault receives enough data to build the EVM transaction `to` as the router contract, not the EOA inbound vault.

### 2. Add Or Confirm Direct Mayachain Quote Test Coverage

Pioneer quote routing can return ShapeShift or another aggregator as the first/best route, which hides whether the direct Mayachain integration is fixed. Add a test path that exercises Mayachain directly, either by integration filter, test harness, or direct module call.

Required quote cases:

- `ETH.ETH -> ZEC.ZEC`
- `ETH.USDT -> ETH.ETH` or another ERC-20 source route, to validate spender/router behavior.
- `ARB -> supported Maya destination`, if ARB is enabled in the integration.

Acceptance for each EVM source quote:

- `quote.router` is a `0x...` contract address.
- `quote.inbound_address` / `quote.inboundAddress` is present.
- `quote.router !== quote.inbound_address` for EVM deposits.
- `quote.txs[0].txParams.recipientAddress === quote.router`.
- `quote.txs[0].txParams.routerAddress === quote.router`.
- `quote.txs[0].txParams.vaultAddress === quote.inbound_address`.
- Memo is clean text, e.g. `=:ZEC.ZEC:<recipient>`, not ABI calldata.

### 3. Fix Pioneer Pending-Swap Truth For Maya

Current production behavior observed on 2026-05-11:

```sh
curl -sS 'https://api.keepkey.info/api/v1/swaps/pending/B5D885DD95C46149909619CB56D218652FC4F217FA7BAA1ED8D7CC2BFB2897AE?rescan=true'
```

returned `status: "pending"` even though Maya Midgard reports a successful outbound. The same endpoint also returns `pending` for the refund and completed fixture txids.

Port the Vault classifier behavior into Pioneer pending lookup/rescan:

- Query Maya Midgard for the inbound txid.
- If no action exists, keep current pending/not-found behavior.
- If action `type=refund`:
  - status: `refunded`
  - buy asset should reflect the refund outbound coin, usually the source asset.
  - persist outbound tx hash, outbound asset, outbound chain, and refund reason.
- If action `type=swap` and `status=success` with an outbound leg:
  - status: `success`
  - buy asset amount should reflect the actual outbound coin amount.
  - persist outbound tx hash and outbound asset.
- If action `status=pending` or no outbound leg:
  - status: `pending`.
- `?rescan=true` must overwrite stale reconstructed `pending` rows when Midgard has terminal truth.

Acceptance:

- `7CE15...BD42D?rescan=true` returns `status: "refunded"`.
- `A9260...25A46?rescan=true` returns `status: "success"`.
- `B5D885...897AE?rescan=true` returns `status: "success"`.
- Repeated calls do not recreate stale `pending` rows.

### 4. Local Curl Verification

Use a local Pioneer base first:

```sh
export PIONEER_BASE='http://127.0.0.1:9001'
```

Quote shape check:

```sh
curl -sS -X POST "$PIONEER_BASE/api/v1/quote" \
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
    swapper: .quote.swapper,
    router: .quote.router,
    inbound: (.quote.inbound_address // .quote.inboundAddress),
    txParams: .quote.txs[0].txParams
  }'
```

Midgard truth check:

```sh
curl -sS 'https://midgard.mayachain.info/v2/actions?txid=7CE15ACD233EA4DFEC386B45BBB347906E41E366D9C4DB95E735ED88F87BD42D' \
  | jq '{count, type:.actions[0].type, status:.actions[0].status, outTx:.actions[0].out[0].txID, outAsset:.actions[0].out[0].coins[0].asset, reason:.actions[0].metadata.refund.reason}'
```

Pioneer status check:

```sh
for tx in \
  7CE15ACD233EA4DFEC386B45BBB347906E41E366D9C4DB95E735ED88F87BD42D \
  A9260E10AE66DF46C4EE4128A664B41736DBD845D07041F67DE278F9CEF25A46 \
  B5D885DD95C46149909619CB56D218652FC4F217FA7BAA1ED8D7CC2BFB2897AE
do
  curl -sS "$PIONEER_BASE/api/v1/swaps/pending/$tx?rescan=true" \
    | jq '{txHash, status, integration, sellAsset, buyAsset, updatedAt}'
done
```

### 5. Vault Local Verification Against Local Pioneer

Run Vault with:

```sh
PIONEER_API_BASE="$PIONEER_BASE"
```

Then use the Vault REST swap flow to open an ETH to ZEC quote and preview build. The review page must show an auditable hdwallet payload before enabling confirm.

Acceptance:

- Confirm remains locked until `previewSwapBuild` returns.
- EVM review summary shows:
  - transaction `to` is the Maya router.
  - calldata starts with `depositWithExpiry` selector `0x44bc937b`.
  - value equals the ETH sell amount base units.
  - memo decodes to the intended swap memo.
- Fee and minimum received remain visible after fees.
- No xpub is present in quote payloads sent to Pioneer.

### 6. Deploy And Production Verification

After Pioneer develop contains the router fix and pending-status fix:

1. Deploy Pioneer server to the intended environment.
2. Verify `https://api.keepkey.info/spec/swagger.json` reflects the deployed build if version metadata is available.
3. Repeat the quote shape curl against:

```sh
export PIONEER_BASE='https://api.keepkey.info'
```

4. Repeat the three pending-swap rescan curls.
5. Only then mark Vault #149 ready for final review, because new live swaps depend on Pioneer quote correctness even though Vault can now render old swaps truthfully.

## Open Risks

- Production may still be running a build before Pioneer #52 because deploy jobs were skipped.
- The quote endpoint may return a non-Maya route first. Local tests need a direct Mayachain harness or route filter so Mayachain is tested explicitly.
- Existing stale `pending` rows in Pioneer can mask Midgard truth unless `?rescan=true` force-updates persisted rows.
- ERC-20 source swaps must verify approval spender equals the router contract, not the inbound vault EOA.
- ARB must use the ARB inbound entry. A hard-coded ETH inbound lookup is not sufficient.

