<#
.SYNOPSIS
    KeepKey Vault - Windows Production Build & Signing Script

.DESCRIPTION
    This script builds the KeepKey Vault Windows application, signs all executables
    and DLLs with the Sectigo EV code signing certificate, and creates a signed
    installer EXE using Inno Setup.

.PARAMETER SkipBuild
    Skip the build step (use existing build artifacts)

.PARAMETER SkipSign
    Skip code signing (for testing build process)

.PARAMETER Thumbprint
    Certificate thumbprint for code signing

.PARAMETER OutputDir
    Directory for final release artifacts

.EXAMPLE
    .\scripts\build-windows-production.ps1

.EXAMPLE
    .\scripts\build-windows-production.ps1 -SkipBuild
#>

param(
    [switch]$SkipBuild = $false,
    [switch]$SkipSign = $false,
    [string]$Thumbprint = "986AEBA61CF6616393E74D8CBD3A09E836213BAA",
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [string]$OutputDir = "release-windows"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ============================================================================
# Configuration
# ============================================================================

# Auto-detect Windows SDK version (find newest installed)
$SDK_BASE = "C:\Program Files (x86)\Windows Kits\10\bin"
$SIGNTOOL = $null
if (Test-Path $SDK_BASE) {
    $sdkVersions = Get-ChildItem -Path $SDK_BASE -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [Version]$_.Name } -Descending
    foreach ($sdk in $sdkVersions) {
        $candidate = Join-Path $sdk.FullName "x64\signtool.exe"
        if (Test-Path $candidate) {
            $SIGNTOOL = $candidate
            break
        }
    }
}
if (-not $SIGNTOOL) {
    # Fallback: check PATH
    $SIGNTOOL = (Get-Command "signtool.exe" -ErrorAction SilentlyContinue).Source
}

# Find Inno Setup compiler
$ISCC = $null
$isccPaths = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
foreach ($p in $isccPaths) {
    if (Test-Path $p) { $ISCC = $p; break }
}

# Resolve paths
if ($PSCommandPath) {
    $ScriptDir = Split-Path -Path $PSCommandPath -Parent
} else {
    $ScriptDir = Split-Path -Path $MyInvocation.MyCommand.Path -Parent
}
$RepoRoot = Split-Path -Path $ScriptDir -Parent
$ProjectDir = Join-Path $RepoRoot "projects\keepkey-vault"
$BuildDir = Join-Path $ProjectDir "_build\dev-win-x64\keepkey-vault-dev"
$ArtifactsDir = Join-Path $RepoRoot $OutputDir

# Read version from package.json
$PackageJson = Get-Content (Join-Path $ProjectDir "package.json") | ConvertFrom-Json
$Version = $PackageJson.version
$AppName = "KeepKey Vault"

# ============================================================================
# Helper Functions
# ============================================================================

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "    [OK] $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "    [WARN] $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "    [ERROR] $Message" -ForegroundColor Red
}

function Assert-Tool {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path $Path)) {
        throw "$Name not found at: $Path"
    }
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' not found in PATH."
    }
}

function Sign-File {
    param(
        [string]$FilePath,
        [string]$Description = ""
    )

    if ($SkipSign) {
        Write-Warning "Skipping sign: $(Split-Path $FilePath -Leaf)"
        return $true
    }

    $fileName = Split-Path $FilePath -Leaf
    $extension = [System.IO.Path]::GetExtension($FilePath).ToLower()

    # Skip .node files - they are native Node modules that signtool doesn't support
    if ($extension -eq ".node") {
        Write-Host "    [SKIP] Native module (not signable): $fileName" -ForegroundColor Gray
        return $true
    }

    # Skip bun shims in .bin/ directories -- they are shell scripts with .exe extension,
    # not real PE binaries. signtool returns 0x800700C1 (ERROR_BAD_EXE_FORMAT).
    if ($FilePath -like '*\.bin\*' -or $FilePath -like '*/.bin/*') {
        Write-Host "    [SKIP] Bun shim (not PE): $fileName" -ForegroundColor Gray
        return $true
    }

    # Check if already signed
    try {
        $sig = Get-AuthenticodeSignature $FilePath
        if ($sig.Status -eq 'Valid') {
            Write-Success "Already signed: $fileName"
            return $true
        }
    } catch {}

    $signArgs = @(
        "sign",
        "/sha1", $Thumbprint,
        "/fd", "sha256",
        "/tr", $TimestampUrl,
        "/td", "sha256"
    )

    if ($Description) {
        $signArgs += "/d"
        $signArgs += $Description
    }

    $signArgs += $FilePath

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $result = & $SIGNTOOL @signArgs 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP

    if ($exitCode -eq 0) {
        Write-Success "Signed: $fileName"
        return $true
    } else {
        $resultStr = $result -join ' '
        if ($resultStr -match "not recognized" -or $resultStr -match "0x800700C1" -or $resultStr -match "BAD_EXE_FORMAT") {
            Write-Host "    [SKIP] Not signable format: $fileName" -ForegroundColor Gray
            return $true
        }
        Write-Error "Failed to sign: $fileName"
        Write-Host "    $result" -ForegroundColor Gray
        return $false
    }
}

