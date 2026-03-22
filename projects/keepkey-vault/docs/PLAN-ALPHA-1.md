# PLAN ALPHA-1

You are a build-and-test agent. You do ONLY what this document says.
You do NOT close PRs. You do NOT mark releases as draft. You do NOT
delete branches. You do NOT modify GitHub in any way. You build, install,
test, and report. Nothing else.

---

## STEP 1: Close KeepKey Vault

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 5
```

## STEP 2: Checkout the branch

```powershell
cd C:\Users\bithi\AProjects\keepkey-vault-v11
git fetch origin
git checkout release-cycle
git pull origin release-cycle
```

## STEP 3: Verify installer is clean

```powershell
Select-String -Path scripts\installer.iss -Pattern "InstallDelete|CloseApplications|\[Code\]"
```

If there are ANY matches, STOP. Say "INSTALLER NOT CLEAN" and paste the matches. Do nothing else.

## STEP 4: Build frontend

```powershell
cd projects\keepkey-vault
bunx vite build
```

If exit code is not 0, STOP. Paste the error. Do nothing else.

## STEP 5: Collect externals

```powershell
bun scripts\collect-externals.ts
```

If exit code is not 0, STOP. Paste the error. Do nothing else.

## STEP 6: Electrobun build

```powershell
bunx electrobun build
```

If exit code is not 0, STOP. Paste the error. Do nothing else.

## STEP 7: Windows production build

```powershell
cd ..\..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-production.ps1
```

If it fails, STOP. Paste the error. Do nothing else.

## STEP 8: Verify installer exists

```powershell
Get-Item release-windows\KeepKey-Vault-*-setup.exe | Select-Object Name, Length
```

If no file exists, STOP. Say "NO INSTALLER PRODUCED". Do nothing else.

## STEP 9: Install over existing v1.2.3

Do NOT uninstall v1.2.3 first. Install directly over it.

```powershell
Start-Process -FilePath (Get-Item release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

Click through the installer. Accept defaults. Check "Launch KeepKey Vault" at end.

## STEP 10: Wait 60 seconds

Wait a full 60 seconds. Do NOT kill anything. Do NOT touch anything.

## STEP 11: Collect results

```powershell
$e = "$env:USERPROFILE\Desktop\alpha1-results"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue

Get-FileHash "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\libNativeWrapper.dll" -ErrorAction SilentlyContinue |
  Out-File "$e\dll-hash.txt"

Get-Content "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\version.json" -ErrorAction SilentlyContinue |
  Out-File "$e\version-json.txt"
```

## STEP 12: Report

Report EXACTLY these answers:

1. Did the installer finish? (yes/no)
2. Did a splash screen appear? (yes/no)
3. Did the main window appear? (yes/no)
4. What does MainWindowHandle say? (paste the number)
5. Is app.log empty or does it have content? (paste first 5 lines if content)
6. Is backend.log empty or does it have content? (paste first 5 lines if content)
7. What is the DLL hash? (paste it)

## RULES

- Do NOT do anything not listed above.
- Do NOT close PRs.
- Do NOT mark releases as draft.
- Do NOT delete remote branches.
- Do NOT suggest alternative approaches.
- Do NOT hot-patch anything.
- Do NOT modify any GitHub state.
- If any step fails, STOP and report what failed. Do nothing else.
