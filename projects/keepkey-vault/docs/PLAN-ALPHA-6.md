# PLAN ALPHA-6

You are a build-and-test agent. You do ONLY what this document says.
You do NOT close PRs. You do NOT mark releases as draft. You do NOT
delete branches. You do NOT modify GitHub in any way. You execute
steps and report results.

## What changed since ALPHA-5

- `collect-externals.ts` now checks `device-protocol/lib/messages_pb.js`
  exists after copy. If missing, attempts auto-build. If still missing,
  exits with fatal error instead of producing a broken bundle.
- `build-windows-production.ps1` now inits `device-protocol` submodule
  and builds `lib/` if `messages_pb.js` is absent.
- AuthStore regression fixed — pairings reload after DB init.
- Vite outputs fixed filenames (`index.js` not `index-[hash].js`).
- Installer is v1.2.1 baseline (no side-effects).

## Goal

Full rebuild from scratch. Verify `messages_pb.js` ends up in the
installed bundle. If the app opens a window, test upgrade path too.

---

## STEP 1: Kill everything

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 3
```

## STEP 2: Pull latest

```powershell
cd C:\Users\bithi\AProjects\keepkey-vault-v11
git checkout release-cycle
git pull origin release-cycle
```

## STEP 3: Verify the root cause fix is present

```powershell
Select-String -Path projects\keepkey-vault\scripts\collect-externals.ts -Pattern "messages_pb.js"
```

Must show matches. If not, STOP — wrong branch.

## STEP 4: Build device-protocol lib

The submodule has `lib/` in `.gitignore`. Build it before anything else.

```powershell
cd modules\device-protocol
npm install 2>$null
npm run build
```

If `npm run build` fails (likely — `sed -i ''` is macOS-only), do this instead:

```powershell
# Check if lib/messages_pb.js already exists from a previous build
if (Test-Path "lib\messages_pb.js") {
    Write-Host "messages_pb.js already exists, skipping build"
} else {
    Write-Host "MANUAL FIX: messages_pb.js missing and build failed"
    Write-Host "Copy lib/ from a macOS machine or run protoc manually"
    # STOP here if truly missing — report "DEVICE-PROTOCOL BUILD FAILED"
}
```

```powershell
cd ..\..
```

## STEP 5: Verify messages_pb.js exists in submodule

```powershell
Test-Path modules\device-protocol\lib\messages_pb.js
```

Must be `True`. If `False`, STOP and report "MESSAGES_PB MISSING FROM SUBMODULE".

## STEP 6: Build frontend

```powershell
cd projects\keepkey-vault
bunx vite build
```

If exit code is not 0, STOP. Paste the error.

## STEP 7: Verify fixed asset filenames

```powershell
Get-ChildItem dist\assets\*.js | Select-Object Name
```

Must show `index.js`, `asset-data.js`, etc. No hashes. If hashes present, STOP.

## STEP 8: Collect externals

```powershell
bun scripts\collect-externals.ts
```

If exit code is not 0, STOP. Paste the error.
The script should print "Verified: @keepkey/device-protocol/lib/messages_pb.js present".

## STEP 9: Verify messages_pb.js in build output

```powershell
Test-Path _build\_ext_modules\@keepkey\device-protocol\lib\messages_pb.js
```

Must be `True`. If `False`, STOP and report "MESSAGES_PB MISSING FROM BUILD OUTPUT".

## STEP 10: Electrobun build

```powershell
bunx electrobun build
```

If exit code is not 0, STOP. Paste the error.

## STEP 11: Windows production build

```powershell
cd ..\..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-production.ps1
```

If it fails, STOP. Paste the error.

## STEP 12: Verify installer exists

```powershell
Get-Item release-windows\KeepKey-Vault-*-setup.exe | Select-Object Name, Length
```

If no file, STOP.

## STEP 13: Wipe all KeepKey state (clean install test)

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 3
Remove-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\sh.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\KeepKey Vault" -Recurse -Force -ErrorAction SilentlyContinue
```

## STEP 14: Install fresh

```powershell
Start-Process -FilePath (Get-Item C:\Users\bithi\AProjects\keepkey-vault-v11\release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

Accept defaults. Check "Launch KeepKey Vault".

## STEP 15: Wait 60 seconds

Do NOT touch anything.

## STEP 16: Verify messages_pb.js in installed app

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\node_modules\@keepkey\device-protocol\lib\messages_pb.js"
```

Must be `True`. If `False`, the fix did not work — report "MESSAGES_PB MISSING FROM INSTALLED APP".

## STEP 17: Collect results

```powershell
$e = "$env:USERPROFILE\Desktop\alpha6-results"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue

Test-Path "$env:LOCALAPPDATA\com.keepkey.vault" |
  Out-File "$e\webview2-created.txt"
```

## STEP 18: Report

```
ALPHA-6 RESULTS:
1. Did device-protocol build succeed? (yes/no/already existed)
2. Did collect-externals confirm messages_pb.js present? (yes/no)
3. Is messages_pb.js in the installed app? (yes/no)
4. Did the installer finish? (yes/no)
5. Did a window appear? (yes/no)
6. MainWindowHandle: [number]
7. app.log has content? (yes/no, paste first 5 lines)
8. backend.log has content? (yes/no, paste first 5 lines)
9. Was com.keepkey.vault created? (yes/no)
```

## STEP 19: If window appeared — test over-install

Only if step 18 shows a window:

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 5
Start-Process -FilePath (Get-Item C:\Users\bithi\AProjects\keepkey-vault-v11\release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

Wait 60 seconds. Then:

```powershell
$e = "$env:USERPROFILE\Desktop\alpha6-overinstall"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue
```

Report:

```
OVER-INSTALL:
1. Did the window appear after over-install? (yes/no)
2. MainWindowHandle: [number]
```

## RULES

- Do NOT do anything not listed above.
- Do NOT close PRs or modify GitHub state.
- Do NOT suggest alternative approaches.
- If any step fails, STOP and report what failed.
