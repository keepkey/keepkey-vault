# Windows 1.3.2 Launch Retro and Next Debug Plan

Date: 2026-05-12
Branch target: `release/1.3.2`
Status: build pipeline improved, installer builds and signs, installed app still fails the fresh launch smoke.

This document captures the Windows build/debugging session so the next batch can start from evidence instead of memory. The goal of the session was to produce a signed Windows installer, install it locally, open it, smoke test launch/runtime logs, then upload to the GitHub release. We did not reach release upload because the installed app still does not produce a fresh backend session.

## Executive summary

We successfully hardened several release-build failure points:

- Zig 0.15.x pin and fast install path were established.
- Windows preflight script was added and exercised.
- `collect-externals.ts` no longer shells out to Unix `du`.
- Electrobun patching works under Git Bash GNU `sed`.
- Production build mirrors `_build/_ext_modules` into `Resources/app/node_modules` with `robocopy`.
- Signing now retries stale malformed PE certificate-table entries.
- `version.json` is forcibly patched to the package version and `stable` channel.
- The wrapper can launch the build-tree app directly through `bun.exe Resources/app/bun/index.js`.
- Installer build completes and signs artifacts.

The remaining blocker is launch after install. The installed `KeepKeyVault.exe` exits quickly, no installed child process remains, and `vault-backend.log` does not advance. One direct installed backend probe before the final rebuild showed a missing nested WalletConnect dependency:

```text
Cannot find module './cjs/src/concat.js'
from ...\@walletconnect\sign-client\node_modules\@walletconnect\core\node_modules\@walletconnect\relay-auth\node_modules\uint8arrays\concat
```

After that, `collect-externals.ts` was patched to preserve unreadable/deep nested `node_modules` trees on Windows and a full rebuild completed. The final direct installed backend probe was interrupted before producing a result, so the next session must establish whether the remaining failure is still packaging or has moved back to the wrapper/process launch path.

## What changed in this session

### Build docs and preflight

Added:

- `docs/WINDOWS-BUILD-QUIRKS.md`
- `docs/WINDOWS-PERFORMANCE-RECOVERY.md`
- `scripts/preflight-windows.ps1`

The quirks doc records the major Windows release hazards encountered across sessions. The performance doc records the regression from the historical pre-bundled baseline to the current high-file-count installer. The preflight script validates common release-machine prerequisites before running `build-windows-production.ps1`.

Preflight fixes made during the session:

- Force scalar-or-array PowerShell values to arrays under StrictMode.
- Guard `.Trim()` calls on nullable git config output.
- Normalize several `.sh` files to LF because Git Bash/bash scripts fail with CRLF.

### Windows build script

Changed `scripts/build-windows-production.ps1` to:

- Clear malformed/stale PE Security Directory entries before retrying `signtool`.
- Pin wrapper compilation to Zig 0.15.x and prefer `C:\Users\<user>\tools\zig-x86_64-windows-0.15.1\zig.exe`.
- Mirror `_build/_ext_modules` into the final app bundle with `robocopy /MIR`.
- Force `Resources/version.json` to the package version, stable channel, and current backend hash using BOM-free UTF-8.
- Use short-path staging at `C:\tmp\kk` before Inno Setup.
- Re-sign wrapper and launcher after icon mutation with `rcedit`.

### Electrobun patch script

Changed `projects/keepkey-vault/scripts/patch-electrobun.sh` to use a GNU/BSD-compatible `sed_in_place` helper instead of BSD-only `sed -i ''`.

### External dependency collection

Changed `projects/keepkey-vault/scripts/collect-externals.ts` to:

- Replace Unix `du` calls with in-process directory size calculation.
- Keep same-version nested packages on Windows instead of deleting them, because long-path deletion can leave partial packages that shadow valid top-level packages.
- Preserve unreadable nested `node_modules` on Windows instead of deleting them.

The current theory is that over-pruning deep nested `node_modules` caused partial WalletConnect/uint8arrays trees to be packaged.

### Wrapper launcher

Changed `scripts/wrapper-launcher.zig` so the wrapper launches:

```text
bin\bun.exe Resources\app\bun\index.js
```

directly instead of:

```text
bin\launcher.exe
```

The build-tree wrapper smoke showed this direct path can spawn Bun and advance `vault-backend.log`. The installed wrapper still exited quickly, so the installed app failure is not yet proven fixed.

## Evidence and baselines

### Known good

- Full production build completed after the final `collect-externals.ts` patch.
- Inno Setup completed.
- Installer installed silently with exit code `0`.
- Installed `Resources/version.json` reads:

