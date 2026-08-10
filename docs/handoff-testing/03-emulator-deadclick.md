# 03 — Emulator never-dead-click

**What:** `initEmulator()` caught every dylib-load failure and returned a normal
`EmulatorStatus{state:'error'}` object; the RPC handlers forwarded that as a
*successful* response, so the UI silently reverted (a dead click, real error
stranded in console). Now the handlers throw and the UI surfaces the error.

**Where:** vault `#338` (MERGED, develop) —
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/index.ts`
(`emulatorInit`/`emulatorSwitchWallet`/`emulatorImportWallet` throw),
`src/mainview/components/DeviceGrid.tsx` (`handleStartEmu` surfaces any
non-running result).

## Test (needs a FAILING emulator to see the value)
1. Install a **stale/incompatible** dylib (e.g. one missing `kkemu_start`) at
   `~/.keepkey/emulator/libkkemu.dylib`.
2. Click **Start** on the emulator card in Vault.

## Verify
- [ ] A red error banner appears with the real reason (e.g. `Symbol "kkemu_start"
      not found` / `kkemu_init returned N`) — **not** a silent revert.
- [ ] With a good dylib, Start still boots the emulator normally.

## Status / gotchas
- This is exactly the bug that masked the earlier `kkemu_start` mismatch —
  before the fix it just dead-clicked.
</content>