# ============================================================================
# Pre-flight Checks
# ============================================================================

Write-Host ""
Write-Host "============================================" -ForegroundColor Magenta
Write-Host "  KeepKey Vault v$Version - Windows Build  " -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta
Write-Host ""

Write-Step "Pre-flight checks"

# Check tools
if (-not $SkipSign) {
    if (-not $SIGNTOOL) {
        throw "SignTool not found. Install the Windows SDK: https://developer.microsoft.com/windows/downloads/windows-sdk/"
    }
    Assert-Tool $SIGNTOOL "SignTool"
    Write-Success "SignTool found: $SIGNTOOL"
}

if (-not $ISCC) {
    throw "Inno Setup not found. Install from https://jrsoftware.org/isdl.php or: winget install JRSoftware.InnoSetup"
}
Write-Success "Inno Setup found: $ISCC"

Assert-Command "git"
Assert-Command "bun"
Assert-Command "yarn"
Write-Success "Build tools available (git, bun, yarn)"

# Check certificate (if signing)
if (-not $SkipSign) {
    $cert = Get-ChildItem -Path "Cert:\CurrentUser\My" -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -eq $Thumbprint }
    if (-not $cert) {
        $cert = Get-ChildItem -Path "Cert:\LocalMachine\My" -ErrorAction SilentlyContinue |
                Where-Object { $_.Thumbprint -eq $Thumbprint }
    }

    if ($cert) {
        Write-Success "Certificate found: $($cert.Subject)"
        Write-Host "        Valid until: $($cert.NotAfter)" -ForegroundColor Gray

        if ($cert.NotAfter -lt (Get-Date).AddDays(30)) {
            Write-Warning "Certificate expires in less than 30 days!"
        }
    } else {
        throw "Certificate not found with thumbprint: $Thumbprint`nMake sure your USB signing token is connected."
    }
}

# ============================================================================
# Build Application
# ============================================================================

