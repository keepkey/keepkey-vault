# Vault wire-up: pioneer per-tx clear-sign `/descriptors/sign` is LIVE (Handoff, 2026-07-03)

**For:** the vault worker (keepkey-vault `src/bun/`).
**From:** pioneer side (`feat/clearsign-live-signer`). The live per-tx signer is built, tested, and
**confirmed working on `localhost:9001`**. This doc is the exact vault-side change to consume it.

> One-line: pioneer `/descriptors/sign` no longer returns a stub — it returns a real per-tx signed
> metadata blob bound to the exact sighash. The vault must now send it the **FULL unsigned tx**
> (not just `{chainId, contractAddress, data}`), because rc3 firmware fail-closes on tx_hash binding.

---

## 0. Status (verified locally, device-free)

- pioneer-server `1.3.137` on `http://localhost:9001`, started with `CLEARSIGN_LIVE_SIGN=true` +
  `INSIGHT_MNEMONIC` (test signer; prod will sign on a KeepKey/HSM, key_id=0).
- Endpoints live: `POST /api/v1/descriptors/decode`, `POST /api/v1/descriptors/sign` (both in
  `/spec/swagger.json` now, so the pioneer-client SDK `SignDescriptor` will regenerate).
- Confirmed: a curated **Cian `deposit`** tx → `classification: VERIFIED` + a valid blob whose
  signature verifies against the **production key_id=0 pubkey `0218621d9c…`** (== firmware
  `METADATA_PUBKEYS[0]`) and whose embedded `tx_hash` == the tx's ethers `unsignedHash`. An uncurated
  contract, or an incomplete-ABI/trailing-bytes decode, → `classification: UNKNOWN` (OPAQUE).

## 1. The breaking change — `/sign` needs the full unsigned tx

The blob's `tx_hash` must equal `keccak(the exact unsigned tx the device signs)`. That hash consumes
`nonce/gas/value/data/chainId`, so the 3-field request can never produce an acceptable blob.

**New request body** (`POST /api/v1/descriptors/sign`):
```jsonc
{
  "chainId": 1,                       // the SAME chainId the device signs (see §3)
  "contractAddress": "0x…",           // = tx `to`
  "data": "0x…",                      // calldata
  "nonce": 5,                         // number or "0x.." hex string
  "gasLimit": 200000,                 // number or hex string
  "value": 0,                         // usually 0 for contract calls; number or hex
  // legacy:
  "gasPrice": "20000000000",
  // OR eip-1559 (send these instead of gasPrice):
  "maxFeePerGas": "…", "maxPriorityFeePerGas": "…"
}
```
`nonce` + `gasLimit` are **required** (400 without them). Legacy vs 1559 is auto-detected: if either
1559 fee field is present it's typed as a 1559 tx, else legacy (EIP-155).

**Response** (unchanged shape + a new `txHash`):
```jsonc
{
  "success": true,
  "signedPayload": "base64…",         // canonical binary payload + 65-byte sig — attach as txMetadata
  "keyId": 0,
  "classification": "VERIFIED" | "UNKNOWN",
  "method": "deposit", "dappName": "Cian", "contractName": "…",
  "txHash": "0x…"                     // the sighash the blob is bound to (== device's sighash)
}
```

## 2. Vault edits (`projects/keepkey-vault/src/bun/`)

**`calldata-decoder.ts`:**
- `fetchPioneerSignedBlob(chainId, contractAddress, data)` (**:453**) — widen the signature to take the
  full unsigned tx and put those fields in BOTH request paths:
  - SDK call (**:466**): `pioneer.SignDescriptor({ chainId, contractAddress, data, nonce, gasLimit, value, gasPrice? , maxFeePerGas?, maxPriorityFeePerGas? })`
  - direct fetch body (**:478**): same object in `JSON.stringify({...})`.
- Caller (**:508-509**) — thread the real `nonce / gasLimit / value / gasPrice | (maxFeePerGas + maxPriorityFeePerGas)`
  into `fetchPioneerSignedBlob`. Source them from wherever the unsigned tx is assembled for
  `ethSignTx` — they MUST be the identical values the device will sign (§3).
- `PioneerSignResponse` (**:409-411**) — already has `signedPayload` + `classification`; optionally add
  `txHash?: string` for logging/verification.
- Blob attach (**:528 / :542**) — keep attaching `signedBlob.signedPayload` as `signedInsightBlob`,
  BUT gate on classification (§4).

**`rest-api.ts`:** the blob still forwards to `ethSignTx` as `txMetadata` (~:2076). Note the existing
chainId `0→1` normalization (~:2039) — see §3.

