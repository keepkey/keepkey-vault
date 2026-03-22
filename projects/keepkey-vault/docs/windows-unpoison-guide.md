# Windows Unpoison Guide

Instructions for recovering a Windows machine from a broken KeepKey Vault
installation. Intended for support staff and affected users.

See also:

- `windows-release-cycle-2026-03.md` for the incident summary
- `electrobun-windows-internals.md` for the underlying Windows packaging model
- `windows-antidote-evidence-guide.md` for what to collect before and after an
  antidote release

---

## Symptoms of a Poisoned Install

- KeepKey Vault won't launch after install (silent failure, no window)
- Uninstall succeeds but reinstall says "files still present"
- Multiple `ElectrobunUpdate_*` entries in Windows Task Scheduler
- `bun.exe` or `launcher.exe` processes lingering in Task Manager
- WebView2 profile errors on launch

---

## Preserve Evidence Before Cleanup

If the machine is available for investigation, collect evidence before deleting
anything. Do this first unless the user is blocked and needs immediate repair.

Minimum evidence set:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\Desktop\kk-vault-evidence" | Out-Null

Get-Process -Name "KeepKeyVault", "launcher", "bun", "msedgewebview2" -ErrorAction SilentlyContinue |
  Select-Object Name, Id, Path, StartTime |
  Out-File "$env:USERPROFILE\Desktop\kk-vault-evidence\processes.txt"

Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -like "ElectrobunUpdate_*" } |
  Format-List * |
  Out-File "$env:USERPROFILE\Desktop\kk-vault-evidence\scheduled-tasks.txt"

Get-ChildItem "$env:LOCALAPPDATA\sh.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$env:USERPROFILE\Desktop\kk-vault-evidence\electrobun-state.txt"

Get-ChildItem "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$env:USERPROFILE\Desktop\kk-vault-evidence\webview2-state.txt"
```

If you suspect the installed app directory is corrupted, also capture:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$env:USERPROFILE\Desktop\kk-vault-evidence\installed-tree.txt"
```

Then continue with cleanup.

---

## Step 1: Kill All Running Processes

Open PowerShell as Administrator:

```powershell
# Kill KeepKey Vault processes
Get-Process -Name "KeepKeyVault", "launcher", "bun" -ErrorAction SilentlyContinue | Stop-Process -Force

# Kill any WebView2 processes tied to KeepKey
Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue | Where-Object {
    $_.MainModule.FileName -like "*keepkey*" -or $_.MainModule.FileName -like "*KeepKey*"
} | Stop-Process -Force
```

---

## Step 2: Uninstall via Add/Remove Programs

If KeepKey Vault appears in Settings > Apps > Installed Apps, uninstall it
normally first. This removes the Inno-Setup-managed files.

If it doesn't appear or uninstall fails, proceed to manual cleanup.

---

## Step 3: Remove Install Directory

```powershell
# Check both possible locations
$paths = @(
    "$env:LOCALAPPDATA\Programs\KeepKeyVault",
    "${env:ProgramFiles}\KeepKeyVault",
    "${env:ProgramFiles(x86)}\KeepKeyVault"
)

foreach ($p in $paths) {
    if (Test-Path $p) {
        Write-Host "Removing install dir: $p"
        Remove-Item -Recurse -Force $p
    }
}
```

---

## Step 4: Remove Electrobun Runtime State

This is the most critical step -- these files survive normal uninstall.

```powershell
# Electrobun app state (update archives, self-extraction, update scripts)
$ebPath = "$env:LOCALAPPDATA\sh.keepkey.vault"
if (Test-Path $ebPath) {
    Write-Host "Removing Electrobun state: $ebPath"
    Remove-Item -Recurse -Force $ebPath
}

# Also check for the identifier without dots
$ebPath2 = "$env:LOCALAPPDATA\keepkey-vault"
if (Test-Path $ebPath2) {
    Write-Host "Removing alt Electrobun state: $ebPath2"
    Remove-Item -Recurse -Force $ebPath2
}
```

---

## Step 5: Remove WebView2 User Data

```powershell
$wv2Path = "$env:LOCALAPPDATA\com.keepkey.vault"
if (Test-Path $wv2Path) {
    Write-Host "Removing WebView2 profiles: $wv2Path"
    Remove-Item -Recurse -Force $wv2Path
}
```

