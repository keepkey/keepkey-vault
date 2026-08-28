# Bundled KeepKey emulator

Release builds stage the firmware shared libraries here; the binaries are build
artifacts and are intentionally gitignored.

- `libkkemu.dylib`: universal macOS arm64 + x86_64
- `libkkemu.dll`: Windows x86_64

Both are built from the `modules/keepkey-firmware` gitlink, must report firmware
7.16.0, include the ClearSign alpha root, and expose the complete Vault FFI ABI.
Run `make build-emulator-release` on macOS to rebuild and verify both.
