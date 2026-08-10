# 05 — LoadClearsignSigner emulator confirm button

**What:** the `/eth/clearsign/load-signer` route called `loadClearsignSigner()`
directly, unlike every other signing route which wraps in `emuWrap()`. Loading a
signer raises a mandatory on-device "Trust identity" confirm — on the emulator
that button press must be armed via `emuWrap`, or the OLED shows the trust screen
but **no green approve button ever appears and the call hangs**. Now wrapped.
`emuWrap` is a no-op on real hardware.

**Where:** vault `#341` (MERGED, develop) —
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/rest-api.ts`
(the `/eth/clearsign/load-signer` handler now `emuWrap(() => wallet.loadClearsignSigner(...))`).

## Test
- Emulator + rc7: run `clearsign-signer-flows.js` (handoff 01/08). The load step
  hits this path.

## Verify
- [ ] On the emulator, the "Trust identity 'Pioneer'" load screen shows a
      clickable **green approve button** (armed) — the load does not hang.
- [ ] Real device (rc7): physical button confirms the load as before.

## Status / gotchas
- Prerequisite for testing handoff 01 on the emulator (without it the load hangs).
</content>