```json
{"version":"1.3.2","hash":"7121da4295c3fd6e","channel":"stable","baseUrl":"https://github.com/keepkey/keepkey-vault/releases/latest/download","name":"keepkey-vault","identifier":"com.keepkey.vault"}
```

- Earlier artifact/signature verification, before the final rebuild, showed valid Authenticode signatures for:
  - `release-windows\KeepKey-Vault-1.3.2-win-x64-setup.exe`
  - build-tree `KeepKeyVault.exe`
  - build-tree `bin\launcher.exe`

### Known bad

- Installed `KeepKeyVault.exe` launch returns a PID, then exits.
- No installed process tree remains after waiting.
- `vault-backend.log` does not advance on installed wrapper launch.
- Before the final rebuild, direct installed `bun.exe Resources\app\bun\index.js` failed on a missing nested `uint8arrays\cjs\src\concat.js`.

### Unknown after final rebuild

The final direct installed backend probe was interrupted. The next session must answer:

- Does the installed nested file exist now?
- Does direct installed `bun.exe "Resources\app\bun\index.js"` start and write a fresh backend log?
- If direct Bun works, why does `KeepKeyVault.exe` exit?
- If direct Bun fails, what is the first missing module or runtime error?

## Next-session milestones

### Milestone 1: freeze the current artifact facts

Run:

```powershell
$repo = "C:\Users\Matheus Louzada\kk\keepkey-vault"
Set-Location $repo
Get-ChildItem .\release-windows | Select Name,Length,LastWriteTime
Get-Content .\release-windows\SHA256SUMS.txt
Get-FileHash .\release-windows\KeepKey-Vault-1.3.2-win-x64-setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\release-windows\KeepKey-Vault-1.3.2-win-x64-setup.exe
```

Success criteria:

- Installer exists.
- Hash matches `SHA256SUMS.txt`.
- Installer signature is `Valid`.

### Milestone 2: verify installed dependency completeness

Check the exact previously missing path:

```powershell
$install = Join-Path $env:LOCALAPPDATA "Programs\KeepKeyVault"
$missing = Join-Path $install "Resources\app\node_modules\@walletconnect\sign-client\node_modules\@walletconnect\core\node_modules\@walletconnect\relay-auth\node_modules\uint8arrays\cjs\src\concat.js"
Test-Path $missing
```

If it is missing, the current `collect-externals.ts` fix is insufficient or Inno Setup/short staging is still dropping deep files.

### Milestone 3: direct installed backend test

Run direct Bun with stderr capture and quote the app path:

```powershell
$install = Join-Path $env:LOCALAPPDATA "Programs\KeepKeyVault"
$bun = Join-Path $install "bin\bun.exe"
$index = Join-Path $install "Resources\app\bun\index.js"
$log = Join-Path $env:LOCALAPPDATA "com.keepkey.vault\vault-backend.log"
$stdout = Join-Path $env:TEMP "kk-installed-direct-stdout.txt"
$stderr = Join-Path $env:TEMP "kk-installed-direct-stderr.txt"
$before = if (Test-Path $log) { (Get-Item $log).LastWriteTimeUtc } else { [datetime]::MinValue }
Remove-Item -Force $stdout,$stderr -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $bun -ArgumentList ('"' + $index + '"') -WorkingDirectory (Join-Path $install "bin") -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Start-Sleep -Seconds 20
$alive = $null -ne (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)
$after = if (Test-Path $log) { (Get-Item $log).LastWriteTimeUtc } else { [datetime]::MinValue }
"AliveAfter20s=$alive LogAdvanced=$($after -gt $before)"
Get-Content $stderr -Tail 80
Get-Content $log -Tail 80
if ($alive) { Stop-Process -Id $p.Id -Force }
```

Success criteria:

- Log advances with a fresh `=== New session`.
- `argv` shows installed `bin\bun.exe` and installed `Resources\app\bun\index.js`.
- Boot reaches at least `[PERF] ... creating BrowserWindow`; ideal is `KeepKey Vault started!`.

### Milestone 4: wrapper installed smoke

Only after direct Bun works:

```powershell
$install = Join-Path $env:LOCALAPPDATA "Programs\KeepKeyVault"
$exe = Join-Path $install "KeepKeyVault.exe"
$log = Join-Path $env:LOCALAPPDATA "com.keepkey.vault\vault-backend.log"
$before = (Get-Item $log).LastWriteTimeUtc
$p = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 35
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -like "$install\*" } |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine
$after = (Get-Item $log).LastWriteTimeUtc
"WrapperPid=$($p.Id) LogAdvanced=$($after -gt $before)"
Get-Content $log -Tail 100
```

Success criteria:

- `KeepKeyVault.exe` or child `bun.exe` remains alive long enough to show in the process tree.
- Log advances.
- No `launcher.exe -> Resources\main.js -> Worker` path is required.