if (-not $SkipBuild) {
    Write-Step "Updating git submodules (selective)"
    Push-Location $RepoRoot
    # Only init the submodules we actually need -- recursive init pulls deeply
    # nested firmware deps whose paths exceed Windows MAX_PATH (260 chars)
    git submodule update --init modules/hdwallet
    git submodule update --init modules/proto-tx-builder
    git submodule update --init modules/keepkey-firmware
    git submodule update --init modules/device-protocol
    Pop-Location

    Write-Step "Checking device-protocol (protobuf lib)"
    Push-Location (Join-Path $RepoRoot "modules\device-protocol")
    # device-protocol/lib/ is gitignored -- the compiled protobuf output must
    # exist from a prior build (macOS or CI). The build:postprocess script uses
    # BSD sed which fails on Windows, so we cannot auto-build here reliably.
    # Fail fast with a clear message instead.
    if (-not (Test-Path "lib\messages_pb.js")) {
        Write-Error "FATAL: modules/device-protocol/lib/messages_pb.js is MISSING"
        Write-Error "This file is gitignored and must be built before the Windows build runs."
        Write-Error "On macOS: cd modules/device-protocol && npm install && npm run build"
        Write-Error "Then commit or copy lib/ to this machine."
        exit 1
    }
    Write-Host "  lib/messages_pb.js present"
    Pop-Location

    Write-Step "Building proto-tx-builder"
    Push-Location (Join-Path $RepoRoot "modules\proto-tx-builder")
    bun install
    Pop-Location

    Write-Step "Building hdwallet"
    Push-Location (Join-Path $RepoRoot "modules\hdwallet")
    yarn install
    yarn build
    Pop-Location

    Write-Step "Installing keepkey-vault dependencies"
    Push-Location $ProjectDir
    # bun install may exit non-zero due to ENOENT errors on deeply nested
    # transitive deps inside file-linked workspace packages. These are not
    # needed at build time (collect-externals resolves them). Tolerate this.
    $ErrorActionPreference = 'Continue'
    bun install
    $ErrorActionPreference = 'Stop'
    Pop-Location

    Write-Step "Building zcash-cli sidecar (Rust)"
    $ZcashCliDir = Join-Path $ProjectDir "zcash-cli"
    if (Test-Path $ZcashCliDir) {
        Push-Location $ZcashCliDir
        cargo build --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed for zcash-cli" }
        Pop-Location
        Write-Success "zcash-cli.exe built"
    } else {
        Write-Host "    [SKIP] zcash-cli/ not found - Zcash shielded features will be unavailable" -ForegroundColor Yellow
    }

    Write-Step "Building Electrobun Windows app"
    Push-Location $ProjectDir
    bun run build
    Pop-Location

    # Patch channel to stable -- Electrobun's --env=stable produces a macOS-style
    # bundle on Windows that our installer can't use. Build as dev, patch to stable.
    $VersionJson = Join-Path $BuildDir "Resources\version.json"
    if (Test-Path $VersionJson) {
        $vj = Get-Content $VersionJson -Raw | ConvertFrom-Json
        $vj.channel = "stable"
        $vj.name = "keepkey-vault"
        $vj.hash = (Get-FileHash (Join-Path $BuildDir "Resources\app\bun\index.js") -Algorithm SHA256).Hash.ToLower().Substring(0, 16)
        # Use .NET WriteAllText to avoid BOM -- PowerShell 5's -Encoding UTF8 writes a BOM
        # which breaks JSON parsing in bun's require()
        [System.IO.File]::WriteAllText($VersionJson, ($vj | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
        Write-Success "Patched version.json: channel=stable"
    }

    Write-Success "Build completed"
} else {
    Write-Step "Skipping build (using existing artifacts)"
}

# Verify build exists
if (-not (Test-Path $BuildDir)) {
    throw "Build directory not found: $BuildDir`nRun without -SkipBuild flag."
}

# ============================================================================
# Sign Executables and DLLs
# ============================================================================

Write-Step "Signing executables and DLLs"

$binDir = Join-Path $BuildDir "bin"
$filesToSign = @()

# Find all .exe and .dll files in bin/
$filesToSign += Get-ChildItem -Path $binDir -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue
$filesToSign += Get-ChildItem -Path $binDir -Filter "*.dll" -Recurse -ErrorAction SilentlyContinue

# Also sign any .exe, .node and .dll files in Resources/ (includes zcash-cli.exe sidecar)
$resourcesDir = Join-Path $BuildDir "Resources"
$filesToSign += Get-ChildItem -Path $resourcesDir -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue
$filesToSign += Get-ChildItem -Path $resourcesDir -Filter "*.node" -Recurse -ErrorAction SilentlyContinue
$filesToSign += Get-ChildItem -Path $resourcesDir -Filter "*.dll" -Recurse -ErrorAction SilentlyContinue

# Also sign the wrapper exe
$wrapperFile = Join-Path $BuildDir "KeepKeyVault.exe"
if (Test-Path $wrapperFile) {
    $filesToSign += Get-Item $wrapperFile
}

Write-Host "    Found $($filesToSign.Count) files to sign" -ForegroundColor Gray

$signedCount = 0
$failedCount = 0

foreach ($file in $filesToSign) {
    if (Sign-File -FilePath $file.FullName -Description $AppName) {
        $signedCount++
    } else {
        $failedCount++
    }
}

Write-Host ""
Write-Host "    Signed: $signedCount, Failed: $failedCount" -ForegroundColor $(if ($failedCount -eq 0) { "Green" } else { "Yellow" })

# ============================================================================
# Prepare App Icon (convert PNG to ICO if needed)
# ============================================================================

Write-Step "Preparing app icon"

$IconPng = Join-Path $BuildDir "Resources\app.ico"  # Actually a PNG despite extension
$IconIco = Join-Path $BuildDir "Resources\app-real.ico"

if (-not (Test-Path $IconIco)) {
    Add-Type -AssemblyName System.Drawing
    $png = [System.Drawing.Image]::FromFile($IconPng)

    $sizes = @(16, 32, 48, 256)
    $imageData = @()

    foreach ($size in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.DrawImage($png, 0, 0, $size, $size)
        $g.Dispose()

        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $imageData += ,$ms.ToArray()
        $ms.Dispose()
        $bmp.Dispose()
    }
    $png.Dispose()

    $fs = [System.IO.File]::Create($IconIco)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $bw.Write([UInt16]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]$sizes.Count)

    $dataOffset = 6 + (16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $bw.Write([byte]($sizes[$i] -band 0xFF))
        $bw.Write([byte]($sizes[$i] -band 0xFF))
        $bw.Write([byte]0)
        $bw.Write([byte]0)
        $bw.Write([UInt16]1)
        $bw.Write([UInt16]32)
        $bw.Write([UInt32]$imageData[$i].Length)
        $bw.Write([UInt32]$dataOffset)
        $dataOffset += $imageData[$i].Length
    }
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $bw.Write($imageData[$i])
    }
    $bw.Close()
    $fs.Close()

    Write-Success "Converted PNG to ICO: app-real.ico"
} else {
    Write-Success "Icon already exists: app-real.ico"
}

