# 02 — Clearsign vendored allowlist + LoadClearsignSigner endpoint

**What:** Pioneer's `/descriptors/decode` + `/descriptors/sign` are 404 in prod,
so the vault stopped calling them. `needsBlindSigning` is now keyed off a
**vendored `firmwareClearSigns` allowlist** that mirrors the device's own
`ethereum_contractHandled` pins (THOR/Maya router deposit, 0x proxy, standard
ERC-20 transfer/approve, addLiquidityETH). Also adds the
`POST /eth/clearsign/load-signer` REST route.

**Where:** vault `#337` (MERGED, develop) —
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/calldata-decoder.ts`,
`rest-api.ts`, `SigningApproval.tsx`, `engine-controller.ts`, `FirmwareDropZone.tsx`.

## Test
- Unit: `cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault && bun test __tests__/firmware-clearsign-gate.test.ts` (7/7 — spoof guard, wrong-address rejection, ERC-20 path).
- Device (rc7): drive real EVM txs and watch the trust badge / blind-sign gate.

## Verify
- [ ] THOR/Maya router **deposit** → clear-signs (trust badge "known").
- [ ] Same deposit selector to a **different** address → blind-signs ("unknown").
- [ ] Standard 68-byte ERC-20 transfer/approve → clear-signs.
- [ ] Uniswap/1inch/relay (firmware-unknown) → blind-signs, **not** falsely "known".
- [ ] `FirmwareDropZone`: flashing against a **wallet-mode** device is blocked
      until it reports `bootloaderMode=true` (no stalled HID freeze).

## Status / gotchas
- MERGED to develop but **allowlist was never device-verified** — confirm on rc7
  that the vendored pins actually match what the firmware clear-signs.
- Supersedes the old `EVM_INSIGHT` flag-gated Pioneer path (removed in the #342
  merge reconciliation).
</content>