### Milestone 5: only then upload release asset

Do not upload to GitHub Releases until:

- Final installer hash/signature is verified.
- Silent install exits `0`.
- Direct installed backend passes.
- Wrapper installed smoke passes.
- User confirms the visible app window is acceptable.

## Working theories to test next

## Follow-up finding: 2026-05-12

The launch blocker was split across two layers:

1. `collect-externals.ts` did collect the missing WalletConnect dependency into `_build\_ext_modules`, but the long build-tree destination path caused the deep nested file to be absent from `Resources\app\node_modules` and from the installed app.
   - Missing file:
     `@walletconnect\sign-client\node_modules\@walletconnect\core\node_modules\@walletconnect\relay-auth\node_modules\uint8arrays\cjs\src\concat.js`
   - Direct installed Bun stderr before the manual overlay:
     `Cannot find module './cjs/src/concat.js' from ...\uint8arrays\concat`
   - Manual `robocopy _build\_ext_modules -> installed Resources\app\node_modules` fixed that crash.

2. The direct `bun.exe Resources\app\bun\index.js` wrapper path got past module resolution after the overlay, but stalled at `new BrowserWindow(...)`. The stock Electrobun launcher path did not stall.
   - Working process tree:
     `KeepKeyVault.exe -> bin\launcher.exe -> bin\bun.exe ..\Resources\main.js`
   - Working backend log reached:
     `window created`, `boot complete`, and `KeepKey Vault started!`

The production fix is:

- Keep the no-spaces install directory: `KeepKeyVault`.
- Use the wrapper to start `bin\launcher.exe`, not direct Bun.
- Overlay `_build\_ext_modules` into `C:\tmp\kk\Resources\app\node_modules` after short staging and before Inno Setup. This bypasses the long build-tree destination path and gives Inno a complete short-path source tree.
- Add a short-stage probe for the exact WalletConnect file so future builds fail before packaging if the deep dependency is missing.

Verified local smoke after manually copying the complete externals into the installed tree:

- `bin\launcher.exe` launched.
- Child `bun.exe` ran `Resources\main.js`.
- Window title appeared as `KeepKey Vault v1.3.2`.
- `vault-backend.log` advanced through `KeepKey Vault started!`.

Verified clean wrapper smoke after removing temporary diagnostics:

- `KeepKeyVault.exe` launched `bin\launcher.exe`.
- `launcher.exe` launched `bin\bun.exe ..\Resources\main.js`.
- `DebugLogExists=False`, confirming the temporary wrapper recorder was not present.
- Window title appeared as `KeepKey Vault v1.3.2`.
- `vault-backend.log` advanced through `window created`, `boot complete`, and `KeepKey Vault started!`.
- The connected KeepKey was detected and reached `State -> ready`.

Remaining release gate:

- Run a fresh production build with the short-stage overlay in `build-windows-production.ps1`.
- Install that newly produced installer into a clean install tree.
- Confirm the WalletConnect probe exists in the installed tree.
- Run wrapper smoke from `KeepKeyVault.exe`, not `launcher.exe` directly.
- Verify final installer hash/signature before upload.

1. Packaging still drops deep nested WalletConnect files.
   - Evidence: direct installed backend previously failed on nested `uint8arrays`.
   - Test: exact `Test-Path` plus direct backend stderr.

2. Wrapper direct launch command is still subtly wrong after install.
   - Evidence: build-tree wrapper advanced logs, installed wrapper did not.
   - Test: direct Bun first; then compare wrapper-created process command line.

3. Process starts but exits before logging because stderr is hidden.
   - Evidence: wrapper launches hidden with `CREATE_NO_WINDOW`; no stderr capture.
   - Test: temporarily add wrapper failure logging to `%LOCALAPPDATA%\com.keepkey.vault\wrapper-launch.log` or launch Bun through a tiny PowerShell/cmd shim for one diagnostic build.

4. Inno Setup or short staging misses paths despite `robocopy`.
   - Evidence: staged file count is high but may not prove the exact nested file exists in the installer payload.
   - Test: compare `C:\tmp\kk`, build tree, and installed tree for the exact missing file.

## Guardrails for next debugging batch

- Do not upload a release asset until installed wrapper smoke passes.
- Do not use broad process-kill filters against `CommandLine`; they can kill the diagnostic PowerShell. Filter by `ExecutablePath -like "$install\*"`.
- Keep `C:\tmp\kk` staging until artifact inspection is complete.
- Treat `vault-backend.log` as the source of truth for app boot.
- Preserve direct Bun and wrapper tests as separate milestones.
- If adding wrapper diagnostics, make them append-only and remove or gate them before release.
