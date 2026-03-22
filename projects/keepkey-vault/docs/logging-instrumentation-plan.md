# Logging Instrumentation Plan

Every phase of the app lifecycle must write to a log file so we can
diagnose failures from evidence, not guesswork.

## Log File Locations

| Phase | Log File | Written By |
|-------|----------|------------|
| Install | `%TEMP%\KeepKeyVault-install.log` | Inno Setup |
| Zig Wrapper (splash) | `%LOCALAPPDATA%\com.keepkey.vault\wrapper.log` | KeepKeyVault.exe |
| Launcher | `{app}\bin\launcher.log` | launcher.exe (stdout) |
| Native Layer | `{app}\bin\app.log` | libNativeWrapper.dll |
| Backend (bun) | `%LOCALAPPDATA%\com.keepkey.vault\vault-backend.log` | bun Worker |
| Uninstall | `%TEMP%\KeepKeyVault-uninstall.log` | Inno Setup |

## Phase 1: Installer Logging (Inno Setup)

### Install log
Already supported — Inno Setup has built-in `/LOG` flag:
```
KeepKey-Vault-1.2.5-win-x64-setup.exe /LOG="%TEMP%\KeepKeyVault-install.log"
```

But we should enable it by default in `installer.iss`:
```ini
[Setup]
SetupLogging=yes
```

This creates `Setup Log {date}.txt` in `%TEMP%`.

### What to log in [Code] section
Add `Log()` calls to every Pascal Script procedure:
```pascal
procedure KillKeepKeyProcesses();
begin
  Log('KillKeepKeyProcesses: starting');
  Log('KillKeepKeyProcesses: killing bun.exe');
  Exec('taskkill.exe', '/F /IM bun.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Log('KillKeepKeyProcesses: bun.exe result=' + IntToStr(ResultCode));
  // ... etc
end;
```

### Uninstall log
```ini
[Setup]
UninstallLogMode=append
```

## Phase 2: Zig Wrapper Logging (KeepKeyVault.exe)

The Zig wrapper (`wrapper-launcher.zig`) currently writes nothing to disk.
It shows a splash screen and spawns launcher.exe.

### Add file logging:
```zig
// At startup, before anything else:
const log_path = getAppDataPath() ++ "\\com.keepkey.vault\\wrapper.log";
const log_file = std.fs.createFileAbsolute(log_path, .{});

fn log(msg: []const u8) void {
    const ts = getTimestamp();
    log_file.writer().print("[{s}] {s}\n", .{ts, msg});
}

// Log every step:
log("Wrapper starting");
log("Creating splash window");
log("Spawning launcher.exe");
log("Launcher spawned, PID=" ++ pid);
log("Waiting for main window...");
log("Main window detected, closing splash");
// OR
log("Timeout: no main window after 30s, exiting");
```

### Watchdog timer:
```zig
// If main window doesn't appear in 60s, kill child processes and exit
const WATCHDOG_MS = 60000;
SetTimer(splash_hwnd, WATCHDOG_TIMER_ID, WATCHDOG_MS, null);

// In WndProc:
WM_TIMER => {
    if (timer_id == WATCHDOG_TIMER_ID) {
        log("WATCHDOG: no main window after 60s, killing children and exiting");
        TerminateProcess(launcher_process, 1);
        PostQuitMessage(1);
    }
}
```

## Phase 3: Launcher Logging (launcher.exe)

launcher.exe is an Electrobun binary — we can't modify it without building
from source (fork). But its stdout goes to the console when launched from
cmd. For production:

### Redirect stdout in Zig wrapper:
```zig
// Instead of just spawning launcher.exe, redirect its stdout:
const launcher_log = createFile("launcher.log");
CreateProcess(
    launcher_exe,
    .hStdOutput = launcher_log,
    .hStdError = launcher_log,
);
```

## Phase 4: Native Layer Logging (libNativeWrapper.dll)

Already writes to `bin/app.log` — but ONLY after initialization succeeds.
The critical gap: **nothing is logged when startEventLoop hangs.**

