# PLAN ALPHA-3

You are a build-and-test agent. You do ONLY what this document says.
You do NOT close PRs. You do NOT mark releases as draft. You do NOT
delete branches. You do NOT modify GitHub in any way. You do NOT
suggest alternative approaches. You execute steps and report results.

## Goal

Three tests on one build. Each test answers a different question.
The build is already done from ALPHA-2 — reuse the same installer exe.

---

## TEST A: Full wipe + fresh install (is it the profile?)

### A1: Kill everything

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault","msedgewebview2" -Force -ErrorAction SilentlyContinue
Start-Sleep 5
```

### A2: Uninstall from Add/Remove Programs

Open Settings > Apps > Installed Apps. Find "KeepKey Vault". Uninstall it.
If it doesn't appear, skip this step.

### A3: Delete ALL KeepKey state

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\sh.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\KeepKey Vault" -Recurse -Force -ErrorAction SilentlyContinue
```

### A4: Verify clean

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\KeepKeyVault"
Test-Path "$env:LOCALAPPDATA\com.keepkey.vault"
```

Both must say `False`. If either says `True`, STOP and report what couldn't be deleted.

### A5: Install

```powershell
Start-Process -FilePath (Get-Item C:\Users\bithi\AProjects\keepkey-vault-v11\release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

Accept defaults. Check "Launch KeepKey Vault".

### A6: Wait 60 seconds

Do NOT touch anything.

### A7: Collect results

```powershell
$e = "$env:USERPROFILE\Desktop\alpha3-testA"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue
```

### A8: Report TEST A

```
TEST A (fresh install after full wipe):
1. MainWindowHandle: [paste number]
2. Did the window appear? (yes/no)
3. app.log has new entries? (yes/no, paste first 3 lines if yes)
4. backend.log exists? (yes/no, paste first 3 lines if yes)
```

**If TEST A PASSES (window appeared):** continue to TEST B.
**If TEST A FAILS:** STOP. Report "TEST A FAILED — fresh install on wiped machine fails." Do NOT continue to TEST B or C. This means the native binary is broken and no installer fix will help.

---

## TEST B: Over-install (does upgrade break it?)

Only do this if TEST A passed.

### B1: Close the app normally (click X). Wait 10 seconds.

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 5
```

### B2: Install again over the working install

```powershell
Start-Process -FilePath (Get-Item C:\Users\bithi\AProjects\keepkey-vault-v11\release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

Accept defaults. Check "Launch KeepKey Vault".

### B3: Wait 60 seconds

### B4: Collect results

```powershell
$e = "$env:USERPROFILE\Desktop\alpha3-testB"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue
```

### B5: Report TEST B

```
TEST B (over-install same version):
1. MainWindowHandle: [paste number]
2. Did the window appear? (yes/no)
3. app.log has new entries since TEST A? (yes/no)
4. backend.log has new entries since TEST A? (yes/no)
```

---

## TEST C: Over-install with asset cleanup (does cleaning stale files fix upgrade?)

Only do this if TEST A passed AND TEST B failed.

### C1: Close the app. Kill processes.

```powershell
Stop-Process -Name "bun","launcher","KeepKeyVault" -Force -ErrorAction SilentlyContinue
Start-Sleep 5
```

### C2: Delete ONLY the assets directory and WebView2 cache

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\views\mainview\assets" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\com.keepkey.vault\stable\WebView2\EBWebView\Default\Cache" -Recurse -Force -ErrorAction SilentlyContinue
```

### C3: Install again

```powershell
Start-Process -FilePath (Get-Item C:\Users\bithi\AProjects\keepkey-vault-v11\release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

Accept defaults. Check "Launch KeepKey Vault".

### C4: Wait 60 seconds

### C5: Collect results

```powershell
$e = "$env:USERPROFILE\Desktop\alpha3-testC"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue
```

### C6: Report TEST C

```
TEST C (over-install after clearing assets + WebView2 cache):
1. MainWindowHandle: [paste number]
2. Did the window appear? (yes/no)
3. app.log has new entries? (yes/no)
4. backend.log has new entries? (yes/no)
```

---

## Decision Tree

```
TEST A fails  → native binary broken. Need Electrobun fork. STOP.
TEST A passes, TEST B passes → upgrades work. Ship it.
TEST A passes, TEST B fails, TEST C passes → add [InstallDelete] for assets + WebView2 cache. Ship it.
TEST A passes, TEST B fails, TEST C fails → full profile wipe needed on upgrade. More investigation.
```

Report the decision tree result as the final line of your report.

## RULES

- Do NOT do anything not listed above.
- Do NOT close PRs.
- Do NOT mark releases as draft.
- Do NOT delete remote branches.
- Do NOT suggest alternative approaches.
- Do NOT modify any GitHub state.
- If TEST A fails, STOP. Do not continue.
