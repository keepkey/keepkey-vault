# 08 — keepkey-sdk clear-sign test train

**What:** the runtime-signer clear-sign test suite (recovered from untracked
files): shared blob builder + offline parity gate + on-device flows.

**Where:** vault `#340` (MERGED, develop) —
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-sdk/tests/`
(`_clearsign.js`, `clearsign-offline-parity.js`,
`evm-clearsign/{clearsign-signer-flows,loadsigner-sign-flows,relay-v2-schema-flow}.js`,
`fixtures/clearsign-golden.json`).

## Test
- Offline (no device): `cd .../projects/keepkey-sdk && node tests/clearsign-offline-parity.js`.
- On-device (rc7): `KEEPKEY_API_KEY=… node tests/evm-clearsign/clearsign-signer-flows.js`
  (self mode; `CLEARSIGN_MODE=pioneer` mode is dead until Pioneer /sign returns).

## Verify
- [ ] Offline parity: **51/51** catalog flows match python-keepkey @1545299
      (blob sha256+len + JS sighash) — already green this session.
- [ ] On-device self mode: load signer → 3 flows sign, no raw hex (ties into
      handoffs 01/06).

## Status / gotchas
- `CLEARSIGN_MODE=pioneer` calls `/api/v1/descriptors/sign` which is 404 in prod
  — only `self` mode is viable now.
- The test now sends the Pioneer identity icon + `persist:true` (handoff 01/07);
  `CLEARSIGN_NO_ICON=1` for the text-only path.
</content>