# Replace the renamed PNG with the real ICO so LoadImageW works at runtime
Copy-Item $IconIco $IconPng -Force
Write-Success "Replaced app.ico with real ICO format"

# ============================================================================
# Build Wrapper EXE (KeepKeyVault.exe)
# NOTE: No spaces in filename - Bun Workers silently fail with spaces in paths
# ============================================================================

Write-Step "Building wrapper EXE"

$WrapperExe = Join-Path $BuildDir "KeepKeyVault.exe"
$WrapperSrc = Join-Path $ScriptDir "wrapper-launcher.zig"

if (-not (Test-Path $WrapperExe)) {
    # Find Zig compiler
    $ZigExe = $null
    $zigPaths = @(
        (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\zig*" -Recurse -Filter "zig.exe" -ErrorAction SilentlyContinue | Select-Object -First 1)
    )
    foreach ($z in $zigPaths) {
        if ($z) { $ZigExe = $z.FullName; break }
    }
    if (-not $ZigExe) {
        $ZigExe = Get-Command "zig" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
    }

    if ($ZigExe) {
        Write-Host "    Using Zig: $ZigExe" -ForegroundColor Gray
        Push-Location (Split-Path $WrapperSrc -Parent)
        & $ZigExe build-exe $WrapperSrc -O ReleaseSmall --subsystem windows "-femit-bin=$WrapperExe"
        Pop-Location

        if ($LASTEXITCODE -eq 0) {
            Write-Success "Built: KeepKeyVault.exe"
        } else {
            throw "Failed to compile wrapper EXE with Zig"
        }
    } else {
        throw "Zig compiler not found. Install via: winget install zig.zig"
    }
} else {
    Write-Success "Wrapper EXE already exists"
}

# Copy DPI-awareness manifest next to wrapper EXE
# Windows auto-loads <exename>.exe.manifest for per-monitor DPI scaling.
# Without this, WebView2 renders at 96 DPI and the OS bitmap-scales it -- blurry text/UI.
$ManifestSrc = Join-Path $ScriptDir "KeepKeyVault.exe.manifest"
$ManifestDst = Join-Path $BuildDir "KeepKeyVault.exe.manifest"
if (Test-Path $ManifestSrc) {
    Copy-Item $ManifestSrc $ManifestDst -Force
    Write-Success "DPI manifest copied"
}

# Embed KeepKey icon into all EXEs
# Electrobun's rcedit call fails (ENOENT -- hardcoded CI path), so we do it ourselves.
$RceditExe = Join-Path $ProjectDir "node_modules\rcedit\bin\rcedit-x64.exe"
if ((Test-Path $IconIco) -and (Test-Path $RceditExe)) {
    # Skip bun.exe -- rcedit on 113MB binary can corrupt it; bun runs headless anyway
    $exesToIcon = @($WrapperExe, (Join-Path $BuildDir "bin\launcher.exe"))
    foreach ($exePath in $exesToIcon) {
        if (Test-Path $exePath) {
            $exeName = Split-Path $exePath -Leaf
            Write-Host "    Embedding icon into $exeName..." -ForegroundColor Gray
            & $RceditExe $exePath --set-icon $IconIco
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Icon embedded into $exeName"
            } else {
                Write-Warning "Failed to embed icon into $exeName"
            }
        }
    }
} elseif (-not (Test-Path $RceditExe)) {
    Write-Warning "rcedit not found - EXEs will use default icon"
}

