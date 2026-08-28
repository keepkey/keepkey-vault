# Bundled Emulator Release SOP

The Vault release carries a certified KeepKey emulator library. Users must not
need to install `libkkemu` separately. Emulator artifact provenance and package
contents are blocking Vault release gates.

This SOP does **not** gate, select, or modify a hardware firmware release. In
particular, never inspect or change the `modules/keepkey-firmware` gitlink to
make this gate pass.

## Release identity

For the current Vault release train, the approved emulator release is
`7.16.0`. The complete artifact set is:

- `libkkemu.dylib` — universal macOS `arm64` + `x86_64`
- `libkkemu.dll` — Windows `x86_64`
- CI handoff name: `emulator-build-input-libkkemu-7.16.0-win-x64.dll`

The expected emulator release must be declared by the Vault release branch and
must agree with the CI artifact name and the runtime version reported by the
emulator. The firmware submodule version is not a source of truth for this
decision.

The controlling machine-readable record is
`projects/keepkey-vault/emulator-bundle/manifest.json`. It pins the certified
source run, artifact ID/digest, platform filenames, library hashes,
architectures, and required ABI symbols.

## Non-negotiable boundary

- Do not run firmware pinning, branch, cleanliness, behind/ahead, or version
  reconciliation as part of a Vault release.
- Do not checkout, reset, clean, merge, fetch, or re-pin
  `modules/keepkey-firmware`.
- If the approved emulator artifacts are absent, have unknown provenance, or
  fail verification, stop the Vault release and repair the emulator artifact
  intake/build workflow separately. Do not repair it by changing the firmware
  gitlink.

## Pre-build artifact gate

Before packaging:

1. Identify the successful certified emulator-artifact CI run and record its
   run ID, commit SHA, artifact ID, and artifact digest in the manifest. The
   Vault release commit may be later; the staged bytes must match the immutable
   certified artifact recorded in the release branch.
2. Obtain both platform libraries from that same artifact. Do not
   mix artifacts from different commits or runs.
3. Record SHA-256 for the original artifacts and the staged copies. They must
   match byte-for-byte until platform signing intentionally changes them.
4. Stage:
   - `projects/keepkey-vault/emulator-bundle/libkkemu.dylib`
   - `projects/keepkey-vault/emulator-bundle/libkkemu.dll`
5. Verify the macOS library contains `arm64` and `x86_64`.
6. Verify both libraries export all 12 Vault FFI functions:
   `kkemu_init`, `kkemu_shutdown`, `kkemu_write`, `kkemu_read`, `kkemu_poll`,
   `kkemu_is_running`, `kkemu_pop_frame`, `kkemu_start`, `kkemu_stop`,
   `kkemu_lock`, `kkemu_unlock`, and `kkemu_trylock`.
7. Verify the Windows DLL imports only Windows system/UCRT DLLs and needs no
   MinGW runtime sidecars.
8. Require CI's ClearSign-root/configuration audit to be green for that exact
   artifact run.

Use `scripts/stage-certified-emulator.sh <downloaded-artifact-dir>` to extract,
stage, and verify both libraries. `make preflight` reruns
`scripts/verify-certified-emulator.mjs`; it never reads the firmware gitlink.

Any failure is a hard stop for the Vault release.

## Packaged-artifact gate

After every platform build:

1. Extract or mount the artifact actually intended for publication.
2. Confirm the bundled library exists at:
   - macOS: `Contents/Resources/app/emulator/libkkemu.dylib`
   - Windows: `Resources/app/emulator/libkkemu.dll`
3. Confirm the packaged library hash matches the staged library before signing,
   or record and verify the expected post-signing hash when signing changes it.
4. Repeat the check for both macOS auto-update archives (`arm64` and `x64`), not
   only the DMGs.

Presence in a build directory is not evidence that the published app contains
the emulator.

## Runtime smoke gate

Smoke-test the packaged app with all user-installed emulator overrides removed
or moved aside so the bundled library is necessarily selected:

- Add an emulator without installing a library and confirm it reports emulator
  release `7.16.0`.
- Create or recover a wallet and confirm OLED preview updates.
- Stop and reopen the emulator; encrypted flash must persist.
- Run a certified ETH→SOL ClearSign swap with labelled review and no Advanced
  Mode prompt.
- Run three consecutive signing operations to cover poll-thread/lock lifecycle.
- On Windows, close/reopen the installed app and confirm a fresh backend log
  session starts.

User-installed libraries remain a development override only. An override makes
the release smoke result invalid because it does not exercise the embedded
artifact.
