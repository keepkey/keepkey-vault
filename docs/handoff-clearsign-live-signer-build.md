# EVM Clear-Signing — Live Per-Tx Signer: Build / Sign / Do (Handoff, 2026-07-02)

**Picks up from** `handoff-pioneer-server-clearsign-metadata.md` and the rc3 firmware/SDK handoffs.
This is the **actionable build plan**: what to build, in what order, what NOT to merge, how to
sign, how to test on-device, and the decisions that gate the live path.

> One-line: prod **blind-signs every EVM contract tx today**. rc3 fail-closes on per-tx `tx_hash`
> binding, so the 2933 static zero-hash blobs are all refused. The fix is a **live per-tx signer**
> on an **operator-controlled isolated box** (not the public prod pod, not the user's machine).

---

## 0. TL;DR / current runtime truth (verified on `develop`)

- **Prod blind-signs EVM contract txs.** Vault `calldata-decoder.ts:fetchPioneerSignedBlob` (~:453)
  requests a blob with only `{chainId, contractAddress, data}` (3s race). On `develop` the
  `/api/v1/descriptors/sign` route is **unregistered (404)**; the only built artifact
  (`dist/controllers/descriptors.controller.js`) has `/sign` as a **hardcoded `{success:false}` stub**.
  404 / `success:false` / timeout → `fetchPioneerSignedBlob` returns `null` → `rest-api.ts` ethSignTx
  logs `no metadata blob — device will show raw hex` → **blind-sign**. Silent.
- **The 3-field request can never produce an rc3-valid blob anyway** — it omits `nonce/gas/value`,
  so no sighash is computable.
- **Serializer is behind rc3.** `pioneer-insight/lib/serializer.js` (no `src/` on disk) has only
  ARG formats 0–3 and a hard **32-byte** value cap. rc3 needs **STRING(4)** + **TOKEN_AMOUNT(5)**
  and a **44-byte** cap — so real token amounts/strings can't even be encoded.
- **Key handling is correct and must stay so.** key_id=0, mnemonic in `pioneer-insight/.env`
  `INSIGHT_MNEMONIC` (0600), used only by the offline `sign-all.mjs` batch job, **never** loaded in
  the server. (Note: prior `.keys` were reportedly lost; a new keypair is being minted regardless.)

## 1. The trust model that shipped (rc3 / PR #281) — the stale 2026-03-17 doc is obsolete

| | OLD doc (2026-03-17) | **rc3 (shipped, emulator-verified)** |
|---|---|---|
| Trust root | firmware ships embedded prod key | `METADATA_PUBKEYS` **all-zero**; host loads key at runtime via `LoadClearsignSigner` (msg 117), RAM-only |
| Bad/mismatched metadata | non-fatal, warns | **fail-closed**: contract data w/o VERIFIED metadata is hard-rejected ("Blocked") |
| Arg formats | 0–3, cap 256 | adds STRING(4)+TOKEN_AMOUNT(5), cap **44** |
| Signing | static pre-signed catalog | **per-tx live signing** (real sighash+values); zero-hash blobs refused |
| UI | "Insight Verified" | **"CLEARSIGN WARNING — Signer '<alias>' … NOT verified by KeepKey"** every page |

## 2. The irreducible tension (state this to anyone who proposes a catalog)

rc3 requires `tx_hash == keccak(exact unsigned tx)` — nonce/gas/value/data. That sighash **only
exists at request time**. Therefore: **you cannot have BOTH a fully air-gapped key AND per-tx
clear-signing for arbitrary user txs.** The signing key MUST be reachable per request. A static
offline catalog (sign once, upload JSON) is exactly today's broken zero-hash state — **do not
pursue it.**

## 3. "Sign locally, only upload the payloads" — the correct reading

Three referents for "local"; only one is both safe and functional:

1. **User's vault machine — NO.** The user must never hold KeepKey's key_id=0 attestation key; a
   leak lets anyone forge VERIFIED metadata that makes a drain read as a benign transfer.
2. **Shared internet-facing prod pod — NO** (this is what the directive is rejecting): a
   brand-forgery key in a 3-replica multi-tenant pod's env/memory is the wrong blast radius.
3. **Operator-controlled isolated signer (HSM/KMS ideal) — YES.** "sign locally" = the key stays on
   KeepKey-operated hardware and never enters the public cluster or the vault; "upload only the
   payloads" = the server/CDN and vault only ever see finished signed blobs, never the key.

**Why an openly-reachable signer is still safe:** it only attests facts it **independently derives
from public calldata** (tx_hash binding stops *replay*, not *mis-signing*); it authorizes nothing
and only ever makes true statements about public calldata. Unrecognized calldata → classify
**OPAQUE / decline**, never blind-stamp VERIFIED.

## 4. Target architecture

Vault sends the **full unsigned tx** → **isolated signer** (holds key_id=0, ideally YubiHSM2 / cloud
KMS doing non-extractable raw secp256k1+SHA256 digest signing) **independently** decodes calldata,
classifies against the descriptor catalog, serializes canonical binary metadata with real `tx_hash`
+ typed args (ADDRESS/STRING/TOKEN_AMOUNT; RAW banned), signs, returns **only the blob**.
`pioneer-server` exposes a **thin proxy** route to the signer; the production mnemonic is **never** in
the public prod pod env. Round-trip (decode+hash+sign+return) must fit the vault's **~3s** budget or
it silently blind-signs — **make that fallback explicit/visible.**

- **Approach A (recommended):** signer computes the sighash from the full tx it receives — one source
  of truth for all clients.
- **Approach B:** vault sends `tx_hash`+args, signer stamps — smaller, but lets the caller dictate the
  attested "what" (forgery vector). Avoid.

## 5. Branch strategy — do NOT merge the kitchen-sink

- **Do NOT merge `feat/clearsign-local`** (316 files, +209k/-67k). It re-touches node-failover/swap
  files already on `develop` and **drags in a regression**: `insight.controller.ts` reverts
  `eth/bsc/polygon.drpc.org` back to the dead `*.llamarpc.com` URLs killed in **#141/#142**.
- The `feature/evm-clear-signing`, `feature/pioneer-insight-clear-signing`,
  `origin/feat/discovery-descriptors-signed` branches are **stale** — they carry discovery JSONs
  already on develop and would REVERT them; ignore.
- **Cut a fresh branch off `develop`** (e.g. `feat/clearsign-live-signer`) and bring over ONLY the
  clear-sign files via read-only `git show feat/clearsign-local:<path> > <path>` — never a
  merge/checkout. **EXCLUDE** the `insight.controller.ts` llamarpc reversion, all `dist/` artifacts,
  and the discovery JSON deletions.

## 6. The focused PR contents (~4200 LOC), ordered for independent review

1. **pioneer-insight `src/` restore + serializer fix** (self-contained, **zero device**):
   restore `src/serializer.ts`, `src/signer.ts`, `src/index.ts`, `src/keys/keygen.ts`,
   `src/cli/keygen.ts`, `package.json`, `tsconfig`, `__tests__` from `feat/clearsign-local` — but
   **fix the serializer**: add `ARG_FORMAT_STRING=4`, `ARG_FORMAT_TOKEN_AMOUNT=5`, raise the value
   cap **32→44** (legacy formats keep 32), export the new formats from `index.ts`. The branch's
   `src/serializer.ts` has the **same gaps** as the compiled `lib/` — correct it, don't copy as-is.
2. **Offline parity gate** (zero device, do FIRST): reproduce python-keepkey
   `REFERENCE_BLOB_SNAPSHOTS` (sha256_hex + byte_len per blob; slot-3 test key, alias "CI Test",
   test-seed idx 0, `REFERENCE_TIMESTAMP=1700000000`) from the JS signer, and byte-match `tx_hash`
   against python's `--flows` dump. Catches serializer drift cheaply.
3. **pioneer-server read-only controllers** (low-risk, no key): `clearsign.controller.ts` (ClearSign
   Explorer catalog views) + the **`/descriptors/decode`** half of `descriptors.controller.ts`.
   tsoa `@Route` auto-wires. EXCLUDE the `/sign` stub for now.
4. **[gated on §8 answers] the real per-tx `/descriptors/sign`**: replace the stub — accept the full
   unsigned tx, decode→attest, compute the correct sighash (legacy vs EIP-1559; **chainId 0→1
   normalization** as the vault does at `rest-api.ts:2039`), call the isolated signer/HSM, return the
   blob. Widen `SignRequest` to `{chainId, to, data, nonce, gasLimit, value, gasPrice | (maxFeePerGas
   + maxPriorityFeePerGas)}`. **Feature-flag it so it ships dark until device-verified.**
5. **Vault (separate repo/PR):** `calldata-decoder.ts` sends the full unsigned tx; widen the 3s race
   or make the blind-sign fallback explicit/visible.
6. **[follow-up] SDK/Vault `LoadClearsignSigner` train:** regenerate hdwallet JS proto bindings
   (msg 117), `hdwallet.loadClearsignSigner`, vault `POST /eth/clearsign/load-signer`,
   `sdk.eth.loadClearsignSigner`, typed `txMetadata` on `/eth/sign-transaction`.

## 7. BUILD → SIGN → TEST → DEPLOY workflow

- **BUILD:** fresh branch off develop; land §6.1–6.3 first (no key, no device). `make` builds the
  workspace; pioneer-insight/lib is turbo-built from the restored src.
- **SIGN:** the key lives on the isolated signer only. For the offline parity gate use the **test**
  key (slot 3). The production key_id=0 signer is stood up per §8's answer.
- **TEST (device), in order of readiness:**
  1. **python-keepkey path (ready now, fastest):** flash rc3 DEBUG_LINK build, run
     `test_msg_ethereum_clear_signing.py`. **WARNING: wipes the device, loads the public test seed —
     never a device with real funds.** Eyeball the OLED for **no hex anywhere** across flows; confirm
     signer == device address.
  2. **SDK/Vault path (after §6.6):** rebuild the vault on :1646 (`make vault` — restarts the live
     vault, ~minutes) to pick up the new hdwallet method + route, then drive a real EVM approval and
     **physically confirm** the trust-warning screen + decoded clear-sign pages on the KeepKey.
- **DEPLOY:** ship §6.1–6.3 anytime (dark/no-op for signing). Flip the `/sign` feature flag only
  after on-device verification; wire the vault to send the full tx in the same coordinated release.

## 8. Open decisions that GATE the live `/sign` path (need answers before §6.4)

1. **WHERE does the key_id=0 signer physically run?** HSM/KMS (recommended, non-extractable) vs a
   self-hosted isolated VM vs (reject) the shared prod pod. This one answer sets the attestation
   key's blast radius.
2. **Confirm intent:** "sign locally, only upload payloads" = key OFF the internet-facing cluster and
   out of the vault, only signed blobs crossing back — **not** a static offline catalog (broken).
3. **Approach A vs B** (§4). Recommend A.
4. **Signer auth:** open to any vault (OK only if it independently decodes-and-attests and authorizes
   nothing) vs auth'd/allowlisted.
5. **Key custody / backup / rotation / incident:** the pubkey is loaded at runtime (rc3) — but a
   leaked signing key still lets anyone forge VERIFIED metadata until the signer key is rotated and
   old signers de-authorized. What's the backup/rotation/incident plan before it goes live?
6. **Availability/degradation:** signer down → vault currently **silently** blind-signs. Acceptable,
   or surface an explicit "unverified — verification service unavailable" state?
7. **Scope:** build the focused PR (§6.1–6.5) and abandon the kitchen-sink merge? Is the
   `LoadClearsignSigner` SDK/Vault train (§6.6) same-landing or follow-up?
8. **Device-test:** start with the python path (wipes device)? Confirm an rc3 DEBUG_LINK build and a
   throwaway device are available.

## 9. What can start NOW (no key, no device, no gating decision)

- §6.1 serializer fix + pioneer-insight `src/` restore
- §6.2 offline parity gate (test key)
- §6.3 read-only ClearSign Explorer + `/descriptors/decode` controllers

These are safe, independently reviewable, improve host-side decode UX, and touch **no key material
and no device**. The live `/sign` handler (§6.4) waits on §8.
