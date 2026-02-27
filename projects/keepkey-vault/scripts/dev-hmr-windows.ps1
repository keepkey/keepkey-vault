<#
.SYNOPSIS
    KeepKey Vault - Windows dev mode with Vite HMR
.DESCRIPTION
    Starts Vite HMR on port 5173, builds the app, then runs Electrobun dev.
    Also clears any existing process listening on port 5173.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Stop-Port {
    param([int]$Port)
    $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $connections) { return }

    $procIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
        if ($procId -gt 0) {
            try {
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            } catch {}
        }
    }
}

function Stop-ProcessByNamePattern {
    param([string]$Pattern)
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -like $Pattern } |
        ForEach-Object {
            try {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            } catch {}
        }
}

# Ensure WebView2 uses a unique user data dir per run (avoids locked profile issues)
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:LOCALAPPDATA "com.keepkey.vault\\dev\\webview2-$timestamp"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"

# Resolve paths
if ($PSCommandPath) {
    $ScriptDir = Split-Path -Path $PSCommandPath -Parent
} else {
    $ScriptDir = Split-Path -Path $MyInvocation.MyCommand.Path -Parent
}
$ProjectDir = Split-Path -Path $ScriptDir -Parent

Write-Step "Stopping existing dev/HMR processes"
Stop-Port -Port 5173
Stop-ProcessByNamePattern -Pattern "*electrobun*"

Write-Step "Starting Vite HMR (port 5173)"
$hmrProc = Start-Process -FilePath "bun" -ArgumentList @("run", "hmr") -WorkingDirectory $ProjectDir -PassThru

# Wait for Vite server to bind
$maxWait = 20
for ($i = 0; $i -lt $maxWait; $i++) {
    $ready = Test-NetConnection -ComputerName "localhost" -Port 5173 -InformationLevel Quiet
    if ($ready) { break }
    Start-Sleep -Seconds 1
}

Push-Location $ProjectDir
try {
    Write-Step "Building app (vite + electrobun build)"
    bun run build

    Write-Step "Starting Electrobun dev"
    bunx electrobun dev
} finally {
    Pop-Location
    if ($hmrProc -and -not $hmrProc.HasExited) {
        try {
            Stop-Process -Id $hmrProc.Id -Force -ErrorAction SilentlyContinue
        } catch {}
    }
}