---

## Step 6: Remove Orphaned Scheduled Tasks

```powershell
# List any Electrobun update tasks
$tasks = schtasks /query /fo list 2>$null | Select-String "ElectrobunUpdate_"
if ($tasks) {
    Write-Host "Found orphaned update tasks:"
    $tasks | ForEach-Object { Write-Host "  $_" }

    # Delete them
    Get-ScheduledTask | Where-Object { $_.TaskName -like "ElectrobunUpdate_*" } | ForEach-Object {
        Write-Host "Deleting task: $($_.TaskName)"
        Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false
    }
} else {
    Write-Host "No orphaned update tasks found."
}
```

---

## Step 7: Remove Stale update.bat Files

```powershell
# Search for stale update scripts in LocalAppData
Get-ChildItem "$env:LOCALAPPDATA" -Filter "update.bat" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Found stale update script: $($_.FullName)"
    Remove-Item $_.FullName -Force
}
```

---

## Step 8: Clean Registry (Usually Not Needed)

Inno Setup uses registry entries to track installation. If the above steps
don't fix reinstall, check:

```powershell
# Check for KeepKey Vault uninstall registry entries
$regPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}_is1",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}_is1",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}_is1"
)

foreach ($rp in $regPaths) {
    if (Test-Path $rp) {
        Write-Host "Found registry entry: $rp"
        # Uncomment to remove:
        # Remove-Item $rp -Force
    }
}
```

---

## Step 9: Verify Clean State

After all cleanup:

```powershell
Write-Host "=== Verification ==="

# Check install dirs
$clean = $true
foreach ($p in @("$env:LOCALAPPDATA\Programs\KeepKeyVault",
                 "$env:LOCALAPPDATA\sh.keepkey.vault",
                 "$env:LOCALAPPDATA\com.keepkey.vault")) {
    if (Test-Path $p) {
        Write-Host "STILL EXISTS: $p"
        $clean = $false
    }
}

# Check processes
$procs = Get-Process -Name "KeepKeyVault", "launcher" -ErrorAction SilentlyContinue
if ($procs) {
    Write-Host "STILL RUNNING: $($procs.Name -join ', ')"
    $clean = $false
}

# Check scheduled tasks
$tasks = Get-ScheduledTask | Where-Object { $_.TaskName -like "ElectrobunUpdate_*" }
if ($tasks) {
    Write-Host "STILL SCHEDULED: $($tasks.TaskName -join ', ')"
    $clean = $false
}

if ($clean) {
    Write-Host "Machine is clean. Safe to reinstall."
} else {
    Write-Host "Residue remains. Review items above before reinstalling."
}
```

---

## Step 10: Reinstall

Download the latest installer from GitHub Releases and run it.

If install still fails after the above cleanup, the issue may be deeper than
file/registry residue. File a bug with the output of the verification script.

After reinstalling an antidote build, follow
`windows-antidote-evidence-guide.md` to record whether the machine was actually
repaired.

---

## One-Liner (Advanced Users)

Full cleanup in one command (run as Administrator):

```powershell
Stop-Process -Name KeepKeyVault,launcher,bun -Force -EA 0; Remove-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault","$env:LOCALAPPDATA\sh.keepkey.vault","$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -EA 0; Get-ScheduledTask | ? TaskName -like "ElectrobunUpdate_*" | Unregister-ScheduledTask -Confirm:$false -EA 0; Write-Host "Cleanup complete."
```

---

## Notes

- WebView2 Runtime itself does NOT need to be uninstalled. It's a shared
  Microsoft component used by many apps. Removing it would break other apps.
- Bun's global cache (`%LOCALAPPDATA%\.bun\`) is separate from KeepKey's
  bundled `bun.exe`. The bundled copy lives inside the install dir and is
  removed with it. The global cache is only present if the user installed
  Bun independently.
- The "can't uninstall Bun" symptom is likely confusion between the bundled
  `bun.exe` (inside KeepKeyVault dir) and a separately installed Bun. The
  bundled copy has no Add/Remove Programs entry.
- The most likely poisoned state is not a single `.dat` file. It is leftover
  runtime state across `%LOCALAPPDATA%\sh.keepkey.vault\`,
  `%LOCALAPPDATA%\com.keepkey.vault\`, and possibly orphaned update tasks.
