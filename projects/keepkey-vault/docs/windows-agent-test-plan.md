# Windows Agent Test Plan — release-cycle branch

## Goal

Build and test the `release-cycle` branch on Windows. The installer has been
reset to the v1.2.1 baseline (zero side-effects). Determine if a clean build
from this branch produces a working Windows installer.

## Pre-conditions

- Windows machine (the bithi machine that has been used for all prior testing)
- Git, Bun, Zig, Inno Setup 6, and the EV signing certificate available
- The machine currently has v1.2.3 installed and working

## IMPORTANT: Do not skip steps. Do not improvise. Follow this exactly.

---

## Phase 1: Prepare the machine

### Step 1.1: Capture current state BEFORE doing anything

```powershell
$evidence = "$env:USERPROFILE\Desktop\test-release-cycle"
New-Item -ItemType Directory -Force $evidence | Out-Null

Get-Process | Where-Object { $_.ProcessName -match 'bun|launcher|KeepKey|msedgewebview2' } |
  Select-Object ProcessName, Id, Path, MainWindowTitle, MainWindowHandle |
  Out-File "$evidence\1-before-processes.txt"

Get-ChildItem "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$evidence\1-before-webview2-state.txt"

Get-ChildItem "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length |
  Out-File "$evidence\1-before-installed-tree.txt"
```

### Step 1.2: Close KeepKey Vault if running

Close it normally from the UI (click X). Wait 10 seconds. Then verify:

```powershell
Get-Process -Name "bun","launcher","KeepKeyVault" -ErrorAction SilentlyContinue
```

If any are still running, kill them:

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 3
```

### Step 1.3: Do NOT uninstall v1.2.3

We are going to install v1.2.6 OVER v1.2.3. This is the upgrade path.
Do NOT uninstall first.

---

## Phase 2: Get the code

### Step 2.1: Checkout the branch

```powershell
cd C:\path\to\keepkey-vault-v11
git fetch origin
git checkout release-cycle
git pull origin release-cycle
```

### Step 2.2: Verify the installer.iss is the simple one

```powershell
Select-String -Path scripts\installer.iss -Pattern "InstallDelete|CloseApplications|\[Code\]"
```

**Expected: NO matches.** If you see any matches, STOP — wrong branch.

### Step 2.3: Verify version is 1.2.6

```powershell
Select-String -Path projects\keepkey-vault\package.json -Pattern '"version"'
```

**Expected: `"version": "1.2.6"`**

---

## Phase 3: Build

### Step 3.1: Build the app

```powershell
cd projects\keepkey-vault
bunx vite build
bun scripts\collect-externals.ts
bunx electrobun build
```

Each command must exit 0. If any fails, STOP and report the error.

### Step 3.2: Run the full Windows production build

```powershell
cd ..\..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-production.ps1
```

This compiles the Zig wrapper, signs binaries, and produces the installer.

**Expected output**: `release-windows\KeepKey-Vault-1.2.6-win-x64-setup.exe`

### Step 3.3: Verify the installer was created

```powershell
Get-Item release-windows\KeepKey-Vault-1.2.6-win-x64-setup.exe |
  Select-Object Name, Length, LastWriteTime
```

If the file does not exist, STOP and report.

---

## Phase 4: Install

### Step 4.1: Run the installer

```powershell
Start-Process -FilePath "release-windows\KeepKey-Vault-1.2.6-win-x64-setup.exe" -Wait
```

Go through the installer normally. Accept defaults. Check "Launch KeepKey Vault"
at the end.

### Step 4.2: Record what happened

In the evidence folder, write down:
- Did the installer complete without errors? (yes/no)
- Did it ask to close running apps? (yes/no)
- Did it show any error dialogs? (yes/no)
- What did the wizard pages look like?

---

## Phase 5: Launch test

### Step 5.1: Wait 60 seconds

The app may take up to 60 seconds to show a window on first launch.
Do NOT kill anything. Just wait.

### Step 5.2: Check for a window

```powershell
Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$evidence\5-after-launch-processes.txt"
```

**Success**: `MainWindowTitle` contains "KeepKey Vault" AND `MainWindowHandle` is NOT 0.
**Failure**: `MainWindowHandle` is 0, or no bun process, or no output.

### Step 5.3: Check for the splash screen

Did a splash screen appear? (yes/no)
Did the splash screen go away on its own? (yes/no)
Did the main app window appear after the splash? (yes/no)

### Step 5.4: Capture logs

```powershell
Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$evidence\5-app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$evidence\5-backend.log" -ErrorAction SilentlyContinue
Get-ChildItem "$env:TEMP" -Filter "Setup Log*.txt" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
  Copy-Item -Destination "$evidence\5-installer.log" -ErrorAction SilentlyContinue
```

### Step 5.5: Capture installed state

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$evidence\5-installed-tree.txt"

Get-ChildItem "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$evidence\5-webview2-state.txt"

Get-FileHash "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\libNativeWrapper.dll" -ErrorAction SilentlyContinue |
  Out-File "$evidence\5-dll-hash.txt"
```

---

## Phase 6: Report results

Report ALL of the following:

1. **Installer**: completed ok? any errors or prompts?
2. **Splash screen**: appeared? went away? or stuck?
3. **Main window**: appeared? title says v1.2.6? or nothing?
4. **app.log**: has content? or empty? paste first 10 lines.
5. **vault-backend.log**: has content? shows PERF timestamps? or empty?
6. **installer log**: paste last 20 lines.
7. **DLL hash**: what is the libNativeWrapper.dll hash?
8. **MainWindowHandle**: 0 or non-zero?

---

## If it FAILS (no window after 60s)

Do NOT try to fix it. Just collect evidence:

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'bun|launcher|KeepKey|msedgewebview2' } |
  Select-Object ProcessName, Id, Path, MainWindowTitle, MainWindowHandle |
  Out-File "$evidence\FAIL-processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$evidence\FAIL-app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$evidence\FAIL-backend.log" -ErrorAction SilentlyContinue

Get-Content "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\version.json" -ErrorAction SilentlyContinue |
  Out-File "$evidence\FAIL-version-json.txt"
```

Then report: "FAILED — no window after 60s" with all the evidence files.

Do NOT try another approach. Do NOT suggest shipping v1.2.3 with patches.
Do NOT try hot-patching. Just report the failure and evidence.

---

## If it SUCCEEDS (window appears with v1.2.6 title)

Celebrate briefly, then test uninstall+reinstall:

1. Close the app normally
2. Uninstall from Settings > Apps > Installed Apps
3. Check: is `com.keepkey.vault` still in `%LOCALAPPDATA%`? (should be — we don't clean it)
4. Reinstall from the same setup exe
5. Launch again — does it work?

Report: "SUCCESS — upgrade from v1.2.3 to v1.2.6 works" with evidence.
