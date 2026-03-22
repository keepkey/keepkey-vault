# PLAN ALPHA-4

You are a build-and-test agent. You do ONLY what this document says.
You do NOT close PRs. You do NOT mark releases as draft. You do NOT
delete branches. You do NOT modify GitHub in any way. You do NOT
suggest alternative approaches. You execute steps and report results.

## Goal

Two apps, tested in parallel. This tells us whether WebView2 works
AT ALL on this machine, and whether the problem is Electrobun or our app.

**App 1**: Electrobun Test App — bare minimum Electrobun app. No KeepKey
code, no device protocol, no Vite, no native modules. Just "open a window."

**App 2**: KeepKey Vault v1.2.6 — the ALPHA-2 build (already built, reuse it).

---

## PART 1: Build and test the demo app

### 1.1: Kill everything

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 3
```

### 1.2: Pull latest

```powershell
cd C:\Users\bithi\AProjects\keepkey-vault-v11
git checkout release-cycle
git pull origin release-cycle
```

### 1.3: Install demo app dependencies

```powershell
cd projects\electrobun-test-app
bun install
```

If it fails, STOP and report.

### 1.4: Build demo app

```powershell
bunx electrobun build
```

If it fails, STOP and report the error.

### 1.5: Launch demo app directly

Do NOT use an installer. Launch the built binary directly.

```powershell
$buildDir = Get-ChildItem _build -Directory | Select-Object -First 1
& "$($buildDir.FullName)\electrobun-test\bin\launcher.exe"
```

If `launcher.exe` doesn't exist, try:
```powershell
Get-ChildItem _build -Recurse -Filter "launcher.exe" | Select-Object FullName
```
Then run whatever path it shows.

### 1.6: Wait 30 seconds

### 1.7: Collect demo app results

```powershell
$e = "$env:USERPROFILE\Desktop\alpha4-demo"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun","launcher" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

# Check if WebView2 user data was created
Test-Path "$env:LOCALAPPDATA\com.keepkey.electrobun-test" |
  Out-File "$e\webview2-created.txt"
```

### 1.8: Report DEMO APP result

```
DEMO APP:
1. Did a window appear with "Electrobun Test App" title? (yes/no)
2. Did it show "WebView2 is working"? (yes/no)
3. MainWindowHandle: [paste number]
4. Was com.keepkey.electrobun-test created in LOCALAPPDATA? (yes/no)
```

### 1.9: Kill demo app

```powershell
Stop-Process -Name "bun","launcher" -Force -ErrorAction SilentlyContinue
Start-Sleep 3
```

---

## PART 2: Fresh install of KeepKey Vault v1.2.6

### 2.1: Full wipe of KeepKey Vault state

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\sh.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\KeepKey Vault" -Recurse -Force -ErrorAction SilentlyContinue
```

Also uninstall from Add/Remove Programs if any entry exists.

### 2.2: Verify clean

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\KeepKeyVault"
Test-Path "$env:LOCALAPPDATA\com.keepkey.vault"
```

Both must be `False`.

### 2.3: Install KeepKey Vault

```powershell
cd C:\Users\bithi\AProjects\keepkey-vault-v11
Start-Process -FilePath (Get-Item release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

Accept defaults. Check "Launch KeepKey Vault".

### 2.4: Wait 60 seconds

### 2.5: Collect vault results

```powershell
$e = "$env:USERPROFILE\Desktop\alpha4-vault"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue

Test-Path "$env:LOCALAPPDATA\com.keepkey.vault" |
  Out-File "$e\webview2-created.txt"

Get-FileHash "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\libNativeWrapper.dll" -ErrorAction SilentlyContinue |
  Out-File "$e\dll-hash.txt"
```

### 2.6: Report VAULT result

```
VAULT:
1. Did the window appear? (yes/no)
2. MainWindowHandle: [paste number]
3. app.log exists and has new entries? (yes/no, paste first 3 lines if yes)
4. backend.log exists? (yes/no, paste first 3 lines if yes)
5. Was com.keepkey.vault created in LOCALAPPDATA? (yes/no)
```

---

## PART 3: Final report

Report BOTH results together, then state which decision tree branch applies:

```
DEMO APP window appeared: [yes/no]
VAULT window appeared: [yes/no]
```

### Decision tree

```
Demo FAILS + Vault FAILS → WebView2 broken on this machine. Not our bug.
                            Need a different test machine.

Demo PASSES + Vault FAILS → Electrobun works, our app breaks it.
                             Problem is in our bun/index.ts or app config.
                             Next: strip vault app to minimum, binary search
                             for what breaks it.

Demo PASSES + Vault PASSES → Both work. Ship it.

Demo FAILS + Vault PASSES → (unlikely) Demo app config wrong. Ignore demo,
                             vault works.
```

Report the decision tree result as the final line.

## RULES

- Do NOT do anything not listed above.
- Do NOT close PRs.
- Do NOT mark releases as draft.
- Do NOT delete remote branches.
- Do NOT suggest alternative approaches.
- Do NOT modify any GitHub state.
- Execute PART 1 fully, then PART 2 fully, then PART 3.
