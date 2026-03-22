# Windows Antidote Evidence Guide

Instructions for validating a future Windows release that is intended to repair
or prevent the v1.2.5 poisoned-install state.

This guide is for support, QA, and engineering. The goal is to collect enough
evidence to answer two questions:

1. Did the new build successfully clean and reinstall affected machines?
2. What residue remains if it did not?

## Scope

Use this guide on:

- machines already affected by the poisoned-install state
- clean Windows VMs used for reproduction
- machines upgraded from an older KeepKey Vault release to the antidote release

## Test Matrix

At minimum, capture results for these paths:

1. Clean machine -> install antidote -> launch -> uninstall -> reinstall
2. Poisoned machine -> manual cleanup -> install antidote -> launch
3. Poisoned machine -> install antidote directly, without manual cleanup
4. Existing healthy machine -> upgrade to antidote

## Evidence to Capture Before Install

Create a workspace on the Desktop:

```powershell
$root = "$env:USERPROFILE\Desktop\kk-vault-antidote"
New-Item -ItemType Directory -Force $root | Out-Null
```

Capture machine identity:

```powershell
systeminfo | Out-File "$root\systeminfo.txt"
[System.Environment]::OSVersion | Out-File "$root\osversion.txt"
```

Capture installed-app and filesystem state:

```powershell
Get-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault" -ErrorAction SilentlyContinue |
  Format-List * | Out-File "$root\before-install-dir.txt"

Get-ChildItem "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\before-install-tree.txt"

Get-ChildItem "$env:LOCALAPPDATA\sh.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\before-electrobun-state.txt"

Get-ChildItem "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\before-webview2-state.txt"
```

Capture running processes and scheduled tasks:

```powershell
Get-Process -Name "KeepKeyVault", "launcher", "bun", "msedgewebview2" -ErrorAction SilentlyContinue |
  Select-Object Name, Id, Path, StartTime |
  Out-File "$root\before-processes.txt"

Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -like "ElectrobunUpdate_*" } |
  Format-List * |
  Out-File "$root\before-scheduled-tasks.txt"
```

Capture uninstall registry state:

```powershell
$regPaths = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}_is1",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}_is1",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}_is1"
)

foreach ($rp in $regPaths) {
  if (Test-Path $rp) {
    Get-ItemProperty $rp | Format-List * | Out-File "$root\registry-$((Split-Path $rp -Leaf).Replace('{','').Replace('}','')).txt"
  }
}
```

## During Install

Record:

- exact installer filename
- exact installer version
- whether Windows prompts for repair, upgrade, or normal install
- whether the installer reports file-in-use, permissions, or cleanup errors
- whether WebView2 bootstrapper runs

Take screenshots of every installer dialog if the machine is already poisoned.

If you launch from PowerShell, preserve the console output:

```powershell
Start-Process -FilePath ".\KeepKey-Vault-ANTIDOTE-win-x64-setup.exe" -Wait
```

## After Install

Capture the installed tree:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\after-install-tree.txt"
```

Capture version metadata:

```powershell
Get-Content "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\version.json" -ErrorAction SilentlyContinue |
  Out-File "$root\after-version-json.txt"
```

If the app launches, record process state:

```powershell
Get-Process -Name "KeepKeyVault", "launcher", "bun", "msedgewebview2" -ErrorAction SilentlyContinue |
  Select-Object Name, Id, Path, StartTime, MainWindowTitle, MainWindowHandle |
  Out-File "$root\after-launch-processes.txt"
```

Capture leftover runtime state:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\sh.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\after-electrobun-state.txt"

Get-ChildItem "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\after-webview2-state.txt"

Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -like "ElectrobunUpdate_*" } |
  Format-List * |
  Out-File "$root\after-scheduled-tasks.txt"
```

## After Uninstall

This is the critical proof point for the antidote release.

After uninstalling from Installed Apps, capture:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs\KeepKeyVault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\after-uninstall-install-tree.txt"

Get-ChildItem "$env:LOCALAPPDATA\sh.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\after-uninstall-electrobun-state.txt"

Get-ChildItem "$env:LOCALAPPDATA\com.keepkey.vault" -Recurse -Force -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, LastWriteTime |
  Out-File "$root\after-uninstall-webview2-state.txt"

Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -like "ElectrobunUpdate_*" } |
  Format-List * |
  Out-File "$root\after-uninstall-scheduled-tasks.txt"
```

## Success Criteria

An antidote release should satisfy all of these:

- installs on a previously poisoned machine without manual registry repair
- launches successfully after install
- leaves no orphaned `ElectrobunUpdate_*` tasks
- leaves no stale `%LOCALAPPDATA%\sh.keepkey.vault\stable\self-extraction\` residue
- leaves no broken reinstall path after uninstall
- can be reinstalled immediately after uninstall

## Failure Signatures to Flag

Escalate immediately if you observe any of these:

- installer says the app is still installed after uninstall
- `KeepKeyVault.exe` is removed but `launcher.exe` or `bun.exe` still run
- `%LOCALAPPDATA%\sh.keepkey.vault\stable\self-extraction\update.bat` still exists
- new `ElectrobunUpdate_*` tasks appear after install or uninstall
- `version.json` cannot be read or contains obvious BOM/parse corruption
- app launches with no window and `MainWindowHandle = 0`

## Minimal Evidence Bundle for Support

If full capture is too heavy, support should at least provide:

- screenshot of Installed Apps entry before and after uninstall
- screenshot of installer error dialog, if any
- `before-scheduled-tasks.txt`
- `after-uninstall-scheduled-tasks.txt`
- `after-uninstall-electrobun-state.txt`
- `after-uninstall-webview2-state.txt`

## Interpretation Notes

- WebView2 runtime itself is shared Microsoft infrastructure and is not evidence
  of KeepKey-specific poisoning by itself.
- `%LOCALAPPDATA%\.bun\` is only relevant if Bun was separately installed on the
  machine; do not treat it as proof of a KeepKey installer failure without more
  context.
- The strongest evidence is KeepKey-specific residue under:
  - `%LOCALAPPDATA%\Programs\KeepKeyVault`
  - `%LOCALAPPDATA%\sh.keepkey.vault`
  - `%LOCALAPPDATA%\com.keepkey.vault`
  - `ElectrobunUpdate_*` scheduled tasks
