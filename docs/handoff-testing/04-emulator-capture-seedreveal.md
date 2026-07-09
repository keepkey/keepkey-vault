# 04 — Emulator capture-frame + seed-reveal/version tooling

**What:** emulator-only dev tooling — grab the live OLED as a PNG (visual proof
for automated test drivers) and reveal the active flash's saved seed / show
version controls.

**Where:** vault `#339` (MERGED, develop) —
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/emulator-window.ts`
(`captureCurrentFrame` + `/_emu/capture` bridge), `index.ts`
(`emulatorCaptureFrame`, `emulatorRevealSeed` RPCs), `rest-api.ts`
(`POST /emulator/capture`, auth'd, `engine.isEmulator`-gated),
`DeviceSettingsDrawer.tsx`.

## Test
- Capture (used already this session to verify the identity logo):
  `POST http://localhost:1646/emulator/capture` with a bearer token → returns
  `{ dataUrl }` (PNG). Example driver:
  `projects/keepkey-sdk/tests/evm-clearsign/_capture-load.js` pattern (removed;
  reconstruct from git if needed).
- Seed reveal: DeviceSettingsDrawer → reveal seed (emulator wallet only).

## Verify
- [ ] `POST /emulator/capture` returns a valid PNG data URL of the current OLED.
- [ ] `emulatorRevealSeed` shows the active flash's saved mnemonic; **rejects on
      a real device** (`engine.isEmulator` gate).
- [ ] Version/seed controls in DeviceSettingsDrawer work; the two prior
      race-condition fixes hold (stale revealed seed on wallet-switch/wipe;
      concurrent mutating actions mutually exclusive).

## Status / gotchas
- REST capture route is registered manually (not in tsoa swagger) — probe it,
  don't expect it in `/spec/swagger.json`.
</content>
