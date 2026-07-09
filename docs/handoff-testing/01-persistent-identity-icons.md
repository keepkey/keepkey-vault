# 01 — Persistent clear-sign identities + logo render

**What:** the "KeepKey + identity" model. A clear-sign signer loaded with
`persist=true` survives reboot (flash storage, `STORAGE_VERSION 17→18`), and
every clear-sign now **leads with the identity's logo + alias + fingerprint**
instead of the "NOT verified by KeepKey" banner — on both the load-consent
screen and every per-tx confirm.

**Where:**
- firmware `release/7.15.0-rc7` (`BitHighlander/keepkey-firmware#299`, OPEN) —
  `lib/firmware/storage.{c,h}`, `signed_metadata.c`, `fsm_msg_ethereum.h`,
  `lib/board/layout.c`, `include/keepkey/board/layout.h`.
- hdwallet `feat/clearsign-signer-icon` (`keepkey/hdwallet#53`, OPEN).
- vault `feat/clearsign-identity-icons-vault` (`keepkey/keepkey-vault#342`, OPEN).

## Test (emulator, fastest)
1. Emulator dylib from rc7 (handoff 12), reloaded in Vault; Vault has #342.
2. `cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-sdk`
   `KEEPKEY_API_KEY=… node tests/evm-clearsign/clearsign-signer-flows.js`
   (sends the Pioneer compass icon + `persist:true`).

## Verify
- [ ] **Load screen** shows the compass logo, full "LOAD CLEARSIGNER" title,
      unclipped "Trust 'Pioneer' (fp)…" body (no first-letter clipping).
- [ ] **Per-tx confirm** leads with the same logo + "Identity" + alias + fp,
      then decoded pages, **no raw hex**, no "NOT verified by KeepKey" scare.
- [ ] **Persistence:** load with `persist:true` → reboot the emulator → drive a
      clear-sign for the SAME `key_id` **without** re-loading → it still verifies
      and renders (reads the flash slot). WipeDevice clears it.
- [ ] **Migration (brick-risk):** seed an emulator on the OLD (v17) dylib, then
      swap to rc7 → wallet loads, keys/label/policies intact, identities empty
      (no data loss, no reset).
- [ ] Load an icon > 384 B or dims > 64 → device rejects at load (validated).
- [ ] Load `persist:true` into all persistent slots, then one more → honest
      "No free persistent identity slot" failure (not silent RAM-only).

## Status / gotchas
- Firmware unit tests 75/75 pass (storage round-trip + migration + clamp).
- Icon column is 40px; identity icons generated at 40px + centered (handoff 07).
- device-protocol pinned to fork `33521a8` (icon fields) — **upstream-pin swap
  is the final-release gate**, not the rc.
- Boot click-through review of trusted identities = deferred (Stage 3).
</content>
