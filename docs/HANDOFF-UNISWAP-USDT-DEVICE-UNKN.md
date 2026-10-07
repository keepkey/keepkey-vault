# Handoff: Finish Uniswap Arbitrum USDT ClearSign on KeepKey

Date: 2026-09-20

## Completed live flow — 2026-09-21

The live Uniswap flow now advances through the certified Arbitrum USDT approval,
the structured Permit2 signature, and the final Universal Router transaction
without requesting blind signing or Advanced Mode. Vault identifies the official
Uniswap Universal Router, Permit2, Arbitrum USDT, and their full addresses.

Two observed router shapes are supported with transaction-bound descriptions:

- Permit2 permit -> Uniswap v4 exact-input -> settle/take/sweep.
- Permit2 permit -> Uniswap v3 exact-input over USDT/USDC/WETH -> unwrap WETH.

Both matchers fail closed on the chain, router, command program, token path,
fees, payer, recipient, allowance, minimum output, deadline, and calldata framing.
The description signature commits to the complete EVM signing hash, including
nonce, fees, value, calldata, and attribution footer. The second live capture
was accepted by production worker version
`f67c8930-183e-4fd8-a237-60773d3a6518` and returned `VERIFIED` with transaction
hash `0xe357a726ada980384c6e5ea16acb67bd485e7aeb90698e21fd72b4576ec75b63`.

The operator confirmed the rebuilt emulator flow is working. The original
`UNKN` defect and the later blind-sign gates are resolved for these reviewed
routes.

## Emulator device proof completed — 2026-09-21

The rebuilt Vault now completes the exact Arbitrum USDT Permit2 approval through
firmware 7.16.0 using the live certified service. The device returned metadata
status `VERIFIED`, identified the signer as `KeepKey Alpha 716 (A9531B9D)`, and
produced a deterministic signature with device-signed hash
`0xb87d9a51efb9e5af7575ab7c669b7088e718cbd135fd4026ba592aee955d7c5d`.

Pixel captures from six consecutive firmware prompts are stored under
`clearsign-case-studies/uniswap-usdt/device-evidence/`:

1. `01-certified.png`: `VERIFIED BY KEEPKEY` and the alpha signer identity.
2. `02-token.png`: `INSIGHT VERIFIED` and `Arbitrum USDT approval`.
3. `03-spender.png`: token contract
   `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`.
4. `04-amount.png`: canonical Permit2 spender
   `0x000000000022D473030F116dDEE9F6B43aC78Ba3`.
5. `05-fee.png`: `Allowance: UNLIMITED USDT`.
6. `06-final.png`: final transaction and gas review.

The replay used an authenticated, environment-gated emulator decision endpoint.
The visible emulator UI is ignored while that test control is enabled, preventing
stale mouse input from approving multiple prompts. The signed transaction was not
broadcast. This resolves the original `UNKN` device-display defect and proves the
identity-plus-address layout. A fresh request originating in the live Uniswap tab
is the remaining end-to-end application proof.

## Live Uniswap Across route added — 2026-09-21

The next live Uniswap request was Across `depositV3` (`0x7b939232`) to the
official legacy Arbitrum SpokePool
`0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A`, bridging native Arbitrum WETH
to Ethereum WETH. The unknown shape entered the production demand queue as
request `13b61aa4a3d5b538bc316102fd611f3e9d092a1080425efa0e33661a29cdd953`.
It exposed and fixed an audit-queue limit that rejected valid verified ABIs with
more than eight parameters.

A firmware-owned Across decoder now pins the SpokePool, selector, source and
destination WETH contracts, Ethereum destination chain, native-value/input
equality, empty message, calldata bounds, recipient, minimum output, relayer,
and deadlines. Worker version `6d3b5415-2de2-4b87-8f03-350ab8961162` serves
the certified decoder; wrong chain, contract, selector, and length fail closed.

The exact captured transaction completed an emulator signing replay with
metadata status `VERIFIED`. Its review screens are stored under
`device-evidence/across/`; they show the full contract and participant addresses,
input `0.007912145012760989 ETH`, minimum `0.007600713759106208 WETH`, Ethereum
destination chain `1`, native transfer, and gas. The signature was not broadcast.
A fresh Uniswap quote is required because Across deadlines are embedded in the
calldata.

## Root ceremony completed — 2026-09-21

The connected physical KeepKey matched the existing root. It signed an Arbitrum
certificate and then eleven additional EVM certificates, all cryptographically
verified and saved under `clearsign-case-studies/uniswap-usdt/evm-certificates/`
(Arbitrum is `arbitrum-certificate.json` in the parent directory). A USB stall on
Berachain was recovered by reconnecting and resuming only unfinished certificates.
No private key was retrieved or exported.

