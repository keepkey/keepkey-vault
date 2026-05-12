# Windows Build & Sign Quirks — Complete Reference

Every build/install/sign/package quirk we've encountered, with **symptom → root cause → diagnostic → fix → prevention**. Pairs with [`WINDOWS-QUIRKS.md`](./WINDOWS-QUIRKS.md) (runtime quirks), [`WINDOWS-BUILD-AND-SIGN.md`](./WINDOWS-BUILD-AND-SIGN.md) (release SOP), and [`WINDOWS-DEV-SETUP.md`](./WINDOWS-DEV-SETUP.md) (first-time machine setup).

This document is **deliberately long**. The whole reason build sessions blow up is that quirks compound — you fix one, the next is hiding behind it. If you read this end-to-end before your next release, you can preflight all of them in under a minute and avoid the cascade.

## How to use this doc

- **In a release session, when something fails**: search for the error message verbatim. Every quirk lists the exact text you'll see.
- **Before a release session**: run `scripts/preflight-windows.ps1` (added in this session). It mechanizes the diagnostic from every quirk.
- **When adding a new dep / tool**: read the *Permanent prevention* row of any quirk that touches the same area.

---

## Table of contents

| # | Area | Quirk |
|---|---|---|
| 1 | Environment | [Zig version drift — wrapper-launcher pinned to 0.15.x](#1-zig-version-drift) |
| 2 | Environment | [Bun TLS `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on some packages](#2-bun-tls-unable_to_verify_leaf_signature) |
| 3 | Environment | [Git `core.autocrlf=true` breaks bash scripts](#3-git-autocrlf-breaks-bash-scripts) |
| 4 | Environment | [PowerShell ExecutionPolicy](#4-powershell-executionpolicy) |
| 5 | Environment | [MAX_PATH / long path support](#5-max_path--long-path-support) |
| 6 | Environment | [WebView2 Runtime missing on Windows 10](#6-webview2-runtime-missing-on-windows-10) |
| 7 | Environment | [Working directory drift between bash and PowerShell](#7-working-directory-drift) |
| 8 | Build prerequisite | [`modules/device-protocol/lib/` is gitignored](#8-device-protocollib-gitignored) |
| 9 | Build | [Electrobun `bun run build` is incremental, not clean](#9-electrobun-build-is-incremental) |
| 10 | Build | [`version.json` doesn't auto-track `package.json`](#10-versionjson-doesnt-auto-track-packagejson) |
| 11 | Build | [`bun install` ENOENT on deeply nested `file:` deps](#11-bun-install-enoent-on-file-deps) |
| 12 | Build | [`postinstall` bash script with CRLF endings](#12-postinstall-bash-script-with-crlf) |
| 13 | Build | [Em-dashes in PowerShell string literals](#13-em-dashes-in-powershell-string-literals) |
| 14 | Build | [PowerShell 5 is default — no `&&` chaining, et al.](#14-powershell-5-is-default) |
| 15 | Build | [Pre-bundle backend regression — 393 → 14,800 files](#15-pre-bundle-backend-regression) |
| 16 | Sign | [Cert thumbprint pinning + env var override](#16-cert-thumbprint-pinning) |
| 17 | Sign | [signtool `0x800700C1 / BAD_EXE_FORMAT` on valid PE](#17-signtool-0x800700c1-bad_exe_format) |
| 18 | Sign | [rcedit invalidates Authenticode signatures](#18-rcedit-invalidates-authenticode-signatures) |
| 19 | Sign | [Cert can be in `CurrentUser\My` or `LocalMachine\My`](#19-cert-in-currentuser-vs-localmachine) |
| 20 | Sign | [Timestamp server flakiness](#20-timestamp-server-flakiness) |
| 21 | Sign | [`.node` and bun shims aren't signable PE files](#21-node-and-bun-shims-arent-signable-pe) |
| 22 | Sign | [Wrapper EXE doesn't exist during the bulk sign loop on clean builds](#22-wrapper-exe-not-signed-on-clean-builds) |
| 23 | Package | [Inno Setup silently drops files with paths >260 chars](#23-inno-setup-max_path-silent-drop) |
| 24 | Package | [`robocopy` default retry kills throughput with Defender](#24-robocopy-default-retry-policy) |
| 25 | Package | [`Expand-Archive` is dog-slow](#25-expand-archive-is-slow) |
| 26 | Package | [PowerShell 5 `-Encoding UTF8` writes BOM, breaks JSON](#26-powershell-5-utf8-bom) |
| 27 | Defender | [Real-time scan dominates build time](#27-defender-real-time-scan) |
| 28 | Install | [No-spaces install path](#28-no-spaces-install-path) |
| 29 | Install | [WebView2 must be bundled into the installer](#29-webview2-must-be-bundled) |
| 30 | Install | [Where to find logs when an install misbehaves](#30-where-to-find-logs) |

---

## 1. Zig version drift

**Symptom**: wrapper EXE compile fails with one of:
```
error: root source file struct 'fs' has no member named 'selfExeDirPath'
error: root source file struct 'fs' has no member named 'cwd'
error: root source file struct 'time' has no member named 'milliTimestamp'
```

**Root cause**: `scripts/wrapper-launcher.zig` was last updated for **Zig 0.15.x** (commit `cfd6ea4`, 2026-03-21, "Zig 0.15.2 compat — DrawTextW sentinel slice to pointer cast"). Zig 0.16 (released ~Apr 2026) shipped the **IO context refactor** that removed:
- `std.fs.cwd()` → now requires `Io` context: `std.fs.cwd(io)`
- `std.time.milliTimestamp()` → relocated, requires `Io`
- `std.fs.selfExeDirPath` → removed entirely; moved to `std.process.executableDirPath(io, ...)`

The build script auto-detects whichever `zig` is on PATH. Nothing in the repo pins a version.

**Diagnostic**:
```powershell
zig version   # 0.15.x → fine, 0.16.x → broken
```

**Fix**: install Zig 0.15.1 to `$env:USERPROFILE\tools\zig-x86_64-windows-0.15.1\`. The build script now checks this location first.
```powershell
Invoke-WebRequest -Uri "https://ziglang.org/download/0.15.1/zig-x86_64-windows-0.15.1.zip" `
    -OutFile "$env:USERPROFILE\tools\zig-0.15.1.zip" -UseBasicParsing
& "C:\Windows\System32\tar.exe" -xf "$env:USERPROFILE\tools\zig-0.15.1.zip" -C "$env:USERPROFILE\tools"
```

(Use `tar.exe` from `System32`, not PowerShell's `Expand-Archive` — see [quirk 25](#25-expand-archive-is-slow).)

**Permanent prevention**: the build script now hard-fails if `zig version` doesn't start with `0.15.`. When Zig releases a new version, update the source and the pin together as a single commit, never piecemeal.

---

## 2. Bun TLS `UNABLE_TO_VERIFY_LEAF_SIGNATURE`

**Symptom**: `bun install` reports:
```
error: UNABLE_TO_VERIFY_LEAF_SIGNATURE downloading package manifest @pioneer-platform/pioneer-discovery
error: UNABLE_TO_VERIFY_LEAF_SIGNATURE downloading package manifest @pioneer-platform/pioneer-client
error: UNABLE_TO_VERIFY_LEAF_SIGNATURE downloading package manifest bs58
```
Other packages download fine. Only a handful fail.

**Root cause**: Corporate proxy / antivirus / Windows TLS inspection presents a different cert chain for specific CDN edges. Some npm packages route through CDNs whose certs Bun's bundled TLS stack doesn't trust. `~/.npmrc` may have `strict-ssl=false` — but **Bun does not honor `strict-ssl=false` from npmrc**. Bun has its own TLS stack and config.

**Diagnostic**:
```powershell
# Check existing npmrc / bunfig state:
Get-Content "$env:USERPROFILE\.npmrc" -ErrorAction SilentlyContinue
Test-Path "$env:USERPROFILE\.bunfig.toml"

# Reproduce in isolation:
cd projects\keepkey-vault
bun install
# Look for UNABLE_TO_VERIFY_LEAF_SIGNATURE lines
```

**Fix** (workaround for one install):
```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
bun install
Remove-Item Env:\NODE_TLS_REJECT_UNAUTHORIZED
```

**Why this is acceptable**: if the user already has `strict-ssl=false` in `.npmrc`, TLS verification is already disabled for npm. This just matches that posture in Bun.

**Permanent prevention**: install the corporate / AV root CA into Bun's trust store, OR add `bunfig.toml` with a CA bundle pointer once Bun ships proper TLS config. Until then, the workaround is fine for builds.

---

## 3. Git autocrlf breaks bash scripts

**Symptom**: `bun install`'s postinstall hook fails with:
```
scripts/patch-electrobun.sh: line 33: syntax error near unexpected token `elif'
scripts/patch-electrobun.sh: line 33: `  elif grep -q ...'
error: postinstall script from "keepkey-vault" exited with 2
```

**Root cause**: Git on Windows defaults to `core.autocrlf=true`, which converts LF → CRLF on checkout. Bash on Windows (Git-Bash) misparses certain shell constructs (`if/elif/fi`, here-docs, etc.) when lines end with CRLF.

**Diagnostic**:
```bash
file projects/keepkey-vault/scripts/*.sh
# "with CRLF line terminators" → broken
# "ASCII text executable"     → fine
```

**Fix** (single file):
```bash
sed -i 's/\r$//' projects/keepkey-vault/scripts/patch-electrobun.sh
```

**Permanent prevention**: add `.gitattributes` at repo root:
```
*.sh text eol=lf
```
This forces LF regardless of `core.autocrlf`. After committing the `.gitattributes`, do `git rm --cached <file> && git add <file>` to renormalize each affected file.

---

## 4. PowerShell ExecutionPolicy

**Symptom**: `.ps1` script doesn't run at all, error similar to:
```
File ... cannot be loaded because running scripts is disabled on this system.
```

**Root cause**: Windows default for current user is `Restricted`. Build/dev scripts are unsigned.

**Fix**:
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Or invoke each script with `-ExecutionPolicy Bypass`:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-production.ps1
```

(The npm scripts in `package.json` already use the `-ExecutionPolicy Bypass` form.)

**Permanent prevention**: document in `WINDOWS-DEV-SETUP.md` as a first-time-machine step. Not changeable from inside the script (chicken-and-egg).

---

## 5. MAX_PATH / long path support

**Symptom**: variable. Specific failures:
- `git submodule update --init --recursive` errors or silently truncates
- `Inno Setup` silently drops files (see [quirk 23](#23-inno-setup-max_path-silent-drop))
- `Copy-Item -Recurse` fails or skips files
- `Test-Path` returns false on a file that actually exists

**Root cause**: Windows path API defaults to `MAX_PATH = 260` characters. Our `node_modules` has deeply nested `@walletconnect/...` and `@swagger-api/...` chains that exceed it.

**Diagnostic**:
```powershell
# Check NTFS long-path policy (system-wide):
(Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled).LongPathsEnabled
# 1 → enabled, 0 → disabled

# Check git's long-path config:
git config --get core.longpaths
# true → enabled
```

**Fix** (one-time per machine, requires admin):
```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
git config --system core.longpaths true
# Reboot recommended.
```

**Permanent prevention**: documented in `WINDOWS-DEV-SETUP.md`. Not all individual tools (e.g. Inno Setup) honor long paths even when the OS does — see [quirk 23](#23-inno-setup-max_path-silent-drop) for the build-time workaround.

---

## 6. WebView2 Runtime missing on Windows 10

**Symptom**: After install, double-clicking `KeepKeyVault.exe` produces **no window, no error, no log**. Process starts then exits silently.

**Root cause**: The app renders its UI via Microsoft WebView2 (Edge Chromium runtime). Windows 11 ships it preinstalled. Windows 10 requires manual install. Without it, `CreateCoreWebView2EnvironmentWithOptions` returns an error that Electrobun handles by exiting silently.

**Diagnostic**:
```powershell
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.name -match "WebView2" }
# Empty → not installed
```

**Fix**: bundled in the installer. `scripts/installer.iss` runs `MicrosoftEdgeWebview2Setup.exe /silent /install` during install. The build script downloads it from `https://go.microsoft.com/fwlink/p/?LinkId=2124703`.

For manual install on Win10:
```powershell
$url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\WebView2Setup.exe" -UseBasicParsing
& "$env:TEMP\WebView2Setup.exe" /silent /install
```

---

## 7. Working directory drift

**Symptom**: `powershell -File scripts/build-windows-production.ps1` errors with:
```
The argument 'scripts/build-windows-production.ps1' to the -File parameter does not exist.
```
Even though the file exists in the repo.

**Root cause**: The Bash tool persists working directory between commands. An earlier `cd projects/keepkey-vault` (e.g. for `bun install`) leaves the shell pointing there. The script path is relative to the repo root.

**Diagnostic**:
```bash
pwd
# Should be /c/Users/.../keepkey-vault
ls scripts/build-windows-production.ps1
```

**Fix**: Always anchor with an explicit `cd` to the repo root before invoking the script:
```bash
cd "/c/Users/Matheus Louzada/kk/keepkey-vault" && powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-production.ps1
```

**Permanent prevention**: scripts that change directory should `Push-Location`/`Pop-Location` to restore on exit. The build script does this internally; the issue is only with the *invocation* from outside.

---

## 8. device-protocol/lib gitignored

**Symptom**: build script aborts with:
```
FATAL: modules/device-protocol/lib/messages_pb.js is MISSING
```

**Root cause**: `modules/device-protocol/lib/` is in `.gitignore`. The compiled protobuf files (`messages_pb.js` and friends) only exist if you've built them locally. Building requires BSD `sed`, which is **not present on Windows**.

**Diagnostic**:
```powershell
Test-Path "modules\device-protocol\lib\messages_pb.js"
```

**Fix**: three options, in order of preference:

1. **Git Bash** (ships GNU sed which works fine):
   ```bash
   cd modules/device-protocol
   npm install
   npm run build
   ls lib/messages_pb.js   # should print
   ```

2. **WSL**:
   ```bash
   wsl
   cd /mnt/c/Users/.../keepkey-vault/modules/device-protocol
   npm install && npm run build
   ```

3. **Copy from another machine** where lib/ is built.

After the first successful build the files persist; you don't need to redo this until someone deletes the submodule or `lib/`.

**Permanent prevention**: see `docs/retro-windows-1.2.6.md`. Long-term fix would be to either commit `lib/` (controversial) or rewrite `build:postprocess` to not require BSD sed.

---

## 9. Electrobun build is incremental

**Symptom**: app installs with wrong version displayed (e.g. you're on `release/1.3.2` but installed app shows `1.2.16`).

**Root cause**: `bun run build` calls `electrobun build` which is **incremental** — it doesn't clean `_build/` first. If you switched branches recently, the old branch's `_build/` artifacts persist. Some files (icons, the wrapper EXE) get overwritten; others (notably `Resources/version.json`) don't, because Electrobun decides they're "current."

This bit us specifically: built on master at `1.2.16` days ago, then switched to `release/1.3.2`, ran the build script. Inno Setup happily packaged the stale 1.2.16 artifacts under a `1.3.2`-named installer EXE.

**Diagnostic**:
```powershell
$build = "projects\keepkey-vault\_build\dev-win-x64\keepkey-vault-dev"
Get-ChildItem $build -File | Sort-Object LastWriteTime | Select-Object Name, LastWriteTime -First 5
# Old timestamps mixed with new = stale state
Get-Content "$build\Resources\version.json"
# Compare version field to (Get-Content projects/keepkey-vault/package.json | ConvertFrom-Json).version
```

**Fix** (always, before a release build):
```powershell
Remove-Item -Recurse -Force projects\keepkey-vault\_build
```

**Permanent prevention**: the build script now (a) forces `version.json` to match `package.json` at patch time, and (b) **emits a warning** when they disagreed. Consider adding an unconditional `_build/` wipe at the top of the script when not `-SkipBuild`.

---

## 10. version.json doesn't auto-track package.json

**Symptom**: same as [quirk 9](#9-electrobun-build-is-incremental) — installed app reports the wrong version.

**Root cause**: Electrobun writes `version.json` based on its own internal state; on incremental builds it doesn't always re-read `package.json`. The Vault runtime reads from `version.json`, not `package.json`.

**Fix**: as of this session the build script always writes `package.json`'s version into `version.json`:
```powershell
$vj.version = $Version   # $Version comes from package.json
```
And warns loudly if they disagreed.

**Permanent prevention**: never trust an Electrobun-emitted version field. Always force from `package.json`. This is now a script-enforced invariant.

---

## 11. bun install ENOENT on file deps

**Symptom**: `bun install` exits non-zero with hundreds of lines like:
```
ENOENT: Failed to open node_modules folder for @cosmjs/socket in C:\Users\...\projects\keepkey-vault\node_modules\@keepkey/hdwallet-keepkey-nodehid\node_modules\@keepkey/hdwallet-keepkey\node_modules\@keepkey/proto-tx-builder\node_modules\@cosmjs/stargate\node_modules\@cosmjs/tendermint-rpc\node_modules
```

**Root cause**: Bun's handling of `file:`-linked workspace packages doesn't recurse correctly through deeply nested transitive deps. The packages reported as missing aren't actually needed at build time — `collect-externals.ts` walks deps separately and resolves them.

**Diagnostic**: harmless if the build later succeeds. If `collect-externals` reports `Verified: all externals resolved`, ignore the ENOENT noise.

**Fix**: tolerate. The build script already does:
```powershell
$ErrorActionPreference = 'Continue'
bun install
$ErrorActionPreference = 'Stop'
```

**Permanent prevention**: not really fixable from our side — it's a Bun limitation. Watch Bun release notes for `file:` link improvements. If we ever rip out the `@keepkey/*` `file:` deps and publish them, this goes away.

---

## 12. postinstall bash script with CRLF

See [quirk 3](#3-git-autocrlf-breaks-bash-scripts) — same root cause, but specifically about `projects/keepkey-vault/scripts/patch-electrobun.sh`, which runs as a npm `postinstall` hook after `bun install`. Failure surfaces only on Windows, and only on a fresh checkout where Git's `core.autocrlf` rewrote the LFs.

---

## 13. Em-dashes in PowerShell string literals

**Symptom**:
```
Unexpected token 'the' in expression or statement.
ParserError: ...
```
on lines that include an em-dash (`—`) inside a double-quoted string in a `.ps1` file.

**Root cause**: PowerShell 5.1's parser tokenizes the contents of a double-quoted string at parse time, looking for variable interpolation and escape sequences. Em-dashes inside the string trip the tokenizer when the file is interpreted under certain encodings.

Em-dashes **inside `#` comments are fine** — comments are skipped at the line level.

**Diagnostic**:
```bash
grep -n "—" scripts/build-windows-production.ps1
# Audit every match: is it inside a "string" or a # comment?
```

**Fix**: replace em-dashes inside string literals with ASCII `--`:
```powershell
# Bad:
throw "Cannot find version — ensure package.json is valid"
# Good:
throw "Cannot find version -- ensure package.json is valid"
```

**Permanent prevention**: this is a soft rule that's easy to break (Claude defaults to em-dashes in narrative writing). A linter check would catch it. Listed in [`retro-windows-1.2.6.md`](../projects/keepkey-vault/docs/retro-windows-1.2.6.md) as a recurring footgun.

---

## 14. PowerShell 5 is default

**Symptom**: scripts that work locally on PowerShell 7 fail on the user's machine, often silently or with strange parser errors. Patterns that don't exist in 5.1:
- `&&` and `||` chaining (`cmd1 && cmd2`)
- Ternary `?:`
- Null-coalescing `??` and `?.`
- `ConvertFrom-Json -AsHashtable`
- Some `Get-MpPreference` quirks

**Root cause**: Windows ships PowerShell 5.1 (Windows PowerShell) by default. PowerShell 7+ ("pwsh") is a separate install. The build script targets 5.1 for compatibility.

**Diagnostic**:
```powershell
$PSVersionTable.PSVersion
# 5.1.x → PowerShell 5, 7.x → pwsh
```

**Fix**: don't use post-5.1 features in build scripts. For chaining:
```powershell
# Bad:
git status && git diff
# Good:
git status; if ($?) { git diff }
```

**Permanent prevention**: keep scripts 5.1-compatible. Document at top of any `.ps1`: `# Targets PowerShell 5.1 — no &&, no ternary, no ??`.

---

## 15. Pre-bundle backend regression

**Symptom**: build is dog-slow at robocopy stage (~14,800 files to stage), Defender chews through them all. First-launch on Windows takes 30-56 seconds while Defender scans the 14k JS files.

**Root cause**: commit `cc9181e` ("perf: pre-bundle backend — 13,400 files to 393") set up `bundle-backend.ts` to inline pure-JS deps into a single 6.5 MB `Resources/app/bun/index.js`, reducing the install to 393 files and first-launch to 2.1 seconds.

Six subsequent fix commits had to **re-externalize** packages that Bun's bundler couldn't safely inline:
- `9d27f25` — google-protobuf (`jspb.Message` global pattern)
- `0905f58` — `@keepkey/proto-tx-builder` (submodule)
- `ac3b25d` — `swagger-client` + `@swagger-api/apidom-*` (`node:buffer` bug)
- `0d9a5f7` — `@walletconnect/*` (ESM/CJS dual-package resolution)
- `18552a6` — recursion in collect-externals pulled in more transitive deps
- `6776099` — more WalletConnect missing deps

Each re-externalization brought a package + transitive deps back. Current count: ~14,800.

**Diagnostic**:
```powershell
$build = "projects\keepkey-vault\_build\dev-win-x64\keepkey-vault-dev"
(Get-ChildItem -Recurse -File "$build\Resources\app\node_modules" | Measure-Object).Count
# Healthy: <500. Current: ~14,800.
```

**Fix**: see [`docs/WINDOWS-PERFORMANCE-RECOVERY.md`](./WINDOWS-PERFORMANCE-RECOVERY.md) for the full recovery plan. Not a single-line fix.

**Permanent prevention**: add a CI file-count check on `Resources/app/node_modules/` with a regression threshold. Fail any PR that pushes the count above the threshold without justification.

---

## 16. Cert thumbprint pinning

**Symptom**: signing fails with:
```
Certificate not found with thumbprint: <hardcoded value>
Make sure your USB signing token is connected.
```

Or, less obviously, **silently signs with the wrong cert** if a different cert with the same thumbprint exists.

**Root cause**: the build script's default `-Thumbprint` value is the KEY HODLERS LLC EV cert (`986AEBA61CF6616393E74D8CBD3A09E836213BAA`). A new signer or a rotated cert won't match.

**Security note**: a cert thumbprint is **not a secret** — it's a SHA-1 hash that identifies which cert in the local store to use. Signing requires the **private key**, which lives only on the physical USB EV token. Hardcoding a thumbprint in a public repo is fine.

**Diagnostic**:
```powershell
Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My |
    Select-Object Thumbprint, Subject, NotAfter |
    Format-Table -AutoSize -Wrap
```

**Fix** (for a new signer):
```powershell
# Set the env var, then run as normal:
[Environment]::SetEnvironmentVariable("KK_SIGN_THUMBPRINT", "<your-thumbprint>", "User")
# Reopen PowerShell so the env var loads.
.\scripts\build-windows-production.ps1
```

**Permanent prevention**: env var override (added this session); document in `WINDOWS-BUILD-AND-SIGN.md`.

---

## 17. signtool 0x800700C1 BAD_EXE_FORMAT

**Symptom**:
```
signtool.exe : SignTool Error: SignedCode::Sign returned error: 0x800700C1
For more information, please see https://aka.ms/badexeformat
SignTool Error: An error occurred while attempting to sign: launcher.exe
```
On a file that's clearly a valid PE (correct MZ header, PE signature, x64 machine type).

**Root cause**: the PE has a **non-zero Security Directory entry** (cert table pointer in the Optional Header) pointing at malformed data — `Get-AuthenticodeSignature` reports `NotSigned`, but a stale ~10 KB cert-table-shaped chunk lives inside the file. signtool refuses to overwrite a damaged cert table.

How does this happen? `rcedit` (the npm package we use to embed icons) modifies the PE resource section via `BeginUpdateResource`. That Win32 API doesn't strip or update the cert table — it just leaves the existing pointer in place. If the file was rcedit'd previously with a transient bad state, the cert table is now garbage. Also affects upstream Electrobun-built `launcher.exe` binaries in some configurations.

**Diagnostic**: dump the Security Directory entry:
```powershell
$bytes = [System.IO.File]::ReadAllBytes($exe)
$peOff = [BitConverter]::ToInt32($bytes, 60)
$optOff = $peOff + 24
$magic = [BitConverter]::ToUInt16($bytes, $optOff)
$rvaCountOff = if ($magic -eq 0x20B) { $optOff + 108 } else { $optOff + 92 }
$secDirOff = $rvaCountOff + 4 + (4 * 8)
$secDirRva  = [BitConverter]::ToUInt32($bytes, $secDirOff)
$secDirSize = [BitConverter]::ToUInt32($bytes, $secDirOff + 4)
"Security Directory: RVA=$secDirRva Size=$secDirSize"
# Non-zero size + Get-AuthenticodeSignature says NotSigned → corrupt cert table
```

**Fix**: zero out the 8 bytes of the Security Directory entry in the Optional Header. The orphan cert-blob bytes elsewhere in the file are harmless (signtool will append a new entry).

The build script's `Sign-File` function now does this automatically: on `0x800700C1`, calls `Clear-PECertTableEntry` and retries.

Note: `signtool remove /s` does **not** work here (`0x00000057 / ERROR_INVALID_PARAMETER`) because the cert table is malformed, not validly-signed.

**Permanent prevention**: strip-and-retry is built into `Sign-File`. Don't add code that touches the PE after signing; if you must, re-sign after.

---

## 18. rcedit invalidates Authenticode signatures

**Symptom**: after `rcedit ... --set-icon`, the previously-valid signature on the file is **invalid** (`Get-AuthenticodeSignature` reports `HashMismatch`). Or worse, the file ends up with a corrupt cert table per [quirk 17](#17-signtool-0x800700c1-bad_exe_format).

**Root cause**: `rcedit` modifies the `.rsrc` section via `BeginUpdateResource`. Per Microsoft's docs ("If a signed PE file is modified, you may need to sign the file again so that it is recognized as a signed file"), this invalidates the Authenticode signature.

This means **`rcedit` must run BEFORE signing, or the affected files must be re-signed AFTER `rcedit`**.

**Diagnostic**: examine the order of operations in the build script:
```powershell
grep -nE "(Sign-File|rcedit|--set-icon)" scripts/build-windows-production.ps1
```

**Fix** (current script flow):
1. Bulk sign loop (signs everything that exists at this point)
2. Build wrapper EXE (Zig)
3. rcedit on wrapper + launcher.exe (invalidates whatever sigs were there)
4. **Re-sign step** — re-signs the rcedit-modified files

Until this session, step 4 was missing. Result: every prior release shipped with `launcher.exe` and `KeepKeyVault.exe` unsigned inside an otherwise-signed installer. SmartScreen would have warned every user.

**Permanent prevention**: the re-sign step is now wired in. Never add another rcedit call without a matching re-sign.

---

## 19. Cert in CurrentUser vs LocalMachine

**Symptom**: build script reports "Certificate not found with thumbprint" even though you know it's installed.

**Root cause**: EV USB tokens (SafeNet, Sectigo, etc.) install the certificate in different cert stores depending on driver mode and install context. Sometimes `Cert:\CurrentUser\My`, sometimes `Cert:\LocalMachine\My`.

**Diagnostic**: the script already checks both. If it still can't find the cert:
```powershell
Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My |
    Select-Object @{N='Store';E={ if ($_.PSParentPath -match 'CurrentUser') {'CurrentUser'} else {'LocalMachine'} }}, Thumbprint, Subject, NotAfter |
    Format-Table -AutoSize -Wrap
```
If your thumbprint isn't in either, the token isn't unlocked or the cert wasn't imported.

**Fix**: unlock the token via the vendor's UI (SafeNet Authentication Client, Sectigo Code Signing tool), import the cert via vendor utility.

---

## 20. Timestamp server flakiness

**Symptom**: signing fails with:
```
SignTool Error: The specified timestamp server either could not be reached or returned an invalid response.
```
Or signed files end up *without* a timestamp counter-signature.

**Root cause**: timestamp servers (digicert.com, sectigo.com, globalsign.com) periodically rate-limit or transiently fail. signtool returns an error and signing fails for that file.

**Why it matters**: an untimestamped signature is valid only while the **cert** is valid. Once the cert expires (here: 2028-07-02), every untimestamped binary becomes "publisher unknown" forever. With a timestamp counter-signature, the binary's "signed at time T" anchor survives cert expiry.

**Fix**: the build script now tries DigiCert → Sectigo → GlobalSign in sequence. Distinguishes real signing errors (cert/file problems) from transient timestamp errors. Retries on the latter, falls through on the former.

**Permanent prevention**: monitor for `[RETRY]` lines in build output. If all three URLs fail consistently, file an issue — your network or AV is blocking all three.

---

## 21. .node and bun shims aren't signable PE

**Symptom**: in the sign loop:
```
[SKIP] Native module (not signable): node-napi-v4.node
[SKIP] Native module (not signable): node.napi.node
[SKIP] Bun shim (not PE): pino.exe
```

**Root cause**: `.node` files are Node native addon binaries — they're DLL-ish but signtool doesn't recognize them as signable PE files. Bun shims in `node_modules/.bin/*.exe` are tiny shell scripts with a `.exe` extension, not real PE binaries (signtool returns `0x800700C1` — see [quirk 17](#17-signtool-0x800700c1-bad_exe_format), but this is a real PE format error, not a cert-table issue).

**Diagnostic**: file the entry under "expected." If you see other files with the same skip message, that's [quirk 17](#17-signtool-0x800700c1-bad_exe_format).

**Fix**: nothing to fix — these legitimately can't be signed. The build script handles both:
- `.node` extension → skip explicitly
- Path under `\.bin\` → skip explicitly
- True PE files that fail → strip cert table and retry (quirk 17 path)

**Permanent prevention**: keep the skip list narrow — don't broaden it to mask real signing errors. The build script previously had `"not recognized"` as a skip trigger which was too loose; we tightened it this session.

---

## 22. Wrapper EXE not signed on clean builds

**Symptom**: on a freshly-cleaned `_build/`, the wrapper EXE (`KeepKeyVault.exe`) is the *user-launched* binary but is **unsigned** in the final installer. SmartScreen warns "unknown publisher" every launch.

**Root cause**: the build script's sign loop runs at step N. It enumerates `bin/*.exe` and `*.dll` plus the wrapper at `_build/.../KeepKeyVault.exe`. **On a clean build, the wrapper doesn't exist yet** — it's compiled by Zig at step N+1. So the sign loop signs everything *except* the wrapper. The wrapper is then created, rcedit'd, and finally never signed at all.

**Diagnostic**:
```powershell
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\KeepKeyVault\KeepKeyVault.exe"
# Status: NotSigned → bug
```

**Fix**: the build script now has an explicit re-sign step after rcedit ([quirk 18](#18-rcedit-invalidates-authenticode-signatures)) that signs both the wrapper and launcher. This is THE fix for the long-running silently-unsigned-wrapper bug.

**Permanent prevention**: don't reorder these steps without testing. The current order is: bulk sign → icon → wrapper Zig build → rcedit → **re-sign wrapper + launcher** → installer.

---

## 23. Inno Setup MAX_PATH silent drop

**Symptom**: installer compiles "successfully" but the installed app crashes on first launch with `Cannot find module 'X'`. Module X exists in the source build tree.

**Root cause**: Inno Setup's compiler doesn't enable long-path-aware Win32 APIs. Files whose *absolute source path* exceeds 260 chars are **silently skipped** from the output installer. No warning, no error in the ISCC log.

The build tree has `_build/dev-win-x64/keepkey-vault-dev/Resources/app/node_modules/@walletconnect/.../node_modules/...` chains that exceed 260 chars.

**Diagnostic**:
```powershell
# Before ISCC runs, sanity-check max source path:
Get-ChildItem -Recurse -File $BuildDir |
    ForEach-Object { $_.FullName.Length } |
    Sort-Object -Descending |
    Select-Object -First 5
# Anything > 250 is in danger zone
```

**Fix**: stage the entire build tree to a short prefix path before invoking ISCC. The build script does this with `robocopy /256 → C:\tmp\kk`. After staging, every absolute path is `C:\tmp\kk\...` (8 char prefix) and well under 260.

**Permanent prevention**: never invoke ISCC against the dev build tree directly. Always stage. The build script does this — don't disable it.

---

## 24. robocopy default retry policy

**Symptom**: `robocopy` for the Inno staging step hangs for 10+ minutes with no progress. Process is alive but CPU usage is ~0%. File count in destination stalls.

**Root cause**: `robocopy`'s defaults are `/R:1000000 /W:30` — retry **one million** times with a 30-second wait between retries. When Windows Defender real-time scan briefly locks a file, robocopy doesn't time out; it waits forever.

**Diagnostic**:
```powershell
Get-Process robocopy | Select-Object Id, CPU, WorkingSet, StartTime
# CPU should grow steadily; if stuck at ~1.5s after 10 minutes, you've hit the hang.
```

**Fix**: the script uses these flags:
```
robocopy $src $dst /E /256 /MT:16 /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS /NP /NS
```
- `/MT:16` — 16-thread parallel copy (~10x faster than single-threaded)
- `/R:1 /W:1` — retry ONCE with 1-second wait (don't get stuck on Defender locks)
- `/XJ` — skip junction points / reparse points (avoid symlink loops)
- `/NFL /NDL /NJH /NJS /NP /NS` — suppress per-file output

Result: 14k files copied in ~5 seconds.

**Permanent prevention**: these flags are committed. Don't remove them.

---

## 25. Expand-Archive is slow

**Symptom**: extracting a multi-tens-of-MB zip via PowerShell's `Expand-Archive` takes 5-10+ minutes.

**Root cause**: PowerShell 5.1's `Expand-Archive` uses .NET's `ZipFile` class single-threaded with no I/O buffering. Defender real-time scans every file as it's written. For an 88 MB zig zip containing ~14k stdlib files, this can take 10+ minutes.

**Fix**: use Windows' built-in `bsdtar` at `C:\Windows\System32\tar.exe` — it handles zip natively and is multi-threaded internally:
```powershell
& "C:\Windows\System32\tar.exe" -xf myarchive.zip -C destination/
```
Same archive: ~5 seconds instead of ~5 minutes.

Do NOT use git-bash's `tar` — that's GNU tar which **cannot** read zip format.

**Permanent prevention**: prefer `bsdtar` for any zip extraction in scripts. Faster, fewer dependencies.

---

## 26. PowerShell 5 UTF8 BOM

**Symptom**: app crashes silently on launch. `vault-backend.log` is empty or never created. SQLite never initializes. Settings never persist.

**Root cause**: PowerShell 5.1's `Out-File -Encoding UTF8` writes a **BOM** (byte-order mark) at the start of the file. `version.json` with a BOM fails to parse in Bun's `require()`, which crashes `Electrobun.getVersionInfo()`, which throws inside `Utils.paths.userData`, which prevents the SQLite path from being computed.

**Diagnostic**:
```powershell
$bytes = [System.IO.File]::ReadAllBytes("path\to\version.json")[0..2]
# BOM = 0xEF 0xBB 0xBF
$bytes | ForEach-Object { '{0:X2}' -f $_ }
```

**Fix** (in scripts that write JSON):
```powershell
[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
# The $false → no BOM
```
NOT this:
```powershell
$content | Out-File -Encoding UTF8 -Path $path   # writes BOM in PS 5.1
```

**Permanent prevention**: when writing JSON / TOML / YAML, always use the explicit `WriteAllText` with `UTF8Encoding($false)`. Documented in `retro-windows-1.2.6.md`.

---

## 27. Defender real-time scan

**Symptom**: every build operation is 5-10x slower than on a Linux/Mac machine of similar specs. `robocopy`, `signtool`, `bun install`, `electrobun build` all bottleneck on Defender.

**Root cause**: Windows Defender's real-time protection scans every file at write time and every executable at load time. With ~14,800 files in the build tree, this is the dominant build cost.

**Fix** (one-time per machine, requires admin):
```powershell
Add-MpPreference -ExclusionPath "$env:USERPROFILE\path\to\keepkey-vault"
Add-MpPreference -ExclusionPath "C:\tmp\kk"
Add-MpPreference -ExclusionProcess "signtool.exe","robocopy.exe","bun.exe","node.exe","cargo.exe","ISCC.exe"
(Get-MpPreference).ExclusionPath
(Get-MpPreference).ExclusionProcess
```

**Security note**: build-machine local. These exclusions don't affect end-user installs — every user gets full Defender protection on the installed app.

**Permanent prevention**: document in `WINDOWS-DEV-SETUP.md`, list as a strong recommendation for any build machine.

---

## 28. No-spaces install path

**Symptom**: app installs cleanly, launches, but Bun Worker processes fail to spawn. App is unresponsive.

**Root cause**: Bun Workers silently fail when the executable path contains spaces. Default install of "KeepKey Vault" to `{autopf}\KeepKey Vault\` has a space and breaks.

**Fix**: install dir is `KeepKeyVault` (no space). EXE is `KeepKeyVault.exe` (no space). Inno Setup config uses `{autopf}\KeepKeyVault` regardless of `MyAppName` display value.

**Permanent prevention**: don't rename the install dir to include spaces. Documented in `installer.iss` comments.

---

## 29. WebView2 must be bundled

See [quirk 6](#6-webview2-runtime-missing-on-windows-10). Build-side: `MicrosoftEdgeWebview2Setup.exe` is downloaded by the build script and bundled into the installer via `installer.iss [Run]`. Don't strip it — Windows 10 users will silently fail to launch the app.

---

## 30. Where to find logs

When an installed build misbehaves, **`vault-backend.log` is the single source of truth**:

```powershell
Get-Content "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" -Tail 100
```

Other locations:
- `$env:LOCALAPPDATA\com.keepkey.vault\` — runtime data (logs, SQLite DB, WebView2 profiles)
- `$env:LOCALAPPDATA\Programs\KeepKeyVault\` — install dir (binaries, resources)
- `$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\version.json` — actual version of installed app

**Note**: Windows has no separate Electrobun crash log, no WER dump in the usual locations, and renderer-side `console.log` doesn't reach the file. The boot env dump (sync logger, added in 1.2.14 — see `HANDOFF-1.2.14-WIN10-WATCHDOG-CRASH.md`) is at the top of every session's log lines.

A session that ends abruptly mid-`Scanning for HID device...` is usually a native libusb crash (`HANDOFF-1.2.14-WINDOWS-PAIR.md` finding 2).

---

## Preflight checklist

Before any release build, run through this list. The `preflight-windows.ps1` script (added this session) mechanizes most of it:

- [ ] Branch is the release branch you intend (`git rev-parse --abbrev-ref HEAD`)
- [ ] `package.json` version matches the intended release
- [ ] Working tree clean (`git status` empty)
- [ ] `modules/device-protocol/lib/messages_pb.js` exists ([quirk 8](#8-device-protocollib-gitignored))
- [ ] `_build/` is absent OR you intend to use it ([quirk 9](#9-electrobun-build-is-incremental))
- [ ] `zig version` reports 0.15.x ([quirk 1](#1-zig-version-drift))
- [ ] `bun --version` is recent (no specific pin yet)
- [ ] `~/.npmrc` has expected `strict-ssl=false` if behind corporate TLS inspection ([quirk 2](#2-bun-tls-unable_to_verify_leaf_signature))
- [ ] All `.sh` scripts have LF line endings (`file projects/keepkey-vault/scripts/*.sh`) ([quirk 3](#3-git-autocrlf-breaks-bash-scripts))
- [ ] Defender exclusions present (`(Get-MpPreference).ExclusionPath`) ([quirk 27](#27-defender-real-time-scan))
- [ ] EV token unlocked, cert visible (`Get-ChildItem Cert:\CurrentUser\My | Where Thumbprint -eq <yours>`) ([quirk 19](#19-cert-in-currentuser-vs-localmachine))
- [ ] Long paths enabled in registry + git config ([quirk 5](#5-max_path--long-path-support))

If any item fails, **fix it before kicking off the build**. The build is 15-20 minutes; fixing a preflight item is 1 minute. Always preflight.

---

## Related docs

| Doc | What it covers |
|---|---|
| [`WINDOWS-BUILD-AND-SIGN.md`](./WINDOWS-BUILD-AND-SIGN.md) | Release SOP — what to run, in what order |
| [`WINDOWS-DEV-SETUP.md`](./WINDOWS-DEV-SETUP.md) | First-time machine setup for external contributors |
| [`WINDOWS-DEV-MODE.md`](./WINDOWS-DEV-MODE.md) | Dev launch + HMR troubleshooting |
| [`WINDOWS-QUIRKS.md`](./WINDOWS-QUIRKS.md) | **Runtime** quirks (window drag, drop-through clicks, etc.) |
| [`WINDOWS-PERFORMANCE-RECOVERY.md`](./WINDOWS-PERFORMANCE-RECOVERY.md) | Plan to recover the 393-file pre-bundle optimization |
| [`HANDOFF-1.2.14-WINDOWS-PAIR.md`](./HANDOFF-1.2.14-WINDOWS-PAIR.md) | Three open Win10 pair-failure findings |
| [`HANDOFF-1.2.14-WIN10-WATCHDOG-CRASH.md`](./HANDOFF-1.2.14-WIN10-WATCHDOG-CRASH.md) | Sync logger story + boot env dump |
| [`retro-windows-1.2.6.md`](../projects/keepkey-vault/docs/retro-windows-1.2.6.md) | First Windows release retro |
