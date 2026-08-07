# keepkey-sdk EVM Clear-Signing Coverage — Automated Device Testing (Handoff, 2026-07-02)

**Picks up from** `handoff-clearsign-pdf-and-device-testing.md` (production blocker #2). rc3 is
built and running on device (`firmware-v7.15.0`, fork `release/7.15.0-rc3`). The python-keepkey
suite already drives all **51** clear-sign flows on hardware — this handoff is about giving the
**keepkey-sdk / Vault REST path** (the path real apps use) the same coverage, starting with a
first tranche of ~23 flows.

> One-line goal: grow `keepkey-sdk/tests/evm-clearsign` from its current 7 decoder cases to
> ≥23 catalog flows, driven through `/eth/sign-transaction` on a **runtime-loaded** signer —
> conformance-checked against python-keepkey's frozen reference vectors.

---

## 0. TL;DR — this is a "build the train, then port flows" job, not "add test files"

The SDK's current clear-sign fixtures **cannot pass on rc3** and there is no JS path to load a
signer. Two things must be built before flow #1 goes green:

1. **A runtime `LoadClearsignSigner` train** (proto → hdwallet-keepkey → Vault REST → SDK). The
   device owns the USB transport while the Vault is up, so the signer **must** be loadable
   through the Vault — a REST route is mandatory, not optional.
2. **Per-tx metadata signing in JS** (real `tx_hash`, real `STRING`/`TOKEN_AMOUNT` values,
   signed by the loaded **test** key — not the old built-in firmware key).

Only then does "port the catalog flows" become mechanical.

---

## 1. Why the current SDK clear-sign tests fail on rc3 (the crux)

| | SDK today | rc3 firmware requires |
|---|---|---|
| Signer key | firmware **built-in** key `0218621d…` (DEBUG_LINK slot) | `METADATA_PUBKEYS` **all-zero** → no built-in key; must `LoadClearsignSigner` at runtime |
| tx_hash in blob | `ZERO_HASH` (`generate-evm-fixtures.js:makeBlob`) | real sighash; `signed_metadata_enforce` is **fail-closed** at `send_signature` (metadata.tx_hash must equal the tx's computed sighash) |
| classification | hardcoded `CLASSIFICATION_VERIFIED` | derived from a **trusted loaded signer**; a zero-hash/blanket-VERIFIED blob is `MALFORMED`/refused |
| arg values | mostly RAW/empty | `ADDRESS` / `STRING` / `TOKEN_AMOUNT` (hex-free); RAW renders hex (honest fallback, banned from the catalog) |

Evidence: `keepkey-sdk/tests/fixtures/generate-evm-fixtures.js:49` (`makeBlob` → `txHash: ZERO_HASH,
classification: CLASSIFICATION_VERIFIED`, `keyId: 0`, requires firmware pubkey `0218621d…`). Only
1 of 7 generated blobs is even attached today (`tests/evm-clearsign/uniswap-v2-eth-to-token.js:59`);
the other 6 are dead. On rc3 all of these are rejected.

`LoadClearsignSigner` presence check (2026-07-02): **zero** hits for `LoadClearsignSigner` /
`loadClearsignSigner` across `keepkey-sdk`, `modules/hdwallet`, and Vault `src/bun`. The JS train
does not exist yet.

---

## 2. The train to build (do these in order)

### 2a. device-protocol — DONE
`LoadClearsignSigner` (msg **117**) + `ARG_FORMAT_STRING`(4)/`ARG_FORMAT_TOKEN_AMOUNT`(5) already
shipped (`2ec999a`, now on PR #111 `up/release-protocol`). Regenerate the **JS** proto bindings
consumed by hdwallet-keepkey from this.

### 2b. hdwallet-keepkey (`modules/hdwallet`) — ADD
- A `loadClearsignSigner({ pubkey /*33-byte compressed*/, alias /*[A-Za-z0-9 _-]*/ , slot })`
  method that sends msg 117 and awaits the on-device confirm (alias + sha256[:4] fingerprint).
- Confirm `ethSignTx` already forwards an `EthereumTxMetadata` step before signing (the Vault
  uses this for `/eth/sign-transaction`); if the metadata message isn't exposed, add it.

### 2c. Vault (`src/bun`, REST) — ADD
- **New route** `POST /eth/clearsign/load-signer` `{ pubkey, alias, slot }` → hdwallet
  `loadClearsignSigner`. RAM-only on device; the route just proxies + returns the fingerprint.
  (Add to `openapi/swagger.json` so the SDK client generates a typed method.)
- `POST /eth/sign-transaction`: today `txMetadata` is an **untyped pass-through** (not in the
  `EthSignTxParams` type or swagger — `keepkey-sdk/src/types.ts:81`, `openapi/swagger.json`).
  Verify it forwards the signed payload via `ethereum_send_tx_metadata` **before** signing and
  that the firmware computes the sighash over the exact tx being signed (chainId normalization
  `0→1` still applies — see the eip1559-chainId skip note in §6). Type the `txMetadata` field
  `{ signedPayload: hex, keyId: number }` while you're here.

### 2d. keepkey-sdk — ADD
- `sdk.eth.loadClearsignSigner(...)` (POST the new route) — mirrors `ethSignTransaction`
  (`src/index.ts:330`).
- **Rework blob signing** in `tests/fixtures/generate-evm-fixtures.js` (or a new
  `tests/_clearsign.js` helper): per-tx `tx_hash` = keccak of the tx RLP pre-image (must match
  what the firmware computes for the SAME tx), sign with a **test** private key (see §3), embed
  real `args[]` (ADDRESS/STRING/TOKEN_AMOUNT). The pioneer-insight primitives it already imports
  (`serializeMetadata` / `signPayload`, `generate-evm-fixtures.js:17`) do the serialization — you
  are changing *what* gets signed (real hash + test key), not the crypto.

---

## 3. The reference contract — don't reinvent, mirror python

`keepkey-firmware/deps/python-keepkey @ 1545299` is the single source of truth.

- **Catalog:** `keepkeylib/clearsign_catalog.py` — `CLEARSIGN_FLOWS` (51 flows). Each flow is
  pure data: `{ key, protocol, category, method, signature, to, value, data (selector+ABI),
  args[] (display_args w/ ARG_FORMAT_*), why, source, chain_id }`. Deterministic: chain 1, nonce
  0, gasPrice 20 gwei, gasLimit 250000, `REFERENCE_TIMESTAMP=1700000000`, RFC-6979 → byte-repro.
- **Wire dump (the external contract):**
  `python3 tests/test_msg_ethereum_clear_signing.py --flows` → per-flow `to / value / calldata /
  tx_hash / blob` hex. Generate this once and treat it as golden input for the JS tests.
- **Conformance target:** `REFERENCE_BLOB_SNAPSHOTS` (`key → (sha256_hex, byte_len)`). The JS
  blob generator, given the same flow + test key + timestamp, must reproduce these sha256+len.
  This is the cheapest offline gate that the JS metadata serializer matches python **before** any
  device is involved — build it first.
- **Test key:** python loads `TEST_PRIVATE_KEY` (SignIdentity idx 0 of the BIP-39 mnemonic12 test
  seed) into slot **3**, alias `'CI Test'`, via `LoadClearsignSigner`. The blob `key_id` = 3.
  Mirror this exactly in JS so snapshots match — same key, same slot, same alias, same timestamp.
- **On-device driver to copy:** `_clearsign_flow` (`test_msg_ethereum_clear_signing.py:891`):
  `AdvancedMode=0` → `ethereum_send_tx_metadata(blob, key_id=3)` → assert `VERIFIED` →
  `ethereum_sign_tx(...)` → `recover_eth_signer(...) == device address`. The SDK equivalent:
  load signer once (beforeAll) → per flow POST `/eth/sign-transaction` with `txMetadata` → assert
  a signature returns (optionally recover signer == `ethGetAddress`).

---

## 4. Phase 1 — the first 23 flows

There is **no built-in "23" subset** (the catalog is a flat 51 across 11 categories). Define the
first tranche as **static-ABI, single-signer, high-frequency** flows — these need no dynamic ABI
encoding in JS and exercise all three display formats (ADDRESS / STRING / TOKEN_AMOUNT):

| # | catalog key | why in tranche 1 |
|---|---|---|
| 1 | `erc20-transfer` | already in SDK; re-point to catalog blob |
| 2 | `erc20-approve` | already in SDK |
| 3 | `erc20-approve-unlimited` | already in SDK; UNLIMITED render |
| 4 | `erc20-transferfrom` | core |
| 5 | `weth-deposit` | WETH wrap |
| 6 | `weth-withdraw` | WETH unwrap |
| 7 | `erc20-usdc-increase-allowance` | approvals |
| 8 | `erc20-usdc-decrease-allowance` | approvals |
| 9 | `usdt-approve` | non-standard USDT |
| 10 | `aave-v3-supply` | flagship: STRING+TOKEN_AMOUNT+ADDRESS |
| 11 | `aave-v3-pool-borrow` | lending |
| 12 | `aave-v3-pool-repay` | lending |
| 13 | `aave-v3-pool-withdraw` | lending |
| 14 | `compound-v3-comet-supply` | lending |
| 15 | `compound-v3-comet-withdraw` | lending |
| 16 | `spark-protocol-supply` | lending |
| 17 | `lido-steth-submit` | staking |
| 18 | `rocketpool-deposit-pool-deposit` | staking |
| 19 | `etherfi-liquiditypool-deposit` | staking |
| 20 | `eigenlayer-strategymanager-deposit` | restaking |
| 21 | `compound-governor-bravo-castvote` | governance |
| 22 | `ens-public-resolver-setaddr` | governance |
| 23 | `uniswap-v3-exact-input` | already in SDK (single static tuple) |

**Deferred to phase 2** (need dynamic ABI / `flow_raw`, or signature-typed payloads): the 8
`flow_raw` flows (uniswap-v2 swaps, uniswap-v3-multicall, uniswap-v4 universal router,
erc1155 batch transfer, safe execTransaction, erc4337 handleOps, eip7702 authorization,
curve-3pool), plus the permits (eip2612, dai, permit2 approve + permitTransferFrom) and the
ERC-4626 vault set (metamorpho/yearn) and NFT/bridge flows. That's the remaining 28 → the full 51.

---

## 5. Test structure (one signer load, N flow files)

```js
// tests/evm-clearsign/_setup: load the CI signer once (device confirms alias + fp)
const fp = await sdk.eth.loadClearsignSigner({ pubkey: CI_TEST_PUBKEY, alias: 'CI Test', slot: 3 })
// >>> CONFIRM on device: "Trust signer 'CI Test' (<fp>)... NOT verified by KeepKey" <<<

// per flow file (auto-discovered by tests/run-all.js):
run('aave-v3-supply — clearsign', async (getSdk, assert) => {
  const sdk = await getSdk()
  const flow = FLOWS['aave-v3-supply']            // from the --flows dump / ported catalog
  const tx = { addressNList: ETH_PATH, to: flow.to, value: flow.value, data: flow.data,
               nonce: '0x0', gasLimit: toHex(250000), gasPrice: toHex(20e9), chainId: 1 }
  const blob = signFlowMetadata(flow, tx, CI_TEST_PRIVKEY)   // real tx_hash + test key
  const res = await sdk.eth.ethSignTransaction({ ...tx, txMetadata: { signedPayload: blob, keyId: 3 } })
  assert('signed', !!(res.serializedTx || res.r))
})
```

Add cases as one file per flow under `tests/evm-clearsign/` — `run-all.js` discovers them, no
registration. The existing 7 overlapping cases get re-pointed at catalog blobs (delete the
`ZERO_HASH` fixtures).

---

## 6. Runbook — running it on the device we have up

- **Device:** rc3 (`firmware-v7.15.0`) flashed, Vault running on **1646**. The clear-sign suite
  only **signs** (no broadcast) and does **not** wipe — but it needs `AdvancedMode OFF` and the
  loaded signer. (Note: the *python* suite DOES wipe + load the mnemonic12 test seed; the SDK
  suite does not, so it can run against the current device state.)
- **Env:** `KEEPKEY_API_KEY=<key>` (required), `KEEPKEY_URL` (default `http://localhost:1646`),
  plus the test-signer key material (mirror python's `INSIGHT_MNEMONIC` / test seed idx 0).
- **Run:** `cd projects/keepkey-sdk && npm run build && node tests/run-all.js evm-clearsign`
  (substring filter). Single flow: `KEEPKEY_API_KEY=… node tests/evm-clearsign/aave-v3-supply.js`.
- **`make` gap:** there is **no** `make sdk-clearsign-test` target — the `make sdk-test-…`
  comments in the test headers are stale/aspirational. Per repo convention, add a real target
  (wrapping the `node tests/run-all.js evm-clearsign` invocation) rather than documenting a raw
  `node` call.
- **Offline gate first:** wire the `REFERENCE_BLOB_SNAPSHOTS` sha256+len check as a no-device
  JS test — it catches serializer drift without burning device time or on-device confirms.

### Gotchas
- **tx_hash binding is fail-closed.** If the JS `tx_hash` doesn't byte-match the firmware's
  computed sighash for the exact tx, every flow is refused — this is the #1 thing to get right.
  Validate against the `--flows` dump's `tx_hash` per flow before touching a device.
- **chainId 0→1 normalization** in the Vault REST path (`rest-api.ts`) is why
  `evm-firmware/eip1559-chainid-required.js` is skipped — keep flows on chainId 1.
- **Signer is RAM-only**: dropped on reboot AND WipeDevice. Load once per device session
  (beforeAll); if the suite reboots/wipes, re-load.
- **Alias allowlist** `[A-Za-z0-9 _-]` — `'CI Test'` is fine; don't get creative (adversarial
  review already closed a quoted-region breakout).

---

## 7. Key files

**keepkey-sdk** (`projects/keepkey-vault-v11/projects/keepkey-sdk`)
- `tests/evm-clearsign/*.js` (8) + `tests/evm-firmware/*.js` (6) — current suite
- `tests/fixtures/generate-evm-fixtures.js` — blob gen (rewrite: per-tx hash + test key)
- `tests/_helpers.js` (`run`, calldata builders), `tests/run-all.js` (runner)
- `src/index.ts:330` (`ethSignTransaction`) — add `loadClearsignSigner` beside it
- `src/types.ts:81` + `openapi/swagger.json` — type `txMetadata`, add the load-signer route

**python-keepkey** @ `1545299` (the reference — read-only)
- `keepkeylib/clearsign_catalog.py` — `CLEARSIGN_FLOWS` (51)
- `keepkeylib/signed_metadata.py` (RFC-6979), `keepkeylib/clearsign_abi.py` (selector/ABI)
- `tests/test_msg_ethereum_clear_signing.py` — `_clearsign_flow` (:891), batch (:915),
  `REFERENCE_BLOB_SNAPSHOTS`, `--flows` dump (:1137)

**Vault / hdwallet**
- `src/bun` REST (add `/eth/clearsign/load-signer`; verify `/eth/sign-transaction` metadata+hash)
- `modules/hdwallet` keepkey — add `loadClearsignSigner` (msg 117)

**firmware** (reference for behavior): `lib/firmware/signed_metadata.c`,
`fsm_msg_ethereum.h` (LoadClearsignSigner), `unittests/firmware/signed_metadata.cpp` (59 tests).

---

## 8. Open questions for you
1. **Slot/key:** reuse python's slot 3 + test-seed idx 0 so snapshots match 1:1, or pick an
   SDK-specific test key (then JS gets its own snapshot set, no python parity)? Parity is cheaper.
2. **Scope of the Vault route:** a dedicated `/eth/clearsign/load-signer`, or fold signer-load
   into a broader `/system/*` route? (recovery went under `/system/recovery/*`.)
3. **Phase-1 assertion depth:** signature-returned only (fast), or also recover-signer==device
   (matches python, catches a wrong-hash-that-still-signs)? Recommend the latter for the flagship
   few, signature-only for the bulk.
