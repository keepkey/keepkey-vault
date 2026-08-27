# Windows Build & Signing SOP

The linear procedure for cutting a signed KeepKey Vault Windows release. Pairs with [`WINDOWS-DEV-SETUP.md`](./WINDOWS-DEV-SETUP.md) (first-time machine setup), [`WINDOWS-BUILD-QUIRKS.md`](./WINDOWS-BUILD-QUIRKS.md) (build/sign/package gotchas), and [`WINDOWS-QUIRKS.md`](./WINDOWS-QUIRKS.md) (runtime gotchas).

The build, signing, and installer steps are all driven by **one PowerShell script**: [`scripts/build-windows-production.ps1`](../scripts/build-windows-production.ps1). This document explains what the script does, what to verify, and how to recover from common failures.

---

## TL;DR

```powershell
# From the repo root (PowerShell 5.1+), USB EV signing token plugged in:
# First download the matching CI artifact's emulator-build-input DLL and save it as:
# projects\keepkey-vault\emulator-bundle\libkkemu.dll
.\scripts\preflight-windows.ps1 -Strict
.\scripts\build-windows-production.ps1
```

Output: `release-windows\KeepKey-Vault-<version>-win-x64-setup.zip` (contains the
EV-signed `setup.exe` + `setup-*.bin`) and `SHA256SUMS-windows.txt`. **Ship the
`.zip`, not a bare `.exe`** — see [Smart App Control](#smart-app-control-ship-a-zip-not-a-bare-exe).

To rebuild the installer from an existing build tree without rebuilding sources:

```powershell
.\scripts\build-windows-production.ps1 -SkipBuild
```

To produce an unsigned test build (no token required):

```powershell
.\scripts\build-windows-production.ps1 -SkipSign
```

---

## Prerequisites

A fully provisioned build machine. If this is a fresh box, follow [`WINDOWS-DEV-SETUP.md`](./WINDOWS-DEV-SETUP.md) first.

**Tools** (all must be on PATH or in their standard install location):
- Bun, Yarn, Git
- Windows SDK (provides `signtool.exe`)
- Inno Setup 6 (provides `ISCC.exe`)
- Zig compiler (`winget install zig.zig`) — builds the launcher wrapper EXE
- Rust + cargo — builds the `zcash-cli` sidecar
- `cmd.exe` and `robocopy` — present on every Windows install

**Signing artifacts**:
- USB EV code-signing token plugged in and unlocked (PIN entered at least once in this session — the script triggers signtool which prompts when needed)
- Certificate visible in either `Cert:\CurrentUser\My` or `Cert:\LocalMachine\My`
- Default thumbprint baked into the script is the KEY HODLERS LLC EV cert (`986AEBA61CF6616393E74D8CBD3A09E836213BAA`). To use a different cert, set `$env:KK_SIGN_THUMBPRINT` or pass `-Thumbprint`.

**Repo state**:
- Clean checkout on the release branch (e.g. `release/X.Y.Z`) with all expected submodules initialized — the script handles submodule init itself, but a dirty tree will produce a dirty build
- `modules/device-protocol/lib/messages_pb.js` **must exist** (see [The device-protocol pitfall](#the-device-protocol-pitfall) below)
- `projects/keepkey-vault/emulator-bundle/libkkemu.dll` must be the
  `emulator-build-input-libkkemu-7.16.0-win-x64.dll` from the matching commit's
  macOS CI artifact. The build rejects a missing/non-PE DLL and verifies that
  Electrobun copied the exact SHA-256 into the app.

---

## What the script does (step by step)

The script is one continuous flow. Each step exits hard on failure unless explicitly marked tolerant. Refer to line numbers in `scripts/build-windows-production.ps1` if you need to debug a specific stage.

### 1. Pre-flight checks (lines ~205-252)
Verifies `signtool`, `ISCC`, `git`, `bun`, `yarn` are reachable. Loads the EV cert by thumbprint and warns if it expires in under 30 days. Fails fast with actionable messages if anything is missing.

### 2. Submodule init (lines ~258-267)
Only initializes the modules the build actually needs:
- `modules/hdwallet`
- `modules/proto-tx-builder`
- `modules/device-protocol`

The Windows machine does not compile firmware. CI cross-builds the DLL from the
Vault's exact firmware gitlink, verifies 7.16.0, the ClearSign alpha root, all
12 FFI exports, and system-only imports. The PowerShell build consumes that
verified DLL and Authenticode-signs the copy inside the app.

### 3. device-protocol `lib/` verification (lines ~269-283)
Checks that `modules/device-protocol/lib/messages_pb.js` is present. If missing, the script aborts with instructions. This file is gitignored — see [The device-protocol pitfall](#the-device-protocol-pitfall).

### 4. Dependency builds (lines ~285-304)
- `bun install` inside `modules/proto-tx-builder`
- `yarn install && yarn build` inside `modules/hdwallet`
- `bun install` inside `projects/keepkey-vault` (tolerates ENOENT on deeply nested `file:` deps — `collect-externals.ts` resolves these later)

### 5. zcash-cli sidecar (lines ~306-316)
`cargo build --release` inside `projects/keepkey-vault/zcash-cli`. If the directory is missing, Zcash shielded features are silently disabled in the resulting build (non-fatal).

### 6. Electrobun build (lines ~318-321)
`bun run build` — produces `_build/dev-win-x64/keepkey-vault-dev/`. Build channel is patched from `dev` to `stable` at runtime (line ~325) because Electrobun's native `--env=stable` produces a macOS-style bundle on Windows.

**Bundled Bun must be a non-AVX-safe baseline build.** `electrobun.config.ts` pins `build.bunVersion` (≥ `1.3.14`) so the build downloads a known-good Bun instead of whatever ships with the pinned Electrobun. On Windows the override always fetches `bun-windows-x64-baseline.zip` (the baseline/non-AVX variant). This is the second half of the non-AVX launch fix: the `-mcpu=baseline` wrapper (step 9) lets the app *reach* `bun.exe`, and a baseline Bun ≥ 1.3.14 (baseline WebKit + the JSC AVX-gating fix) ensures `bun.exe` itself runs on no-AVX CPUs. Bun 1.3.9 (the old Electrobun 1.13.1 default) sits inside an upstream non-AVX regression window — do not ship it. **Verify after build:** the bundled `bun.exe` banner reads `Bun v<ver> ... Windows x64 (baseline)` with `<ver>` ≥ 1.3.14, and the bundle's `version.json` records the same. See §5 of [`windows-non-avx-launcher-crash.md`](./windows-non-avx-launcher-crash.md).

### 7. Bulk signing (lines ~360-396)
Scans `*.exe`, `*.dll`, and `*.node` under `bin/` and `Resources/`; native `.node` addons and Bun `.bin` shims are skipped because they are not signable PE files. The wrapper EXE (`KeepKeyVault.exe`) is rebuilt and signed later in step 9.

Skip patterns (treated as success):
- `.node` files — signtool doesn't support native addon binaries
- Files under `.bin\` — Bun shims with `.exe` extension are shell scripts, not real PE
- Files already validly signed (no double-sign)

**Failure handling**: any unexpected signing failure aborts the run unless `-AllowSignFailures` is passed. Mixed signed/unsigned in a release would trigger SmartScreen on the unsigned binaries and break enterprise allowlists.

### 8. Icon prep (lines ~402-462)
Converts the renamed-PNG `Resources/app.ico` to a real multi-size ICO (16/32/48/256px) using `System.Drawing`. `LoadImageW` at runtime can't load PNGs disguised as ICO, so this step is required for the title bar / taskbar icon.

### 9. Build wrapper EXE + rcedit + re-sign (lines ~464-588)
- Compiles `scripts/wrapper-launcher.zig` to `KeepKeyVault.exe` via Zig (`-target x86_64-windows -mcpu=baseline -O ReleaseSmall --subsystem windows`)
  - **`-mcpu=baseline` is load-bearing — do not drop it.** Without it Zig defaults to `-mcpu=native` and compiles the wrapper for the *build box's* CPU (AVX2), baking a VEX `vmovdqa` into `main()`'s prologue. On a no-AVX CPU (e.g. Intel Pentium Silver N5030 "Gemini Lake", SSE4.2 only) the app dies instantly at launch with `0xC000001D STATUS_ILLEGAL_INSTRUCTION` at `KeepKeyVault.exe+0x1b96`, before `bun.exe` ever runs. `baseline` = x86-64-v1, runs everywhere. See [`windows-non-avx-launcher-crash.md`](./windows-non-avx-launcher-crash.md).
  - **Verify baseline after build:** disassemble the produced `KeepKeyVault.exe` and confirm **zero** AVX/VEX instructions (`vmov*`, `vxor*`, `vpxor`, …); the byte sequence `c5 f9 7f` must be absent. PE sanity: `.text` VSize ≈ `0x5A46` (baseline), not `0x5CB6` (the AVX build that shipped in 1.4.3).
- Copies the DPI manifest next to the wrapper
- Runs `rcedit` to embed the icon into the wrapper and `launcher.exe`
- **Re-signs** both rcedit-modified EXEs — `rcedit` invalidates Authenticode signatures because `BeginUpdateResource` modifies the `.rsrc` section. Without this, the user-launched binary ships unsigned.

### 10. MAX_PATH staging (lines ~597-614)
The build tree has paths >260 chars (deep `node_modules`). Inno Setup silently skips such files. Workaround: use `robocopy` to stage everything into `C:\tmp\kk` first. Do not pass `/256`; that disables robocopy long-path support.

### 11. Inno Setup compile + installer sign (lines ~616-657)
`ISCC` produces `release-windows\KeepKey-Vault-<version>-win-x64-setup.exe`, then `signtool` signs the installer itself. The WebView2 bootstrapper is bundled into the installer and runs at install time (required on Windows 10).

### 12. Checksums (lines ~661-680)
Writes `release-windows\SHA256SUMS-windows.txt` covering every Windows artifact in the output directory. The CI draft-release job owns the combined `SHA256SUMS.txt`, so the Windows checksum file is platform-scoped to avoid clobbering it during manual upload.

---

## The device-protocol pitfall

`modules/device-protocol/lib/` is `.gitignore`d. The compiled protobuf files (`messages_pb.js`) only exist if built locally. **You cannot build `device-protocol` on Windows out of the box** — its `build:postprocess` step uses BSD `sed`, which is not present on Windows.

The script fails fast with this message:

```
FATAL: modules/device-protocol/lib/messages_pb.js is MISSING
This file is gitignored and must be built before the Windows build runs.
```

**Three ways to get `lib/`**:

1. **Build it on macOS / Linux**, then copy `modules/device-protocol/lib/` to the Windows machine. This is what the script docstring suggests. Works but is annoying.

2. **Use WSL** on the same Windows box:
   ```bash
   wsl
   cd /mnt/c/Users/<you>/kk/keepkey-vault/modules/device-protocol
   npm install
   npm run build
   exit
   ```
   The `lib/` directory is shared between WSL and Windows because of the `/mnt/c` path.

3. **Use Git Bash** with a real `sed` (Git Bash ships GNU sed):
   ```bash
   cd modules/device-protocol
   npm install
   npm run build
   ```
   Verify with `ls lib/messages_pb.js` afterward. This is the lightest-weight option and works on most setups.

After the file exists once, subsequent builds reuse it. Commit-or-don't is a separate policy question — currently we don't commit it.

---

## Smart App Control: ship a `.zip`, not a bare `.exe`

**This shipped broken in 1.4.11.** A normal single-file Inno installer
(`UseSetupLdr=yes`, the default) is a self-extractor: at runtime it unpacks an
**unsigned** `setup.tmp` engine into `%TEMP%\is-*` and executes it. **Smart App
Control (SAC)** and WDAC block unsigned code, so on any Windows 11 machine with
SAC on (the default on many clean installs) the installer dies immediately with
"Setup failed to initialize" (exit code 1) and logs **CodeIntegrity 3077/3033**
in `Microsoft-Windows-CodeIntegrity/Operational`. The outer `setup.exe` being
EV-signed does not help — SAC evaluates the extracted `setup.tmp` on its own, and
that file is never signed (stock Inno cannot sign it).

**The fix (already in `installer.iss` + `build-windows-production.ps1`):**
`UseSetupLdr=no`. With no loader there is no `setup.tmp`; the EV-signed `setup.exe`
IS the engine and runs in-process, so SAC only sees the signed exe and allows it.
Inno then emits `setup.exe` + `setup-*.bin`, which the build script zips into
`KeepKey-Vault-<version>-win-x64-setup.zip`. Users extract the zip and run
`setup.exe`. **Only the `.zip` is uploaded; never a bare `.exe`.**

**The app itself is SAC-clean** — every shipped binary (`KeepKeyVault.exe`,
`launcher.exe`, `bin\bun.exe`, DLLs) is EV-signed and runs under SAC without a
block. Only the installer's extracted `setup.tmp` was the problem.

> **You MUST test the installer on a machine with Smart App Control ON (Enforce)
> before every release.** SAC-off machines install fine even with the broken
> single-exe — that is exactly how 1.4.11 slipped through (the 1.4.7 smoke test
> ran on a SAC-off box). Verify no 3077/3033 appears:
> ```powershell
> Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-CodeIntegrity/Operational';Id=3077,3033;StartTime=(Get-Date).AddMinutes(-5)}
> # (also confirm SAC is actually on: (Get-MpComputerStatus).SmartAppControlState -eq 'On')
> ```

Full incident write-up: [`docs/incidents/1.4.11-smart-app-control-installer-block.md`](./incidents/1.4.11-smart-app-control-installer-block.md).

---

## Verifying the release

After the script finishes, verify everything before uploading:

```powershell
$out = "release-windows"

# 1. Installer is signed
$installer = Get-ChildItem "$out\*.exe" | Select-Object -First 1
Get-AuthenticodeSignature $installer.FullName | Format-List
# Status should be: Valid

# 2. The signature includes a timestamp counter-signature
signtool verify /pa /v $installer.FullName
# Look for "The signature is timestamped"

# 3. SHA256SUMS-windows matches
Get-Content "$out\SHA256SUMS-windows.txt"
(Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLower()
# Should match
```

**End-to-end smoke**:
1. Run the installer on a fresh Windows VM (or a machine that's never had KeepKey Vault installed)
2. Confirm the install dir is `%LOCALAPPDATA%\Programs\KeepKeyVault\` with no spaces
3. Plug in a KeepKey and verify the splash advances to the dashboard
4. Open `%LOCALAPPDATA%\com.keepkey.vault\vault-backend.log` and confirm the `[Boot] platform=win32` line appears at the top (the sync logger from 1.2.14 — if it's missing, the worker died early)

---

## Common failures

### `signtool: 0x8009200D` or "no certificates found"
The USB EV token isn't reachable. Re-plug the token, unlock it with the management software (SafeNet / Sectigo Code Signing tool), then re-run.

### `signtool: 0x80096004` or timestamp errors
DigiCert is rate-limiting or down. The script now retries Sectigo and GlobalSign automatically — if all three fail, wait 5 minutes and re-run.

### `Inno Setup compilation failed`
Almost always a MAX_PATH issue. Inno silently drops files; the compile fails when a needed file is missing. Confirm `$ShortStage` was populated:

```powershell
(Get-ChildItem -Recurse -File "C:\tmp\kk" | Measure-Object).Count
# Should be ~13,000+ files
```

If the count is low, robocopy hit a problem. Run it manually with full output:

```powershell
robocopy "projects\keepkey-vault\_build\dev-win-x64\keepkey-vault-dev" "C:\tmp\kk" /E
```

### `FATAL: modules/device-protocol/lib/messages_pb.js is MISSING`
See [The device-protocol pitfall](#the-device-protocol-pitfall) above.

### `Failed to compile wrapper EXE with Zig`
Zig not on PATH or not installed. `winget install zig.zig` and reopen the PowerShell session.

### Wrapper EXE has wrong icon / "unknown publisher"
This used to happen because `rcedit` invalidated the wrapper signature after signing. The script now re-signs after rcedit. If you see it on a current build, the re-sign step (line ~575) failed silently — check the build log for `[ERROR] Failed to sign: KeepKeyVault.exe`.

### App installs but shows no window
Most likely WebView2 is missing on Windows 10. The installer should have run the WebView2 bootstrapper (`MicrosoftEdgeWebview2Setup.exe`). Check `Add or Remove Programs` for "Microsoft Edge WebView2 Runtime"; if absent, run the bootstrapper manually.

For deeper diagnosis read `%LOCALAPPDATA%\com.keepkey.vault\vault-backend.log` and `HANDOFF-1.2.14-WIN10-WATCHDOG-CRASH.md` (sync logger details).

---

## Re-signing an existing installer

If you need to re-sign a pre-built installer (cert rotation, missed timestamp, etc.):

```powershell
$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
$thumb    = "986AEBA61CF6616393E74D8CBD3A09E836213BAA"
$ts       = "http://timestamp.digicert.com"

& $signtool sign /sha1 $thumb /fd sha256 /tr $ts /td sha256 `
    /d "KeepKey Vault Installer" `
    "release-windows\KeepKey-Vault-<version>-win-x64-setup.exe"

# Verify
& $signtool verify /pa /v "release-windows\KeepKey-Vault-<version>-win-x64-setup.exe"
```

---

## Script parameters reference

| Param | Default | Purpose |
|---|---|---|
| `-SkipBuild` | off | Reuse existing `_build/`; only sign + package |
| `-SkipSign` | off | Build + package without signing (test builds) |
| `-Thumbprint` | hardcoded | Cert thumbprint override; also reads `$env:KK_SIGN_THUMBPRINT` |
| `-TimestampUrls` | digicert/sectigo/globalsign | First-success retry list; pass a custom array if your CA is different |
| `-OutputDir` | `release-windows` | Final artifact directory |
| `-AllowSignFailures` | off | Don't abort on signing errors (for iteration on a non-signing machine) |

---

## Release checklist

Before tagging and uploading:

- [ ] Working tree is clean on the release branch (`git status` is empty)
- [ ] `package.json` version matches the intended release
- [ ] `modules/device-protocol/lib/messages_pb.js` is present
- [ ] Matching CI DLL is staged at `projects\keepkey-vault\emulator-bundle\libkkemu.dll`
- [ ] EV token plugged in, unlocked, certificate visible
- [ ] Run `.\scripts\preflight-windows.ps1 -Strict`
- [ ] Run `.\scripts\build-windows-production.ps1`
- [ ] **Non-AVX:** `KeepKeyVault.exe` disassembles to **0** AVX/VEX instructions (`.text` VSize ≈ `0x5A46`; `c5 f9 7f` absent) — see step 9
- [ ] **Non-AVX:** bundled `bun.exe` banner reads `Windows x64 (baseline)` and version ≥ 1.3.14 — see step 6
- [ ] Verify installer signature via `signtool verify /pa /v` (on the extracted `setup.exe`)
- [ ] **Smart App Control:** extract the `.zip` and run `setup.exe` on a machine with **SAC ON (Enforce)** — installs with **no** CodeIntegrity 3077/3033. This is mandatory and non-negotiable (see [Smart App Control](#smart-app-control-ship-a-zip-not-a-bare-exe)); SAC-off machines are NOT a valid test.
- [ ] Smoke-test the installer on a clean Windows VM
- [ ] **Non-AVX (if hardware available):** app launches past the splash on a no-AVX CPU (Gemini Lake N5030/N4020) instead of `0xC000001D`
- [ ] Compare `SHA256SUMS-windows.txt` against the `.zip` hash
- [ ] Upload the **`.zip`** (NOT a bare `.exe`) and `SHA256SUMS-windows.txt` to the GitHub release
- [ ] Run the installed app, pair a real device, confirm `vault-backend.log` has the expected boot lines
- [ ] Add an emulator without dropping a DLL; confirm it boots and reports firmware 7.16.0
- [ ] On the emulator, run certified ETH→SOL ClearSign; labelled review appears and no Advanced Mode prompt is shown
