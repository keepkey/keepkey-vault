# Zcash PCZT Clear-Signing — TDD Retro

## What went wrong (3 preventable bugs)

### Bug 1: `transparent_outputs[*].index` missing
- **Failure**: "Could not parse protocol buffer message" on first shield attempt
- **Root cause**: Sidecar serialized outputs without `index` field; `outputMsg.setIndex(undefined)` → malformed protobuf
- **Why no test caught it**: SDK test `build-response-shape.js` didn't assert `transparent_output[0].index`
- **Fix**: `main.rs` — use `.enumerate()` when building outputs JSON
- **Test added**: `assert('transparent_output[0].index is a number', typeof to[0].index === 'number')`

### Bug 2: Transparent digest form mismatch (T.1 vs S.2)
- **Failure**: "Transparent digest mismatch" (firmware error code 9)
- **Root cause**: Sidecar computed S.2 form (`digest_transparent_sig_for_orchard`) but firmware verifies T.1 form (`zcash_compute_transparent_digest`)
- **Why no test caught it**: No integration test verified the digest value; unit test fixture used made-up hex constants
- **Fix**: `zip244.rs` — use `digest_transparent_txid` for the `transparent` digest
- **Test needed**: SDK test that calls `/api/zcash/shielded/build`, recomputes T.1 digest from the returned transparent inputs/outputs, and asserts it matches `digests.transparent`

### Bug 3: `recipient`/`rseed` missing from output actions → "Missing Orchard output metadata"
- **Failure**: Firmware rejects ZcashPCZTAction for output action — `has_recipient` / `has_rseed` are false
- **Root cause**: Two sub-bugs compounded:
  1. Proto fields 15 (`recipient`) and 16 (`rseed`) existed in the firmware's pinned device-protocol but the vault's `modules/device-protocol` was behind (missing those commits)
  2. Sidecar was using IVK decryption to extract recipient/rseed — silently returned `None` because the PCZT builder uses a different `esk` path; the direct PCZT output API (`action.output().recipient()`, `action.output().rseed()`) was always available
- **Why no test caught it**: Test fixture `SHIELD_REQUEST` had no `recipient`/`rseed` fields on actions, so `zcash.ts` sent them as `undefined` without any assertion failing
- **Fix**:
  - Cherry-pick device-protocol commits `870b8ea` + `6ec974ee` (adds fields 15/16) and regenerate JS bindings
  - `pczt_builder.rs`: use `pczt_bundle.actions()[i].output().recipient()` / `.rseed()` directly
  - `zcash.ts`: send `actionMsg.setRecipient(...)` / `actionMsg.setRseed(...)` for output actions
- **Tests added**:
  - `SHIELD_REQUEST` fixture now includes `recipient: "ab".repeat(43)` and `rseed: "cd".repeat(32)` on action[0]
  - New assertion in "full protocol sequence" test: `capturedActionMsg[0].getRecipient_asU8()` is 43 bytes
  - `build-response-shape.js`: output actions must have `recipient` (86-char hex) and `rseed` (64-char hex)

### Bug 4: Shield sighash uses S.2 form instead of T.1 → "could not validate orchard proof"
- **Failure**: Broadcast failed with "could not validate orchard proof" after device signing succeeded
- **Root cause**: `compute_zip244_digests_hybrid` called `digest_transparent_sig_for_orchard` which returns the full S.2 form (includes `hash_type || amounts || scripts || txin_sig_digest`) when transparent inputs are present. The consensus verifier and firmware both compute the Orchard sighash with T.1 form (`digest_transparent_txid`). Dummy spend auth sigs were created under S.2 sighash; the chain verified against T.1 → signature mismatch → consensus failure.
- **Why no test caught it**: No test verified that `compute_zip244_digests_hybrid` uses T.1 form. The existing `test_transparent_sig_digest_differs_from_txid_digest` showed the forms differ but didn't pin which one the hybrid function uses.
- **Fix**: `zip244.rs` — change `digest_transparent_sig_for_orchard` → `digest_transparent_txid` in `compute_zip244_digests_hybrid`. The S.2 form is only needed for per-input transparent ECDSA P2PKH sigs.
- **Test added**: `test_hybrid_shield_sighash_must_use_t1_not_s2` in `zip244.rs` — asserts that T.1 ≠ S.2 when inputs present, documents that the hybrid digest must use T.1.

---

## TDD rules going forward

1. **Before touching transport code**: add a test fixture field and an assertion for it. If the assertion fails, the fixture is wrong, not the code.
2. **Protocol boundary tests**: every field the firmware checks must appear in the test fixture with realistic byte lengths. Firmware error codes (1=syntax, 3=missing, 9=mismatch) map to specific fields — search `fsm_msg_zcash.h` for the string to find exactly which check failed.
3. **SDK regression tests**: `tests/zcash/build-response-shape.js` must assert ALL fields the firmware requires. Run it against a live sidecar before considering an integration complete.
4. **Don't reach for clever crypto** when the plain data is already there. PCZT = Partially Created Zcash Transaction — it stores plaintext metadata for signers. Always check the direct PCZT API (`action.output().recipient()`) before attempting decryption.

---

## Files touched in this session

| File | Change |
|------|--------|
| `modules/device-protocol/messages-zcash.proto` | Cherry-pick: add `recipient` (field 15) + `rseed` (field 16) to `ZcashPCZTAction` |
| `modules/device-protocol/lib/messages-zcash_pb.js` | Regenerated (protoc) |
| `zcash-cli/src/main.rs` | Fix: add `index` to transparent_outputs JSON |
| `zcash-cli/src/zip244.rs` | Fix: use T.1 form for transparent digest |
| `zcash-cli/src/pczt_builder.rs` | Fix: use `pczt_bundle.actions()[i].output().recipient()/.rseed()` directly |
| `hdwallet-keepkey/src/zcash.ts` | Fix: send `recipient`+`rseed` fields; add `recipient?`/`rseed?` to action type |
| `hdwallet-keepkey/src/zcash.test.ts` | TDD: fixture has `recipient`+`rseed`; assertions verify they reach protobuf |
| `keepkey-sdk/tests/zcash/build-response-shape.js` | TDD: assert output actions have `recipient`+`rseed` |
| `zcash-cli/src/zip244.rs` | Fix: T.1 form for hybrid sighash transparent digest; add regression test |
