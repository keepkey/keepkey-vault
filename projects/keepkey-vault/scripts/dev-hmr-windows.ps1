<#
.SYNOPSIS
    KeepKey Vault - Windows dev mode with Vite HMR
.DESCRIPTION
    Kills stale processes, clears locked build dirs, starts Vite HMR,
    builds the app, then runs Electrobun dev with console output.

    Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-hmr-windows.ps1
    Or:    bun run dev:hmr:win
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "    [OK] $Message" -ForegroundColor Green
}

function Stop-Port {
    param([int]$Port)
    $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $connections) { return }
    $procIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
        if ($procId -gt 0) {
            try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}

function Stop-KeepKeyProcesses {
    # Kill any bun/launcher/electrobun from prior runs that may lock _build/
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ProcessName -match 'electrobun' -or
            ($_.ProcessName -eq 'launcher' -and $_.Path -match 'keepkey') -or
            ($_.ProcessName -eq 'bun' -and $_.Path -match 'keepkey')
        } |
        ForEach-Object {
            try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
}

# ── Resolve paths ────────────────────────────────────────────────────────
if ($PSCommandPath) {
    $ScriptDir = Split-Path -Path $PSCommandPath -Parent
} else {
    $ScriptDir = Split-Path -Path $MyInvocation.MyCommand.Path -Parent
}
$ProjectDir = Split-Path -Path $ScriptDir -Parent
$BuildDir = Join-Path $ProjectDir "_build"

# ── Cleanup ──────────────────────────────────────────────────────────────
Write-Step "Cleaning up stale processes"
Stop-KeepKeyProcesses
Stop-Port -Port 5177   # Vite HMR
Stop-Port -Port 50000  # App REST server
Start-Sleep -Seconds 2

# Try to remove locked _build if it exists (WebView2 profile locks it)
if (Test-Path $BuildDir) {
    try {
        Remove-Item -Path $BuildDir -Recurse -Force -ErrorAction Stop
        Write-Success "Removed old _build/"
    } catch {
        Write-Host "    [WARN] _build/ locked - attempting rename workaround" -ForegroundColor Yellow
        $stale = Join-Path $ProjectDir "_build_stale_$(Get-Date -Format 'HHmmss')"
        try {
            Rename-Item $BuildDir $stale -ErrorAction Stop
            Write-Success "Renamed to $stale (clean up later)"
        } catch {
            Write-Host "    [WARN] Could not remove _build/ - Electrobun will try to overwrite" -ForegroundColor Yellow
        }
    }
}

# ── WebView2 profile isolation ───────────────────────────────────────────
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:LOCALAPPDATA "com.keepkey.vault\dev\webview2-$timestamp"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"

# ── Start Vite HMR ──────────────────────────────────────────────────────
Write-Step "Starting Vite HMR (port 5177)"
$hmrProc = Start-Process -FilePath "bun" -ArgumentList @("run", "hmr") -WorkingDirectory $ProjectDir -PassThru -WindowStyle Hidden

# Wait for Vite to bind
$maxWait = 15
for ($i = 0; $i -lt $maxWait; $i++) {
    $ready = Test-NetConnection -ComputerName "localhost" -Port 5177 -InformationLevel Quiet -WarningAction SilentlyContinue 2>$null
    if ($ready) { break }
    Start-Sleep -Seconds 1
}
if ($i -eq $maxWait) {
    Write-Host "    [WARN] Vite HMR may not be ready yet" -ForegroundColor Yellow
} else {
    Write-Success "Vite HMR ready on port 5177"
}

# ── Build ────────────────────────────────────────────────────────────────
Push-Location $ProjectDir
try {
    Write-Step "Building app (bundle-backend + vite + collect-externals + electrobun + patch-bundle)"
    bun scripts/bundle-backend.ts
    if ($LASTEXITCODE -ne 0) { throw "bundle-backend failed" }

    bunx vite build
    if ($LASTEXITCODE -ne 0) { throw "vite build failed" }

    bun scripts/collect-externals.ts
    if ($LASTEXITCODE -ne 0) { throw "collect-externals failed" }

    bunx electrobun build
    # electrobun build may warn about rcedit/zcash-cli — non-fatal

    bun scripts/patch-bundle.ts
    if ($LASTEXITCODE -ne 0) { throw "patch-bundle failed" }

    Write-Success "Build complete"

    # ── Launch ───────────────────────────────────────────────────────
    # CRITICAL: Do NOT use `bunx electrobun dev` — it spawns launcher.exe
    # through an intermediate process that breaks WebView2 window creation
    # on Windows. Launch launcher.exe directly from the build bin/ directory.
    $LauncherExe = Join-Path $BuildDir "dev-win-x64\keepkey-vault-dev\bin\launcher.exe"
    if (-not (Test-Path $LauncherExe)) {
        throw "launcher.exe not found at: $LauncherExe"
    }
    $LauncherDir = Split-Path $LauncherExe -Parent

    Write-Step "Launching app (launcher.exe direct)"
    Write-Host "    Press Ctrl+C to stop" -ForegroundColor Gray
    Write-Host ""

    Push-Location $LauncherDir
    & $LauncherExe
    Pop-Location
} finally {
    Pop-Location
    # Cleanup HMR process
    if ($hmrProc -and -not $hmrProc.HasExited) {
        try { Stop-Process -Id $hmrProc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    # Kill any remaining app processes
    Stop-KeepKeyProcesses
}