## 3. CRITICAL: the tx sent to pioneer must match the tx sent to the device, byte-for-byte

The sighash is over `nonce, gasPrice|fees, gasLimit, to, value, data, chainId`. If ANY field differs
between what the vault sends pioneer and what it signs on the device, `tx_hash` won't match and rc3
**refuses the blob** (→ device blind-signs or blocks). Specifically:
- Send pioneer the **same `chainId` the device signs**. The vault already normalizes `0→1`
  (`rest-api.ts:2039`); pioneer independently normalizes `0→1` too, so sending `0` or `1` both hash as
  `1` — but send whatever the device actually uses, and be consistent.
- Same `nonce`, `gasLimit`, `value`, and legacy-vs-1559 fee fields.
- Fetch the blob AFTER these fields are finalized (post gas-estimation), not before.

## 4. Classification handling (don't silently blind-sign)

- `VERIFIED` → attach `signedPayload` as `txMetadata`; device renders the decoded who/what/why behind
  the rc3 "CLEARSIGN WARNING — Signer '<alias>' describes this tx. NOT verified by KeepKey" screen.
- `UNKNOWN` (OPAQUE) → the blob binds the sighash but is OPAQUE, so rc3 **fail-closes** (blocks contract
  data unless AdvancedMode). Attaching it does not enable clear-sign. Decide the UX: either don't
  attach (let the existing raw-hex/AdvancedMode path handle it) or surface an explicit
  "unverified — this contract/call isn't in the clear-sign catalog" state. **Do not** present OPAQUE as
  verified, and don't silently fall through to blind-sign without telling the user.

## 5. Pointing the vault at pioneer

- Local test: point `getPioneerApiBase()` (or the SDK base) at `http://localhost:9001`. The local
  server is already running with signing enabled.
- Prod: the signer is **dark** until deployed with `CLEARSIGN_LIVE_SIGN=true` and an operator signer
  (KeepKey/HSM, key_id=0) — see `handoff-clearsign-live-signer-build.md` §8. Until then prod `/sign`
  returns `{success:false}` and the vault degrades (no blob).

## 6. Firmware requirement (blocks the device test if wrong)

The device under test MUST run a **`release/7.15.0-rc3`** build (firmware commit `7f635a36` lineage:
`ARG_FORMAT_STRING=4`, `ARG_FORMAT_TOKEN_AMOUNT=5`, `METADATA_MAX_ARG_VALUE_LEN=44`). **Older firmware
(formats 0-3, cap 32) REFUSES any blob carrying a STRING arg** — clear-signing would silently fail on
exactly the calls pioneer marks VERIFIED with a string/label arg (e.g. a THORChain deposit memo).

## 7. Test recipe (device)

1. `make vault` (rebuilds + restarts the vault on :1646 — you at the device).
2. Point the vault's pioneer base at `localhost:9001`.
3. Flash a `release/7.15.0-rc3` DEBUG_LINK build on a **throwaway** device.
4. Drive a **curated-contract** tx (VERIFIED path): e.g. a Cian `deposit`, or an `approve`/`transfer`
   on a token in `evm-descriptors`. Confirm the OLED shows the decoded method + typed args (no raw
   hex) + the CLEARSIGN WARNING, sign, and verify the recovered signer == the device address
   (matches `test_msg_ethereum_clear_signing.py:_clearsign_flow`).
5. Drive an **uncurated** contract → confirm classification UNKNOWN → device blocks (fail-closed), not
   blind-sign.

## 8. Confirmed-working request (copy for parity)

```bash
# curated Cian deposit → VERIFIED (values are illustrative; use the REAL unsigned tx)
curl -s -X POST http://localhost:9001/api/v1/descriptors/sign -H 'Content-Type: application/json' -d '{
  "chainId":1,"contractAddress":"<curated contract>","data":"0x<selector+args>",
  "nonce":5,"gasLimit":200000,"value":0,"gasPrice":"20000000000"
}'
# → {"success":true,"signedPayload":"…","keyId":0,"classification":"VERIFIED","method":"deposit","dappName":"Cian","txHash":"0x…"}
```

## Notes / open items
- The read-only **ClearSign Explorer** controller (`/clearsign/*`) is DEFERRED on the pioneer side (it
  needs separate discovery-export wiring); only `/descriptors/decode` + `/sign` are live.
- OPAQUE arises for: uncurated contract, incomplete catalog ABI (fails the round-trip integrity check),
  a non-address/uint/string arg, or an oversized value. Improving VERIFIED coverage = adding/completing
  entries in `pioneer-discovery` `evm-descriptors.json` + `universal-selectors.json`.
- Nothing is released; pioneer changes live on `feat/clearsign-live-signer` (not merged).
