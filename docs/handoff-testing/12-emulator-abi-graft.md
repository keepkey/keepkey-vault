# 12 — Firmware emulator-ABI graft (testable dylib)

**What:** the clear-sign firmware line (RC6) and the emulator-dylib ABI line
(`kkemu_start`, poll thread) had **diverged** — neither branch had both, so an
emulator built from the clear-sign branch was missing `kkemu_start` (dead click,
handoff 03). Cherry-picked the 4 emulator-ABI commits (#249–252) onto the
clear-sign branch so the feature is emulator-testable. Those commits touch
`lib/emulator/*` only (no-op for device firmware).

**Where:** firmware `feat/clearsign-persistent-identity-icons` /
`release/7.15.0-rc7` (`BitHighlander/keepkey-firmware`). Submodule at
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/modules/keepkey-firmware`.

## Test / build
```
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/modules/keepkey-firmware
git checkout release/7.15.0-rc7    # (or feat/clearsign-persistent-identity-icons)
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11
make build-emulator                # installs ~/.keepkey/emulator/libkkemu.dylib
```
then **reload the emulator in Vault**.

## Verify
- [ ] `nm -gU ~/.keepkey/emulator/libkkemu.dylib | grep kkemu_start` → present
      (all 12 `kkemu_*` FFI symbols the vault requires).
- [ ] Emulator boots in Vault; clear-sign firmware (`signed_metadata.c`) is
      compiled in (handoffs 01/05 exercise it).

## Status / gotchas
- This is the **prerequisite** for emulator-testing handoffs 01/03/04/05.
- The device firmware build ignores these commits (emulator-only files); they're
  cleanly separable if the eventual PR wants the feature without the emu graft.
- device-protocol pinned to fork `33521a8` (msg-117 icon fields).
</content>
