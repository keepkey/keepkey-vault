# Clear-sign: what shipped, what was rejected, and what's next (Handoff, 2026-07-29)

Relay swaps now clear-sign on device in both directions, verified on real hardware.
This handoff covers what landed, one design that was **rejected after review** (and why
the reasoning matters), and the two pieces of remaining work.

Repo root assumed: `/Users/highlander/WebstormProjects/keepkey-stack`

---

## 0. TL;DR

- **Shipped and live.** ETH→SOL and SOL→ETH Relay swaps clear-sign. No per-transaction
  signing service anywhere in the path.
- **Rejected.** Persisting clear-sign signers to public flash (firmware PR #322, closed).
  The justification was wrong in a way worth internalising — see §3.
- **Next.** (a) a KeepKey that *issues* clear-sign signatures, (b) certificate chains so
  onboarding a provider doesn't need a firmware release. (b) needs a spec before code.

**Update 2026-07-29.** (a) is built: firmware PR **#323** (`feat/clearsign-attestor-v2`,
fork develop) + device-protocol `feat/clearsign-attestor-v2`. Builds clean and 379/379 unit
tests pass in both the flag-on and default-off configurations. **Gate 3 is done** —
emulator OLED captures and the harness that produced them are in
`docs/evidence/clearsign-attestor-gate3/`. It caught two real truncation bugs (the
discriminator rendered off the screen entirely; batched labels scrolled off at max
length), both fixed in #323; confirm screens are now one label each. (b) now has a
written proposal at `docs/spec-clearsign-certificate-chains.md` — still unimplemented and
still needs security-model review, per §5.

---

## 1. What shipped

| Repo | Change | State |
|---|---|---|
| `modules/keepkey-firmware` | PR **#321** → `develop` = `b649ba8b` | merged |
| `projects/keepkey-vault` | PR **#380** → `develop` = `98d08014` | merged |
| `projects/pioneer` | **v1.3.149** = `807c16c42` | **live on green** |

### The idea

A **schema** describes how to *read* one instruction or contract method — program/contract,
discriminator/selector, and the labelled args. It carries **no amounts and no transaction
hash**, so one signature covers every future call to that method and the device decodes the
values out of the bytes it is about to sign.

Safety comes from **structural completeness**, not transaction binding:
discriminator + declared arg widths must equal the instruction data length *exactly*; every
displayed account index must exist; lookup-table-backed instructions are never eligible;
and every other instruction must be one firmware already decodes.

### Firmware (#321)

- `KKSOLSC1` Solana instruction schemas — `solana_parseInstrSchema()` /
  `solana_schemaApplies()` in `lib/firmware/solana.c`
- **Payable EVM v2 calls** now clear-sign. Previously *any* native value was refused, which
  forced blind-signing on exactly the routes most worth reviewing. Refusing was never the
  safety property; **showing the amount is** — `signed_metadata_schema_moves_value()` makes
  `ethereum.c` keep the amount screen.
- **`ARG_FORMAT_BYTES`** accepted in v2 args (Relay's order id is an opaque word; without
  this the call was inexpressible)
- **`CreateAssociatedTokenAccountIdempotent`** (ATA data `[1]`) accepted. This was a *wide*
  bug: one unrecognised instruction forces the whole tx opaque, so **any** SPL transfer to
  an address without a token account blind-signed.

### Vault (#380)

- `src/bun/evm-schema-registry.ts`, `src/bun/solana-schema-registry.ts` + their
  `*-local.json` registries; `swap.ts` attaches a matching schema. **No match = today's
  behaviour**, so it can never block a swap.
- `fix(assets)`: Pioneer lowercases the network part of token CAIPs, but Solana/Tron network
  ids are base58 and **case-sensitive**. The icon URL is `base64(caip)`, so USDT-on-Solana
  404'd. Fixed where the CAIP enters, not at the URL.

### Pioneer (v1.3.149)

- **Inlines address-lookup-table accounts** when the tx still fits (`compileToV0Message([])`,
  measured **261 → 320 bytes** against a 1232 limit). A hardware wallet has no network, so
  ALT accounts are absent from the bytes it signs — it cannot show where funds go. Falls back
  to the ALT form if inlining would overflow.
- Registers the Relay bridge program in `pioneer-discovery`.

### Real Relay data (captured from `api.relay.link`, 2026-07-27)

```
Solana program 99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2
  0d9e0ddf5fd51c06  depositNative (native SOL, 5 accounts)
  0b9c60da27a3b413  depositToken  (SPL, 10 accounts)
  both 48 bytes = 8 disc + u64 LE amount @8 + 32-byte order id

EVM router 0x4cd00e387622c35bddb9b4c962c136462338bc31
  selector 0x49290c1c, calldata 68 bytes = 4 + address(depositor) + bytes32(orderId)
  PAYABLE (0.00798 ETH on the sample quote)
```

