# Monero signing on every Desktop platform: implementation plan

Paths below are relative to the repository root (`keepkey/keepkey-vault`). The app is `projects/keepkey-vault`.

> **Status (feat/monero-windows):** win32-x64 is implemented: build-script targets, runtime gates, packaging, the raw-hash signing exclusion, CI jobs `monero-native-win32-x64` and windows-unsigned staging, and tests. The manifests have no `win32-x64` entries yet; they get pinned from the first green `monero-native-win32-x64` run in a reviewed commit, and only then does Windows show Monero as available. linux-x64 and darwin-x64 are not started. Publishing a `monero-native-<date>` release is the owner's decision; CI produces only workflow artifacts.

## 1. Why

Windows does not need a firmware change. Monero signing is gated entirely inside KeepKey Desktop. Desktop needs two native helpers that it builds itself:
- the host adapter (`monero-host-adapter`)
- the core verifier (`libmonero_core_verify`)

Both build scripts refuse to run on anything other than macOS (`scripts/build-monero-host-adapter.py:61`, `scripts/build-monero-core-verifier.py:30`). Both pin manifests only have a `darwin-arm64` entry. Desktop also has two hard-coded `darwin-arm64` checks in `src/bun/monero-device-signing.ts:132` and `:162`. So on every other platform `moneroAvailable` (`src/bun/index.ts:1948`) is false, and the UI shows "Monero is unavailable in this build."

The reason this isn't a quick fix: each manifest pin is the sha256 of a reproducible native build, and a Windows pin can only come from a real Windows build. That build needs a Windows toolchain, either a windows-2022 CI runner or a Windows machine. After that, testing a real device on Windows needs the Windows PC.

The official wallet tools are already pinned for all five platforms:
- `monero-cli/prepare.py:21-22,60,84-85`
- `monero-cli/src/tools.ts:13-19`

The sidecar and monerod lookup already handle `.exe` (`src/bun/monero-sidecar.ts:34-56`, `src/bun/monero-node.ts:20-32`).

## 2. Toolchain decision

**win32-x64: MSYS2 UCRT64 (MinGW-w64 GCC), fully static.** Flags: `-static -static-libgcc -static-libstdc++`, plus static winpthread. Boost, OpenSSL and libsodium are built from the same pinned archives.

Reasons:
- MinGW-w64 is the Windows toolchain Monero upstream supports. An MSVC build of Monero Core would need patches to the reviewed v0.18.5.4 source. (I could not check the upstream README in this repo, so the "upstream-supported" claim is UNCONFIRMED here.)
- UCRT64 means imports come from `api-ms-win-crt-*` / `ucrtbase` rather than `msvcrt`.
- Static runtime linking meets the bar in `docs/emulator-release-sop.md:106-107`: Windows/UCRT system DLLs only, and no MinGW runtime sidecars.

Pin the MSYS2 package versions (or use a snapshot) and record them in the manifest. Without that, the sha256 changes whenever the runner image changes.

**linux-x64:** GCC in a pinned old-glibc container (manylinux_2_28 or Debian 11), with `-static-libstdc++ -static-libgcc`. Exports are limited with `-Wl,--version-script`, and the build uses `-Wl,--gc-sections -Wl,--as-needed`. It is checked with `readelf -d` against libc/libm/libpthread/ld-linux plus a `GLIBC_` symbol-version cap.

**darwin-x64:** the current scripts with `-arch x86_64`, OpenSSL `darwin64-x86_64-cc`, Boost `architecture=x86` and `CMAKE_OSX_ARCHITECTURES=x86_64`, built on a native Intel runner (`macos-15-intel`). No universal binary while the manifest holds one hash per platform key.

## 3. Work items, in order

### (a) Build scripts take a target

Files:
- `scripts/build-monero-host-adapter.py`
- `scripts/build-monero-core-verifier.py`

**Platform selection**
- Replace the `sys.platform != "darwin"` checks (host-adapter `:61`, verifier `:30`) and the hard-coded `manifest['files']['darwin-arm64']` lookups (host-adapter `:59`, verifier `:29`) with a target key: `win32-x64`, `linux-x64`, `darwin-x64` or `darwin-arm64`.

