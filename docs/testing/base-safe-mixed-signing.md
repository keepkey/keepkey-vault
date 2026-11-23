# Base Safe practice with local Vault, KeepKey, and Safe web

Run the local development app against **Base mainnet, chain 8453**. Deployment,
funding, and execution use real ETH and fees. Owner approvals and queue sharing
are off-chain. The connected KeepKey pays deployment and execution gas when it
submits those transactions.

Opening **Multisig** restores saved directory Safes for the connected owner and
discovers additional Base Safes through Safe's owner API. Discovery verifies
supported code and current ownership on-chain. **Find my Safes** explicitly
retries discovery. The view reloads after wallet identity changes, including
changes on the same device. New discoveries require an owner review; previously
reviewed Safes retain their review unless their owners or threshold changed.

## Prepare the owners and deploy

1. Enable **Multisig** in Settings. Open **Multisig → Create a Safe**. If the
   provider needs configuration, use **Verify & use RPC** with a Base endpoint.
2. Add the other wallet's receiving address to the **Base address book**. ENS
   contacts must resolve to a concrete address before saving; the ENS name is
   the label. Confirm that the web wallet controls that exact address.
3. Use **Address book** beside Owner 2. The connected KeepKey is Owner 1.
   For a two-wallet rehearsal, use **2 of 2**. The picker excludes the connected
   owner, duplicate selected owners, and saved vault contracts.
4. Choose **Review deployment**. Check Base, the full owner addresses, threshold,
   predicted Safe address, and estimated fees. **Save setup for later** preserves
   the draft without deployment. **Confirm on KeepKey & submit** signs and
   broadcasts the reviewed deployment. Refresh until the Safe is deployed.
5. Choose **Open in Safe ↗** and connect the second wallet. Check the same Base
   Safe address, owners, and threshold in both apps. Fund the Safe with a small
   amount of Base ETH after deployment is confirmed. Keep gas ETH in the wallet
   that will execute it.

## Vault proposes, Safe web approves

1. In Vault, create a small **ETH** transfer to an address you control. Review the
   recipient, amount, Base network, Safe address, nonce, and transaction hash.
2. Choose **Approve with KeepKey**. Compare the device display with the review.
   This signs the Safe approval; it does not execute the transfer.
3. Choose **Share with Safe**. This explicitly uploads the connected owner's
   verified approval to Safe's Transaction Service. Check the same transaction
   hash and contents in Safe web, then approve with the second wallet.
4. Refresh Vault, or wait for its 30-second visible-view poll. It must show both
   verified owner approvals. Select **Review execution**; compare the transfer
   and fees, then confirm on KeepKey to submit if you want to execute it there.
5. After confirmation, refresh both apps. The Safe nonce should advance and the
   transaction should leave the pending queue. Check the recipient's balance
   and BaseScan transaction status. A submission alone is not confirmation.

## Safe web proposes, Vault approves

1. In Safe web, propose a direct ETH transfer or **native Base USDC** transfer
   with CALL operation and zero Safe gas refunds. Approve with the web wallet.
2. Open/refresh that Safe in Vault. Select the downloaded proposal and compare
   its hash, nonce, recipient, and amount with Safe web.
3. Approve on KeepKey, then choose **Share with Safe**. Safe web should show the
   additional approval. Execute from either app using a separate execution review.

## Expected checks

- Queue entries are locally hashed, checked against the Safe's on-chain hash,
  and their owner signatures verified. EIP-712 and Safe's EOA `eth_sign`
  signatures are supported. Future nonces remain visible but cannot be signed
  or executed in Vault before the current nonce advances.
- Owner/threshold changes are saved as observed configuration while retaining
  the previous reviewed owners. Funding, signing, sharing, and execution stay
  blocked until **Review changed owners** is explicitly confirmed. A removed
  connected owner loses the wallet's Safe listing after refresh.
- Unsupported calls, batches, contract-owner signatures, on-chain hash approvals,
  and malformed entries appear as queue issues for review in Safe. They are not
  counted as verified approvals. API failures preserve local proposals and show
  **Safe queue unavailable**. JSON proposal exchange remains available.
- Nested Safe ClearSign requires firmware capability 28 and the applicable
  signed metadata. If Vault displays the limited-description firmware banner,
  record the queue test separately; that is not a successful nested ClearSign
  hardware-display test. The alpha firmware channel is intentionally empty.
- Vault supports pinned SafeL2 1.4.1/1.5.0 on Base, direct ETH and native Base
  USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`) transfers. Base's extra
  L1 data fee is excluded from the displayed execution gas ceiling.

## Local verification

From `projects/keepkey-vault`:

```sh
bun test src/bun/safe-multisig.test.ts src/bun/safe-transaction-service.test.ts __tests__/safe-web-practice.test.ts
bun scripts/check-base-safe.ts <Base-Safe-address>
```

The preflight script uses only public read RPC methods and Safe's pending-queue
GET endpoint. Set `BASE_SAFE_RPC_URL` to select its RPC. An optional backend-only
`SAFE_TRANSACTION_SERVICE_API_KEY` authenticates Transaction Service requests.
The script never signs, shares proposals, or broadcasts.

The 2026-11-17 live preflight of the previously saved Safe
`0x6717d97655d8fC9d05C2DD3F28b54f574309B473` found SafeL2 1.5.0, threshold 2 of
5, nonce 3, and zero remote pending proposals. Its saved four-owner snapshot
still requires review. This read-only observation does not deploy a practice
Safe or prove the hardware signing display.

A read-only auto-load check using owner
`0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E` restored that directory record despite
its older per-wallet record being stored under another wallet. Live discovery
verified 2 of 5 owners, retained the reviewed 4-owner baseline, and marked it for
review. Test changes stayed in memory; no signing or broadcast was requested.
