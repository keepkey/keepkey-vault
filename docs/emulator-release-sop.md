# Bundled Emulator Release SOP

Owner policy, 2026-11-18: **the default bundled emulator always comes from the
latest `alpha` of `BitHighlander/keepkey-firmware`.** Resolve that branch once,
qualify its exact commit, and record the immutable artifact and library hashes.
An older certified emulator is not a fallback when the current alpha artifact
is missing or failed. This policy supersedes the previous fixed-source bundle.

The Vault release carries a certified KeepKey emulator library. Users must not
need to install `libkkemu` separately. Emulator artifact provenance and package
contents are blocking Vault release gates.

This SOP does **not** gate, select, or modify a hardware firmware release. In
particular, never inspect or change the `modules/keepkey-firmware` gitlink to
make this gate pass.

## Development build switching

Vault's emulator Settings can keep multiple local `libkkemu` builds. Install a
build with **Change Version…** or drop its library on Vault, then choose an
installed build from the picker. Vault stores each library under its SHA-256
content ID in `~/.keepkey/emulator/builds/`; it never overwrites a loaded
library. The picker shows the firmware version only after that build has started
and Vault has read Features from it. Keep the content ID in QA evidence so two
different builds that report the same version remain distinguishable.

Switching stops the running emulator, selects the new library, and starts it
with an encrypted flash image named `build-<first 16 hash characters>`. A build
may use only its own flash through the normal Vault wallet selector. Import a
test seed into that build's flash if cross-version signing comparisons require
the same addresses. If startup fails, Vault restores the previous build and
flash when possible; record any failure before retrying. The legacy
`~/.keepkey/emulator/libkkemu.*` override and bundled release library still
work when no development build is selected.

Emulator QA does not satisfy a physical OLED or signed firmware update gate.
Record the hardware firmware version and test result separately before
marking a release candidate ready.

## Release identity

The emulator version comes from the frozen fork-alpha source (currently
`7.17.0`). The complete artifact set is:

- `libkkemu.dylib` — universal macOS `arm64` + `x86_64`
- `libkkemu.dll` — Windows `x86_64`
- CI handoff: `certified-emulator-alpha-<full firmware SHA>`, containing both
  libraries and `source-receipt.json` from one successful certification run.

The source must equal the live fork-alpha head at certification and intake.
Its firmware CI must have passed on that exact head. If alpha advances during
either operation, repeat for its new head. The firmware submodule version is
not a source of truth for this decision.

The controlling machine-readable record is
`projects/keepkey-vault/emulator-bundle/manifest.json`. It pins the certified
source run, artifact ID/digest, platform filenames, library hashes,
architectures, and required ABI symbols.
Its source record distinguishes the Vault certification commit/run from the
firmware repository, alpha commit and qualifying firmware CI run.

The `Build Certified Emulator Artifact` workflow builds a fresh independent
fork-alpha checkout through `scripts/build-alpha-emulator.sh`. Both platform
builders consume that one frozen checkout. It audits the universal macOS
13 library, Windows ABI/imports, production ClearSign root and PIN flows before
uploading the source receipt and both libraries together.

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

1. Run `make refresh-alpha-emulator`. It resolves the current fork-alpha head,
   requires green exact-head firmware CI, finds a successful certification run
   for that source, verifies the artifact ZIP digest and both receipt-bound
   library hashes, then updates the bundle manifest. Missing certification
   stops the build; run the certification workflow for current alpha first.
   Identify the successful certified emulator-artifact CI run and record its
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

Normal local and hosted packaging uses `scripts/refresh-alpha-emulator.mjs`.
Library files are replaced by rename, preserving any already-loaded inode.
`make preflight` reruns `scripts/verify-certified-emulator.mjs`, including the
latest-alpha identity check; it never reads the firmware gitlink.

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
  release `7.17.0`.
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