The live signer now reports certificates for all 13 selected chains:
Ethereum (1), Optimism (10), BNB Smart Chain (56), Gnosis (100), Unichain (130),
Polygon (137), Mantle (5000), Base (8453), Arbitrum One (42161), Arbitrum Nova
(42170), Avalanche (43114), Berachain (80094), and Blast (81457).
The existing mainnet certificate remains in its dedicated binding. The other 12
are deployed as `CLEARSIGN_EVM_CERTIFICATES_JSON`. New certificates expire at
2026-12-31T00:00:00Z. Source deployment `530346ea-5a3b-41a9-87ee-ee7a2fd9b74f`
adds the reviewed scope allowlist and a working Arbitrum dRPC fallback; subsequent
secret deployment installs the certificates without changing source.

Live checks passed for Ethereum USDC approval, Arbitrum USDC transfer and
transferFrom, exact certificate chain binding, root/delegate signatures, Vault
resolution, malformed/denied calls, and the existing Arbitrum USDT approval.
Catalog reports all 7,192 eligible discovery tokens now have a chain certificate;
each dynamic request still requires successful on-chain identity verification.
This is not the entire Pioneer asset list or universal swap support.
Focused Vault tests: 56 pass. Scope/certificate tests: 27 pass. Worker route and
discovery tests: 21 pass. Packaged Vault build passes.

**The root certificate blocker is resolved. Live device review and a completed
Uniswap swap remain unproven.** Host identity/full-address changes are built;
firmware still needs live inspection of every review screen and spender identity.

## Certificate scope correction — historical blocker, 2026-09-21

**This section supersedes the deployment claims below. The swap is unfinished.**
The captured certificate authorizes chain ID `1`, not all Ethereum-compatible
chains. Firmware can report metadata signature verification but still correctly
refuse to suppress generic review for Arbitrum (`42161`). The screenshot showing
`UNKN` is evidence that the prior deployment did not complete device recognition.
The saved `certified-response.json` is a wrong-scope regression fixture, not a
valid Arbitrum artifact.

The production signer now requires an exact-chain certificate (deployment
`1ac82ffd-0a8e-4971-8572-5dfdaca47316`). Its on-demand discovery inventory has
7,192 eligible tokens, but eligibility does not mean every chain has signing
authorization. Arbitrum needs an existing-root-signed delegate certificate.
The public request is `clearsign-case-studies/uniswap-usdt/arbitrum-certificate-request.json`.

The operator offered to connect a KeepKey. First inspect its public identity using
`projects/keepkey-vault/scripts/clearsign-root-ceremony.ts` without `--sign`.
Only the original root at `m/44'/60'/0'/0/0`, public address
`0x4f55376c50edc6DE9E5f96A67556FbEeA8339f7a`, can issue this certificate.
A regular wallet device cannot substitute for it. The latest inspection did not
find exactly one physical KeepKey; no signing or device policy change occurred.
Never reset a device or replace the firmware root to bypass this check.

Host identity/full-address rendering changes are implemented but still require
a fresh packaged build and live review. Device identity, Permit2, and final swap
evidence remain required after provisioning the correct certificate.

## Live deployment update — 2026-09-21 UTC

The signing-key blocker below was based on the wrong source tree. The operator
confirmed use of the existing deployed ClearSigner. Cloudflare already holds its
alpha delegate and Ethereum certificate; no private key was retrieved or exported.
The live service is an online certified signer, not the keyless worker currently
in this checkout. **Do not deploy this checkout's keyless worker over production.**

Production was updated from its exact deployed source commit `6a6985133`, adding
only the reviewed Arbitrum USDT schema and its tests. All six existing catalog
entries were retained. Deployment version:
`d92f0031-a12f-4eeb-95dd-0ab52f38de3c`.
Source label: `6a6985133+arbitrum-usdt-approval`.
Reproducible patch: `clearsign-case-studies/uniswap-usdt/production-signer.patch`.

The live approval request now returns `VERIFIED`, key ID `128`, fingerprint
`a9531b9d`, and a v3 certified envelope. The public response is saved in
`clearsign-case-studies/uniswap-usdt/certified-response.json`. Its root certificate,
Ethereum scope, delegate signature, and exact schema were independently verified
using the keyless worker's artifact validator.
Production checks also confirmed all six prior catalog IDs remain, both scopes
report ready, and four negative chain/contract/selector/length bindings return
HTTP 422. Solana RPC readiness briefly fluctuated before recovering; the deployed
Solana code and provider configuration were preserved.

Vault now propagates certified schema failures through central signing, REST, and
WalletConnect instead of silently continuing without authentication. Reviewed
catalog misses produce an explicit provisioning error. Verification: 126 focused
Vault tests pass; 34 production worker tests pass; exact firmware approval test
passes; packaged Vault build passes outside the macOS sandbox. The optional live
REST gating suite was attempted before Vault was reachable and could not run.