**Per-target build steps**

| Step | Where (current) | win32-x64 | linux-x64 | darwin-x64 |
|---|---|---|---|---|
| OpenSSL Configure | host-adapter `:101-103` | `mingw64` with `no-shared`, MSYS2 perl and make | `linux-x86_64` | `darwin64-x86_64-cc` |
| Boost | host-adapter `:105-109`, verifier `:71-74` | `toolset=gcc target-os=windows address-model=64 runtime-link=static` | `toolset=gcc architecture=x86` | `architecture=x86`, `-arch x86_64` |
| Sodium objects | host-adapter `:111,115`, verifier `:76` | `x86_64-w64-mingw32-gcc -O2`, no `-fPIC` | `gcc -fPIC` | as today with `-arch x86_64` |
| Link | host-adapter `:124`, verifier `:86` | `-Wl,--gc-sections`, plus a `.def` file exporting only `monero_core_verify` and `monero_core_plan_size` | `--version-script` | as today |
| CMake | host-adapter `:131`, verifier `:93` | drop `CMAKE_OSX_*`, use `-G "MSYS Makefiles"` or Ninja | drop `CMAKE_OSX_*` | `CMAKE_OSX_ARCHITECTURES=x86_64` |

On win32 the sources have only `extern "C"` and no dllexport (`native/monero-core-verifier/verify.cpp:54,130,133`, `core-plan.h:8`). A `.def` file is the least invasive way to control exports.

**OpenSSL pinning (also fixes macOS today).** `core-verifier.py:95` points `OPENSSL_ROOT_DIR` at `/opt/homebrew/opt/openssl@3`. Point it at the pinned OpenSSL build the same way host-adapter `:137-138` does.

**Link-rewrite seam (most fragile).** Host-adapter `:146-149` and verifier `:101` parse `link.txt` and filter out `/opt/homebrew/*.dylib`. Per target, filter `/mingw64` or `/ucrt64` `*.dll.a` import libraries on win32, and `/usr/lib/*.so` on linux.

**Dependency and export checks.** These replace `otool`/`lipo`/`nm` (host-adapter `:22-26,153-157`, verifier `:106-111`).
- win32: `objdump -p` with an import allow-list of KERNEL32, ADVAPI32, WS2_32, CRYPT32, BCRYPT, USER32 and `api-ms-win-crt-*`/`ucrtbase`. It hard-fails on `libstdc++-6`, `libgcc_s_seh-1`, `libwinpthread-1`, `VCRUNTIME140` and `MSVCP140`. The exact import set is UNCONFIRMED until a real build, and upstream may need iphlpapi as well.
- linux: `readelf -d` plus the GLIBC cap.

**Recorded toolchain.** Host-adapter `:164-165` and verifier `:116-117` record `clang++ --version` and `xcrun`. For win32 and linux, record `gcc --version` and the MSYS2 package list instead.

**Determinism**
- win32: `-Wl,--no-insert-timestamp`.
- All targets: `-ffile-prefix-map`.
- Add the `SOURCE_DATE_EPOCH`/`ZERO_AR_DATE` environment that host-adapter `:96` sets to the verifier's `run()` at `:64-66`, which currently sets neither.

### (b) Manifests: one `files` entry per platform

Files:
- `projects/keepkey-vault/monero-cli/host-adapter-manifest.json`
- `projects/keepkey-vault/monero-cli/core-verifier-manifest.json`

Add entries for `win32-x64`, `linux-x64` and `darwin-x64`:

| Platform | Host adapter | Core verifier |
|---|---|---|
| win32-x64 | `monero-host-adapter.exe` | `monero_core_verify.dll`, exports `monero_core_verify` and `monero_core_plan_size` with no leading underscore |
| linux-x64 | ELF binary | `libmonero_core_verify.so` |
| darwin-x64 | as darwin-arm64 | `libmonero_core_verify.dylib` |