### Fork fix needed:
In `nativeWrapper.cpp`, add logging BEFORE the message loop:
```cpp
void startEventLoop(const char* identifier, const char* name, const char* channel) {
    // Open log file FIRST, before anything else
    FILE* log = fopen("app.log", "a");
    fprintf(log, "[%s] startEventLoop called: id=%s name=%s ch=%s\n",
            timestamp(), identifier, name, channel);

    // Log each step:
    fprintf(log, "[%s] Creating message window...\n", timestamp());
    HWND messageWindow = CreateWindowA(...);
    fprintf(log, "[%s] Message window: %p\n", timestamp(), messageWindow);

    fprintf(log, "[%s] Entering message loop...\n", timestamp());
    // ... message loop
}
```

### WebView2 initialization logging:
```cpp
fprintf(log, "[%s] CreateCoreWebView2EnvironmentWithOptions called\n", timestamp());
HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(...);
fprintf(log, "[%s] Result: 0x%08X\n", timestamp(), hr);

// In the callback:
fprintf(log, "[%s] Environment created, creating controller...\n", timestamp());
fprintf(log, "[%s] Controller created, HRESULT: 0x%08X\n", timestamp(), result);
fprintf(log, "[%s] WebView2 visible, navigating to URL\n", timestamp());
```

## Phase 5: Backend Logging (vault-backend.log)

Already implemented in PR #43:
- File logger intercepts console.log/warn/error
- Writes to `%LOCALAPPDATA%\com.keepkey.vault\vault-backend.log`
- `[PERF]` timestamps throughout boot

### Gap: log file uses `flags: 'w'` (overwrite)
Should use `flags: 'a'` (append) with rotation, so we can see logs from
crashed runs that didn't complete:
```typescript
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
// Add separator on each run:
logStream.write(`\n=== New session: ${new Date().toISOString()} ===\n`)
```

## Phase 6: Evidence Collection Script

Create `scripts/collect-diagnostics.ps1`:
```powershell
$out = "$env:TEMP\keepkey-diagnostics-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
mkdir $out

# Logs
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\vault-backend.log" $out -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\com.keepkey.vault\wrapper.log" $out -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\app.log" $out -ErrorAction SilentlyContinue
Get-ChildItem "$env:TEMP\Setup Log*.txt" | Copy-Item -Destination $out

# System state
Get-Process | Where-Object { $_.ProcessName -match 'bun|launcher|KeepKey|msedgewebview2' } |
    Select-Object ProcessName, Id, Path | Out-File "$out\processes.txt"

Get-ScheduledTask | Where-Object { $_.TaskName -like 'ElectrobunUpdate_*' } |
    Out-File "$out\scheduled-tasks.txt"

Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'KeepKey|bun|electrobun' } |
    Select-Object DisplayName, UninstallString | Out-File "$out\registry.txt"

Get-ChildItem "$env:LOCALAPPDATA" -Directory |
    Where-Object { $_.Name -match 'keepkey|vault|electrobun' } |
    Select-Object Name, LastWriteTime | Out-File "$out\appdata-dirs.txt"

# Hashes
Get-FileHash "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\libNativeWrapper.dll" |
    Out-File "$out\hashes.txt"
Get-FileHash "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\main.js" |
    Out-File "$out\hashes.txt" -Append
Get-FileHash "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\bun.exe" |
    Out-File "$out\hashes.txt" -Append

# version.json
Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\version.json" $out -ErrorAction SilentlyContinue
Copy-Item "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\metadata.json" $out -ErrorAction SilentlyContinue

Write-Host "Diagnostics saved to: $out"
Compress-Archive -Path $out -DestinationPath "$out.zip"
Write-Host "Zipped: $out.zip"
```

## Implementation Priority

1. **Installer logging** (`SetupLogging=yes` + `Log()` calls) — 30 min
2. **Backend log append mode** (change `'w'` to `'a'`) — 5 min
3. **Diagnostics collection script** — 30 min
4. **Zig wrapper logging + watchdog** — 2 hours
5. **Native layer logging** (requires fork) — part of electrobun fork work
6. **Launcher stdout redirect** (requires fork or wrapper change) — 1 hour