Rebuilt Vault was launched with `CLEARSIGN_RUNTIME_URL` and
`CLEARSIGN_SERVICE_URL` unset. The browser extension reconnected. The operator was
asked to select their emulator wallet and retry the live Uniswap request, leaving
device review open. **Device screenshot, live Permit2 review, and router/swap proof
remain outstanding. This is not yet a completed swap proof.**

The remaining sections describe the original diagnosis and proposed offline
migration; their claimed immediate signing-key blocker is superseded above.

## Outcome still required

For the real Uniswap approval below, the physical/emulated KeepKey must display an
authenticated token identity (`USDT`), not `UNKN`, and Vault must report that the
description is authenticated by KeepKey:

- chain: Arbitrum One (`42161`)
- token contract: `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9`
- call: ERC-20 `approve(address,uint256)` (`0x095ea7b3`)
- spender: canonical Permit2 `0x000000000022d473030f116ddee9f6b43ac78ba3`
- allowance: `uint256.max` (unlimited)
- calldata length: 68 bytes

The user is still seeing `UNKN` on the device. This task is **not complete** until a
fresh request from the live Uniswap app proves `USDT` on the KeepKey screen.

## Why it still says `UNKN`

Firmware's generic ERC-20 parser knows the call is `approve` and decodes the spender
and allowance, but its finite built-in token table does not identify this Arbitrum
USDT deployment. Vault knows the token, but a host label is not sufficient evidence
for the device.

The reusable certified schema has now been implemented, but the deployed ClearSign
worker does not yet contain the alpha-delegate-signed artifact for this schema.
Without that artifact, Vault sends no certified metadata blob and firmware correctly
falls back to the generic `UNKN` approval screen. Do not fix this by trusting the host
label or by using the disposable runtime test key as KeepKey-authenticated metadata.

## Correct trust path

1. The catalog binds chain ID + exact token contract + selector + calldata shape.
2. The schema binds argument 0 as `Spender` and argument 1 as a token amount with
   symbol `USDT` and 6 decimals.
3. The existing KeepKey alpha Ethereum certificate and delegate sign this static
   schema offline (`keyId = 0x80`).
4. The keyless public worker distributes the signed artifact.
5. Firmware validates the root certificate and delegate signature, matches the exact
   transaction, then decodes the spender and allowance from the transaction bytes.

This avoids putting every token in firmware while preventing the server or Vault from
changing `UNKN` into an arbitrary trusted symbol.

## Work already implemented

- Certified schema entry:
  `projects/keepkey-vault/src/bun/evm-certified-schema.ts`
- Exact schema/catalog tests:
  `projects/keepkey-vault/src/bun/evm-certified-schema.test.ts`
- Worker catalog and fail-closed tests:
  `projects/keepkey-vault/clearsign-worker/src/index.test.ts`
- Ethereum-scoped local ceremony signer:
  `projects/keepkey-vault/scripts/clearsign-live-signer.ts`
- Exact firmware-boundary regression:
  `modules/keepkey-firmware/unittests/firmware/signed_metadata.cpp`
  test `V2SchemaDecodesArbitrumUsdtPermit2Approval`
- Host chain/fee corrections:
  `SigningApproval.tsx` names Arbitrum One;
  `evmFeePreview.ts` uses ETH for Arbitrum fees.
- Identity-first Uniswap decoding prevents ERC-20 `approve` from being misclassified
  as a V3 position-NFT approval.
- Runtime metadata now refuses configured-provider `OPAQUE` responses rather than
  silently degrading.

Verification completed:

- exact firmware test: pass
- focused Vault/worker/Uniswap suite: 124 pass, 0 fail
- production Vault build: pass
- rebuilt Vault was relaunched with the disposable runtime provider at
  `http://127.0.0.1:18447`; this provider is development evidence only.

## Exact remaining steps

### 1. Produce the certified artifact with approved key custody

Use the existing alpha delegate key through its approved file/HSM/Studio path. Never
paste or commit the private key. The signer validates that the key matches reviewed
delegate fingerprint `a9531b9d`.

Start the signer with:

```sh
CLEARSIGN_SIGNER_KEY_FILE=/approved/path/delegate.json \
CLEARSIGN_ETHEREUM_CERTIFICATE_FILE=/approved/path/ethereum-certificate.json \
CLEARSIGN_SIGNER_PORT=1647 \
bun scripts/clearsign-live-signer.ts
```

Then request only the privacy-preserving transaction shape:

