# PLAN ALPHA-4

You are a build-and-test agent. You do ONLY what this document says.
You do NOT close PRs. You do NOT mark releases as draft. You do NOT
delete branches. You do NOT modify GitHub in any way. You build, install,
test, and report. Nothing else.

## Goal

Run two tests in parallel on the SAME Windows machine:

1. **KeepKey Vault** — full real app installer path
2. **Electrobun Test App** — minimal native WebView2 smoke test

This plan exists to stop guessing. The demo app answers one narrow question:

> Can Electrobun + WebView2 create a visible window on this machine at all?

If the demo app fails, stop blaming KeepKey app code. If the demo app passes
while Vault fails, stop blaming the machine generically.

## Expected Outcomes

Decision matrix:

| Vault | Demo App | Meaning |
|------|----------|---------|
| PASS | PASS | Machine + native layer are fine. Problem is in Vault packaging/state/app path. |
| FAIL | PASS | KeepKey-specific packaging, cache, or runtime path is broken. |
| FAIL | FAIL | Machine, WebView2 runtime, or Electrobun native layer is broken on this host. |
| PASS | FAIL | Inconsistent result — collect all evidence and STOP. |

## PART 1: Prepare Vault Build

### 1.1 Close running processes

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 5
```

### 1.2 Pull latest branch

```powershell
cd C:\Users\bithi\AProjects\keepkey-vault-v11
git checkout release-cycle
git pull origin release-cycle
```

### 1.3 Build Vault frontend

```powershell
cd projects\keepkey-vault
bunx vite build
```

If this fails, STOP and paste the error.

### 1.4 Verify fixed asset filenames

```powershell
Get-ChildItem dist\assets\*.js | Select-Object Name
```

Expected: `index.js`, `asset-data.js`, locale chunks, no hashed filenames.

If you see `index-XXXX.js`, STOP and report `HASHED ASSETS STILL PRESENT`.

### 1.5 Build full Vault installer

```powershell
bun scripts\collect-externals.ts
bunx electrobun build
cd ..\..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows-production.ps1
```

If any step fails, STOP and paste the error.

### 1.6 Verify installer exists

```powershell
Get-Item release-windows\KeepKey-Vault-*-setup.exe | Select-Object Name, Length
```

If no installer exists, STOP and report `NO VAULT INSTALLER`.

## PART 2: Build Minimal Electrobun Test App

### 2.1 Verify demo app exists

```powershell
Get-Item C:\Users\bithi\AProjects\keepkey-vault-v11\projects\electrobun-test-app\package.json
```

If missing, STOP and report `DEMO APP MISSING`.

### 2.2 Install demo app dependencies

```powershell
cd C:\Users\bithi\AProjects\keepkey-vault-v11\projects\electrobun-test-app
bun install
```

If this fails, STOP and paste the error.

### 2.3 Build demo app

```powershell
bun run build
```

If this fails, STOP and paste the error.

### 2.4 Verify demo app build output

```powershell
Get-ChildItem _build -Recurse -Filter "launcher.exe" | Select-Object FullName
```

If no `launcher.exe` appears, STOP and report `DEMO APP BUILD MISSING`.

## PART 3: Test Vault

### 3.1 Fully wipe KeepKey Vault state

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault","msedgewebview2" -Force -ErrorAction SilentlyContinue
Start-Sleep 5
Remove-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\sh.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\KeepKey Vault" -Recurse -Force -ErrorAction SilentlyContinue
```

### 3.2 Install Vault fresh

```powershell
Start-Process -FilePath (Get-Item C:\Users\bithi\AProjects\keepkey-vault-v11\release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

Accept defaults. Check `Launch KeepKey Vault`.

### 3.3 Wait 60 seconds

Do NOT touch anything.

### 3.4 Collect Vault evidence

```powershell
$e = "$env:USERPROFILE\Desktop\alpha4-vault"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun","launcher","KeepKeyVault" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle, Path |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue

Get-ChildItem "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\views\mainview\assets\*.js" -ErrorAction SilentlyContinue |
  Select-Object Name |
  Out-File "$e\asset-filenames.txt"

Get-Content "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\views\mainview\index.html" -ErrorAction SilentlyContinue |
  Out-File "$e\index.html.txt"
```

## PART 4: Test Demo App

### 4.1 Close Vault before demo test

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 5
```

### 4.2 Wipe demo app state

```powershell
Remove-Item "$env:LOCALAPPDATA\com.keepkey.electrobun-test" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "C:\Users\bithi\AProjects\keepkey-vault-v11\projects\electrobun-test-app\_build" -Recurse -Force -ErrorAction SilentlyContinue
```

### 4.3 Rebuild demo app after wipe

```powershell
cd C:\Users\bithi\AProjects\keepkey-vault-v11\projects\electrobun-test-app
bun run build
```

If this fails, STOP and paste the error.

### 4.4 Launch demo app

```powershell
$launcher = (Get-ChildItem _build -Recurse -Filter "launcher.exe" | Select-Object -First 1).FullName
Start-Process -FilePath $launcher
```

### 4.5 Wait 20 seconds

Do NOT touch anything.

### 4.6 Collect demo app evidence

```powershell
$e = "$env:USERPROFILE\Desktop\alpha4-demo"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun","launcher" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle, Path |
  Out-File "$e\processes.txt"

Get-ChildItem _build -Recurse -Filter "*.log" -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$e\logs-present.txt"
```

## PART 5: Report

Report EXACTLY these answers:

### Vault

1. Did the Vault installer finish? (yes/no)
2. Did the Vault splash screen appear? (yes/no)
3. Did the Vault main window appear? (yes/no)
4. What is Vault `MainWindowHandle`? (paste number)
5. Does Vault `app.log` have NEW entries? (yes/no, paste first 5 lines if yes)
6. Does Vault `backend.log` have content? (yes/no, paste first 5 lines if yes)
7. What JS filenames are on disk? (paste list)
8. What bundle name does `index.html` reference? (paste the script line)

### Demo App

9. Did the demo app window appear? (yes/no)
10. What is demo app `MainWindowHandle`? (paste number)
11. Were any log files created for the demo app? (yes/no, paste list)
12. Does the demo app prove Electrobun can open a window on this machine? (yes/no)

### Final classification

13. Which matrix result matches?
    - `Vault PASS / Demo PASS`
    - `Vault FAIL / Demo PASS`
    - `Vault FAIL / Demo FAIL`
    - `Vault PASS / Demo FAIL`

14. Based on the matrix, what is the narrowest correct conclusion?

## RULES

- Do NOT do anything not listed above.
- Do NOT close PRs.
- Do NOT mark releases as draft.
- Do NOT delete remote branches.
- Do NOT suggest alternative approaches.
- Do NOT hot-patch anything.
- Do NOT modify any GitHub state.
- If any required build step fails, STOP and report it.
