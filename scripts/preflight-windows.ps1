<#
.SYNOPSIS
    KeepKey Vault - Windows preflight check.

.DESCRIPTION
    Validates every build/sign prerequisite documented in
    docs/WINDOWS-BUILD-QUIRKS.md. Run this BEFORE invoking
    build-windows-production.ps1.

    Exits 0 if all checks pass, 1 otherwise. Each failing check prints a
    pointer to the relevant section in WINDOWS-BUILD-QUIRKS.md.

.PARAMETER Strict
    Treat warnings as failures.

.PARAMETER SkipSign
    Don't check cert / EV token state (useful for non-signing dev builds).

.EXAMPLE
    .\scripts\preflight-windows.ps1

.EXAMPLE
    .\scripts\preflight-windows.ps1 -Strict

.EXAMPLE
    .\scripts\preflight-windows.ps1 -SkipSign
#>

param(
    [switch]$Strict = $false,
    [switch]$SkipSign = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# ── State ────────────────────────────────────────────────────────────────
$script:Failures = @()
$script:Warnings = @()

function Pass {
    param([string]$Msg)
    Write-Host "  [OK]   $Msg" -ForegroundColor Green
}
function Fail {
    param([string]$Msg, [string]$Quirk = "")
    $script:Failures += $Msg
    Write-Host "  [FAIL] $Msg" -ForegroundColor Red
    if ($Quirk) { Write-Host "         See docs/WINDOWS-BUILD-QUIRKS.md $Quirk" -ForegroundColor DarkGray }
}
function Warn {
    param([string]$Msg, [string]$Quirk = "")
    $script:Warnings += $Msg
    Write-Host "  [WARN] $Msg" -ForegroundColor Yellow
    if ($Quirk) { Write-Host "         See docs/WINDOWS-BUILD-QUIRKS.md $Quirk" -ForegroundColor DarkGray }
}
function Section {
    param([string]$Name)
    Write-Host ""
    Write-Host "==> $Name" -ForegroundColor Cyan
}

# Resolve repo root from script location
$ScriptDir = if ($PSCommandPath) { Split-Path -Path $PSCommandPath -Parent } else { Split-Path -Path $MyInvocation.MyCommand.Path -Parent }
$RepoRoot = Split-Path -Path $ScriptDir -Parent
$ProjectDir = Join-Path $RepoRoot "projects\keepkey-vault"
$BuildDir = Join-Path $ProjectDir "_build"

Write-Host ""
Write-Host "============================================" -ForegroundColor Magenta
Write-Host "  KeepKey Vault Windows preflight check    " -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta

# ── Git state ────────────────────────────────────────────────────────────
Section "Git state"
try {
    $branch = (& git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>&1).Trim()
    Pass "On branch: $branch"
    $dirty = (& git -C $RepoRoot status --short 2>&1)
    if ($dirty) {
        Warn "Working tree is dirty (uncommitted changes present):"
        $dirty -split "`n" | ForEach-Object { Write-Host "          $_" -ForegroundColor DarkGray }
    } else {
        Pass "Working tree is clean"
    }
} catch {
    Fail "git is not available or repo is broken: $($_.Exception.Message)"
}

# ── Project version ──────────────────────────────────────────────────────
Section "Project version"
$pkg = $null
$pkgJsonPath = Join-Path $ProjectDir "package.json"
if (-not (Test-Path $pkgJsonPath)) {
    Fail "package.json not found at $pkgJsonPath"
} else {
    try {
        $pkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
        Pass "package.json version: $($pkg.version)"
    } catch {
        Fail "Failed to parse package.json: $($_.Exception.Message)"
    }
}

# ── device-protocol/lib (quirk 8) ────────────────────────────────────────
Section "device-protocol/lib"
$messagesPb = Join-Path $RepoRoot "modules\device-protocol\lib\messages_pb.js"
if (Test-Path $messagesPb) {
    Pass "modules/device-protocol/lib/messages_pb.js present"
} else {
    Fail "modules/device-protocol/lib/messages_pb.js MISSING" "quirk 8"
    Write-Host "         Build via Git-Bash: cd modules/device-protocol && npm install && npm run build" -ForegroundColor DarkGray
}

# ── _build/ staleness (quirk 9) ──────────────────────────────────────────
Section "Build dir freshness"
if (Test-Path $BuildDir) {
    $devBuild = Join-Path $BuildDir "dev-win-x64\keepkey-vault-dev"
    if (Test-Path $devBuild) {
        $oldest = Get-ChildItem $devBuild -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime |
            Select-Object -First 1
        if ($oldest) {
            $age = ((Get-Date) - $oldest.LastWriteTime).TotalDays
            if ($age -gt 1) {
                Warn ("_build/ contains files older than 1 day (oldest: {0}, {1:N1} days)" -f $oldest.Name, $age) "quirk 9"
                Write-Host "         Recommend: Remove-Item -Recurse projects\keepkey-vault\_build" -ForegroundColor DarkGray
            } else {
                Pass "_build/ is recent (oldest file <1 day old)"
            }
        }
        # version.json sanity (quirk 10)
        $vj = Join-Path $devBuild "Resources\version.json"
        if ((Test-Path $vj) -and ($pkg)) {
            try {
                $vjObj = Get-Content $vj -Raw | ConvertFrom-Json
                if ($vjObj.version -eq $pkg.version) {
                    Pass "version.json matches package.json ($($pkg.version))"
                } else {
                    Fail "version.json reports $($vjObj.version) but package.json says $($pkg.version)" "quirk 10"
                    Write-Host "         The build script forces this match, but if you're not rebuilding it'll ship stale." -ForegroundColor DarkGray
                }
            } catch {
                Warn "version.json present but unparseable"
            }
        }
    }
} else {
    Pass "_build/ is absent (clean state)"
}

# ── Tool versions (quirks 1, 14) ─────────────────────────────────────────
Section "Build tools"

# Zig (quirk 1)
$zigCandidates = @(
    "$env:USERPROFILE\tools\zig-x86_64-windows-0.15.1\zig.exe",
    "$env:USERPROFILE\tools\zig-x86_64-windows-0.15.2\zig.exe"
)
$zigExe = $null
foreach ($p in $zigCandidates) {
    if (Test-Path $p) { $zigExe = $p; break }
}
if (-not $zigExe) {
    $zigExe = (Get-Command zig -ErrorAction SilentlyContinue).Source
}
if (-not $zigExe) {
    Fail "Zig compiler not found" "quirk 1"
} else {
    $zigVer = (& $zigExe version 2>&1).Trim()
    if ($zigVer -match '^0\.15\.') {
        Pass "Zig version: $zigVer (at $zigExe)"
    } else {
        Fail "Zig $zigVer at $zigExe (need 0.15.x)" "quirk 1"
        Write-Host "         Install from https://ziglang.org/download/0.15.1/zig-x86_64-windows-0.15.1.zip" -ForegroundColor DarkGray
    }
}

# PowerShell
$psVer = $PSVersionTable.PSVersion.ToString()
if ($PSVersionTable.PSVersion.Major -ge 5) {
    Pass "PowerShell version: $psVer"
} else {
    Fail "PowerShell version $psVer is too old (need 5.1+)"
}

# Bun
$bunExe = (Get-Command bun -ErrorAction SilentlyContinue).Source
if ($bunExe) {
    $bunVer = (& bun --version 2>&1).Trim()
    Pass "Bun: $bunVer (at $bunExe)"
} else {
    Fail "Bun not found on PATH"
    Write-Host "         winget install Oven-sh.Bun" -ForegroundColor DarkGray
}

# Yarn
$yarnExe = (Get-Command yarn -ErrorAction SilentlyContinue).Source
if ($yarnExe) {
    $yarnVer = (& yarn --version 2>&1).Trim()
    Pass "Yarn: $yarnVer (at $yarnExe)"
} else {
    Fail "Yarn not found on PATH (required by modules/hdwallet)"
    Write-Host "         winget install Yarn.Yarn" -ForegroundColor DarkGray
}

# Cargo (Rust)
$cargoExe = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if ($cargoExe) {
    $cargoVer = ((& cargo --version 2>&1) -split " ")[1]
    Pass "Cargo: $cargoVer (at $cargoExe)"
} else {
    Fail "Cargo not found on PATH (required by zcash-cli sidecar)"
    Write-Host "         winget install Rustlang.Rustup; rustup default stable" -ForegroundColor DarkGray
}

# Inno Setup
$iscc = $null
$isccPaths = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
foreach ($p in $isccPaths) { if (Test-Path $p) { $iscc = $p; break } }
if ($iscc) {
    Pass "Inno Setup: $iscc"
} else {
    Fail "Inno Setup 6 not found"
    Write-Host "         winget install JRSoftware.InnoSetup" -ForegroundColor DarkGray
}

# SignTool (only if signing)
if (-not $SkipSign) {
    $sdkBase = "C:\Program Files (x86)\Windows Kits\10\bin"
    $signtool = $null
    if (Test-Path $sdkBase) {
        $sdks = Get-ChildItem $sdkBase -Directory | Where-Object Name -match '^\d+\.\d+\.\d+\.\d+$' | Sort-Object Name -Descending
        foreach ($sdk in $sdks) {
            $cand = Join-Path $sdk.FullName "x64\signtool.exe"
            if (Test-Path $cand) { $signtool = $cand; break }
        }
    }
    if ($signtool) {
        Pass "SignTool: $signtool"
    } else {
        Fail "SignTool not found - install Windows SDK" "quirk 19"
    }
}

# ── Shell script line endings (quirks 3, 12) ─────────────────────────────
Section "Shell script line endings"
$shScripts = @(
    @(Get-ChildItem -Recurse "$ProjectDir\scripts" -Filter "*.sh" -ErrorAction SilentlyContinue)
    @(Get-ChildItem -Recurse "$RepoRoot\scripts" -Filter "*.sh" -ErrorAction SilentlyContinue)
)
$crlfFiles = @()
foreach ($s in $shScripts) {
    $head = [System.IO.File]::ReadAllBytes($s.FullName)
    if ($head.Length -ge 2) {
        # Look for CR before first LF
        for ($i = 0; $i -lt [Math]::Min($head.Length, 4096); $i++) {
            if ($head[$i] -eq 0x0A) {
                if ($i -gt 0 -and $head[$i - 1] -eq 0x0D) { $crlfFiles += $s.FullName }
                break
            }
        }
    }
}
if ($crlfFiles.Count -eq 0) {
    Pass "All $($shScripts.Count) .sh scripts have LF line endings"
} else {
    Fail "$($crlfFiles.Count) .sh scripts have CRLF line endings (will fail bash parsing)" "quirk 3"
    foreach ($f in $crlfFiles) { Write-Host "         $f" -ForegroundColor DarkGray }
    Write-Host "         Fix: sed -i 's/\r`$//' <file>" -ForegroundColor DarkGray
}

# ── Long path support (quirk 5) ──────────────────────────────────────────
Section "Long path support"
$lpe = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -ErrorAction SilentlyContinue
if ($lpe -and $lpe.LongPathsEnabled -eq 1) {
    Pass "NTFS LongPathsEnabled = 1"
} else {
    Warn "NTFS LongPathsEnabled is not 1 - submodule deps may fail" "quirk 5"
    Write-Host "         Fix (admin): New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force" -ForegroundColor DarkGray
}
$gitLpRaw = & git config --get core.longpaths 2>&1
$gitLp = if ($gitLpRaw) { ($gitLpRaw -join "`n").Trim() } else { "" }
if ($gitLp -eq "true") {
    Pass "git core.longpaths = true"
} else {
    Warn "git core.longpaths is not true" "quirk 5"
    Write-Host "         Fix: git config --system core.longpaths true" -ForegroundColor DarkGray
}

# ── npm/Bun TLS state (quirk 2) ──────────────────────────────────────────
Section "TLS / package fetch state"
$npmrc = Join-Path $env:USERPROFILE ".npmrc"
if (Test-Path $npmrc) {
    $npmContent = Get-Content $npmrc -Raw
    if ($npmContent -match "strict-ssl\s*=\s*false") {
        Warn "~/.npmrc has strict-ssl=false (corporate TLS inspection likely)" "quirk 2"
        Write-Host "         Bun does NOT honor this. If bun install fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE," -ForegroundColor DarkGray
        Write-Host "         run: `$env:NODE_TLS_REJECT_UNAUTHORIZED='0'; bun install" -ForegroundColor DarkGray
    } else {
        Pass "~/.npmrc TLS config looks default"
    }
} else {
    Pass "~/.npmrc absent (default TLS state)"
}
$proxyVars = @(@($env:HTTP_PROXY, $env:HTTPS_PROXY) | Where-Object { $_ })
if ($proxyVars.Count -gt 0) {
    Warn "Proxy env vars set: $($proxyVars -join ', ')"
} else {
    Pass "No proxy env vars set"
}

# ── Defender exclusions (quirk 27) ───────────────────────────────────────
Section "Windows Defender exclusions"
try {
    $mp = Get-MpPreference -ErrorAction SilentlyContinue
    if ($mp) {
        $exPaths = @($mp.ExclusionPath)
        $exProcs = @($mp.ExclusionProcess)
        $repoExcluded = $exPaths | Where-Object { $RepoRoot -like "$_*" }
        $stagingExcluded = $exPaths | Where-Object { "C:\tmp\kk" -like "$_*" }
        if ($repoExcluded) {
            Pass "Repo dir is excluded from Defender ($repoExcluded)"
        } else {
            Warn "Repo dir not in Defender exclusions (build will be slow)" "quirk 27"
            Write-Host "         Run as admin: Add-MpPreference -ExclusionPath '$RepoRoot'" -ForegroundColor DarkGray
        }
        if ($stagingExcluded) {
            Pass "C:\tmp\kk staging is excluded"
        } else {
            Warn "C:\tmp\kk not in Defender exclusions" "quirk 27"
            Write-Host "         Run as admin: Add-MpPreference -ExclusionPath 'C:\tmp\kk'" -ForegroundColor DarkGray
        }
        $expectedProcs = @('signtool.exe', 'robocopy.exe', 'bun.exe', 'node.exe', 'cargo.exe', 'ISCC.exe')
        $missing = $expectedProcs | Where-Object { $_ -notin $exProcs }
        if ($missing.Count -eq 0) {
            Pass "Defender process exclusions cover build tools"
        } else {
            Warn "Defender process exclusions missing: $($missing -join ', ')" "quirk 27"
        }
    } else {
        Warn "Could not query Defender (Get-MpPreference unavailable in this shell)"
    }
} catch {
    Warn "Defender check failed: $($_.Exception.Message)"
}

# ── EV signing cert (quirk 19) ───────────────────────────────────────────
if (-not $SkipSign) {
    Section "EV signing certificate"
    $defaultThumb = "986AEBA61CF6616393E74D8CBD3A09E836213BAA"
    $thumb = if ($env:KK_SIGN_THUMBPRINT) { $env:KK_SIGN_THUMBPRINT } else { $defaultThumb }
    $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
        Where-Object Thumbprint -eq $thumb |
        Select-Object -First 1
    if ($cert) {
        $daysLeft = ($cert.NotAfter - (Get-Date)).TotalDays
        Pass "Cert found: $($cert.Subject)"
        Write-Host "         Valid until $($cert.NotAfter), $([math]::Round($daysLeft)) days left" -ForegroundColor DarkGray
        if ($daysLeft -lt 30) {
            Warn "Cert expires in $([math]::Round($daysLeft)) days - rotate soon"
        }
    } else {
        Fail "Cert thumbprint $thumb not found in any store" "quirk 19"
        Write-Host "         Plug in + unlock the EV USB token, or set `$env:KK_SIGN_THUMBPRINT to a different cert." -ForegroundColor DarkGray
    }
}

# ── Summary ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Magenta
$pass = if ($Strict) { $script:Failures.Count -eq 0 -and $script:Warnings.Count -eq 0 } else { $script:Failures.Count -eq 0 }
if ($pass) {
    Write-Host "  Preflight: PASS" -ForegroundColor Green
    if ($script:Warnings.Count -gt 0) {
        Write-Host "  $($script:Warnings.Count) warning(s) - review before building." -ForegroundColor Yellow
    }
} else {
    Write-Host "  Preflight: FAIL" -ForegroundColor Red
    Write-Host "  $($script:Failures.Count) failure(s), $($script:Warnings.Count) warning(s)" -ForegroundColor Red
    Write-Host "  Fix the failures above before running build-windows-production.ps1." -ForegroundColor Red
}
Write-Host "============================================" -ForegroundColor Magenta
Write-Host ""

exit ($script:Failures.Count -gt 0 -or ($Strict -and $script:Warnings.Count -gt 0))