Each entry needs:
- its own sha256 and size, copied in full from the first CI run in a reviewed commit
- a dependency allow-list
- a per-platform `qualification` block (today's block describes Apple clang 21.0.0 and SDK 26.4)

Also add `archiveSources` URLs for all seven pinned archives. Today only openssl-3.5.9 has a URL, and CI cannot fetch the others. Where the other URLs came from is UNCONFIRMED.

### (c) Runtime gates and file names

`projects/keepkey-vault/src/bun/monero-device-signing.ts`
- `:132`: remove the `process.platform!=='darwin'||process.arch!=='arm64'` early return and let the manifest decide. The lookup roots at `:133` already work on any platform.
- `:119-120` `checkedLibrary`: skip the `0o022` mode check on win32, as `monero-sidecar.ts:38` and `monero-node.ts:32` already do.
- `:162-164` research prover path: per the comment at `:128`, capability firmware needs only the core verifier, so `libmonero_device_proof.dylib` is out of scope for production. Leave this path gated to darwin-arm64.
- Note: `VERIFY_SHA` at `:17` is a different build from the manifest verifier. If that path is ever ported, it needs a second pin per platform; it cannot reuse the manifest entry.

`projects/keepkey-vault/src/bun/monero-core-verifier-artifact.ts`
- `:10,14-17` `moneroCoreVerifierHostSupported`: make `minimumMacosVersion`/`minimumDarwinMajor` optional and apply them only to darwin keys. Today `os.release()` on Windows (`10.0.x`) and on Linux (kernel major) fails the check.
- `:20-21` `regular()`: add the win32 mode exemption.
- `:58-69` signed fallback: this path is macOS-only (it uses codesign). Use the raw-hash policy on win32 and linux (see (d)).

`projects/keepkey-vault/src/bun/monero-node.ts`
- `:59` (`/Volumes` check) and `:92`/`:103` (non-linux process-command lookup): confirm what they do on win32 (UNCONFIRMED).

No change needed:
- `src/bun/index.ts:1542,1948,2501,11125`
- `src/mainview/components/DeviceSettingsDrawer.tsx:1628,1730,1731`
- `monero-cli/src/host-adapter.ts` (already has the win32 exemption at `:19`)

### (d) Staging, verification and packaging

**`electrobun.config.ts`** (`projects/keepkey-vault/electrobun.config.ts`)
- `:44,54` (adapter) and `:63,69` (verifier) hard-code `monero-host-adapter` and `libmonero_core_verify.dylib`. Derive them from `hostAdapterArtifact().filename` / `moneroCoreVerifierArtifact().filename`. Otherwise the `.exe` and `.dll` are silently left out of the package.
- The wallet tools already use `.exe` via `isWindows` (`:35-38,48`).

**`scripts/build-signed.ts`**
- `:102`: use the manifest filename for the adapter.
- `:100-109`: limit the Developer ID requirement and the `sign-monero-core-verifier.ts` call to darwin.
- `:169`: receipt `bundleRelativePath` is hard-coded to `Contents/Resources/app/monero-device/libmonero_core_verify.dylib`. Make it per-platform, or darwin-only.

**`scripts/sign-monero-core-verifier.ts`** (`:8,25`): darwin-only (it calls codesign). Skip it on win32 and linux.

**Windows signing policy: raw hash.** `scripts/build-windows-production.ps1` (repo root) signs every PE file in the bundle (around lines 217-320). Exclude `monero-host-adapter.exe` and `monero_core_verify.dll` from signtool so the raw manifest sha256 matches. Whether the current skip list would exclude them is UNCONFIRMED.

The script never mentions Monero and calls `bun run build` (`:469,595`), not `build-signed.ts`. Add an explicit check that the Monero files are present, honoring `KEEPKEY_REQUIRE_MONERO_SIDECAR=1`. Whether the Windows build reaches the `build-signed.ts` gate today is UNCONFIRMED.

**`scripts/verify-release-bundle.ts`** (`:83-92`): add win32 and linux branches that call `moneroReleaseAssetProblems(appDir, 'win32-x64' | 'linux-x64', ...)`.

**`scripts/monero-release-assets.ts`**
- `:26`: replace `--config=/dev/null` with `NUL` on win32.
- `:39,50-51`: add `.exe` to `monero-wallet-rpc` and `monerod`.
- Packaged Bun path `../../MacOS/bun`: use the Windows Bun location (UNCONFIRMED layout).
- The probe symbol names must match each platform's exports.

**darwin-x64 only:** `scripts/sign-macos-app.sh:45-49,64-68,141` keeps its own list of Monero paths. Check it.

**linux:** check whether `scripts/collect-externals.ts:766-779` (signs every .dylib/.so) runs on that bundle (UNCONFIRMED). If it does, exclude the verifier `.so`.

No change needed: `scripts/stage-monero-adapter.ts` and `scripts/stage-monero-core-verifier.ts` are already generic once the manifest keys exist.

### (e) CI job that builds and uploads

File: `.github/workflows/build.yml`

New job `monero-native-win32-x64`:
- `runs-on: windows-2022`, `timeout-minutes: 120`, no `needs`.
- Toolchain: `msys2/setup-msys2@v2` with `msystem: UCRT64` and pinned `mingw-w64-ucrt-x86_64-{gcc,cmake,ninja,perl,python,pkgconf}` plus `make`.
- Archives: an `actions/cache` keyed on the `archivesSha256` values. A fetch step reads `source.archiveSources`, downloads each archive and fails on any sha256 mismatch.
- Build both scripts with `--target win32-x64`.
- Print the full sha256 values and the `objdump -p` imports, then fail on any non-allow-listed import.
- Upload the artifact `monero-native-win32-x64`.
- First run reports the hashes, which are pinned in a reviewed commit. Later runs must match the pins (reproducibility gate).

After review, the owner may choose to publish the bytes to a new `monero-native-<date>` tag (the port work stops at CI artifacts and never publishes):
- pre-release, never Latest
- per-platform asset names such as `monero-host-adapter-win32-x64.exe` and `monero_core_verify-win32-x64.dll`, which never collide with app asset names
- bump `MONERO_NATIVE_RELEASE_TAG` at `:33`

Same job shape for:
- `linux-x64`: in a pinned old-glibc container
- `darwin-x64`: on `macos-15-intel`

Then change the download and `--require` staging steps at `:316-336` from "arm64 only" to per-platform. Also check the other `expected-arch == 'arm64'` gates at `:266,385,415,462` (whether they touch Monero is UNCONFIRMED).

### (f) The `windows-unsigned` job stages and smoke-tests Monero

Same file, the `windows-unsigned` job at `:901-985`.
- Set `needs: [device-protocol-lib, monero-native-win32-x64]`, or download from the release tag.
- After the Zig step (bash):
  1. `python monero-cli/prepare.py`
  2. download the artifact into `.reviewed-monero`
  3. `bun scripts/stage-monero-adapter.ts --require --source .reviewed-monero/monero-host-adapter.exe`
  4. `bun scripts/stage-monero-core-verifier.ts --source .reviewed-monero/monero_core_verify.dll`
  5. add `MONERO_CORE_VERIFY_DIR` to `$GITHUB_ENV`
  6. `bun run monero:build && bun run monero:test`
- Set `KEEPKEY_REQUIRE_MONERO_SIDECAR: '1'` on the Build (unsigned) step.
- After the build: unpack the `release-windows` payload and run `bun monero-cli/package-smoke.ts --app-dir=<dir containing monero-tools/monero-tools.json>`.

### (g) Tests to update

App-relative paths:
- `__tests__/monero-release-assets.test.ts:95-99`: today it asserts win32-x64, linux-x64 and darwin-x64 return no problems. Flip it to require the artifacts. Also review `:13-16,46-110`.
- `__tests__/monero-core-verifier-artifact.test.ts:14,24`: add per-platform cases, including win32 `os.release()='10.0.22631'` and the mode exemption.
- `__tests__/monero-preview-gates.test.ts:53-69,166`
- `monero-cli/src/host-adapter.test.ts:16`: add `.exe` filename cases.
- `src/bun/monero-send.test.ts:1582` and `src/bun/monero-stream-signer.test.ts:181`: check them.
- `src/bun/monero-emulator.test.ts:65-66`: unchanged (the emulator stays darwin-arm64).
- New: an `electrobun.config.ts` test that the adapter and verifier names come from the manifest.

## 4. Mac + CI versus the Windows 11 PC

**From the Mac + CI:**
- every code change in (a), (c), (d) and (g), plus the YAML in (e) and (f)
- the OpenSSL pinning fix
- the darwin-x64 build (Intel runner)
- the linux-x64 build (container)
- running the Windows build on the windows-2022 runner, reading its hashes and imports, pinning them, and (owner's decision) publishing the pre-release tag
- the CI package smoke test on Windows

**Needs the Windows 11 PC:**
- debugging MinGW build failures that need fast local iteration (optional; CI can do it more slowly)
- confirming that the installed app's Bun FFI loads the DLL
- the real KeepKey test over HID/WebUSB on Windows: receive, send, and verifying on the device

## 5. Windows PC handoff: manual test with a real KeepKey (firmware 7.17)

**Prerequisites**
- A Windows 11 x64 PC with a KeepKey on firmware 7.17 that holds a small amount of XMR, or that will receive some in step 6.
- A second wallet to send to. Never use the owner's contacts.
- The owner must approve any real-money send before step 8.

**Steps**
1. Download the `ci-windows-unsigned` artifact from the green `build.yml` run on the branch. Its URL is UNCONFIRMED until the run exists; open `https://github.com/keepkey/keepkey-vault/actions/workflows/build.yml` and choose that run. The repo is `keepkey/keepkey-vault`.
2. Record the artifact's full sha256 (`Get-FileHash -Algorithm SHA256 <file>` in PowerShell). Install the unsigned build. SmartScreen will warn because the build is unsigned.
3. Check the install folder for `monero-tools\monero-host-adapter.exe` and `monero-device\monero_core_verify.dll`. Run `Get-FileHash` on both and compare each against the full sha256 in its `win32-x64` manifest entry. The exact install root is UNCONFIRMED.
4. Start KeepKey Desktop, connect the KeepKey and unlock it with the PIN.
5. Open Settings (the device settings drawer) and turn on the Monero flag. It must NOT show "Monero is unavailable in this build." Where the flag lives is UNCONFIRMED; it is driven by `moneroAvailable`.
6. Open the Monero asset and let it sync with a node, either the bundled monerod or a remote node. Record how long it took and the height it reached.
7. Receive: show the receive address. Compare the full address on Desktop with the full address on the KeepKey screen, page by page. It must never be shortened. Fund it with a small amount and wait for it to confirm.
8. Small send (approved by the owner): send the minimum practical amount to the second wallet. On the device, check the full recipient address (all pages), the amount and the fee, then confirm. Record the full txid.
9. Check the txid on a block explorer and confirm that the recipient wallet received the funds.

**What to capture**
- Desktop logs. The Windows log path is UNCONFIRMED; check `%APPDATA%` and `%LOCALAPPDATA%` for a KeepKey folder and send the full path found.
- Screenshots of: the Settings Monero toggle, sync finished, the receive address on Desktop and photos of every device page, the send review, every device confirmation page, and the result screen with the txid.
- The full sha256 values from steps 2-3, the Windows build number (`winver`), and the firmware version shown in Desktop.

**Pass criteria (all must hold)**
- Monero shows as available.
- Both native file hashes match the manifest exactly.
- Sync finishes.
- The receive address matches in full on Desktop and on the device.
- The send is signed on the device, broadcast, and confirmed on-chain to the right recipient for the right amount.
- No crash, and no "unavailable" or verifier error in the logs.

**Fail criteria (any one)**
- The "unavailable in this build" message appears.
- A hash mismatches.
- A DLL fails to load, or a missing-DLL dialog appears (for example libstdc++-6 or libwinpthread-1).
- An address is shortened or doesn't match.
- The device shows different details than Desktop.
- The send hangs or is rejected.

Report failures with the log excerpt and screenshots.