```sh
curl -sS http://127.0.0.1:1647/v1/evm/schema \
  -H 'content-type: application/json' \
  --data '{"chainId":42161,"contract":"0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9","selector":"0x095ea7b3","calldataLength":68}'
```

Required response properties:

- `classification: VERIFIED`
- `keyId: 128`
- exact chain/contract/selector/length echoed
- fingerprint `a9531b9d`
- `signedPayload` starts with certified envelope version `0x03`

If the approved key is only available through ClearSign Studio/HSM, adapt that
transport; do not export it merely to satisfy the example command.

### 2. Add the artifact to the worker manifest and deploy

The worker is deliberately keyless. Merge the new envelope into the existing
`CLEARSIGN_ARTIFACTS_JSON` secret under this exact EVM artifact ID:

```text
42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9:0x095ea7b3
```

Preserve all existing artifacts and revocations. Deploy the worker using the existing
Cloudflare procedure. Do not replace the full secret with only this entry.

### 3. Verify production service before touching Uniswap

Check:

```sh
curl -sS https://keepkey-clearsign.bithighlander.workers.dev/v1/status
curl -sS https://keepkey-clearsign.bithighlander.workers.dev/v1/catalog
curl -sS https://keepkey-clearsign.bithighlander.workers.dev/v1/evm/schema \
  -H 'content-type: application/json' \
  --data '{"chainId":42161,"contract":"0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9","selector":"0x095ea7b3","calldataLength":68}'
```

The final request must return HTTP 200 and a certified `VERIFIED` envelope. A 503
means the artifact is still not provisioned. A 422 means the deployed catalog does
not contain the new code.

### 4. Relaunch the rebuilt Vault without relying on the disposable provider

Use the current build at:

```text
projects/keepkey-vault/_build/dev-macos-arm64/keepkey-vault-dev.app
```

For the production proof, unset `CLEARSIGN_RUNTIME_URL` so success cannot be credited
to the RAM-loaded disposable signer. Confirm Vault uses the default certified service.

### 5. Replay the real Uniswap flow

Reconnect KeepKey, refresh Uniswap, and initiate the same Arbitrum USDT swap. At the
approval step verify all of the following before confirming anything:

- Vault: `KeepKey ClearSign ready`
- Vault: authenticated/certified source, not merely locally decoded
- Vault: `Arbitrum One`, `USDT`, canonical Permit2, unlimited, fee in ETH
- device: token is `USDT`, not `UNKN`
- device: spender is canonical Permit2
- device: allowance is unlimited
- no raw calldata/hex-only fallback

Capture the Vault report, full non-secret request payload, device screenshot, backend
metadata-resolution log, worker response status, firmware version, and app commit.
Reject/cancel the transaction if any identity differs. The proof does not require
broadcasting a transaction.

### 6. Run final gates

```sh
cd projects/keepkey-vault
bun test __tests__/uniswap-*.test.ts __tests__/permit2-calldata.test.ts \
  __tests__/eip712-permit2.test.ts __tests__/clearsign-risk.test.ts \
  src/bun/evm-runtime-metadata.test.ts src/bun/evm-certified-schema.test.ts \
  src/bun/evm-certified-registry.test.ts src/bun/evm-schema-registry.test.ts \
  clearsign-worker/src/index.test.ts src/shared/evmFeePreview.test.ts
bun run build

cd ../../modules/keepkey-firmware
make -C build-qa firmware-unit -j4
./build-qa/bin/firmware-unit \
  --gtest_filter='SignedMetadataTest.V2SchemaDecodesArbitrumUsdtPermit2Approval'
```

## Do not call it finished when

- only Vault says USDT while the device says `UNKN`;
- a disposable/runtime signer produced the label;
- the worker catalog contains the entry but returns 503 for its artifact;
- a synthetic fixture passes but the live Uniswap request was not replayed;
- the device authenticates `approve` but not the token identity;
- the swap itself remains opaque after the approval. Approval coverage is only the
  setup leg; the subsequent Permit2 signature and router execution require their own
  authenticated reports and live evidence.

## Live production revalidation — 2026-09-21

The approved delegate path and Arbitrum certificate are now deployed. A production
request using the exact privacy-safe shape below returns HTTP 200:

```json
{
  "chainId": 42161,
  "contract": "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
  "selector": "0x095ea7b3",
  "calldataLength": 68
}
```

The response is `classification: VERIFIED`, method `Arbitrum USDT approval`,
key ID `128`, delegate fingerprint `a9531b9d`, and a 292-byte certified payload.
This proves the live service recognizes and certifies the captured approval shape.

## Current state

There is no remaining blocker for the reviewed Arbitrum USDT-to-native Uniswap
flow. New router programs, paths, commands, hooks, or contract deployments remain
unsupported until their semantics and invariants are reviewed and promoted.
