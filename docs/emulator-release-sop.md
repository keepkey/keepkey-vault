# Emulator Release SOP (firmware 7.16)

The Vault release carries the emulator; users should not need to install a
`libkkemu` file. Both platform libraries are derived from the exact
`modules/keepkey-firmware` gitlink and are build artifacts, not committed
binaries.

## Build contract

On macOS, run:

```sh
make build-emulator-release
```

This is a blocking release gate. It produces:

- `projects/keepkey-vault/emulator-bundle/libkkemu.dylib` — universal arm64 + x86_64
- `projects/keepkey-vault/emulator-bundle/libkkemu.dll` — Windows x86_64

The scripts fail unless all of these are true:

- Firmware source version is exactly 7.16.0 and its SHA equals the Vault gitlink.
- `KK_CLEARSIGN_ALPHA_ROOT=ON` survived CMake configuration.
- All 12 FFI functions used by Vault are exported.
- The macOS dylib contains both release architectures.
- The Windows DLL imports only Windows system/UCRT DLLs—no MinGW runtime sidecars.

CI runs this before `build:stable`. The macOS app contains the universal dylib;
the workflow artifact also contains
`emulator-build-input-libkkemu-7.16.0-win-x64.dll` for the Windows signing
machine. That unsigned build input is deliberately removed before draft-release
publication; the Windows production script signs the copy inside the app.

## Release checks

macOS:

1. Build/sign normally with `make build-signed`, or sign the CI Intel archive.
2. Confirm `Contents/Resources/app/emulator/libkkemu.dylib` exists in both app archives.
3. Add an emulator without installing a dylib and confirm firmware 7.16.0 boots.

Windows:

1. Download the matching CI artifact DLL, rename it to `libkkemu.dll`, and place
   it in `projects\keepkey-vault\emulator-bundle\`.
2. Run `scripts\build-windows-production.ps1`; missing, altered, or uncopied DLLs fail the build.
3. Install on a clean Windows machine and run the checklist below.

## Cross-platform smoke checklist

- Add an emulator with no pre-existing `~/.keepkey/emulator` override.
- Create/recover a wallet and confirm the OLED preview updates.
- Stop and reopen the emulator; encrypted flash persists.
- Run a certified ETH→SOL ClearSign swap: labelled review, no Advanced Mode prompt.
- Run three consecutive signing operations to cover poll-thread/lock lifecycle.
- Windows only: close/reopen the installed app and confirm a fresh backend log session starts.

Keep a user-installed library only when intentionally overriding the bundled
release for development. Remove that override before release smoke testing.
