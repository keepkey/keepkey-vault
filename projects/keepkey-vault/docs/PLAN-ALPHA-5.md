# PLAN ALPHA-5

You are a build-and-test agent. You do ONLY what this document says.
You do NOT close PRs. You do NOT mark releases as draft. You do NOT
delete branches. You do NOT modify GitHub in any way. You execute
steps and report results.

## Goal

Two parallel tests on the same machine:

**Test 1**: Expanded demo app — same Electrobun config, same externals,
same native deps as vault. Staged imports with logging between each one.
If the demo passes, it proves the deps work. If it fails, the log shows
which import kills it.

**Test 2**: Vault's bun/index.js run directly from command line to
capture stdout/stderr. No launcher, no wrapper — just bun running the
vault code with visible output.

---

## PART 1: Pull and prepare

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

---

## PART 2: Build and run expanded demo app

### 2.1: Install demo app deps

```powershell
cd C:\Users\bithi\AProjects\keepkey-vault-v11\projects\electrobun-test-app
bun install
```

If it fails, STOP and paste the error.

### 2.2: Build demo app

```powershell
bun run build
```

If it fails, STOP and paste the error.

### 2.3: Copy node_modules into demo build

The demo needs runtime access to the external native deps. Copy them
from the project's node_modules into the build output:

```powershell
$buildDir = (Get-ChildItem _build -Directory | Select-Object -First 1).FullName
$appDir = Get-ChildItem "$buildDir" -Directory | Select-Object -First 1
$resApp = "$($appDir.FullName)\Resources\app"

# Copy node_modules from the demo project into the build
if (Test-Path "node_modules") {
  Copy-Item "node_modules" "$resApp\node_modules" -Recurse -Force
  Write-Host "Copied node_modules to build"
}
```

### 2.4: Wipe old demo state

```powershell
Remove-Item "$env:LOCALAPPDATA\com.keepkey.electrobun-test" -Recurse -Force -ErrorAction SilentlyContinue
```

### 2.5: Launch demo app

```powershell
$launcher = (Get-ChildItem _build -Recurse -Filter "launcher.exe" | Select-Object -First 1).FullName
Write-Host "Launching: $launcher"
Start-Process -FilePath $launcher
```

### 2.6: Wait 30 seconds

### 2.7: Collect demo results

```powershell
$e = "$env:USERPROFILE\Desktop\alpha5-demo"
New-Item -ItemType Directory -Force $e | Out-Null

Get-Process -Name "bun" -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\processes.txt"

Copy-Item "$env:LOCALAPPDATA\com.keepkey.electrobun-test\test-app.log" "$e\test-app.log" -ErrorAction SilentlyContinue
```

### 2.8: Report DEMO result

```
DEMO APP:
1. Did window appear? (yes/no)
2. MainWindowHandle: [number]
3. Paste ENTIRE contents of test-app.log
```

The log shows which stage passed and which failed. This is the key data.

### 2.9: Kill demo

```powershell
Stop-Process -Name "bun","launcher" -Force -ErrorAction SilentlyContinue
Start-Sleep 3
```

---

## PART 3: Run vault bun/index.js directly

This runs the INSTALLED vault's backend directly from command line,
bypassing launcher.exe and the Zig wrapper. We get raw stdout/stderr.

### 3.1: Verify vault is installed

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\bun.exe"
Test-Path "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\bun\index.js"
```

Both must be `True`. If vault is not installed, install it first:
```powershell
Start-Process -FilePath (Get-Item C:\Users\bithi\AProjects\keepkey-vault-v11\release-windows\KeepKey-Vault-*-setup.exe).FullName -Wait
```

### 3.2: Run bun directly with output capture

```powershell
$e = "$env:USERPROFILE\Desktop\alpha5-vault"
New-Item -ItemType Directory -Force $e | Out-Null

$bunExe = "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\bun.exe"
$indexJs = "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\bun\index.js"

Write-Host "Running: $bunExe $indexJs"
Write-Host "Will capture output for 30 seconds then kill..."

$proc = Start-Process -FilePath $bunExe -ArgumentList $indexJs `
  -RedirectStandardOutput "$e\stdout.txt" `
  -RedirectStandardError "$e\stderr.txt" `
  -PassThru -NoNewWindow

Start-Sleep 30

# Check if window appeared
Get-Process -Id $proc.Id -ErrorAction SilentlyContinue |
  Select-Object ProcessName, Id, MainWindowTitle, MainWindowHandle |
  Out-File "$e\process-state.txt"

# Kill it
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
```

### 3.3: Collect vault direct-run results

```powershell
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" "$e\backend.log" -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" "$e\app.log" -ErrorAction SilentlyContinue
```

### 3.4: Report VAULT DIRECT result

```
VAULT DIRECT RUN:
1. Did stdout.txt have content? (yes/no, paste first 20 lines)
2. Did stderr.txt have content? (yes/no, paste first 20 lines)
3. Did a window appear? (yes/no)
4. MainWindowHandle: [number]
5. Did backend.log get created/updated? (yes/no, paste first 5 lines if yes)
6. Did app.log get new entries? (yes/no, paste first 5 lines if yes)
```

---

## PART 4: Final report

Report BOTH results. The combination tells us:

```
Demo window + all stages pass → deps are fine, problem is vault-specific startup path
Demo window + some stages fail → specific dep is broken, log says which one
Demo no window → Electrobun config or build issue (not deps)
Vault stdout shows error → we see the exact crash
Vault stdout empty + no window → process hangs before any JS executes
```

## RULES

- Do NOT do anything not listed above.
- Do NOT close PRs or modify GitHub state.
- Do NOT suggest alternative approaches.
- Paste the FULL test-app.log — every line matters.
- Paste stdout.txt and stderr.txt content — this is the primary evidence.