# ============================================================================
# Create Output Directory
# ============================================================================

Write-Step "Preparing release artifacts"

if (Test-Path $ArtifactsDir) {
    Remove-Item $ArtifactsDir -Recurse -Force
}
New-Item -ItemType Directory -Path $ArtifactsDir | Out-Null

# ============================================================================
# Build Installer EXE with Inno Setup
# ============================================================================

Write-Step "Downloading WebView2 bootstrapper (for Windows 10 support)"

$WebView2Bootstrapper = Join-Path $BuildDir "MicrosoftEdgeWebview2Setup.exe"
if (-not (Test-Path $WebView2Bootstrapper)) {
    $webview2Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    Write-Host "    Downloading from Microsoft..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $webview2Url -OutFile $WebView2Bootstrapper -UseBasicParsing
        $sizeKB = [math]::Round((Get-Item $WebView2Bootstrapper).Length / 1024)
        Write-Success "Downloaded WebView2 bootstrapper: ${sizeKB} KB"
    } catch {
        $errMsg = $_.Exception.Message
        Write-Warning "Failed to download WebView2 bootstrapper: $errMsg"
        Write-Warning "Windows 10 users may need to install WebView2 manually"
    }
} else {
    Write-Success "WebView2 bootstrapper already exists"
}

# ============================================================================
# Build Installer EXE with Inno Setup
# ============================================================================

Write-Step "Building installer EXE with Inno Setup"

$IssFile = Join-Path $ScriptDir "installer.iss"
if (-not (Test-Path $IssFile)) {
    throw "Inno Setup script not found: $IssFile"
}

$isccArgs = @(
    "/DMyAppVersion=$Version",
    "/DMySourceDir=$BuildDir",
    "/DMyOutputDir=$ArtifactsDir",
    "/DMyScriptDir=$ScriptDir",
    $IssFile
)

& $ISCC @isccArgs

if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE"
}

$InstallerExe = Join-Path $ArtifactsDir "KeepKey-Vault-$Version-win-x64-setup.exe"
Write-Success "Created installer: $(Split-Path $InstallerExe -Leaf)"

# Sign the installer EXE itself
if (-not $SkipSign) {
    Write-Step "Signing installer EXE"
    $signed = Sign-File -FilePath $InstallerExe -Description "$AppName Installer"
    if (-not $signed) {
        Write-Error "Failed to sign the installer EXE!"
    }
}

# ============================================================================
# Generate Checksums
# ============================================================================

Write-Step "Generating checksums"

$checksumFile = Join-Path $ArtifactsDir "SHA256SUMS.txt"
$artifacts = Get-ChildItem -Path $ArtifactsDir -File | Where-Object { $_.Name -notlike "*.txt" }

$checksums = @()
foreach ($file in $artifacts) {
    $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
    $checksums += "$hash  $($file.Name)"
    Write-Host "    $($file.Name): $hash" -ForegroundColor Gray
}

$checksums | Out-File -FilePath $checksumFile -Encoding UTF8
Write-Success "Created: SHA256SUMS.txt"

# ============================================================================
# Summary
# ============================================================================

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Build Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Version: $Version" -ForegroundColor White
Write-Host "Output:  $ArtifactsDir" -ForegroundColor White
Write-Host ""
Write-Host "Artifacts:" -ForegroundColor Cyan

$finalArtifacts = Get-ChildItem -Path $ArtifactsDir -File
foreach ($file in $finalArtifacts) {
    $size = [math]::Round($file.Length / 1MB, 2)
    Write-Host "  - $($file.Name) ${size} MB" -ForegroundColor White
}

Write-Host ""

if (-not $SkipSign) {
    Write-Host "All executables have been signed with EV certificate." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Test the installer: run the setup EXE" -ForegroundColor Gray
    Write-Host "  2. Upload EXE to GitHub release" -ForegroundColor Gray
    Write-Host "  3. Verify SmartScreen reputation" -ForegroundColor Gray
} else {
    Write-Host "WARNING: Artifacts are NOT signed - test build only" -ForegroundColor Yellow
}

Write-Host ""