Router addresses are stable per route but **differ between routes**.

---

## 2. How to test it

```bash
# Vault against staging (v1.3.149 is on green now, so this is only for pre-release checks)
PIONEER_API_BASE=https://api-blue.keepkey.info make vault
```

**The DB setting `pioneer_api_base` WINS over the env var** — check Settings first or you
will silently stay on green.

**Load the CI signer before testing.** Schemas in the registries are signed with the CI test
key (slot 3), and loaded signers are **RAM-only** — every reboot or flash wipes them:

```bash
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-sdk
node tests/solana-clearsign/schema-sign.js     # loads signer + 4 on-device assertions
node tests/solana-clearsign/offline-schema.js  # 14 offline checks, no device
```

Success looks like a decoded `Relay Bridge / depositNative` review, and for ETH→SOL a
decoded `bridgeDeposit` review **plus** the native ETH amount screen (two screens — the
amount screen is deliberately kept because a schema cannot bind `msg->value`).

If it blind-signs, check the vault log for `clear-sign schema attached:` — **absent** means
the lookup missed (Pioneer returned ALTs, or a new router address); **present** means the
device rejected it (usually slot 3 is empty).

---

## 3. REJECTED: persisting signers to public flash (firmware #322, closed)

Read this before proposing it again.

**The problem it tried to solve is real.** With no built-in key, clear-signing only works if
a user loads a signer, and loaded signers are RAM-only — so users must reload on **every
boot**. That trains them to approve a trust anchor routinely, and a malicious host then only
has to ask.

**The proposed fix was worse than the disease.** The argument was: "public storage lacks
integrity, but `AdvancedMode` lives there too, so persisting a trust anchor gives a flash
attacker nothing new." **That is false**, and the code says so:

- `lib/firmware/ethereum.c:867-879` — **AdvancedMode** leaves `data_needs_confirm` true and
  still calls `layoutEthereumData()`. Blind signing is permitted, but the user **still sees
  the raw calldata**.
- `lib/firmware/ethereum.c:795-807` — a **matched signed-metadata blob** sets
  `data_needs_confirm = false`. The raw-data screen is **replaced** by whatever the metadata
  claims.

So a persisted rogue signer is **strictly more powerful** than flipping AdvancedMode: the
attacker signs v1 display metadata for the real malicious transaction and the user never sees
the bytes. Attack A is loud and honest; attack B is quiet and lies.

Additional findings from review, all valid: the feature was **unreachable**
(`fsm_msgLoadClearsignSigner` rejects `persist=true` via `CHECK_PARAM` at
`lib/firmware/fsm_msg_ethereum.h:119`); restored records skipped
`signed_metadata_signer_valid()`, icon validation and slot-consistency; the consent screen
says "for this session"; and `storage_clearClearsignIdentity()` had no production caller.

**V18 storage records stay scrubbed.** Do not re-enable without authenticated storage.

### Testing lesson that let it through

Three of those tests **crashed** inside `storage_commit()` (no `storage_location`) and exited
1 — but they were reported as passing because the check counted `[ OK ]` lines instead of the
**exit code**. A crash read as a pass. Always assert the exit status.

---

## 4. NEXT: KeepKey as the signature issuer

**Why this replaces persistence.** A KeepKey-as-issuer needs no persistence at all: the
*verifying* devices get the production key baked into firmware (signature-protected), and the
*issuing* KeepKey holds the private key in its seed, where it already belongs. No per-boot
prompts, no trust anchors in writable flash.

### Does firmware support it today? No — one message short.

`SignIdentity` is close: it derives a deterministic secp256k1 key and returns the 33-byte
compressed pubkey (this is how the CI test key was derived). But its **signature will never
verify**:

- `SignIdentity` → `cryptoMessageSign` → `cryptoMessageHash`, which prepends the **Bitcoin
  message header** + varint length and double-hashes; returns **65 bytes**
- the verifier (`signed_metadata_verify_attestation`) does plain `sha256_Raw(payload)` +
  `ecdsa_verify_digest`, **64-byte compact**

Different digest construction, different length.

### What to build

A message that signs `SHA256(payload)` directly with secp256k1, 64-byte compact.

**It must not be a raw signing oracle.** The device should **parse and validate the payload
before signing**, using the same parsers a verifying device runs
(`solana_parseInstrSchema`, the metadata parsers). A fully compromised host could then only
obtain signatures over well-formed descriptors — never arbitrary bytes. This is the single
most important property of the design.

