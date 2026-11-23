# Bundled KeepKey emulator

Release builds stage the firmware shared libraries here; the binaries are build
artifacts and are intentionally gitignored.

- `libkkemu.dylib`: universal macOS arm64 + x86_64
- `libkkemu.dll`: Windows x86_64

Both come from the latest `alpha` of `BitHighlander/keepkey-firmware`, independently
of the hardware firmware gitlink. They include the production ClearSign root
and expose the complete Vault FFI ABI. `manifest.json` binds both libraries to
one successful certification run and exact firmware alpha commit.

Run `make refresh-alpha-emulator` to stage the current certified artifact.
If alpha has advanced, run the fork's Build Certified Emulator Artifact workflow
first. Packaging refuses an older default bundle. `make build-emulator-release`
on macOS builds and audits both libraries from a fresh frozen alpha checkout;
local output stays temporary until certification and intake.