**Prior art in this session** (rebase, don't restart):

- Firmware handler: `lib/firmware/fsm_msg_clearsign_attestor.h` — copied onto worktree
  branch `feat/clearsign-attestor-v2` (off `b649ba8b`). Derives the key at a dedicated
  hardened path `m/0x4B4B'/0x4353'/0'` ("KK"/"CS"), validates KKSOLSC1 before signing,
  requires an on-device confirm.
- device-protocol messages **1700-1703** on branch `feat/clearsign-attestor` (`328c6bc`) in
  `https://github.com/BitHighlander/device-protocol`.

**Gate it behind a CMake flag** (`KK_CLEARSIGN_ATTESTOR`, OFF for device builds) — the 7.15
line is 4-10KB from the ROM wall. Wire IDs stay reserved either way, so promoting the
physical-device tier later is a flag flip.

### Checklist for the new message

Follow `firmware-new-message-checklist`: `.options` caps in **BOTH** device-protocol and
`include/keepkey/transport/messages-*.options`, forward-declare the handler in
`include/keepkey/firmware/fsm.h`, add `messagemap.def` rows, and verify
`grep -c pb_callback_t` on the generated header is **0**.

---

## 5. NEXT: certificate chains (needs a spec first)

**The problem.** Baking provider keys into firmware works — `METADATA_MAX_KEYS = 4`, direct
slot lookup — but it means **a firmware release per provider**, with a ceiling of four. That
is not a workable B2B onboarding path.

**There is no chain verification anywhere in the metadata code today.** Grep for
`certificate|delegat|issuer` in `lib/firmware/signed_metadata.c` returns nothing.

**The shape.** One KeepKey **root key** baked into firmware signs a small certificate per
provider ("key X belongs to Acme Trust"); the device verifies root → provider → metadata.
Onboarding becomes *issuing a certificate*, not shipping firmware. This composes with §4: the
issuing KeepKey holds the root.

**Design questions to settle before code:**

1. Certificate format and size (ROM budget)
2. **Key-usage scoping** — today *any* trusted key can attest *any* metadata type. A provider
   certificate authorised for Solana schemas must not attest EVM ones. This was flagged in
   independent research of Ledger's implementation and is cheap now, painful later.
3. Revocation — no mechanism exists
4. Whether the root can be rotated, and how

**Do not implement this without a written spec reviewed by whoever owns the firmware security
model.** The persistence PR (§3) is a direct demonstration of the cost of skipping that step
on a trust-model change.

---

## 6. Smaller open items

**SDK signing timeouts — systemic.** Nearly every signing endpoint in
`projects/keepkey-sdk/src/index.ts` calls `client.post(path, params)` with **no timeout**, so
the 30s default aborts while the user reads the device screen and surfaces as a device
failure. Only `solanaSignTransaction` and `loadClearsignSigner` pass `signingTimeoutMs`.
Still affected: `/eth/sign-transaction`, `/eth/sign`, `/eth/sign-typed-data`, nine
`/cosmos/sign-amino-*`, `/hive/sign-operations`, and others.

**Dead KKSOLSW1 code.** The abandoned per-transaction descriptor format left fixtures behind:
`projects/keepkey-sdk/tests/fixtures/solana-clearsign.js` and
`tests/solana-clearsign/descriptor-sign.js`. That device test cannot pass (the published
`@keepkey/device-protocol` has no `setSwapMetadataPayload`). Delete when convenient.

**Uncommitted work on the vault tree** (from the same session, unrelated to clear-signing):
Zcash privacy UI, address book picker, `src/bun/solana-outflow.*`, activity panel,
`src/bun/solana-programs-local.json`. These want their own branches.

**CircleCI is red on pioneer `master`** — pre-existing and unrelated, but a permanently-red
check means the next genuine failure will not stand out.

---

## 7. Gotchas worth keeping

- **Loaded signers are RAM-only.** Reload slot 3 after every reboot/flash. This looks exactly
  like a regression when you forget.
- **Schemas in the registries use the CI TEST key.** Production needs the slot-0 key — a
  custody decision, not code. Until then this is inert for real users.
- **`pioneer_api_base` DB setting beats the env var.**
- **An untracked file that a committed file imports** passes every local check and only fails
  in a built image. This broke every quote on blue (`Cannot find module './solana-clearsign'`)
  and was caught only by the post-deploy smoke test.
- **`Storage.StorageRoundTrip` fails on macOS** — Linux-padding golden. Trust CI; never
  regenerate locally.
- **`Authenticator.WipeCancellationFailsClosed` hangs** the full unit suite locally.
  Pre-existing; filter around it.
- **clang-format version matters.** CI pins **20.1.8**; a newer local build disagrees even on
  untouched files. `pip install clang-format==20.1.8` in a venv.
- **`gh pr edit` fails** on this repo with a Projects-classic GraphQL error — use
  `gh api -X PATCH repos/.../pulls/N`.
- **`git submodule update --init --recursive` silently resets** submodule branches you have
  checked out. It wiped a device-protocol branch mid-session.
