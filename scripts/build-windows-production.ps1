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
    # Cert thumbprint: CLI arg > $env:KK_SIGN_THUMBPRINT > hardcoded KEY HODLERS LLC EV cert.
    # The env var lets CI / a new signer override without editing the script.
    [string]$Thumbprint = $(if ($env:KK_SIGN_THUMBPRINT) { $env:KK_SIGN_THUMBPRINT } else { "986AEBA61CF6616393E74D8CBD3A09E836213BAA" }),
    # Timestamp servers tried in order. Any RFC 3161 server works; ordered by
    # historical reliability. First-success short-circuits; full list exhausted
    # before Sign-File reports a failure.
    [string[]]$TimestampUrls = @(
        "http://timestamp.digicert.com",
        "http://timestamp.sectigo.com",
        "http://timestamp.globalsign.com/tsa/r6advanced1"
    ),
    [string]$OutputDir = "release-windows",
    # Set to allow non-fatal sign failures (e.g. iterating on a non-signing
    # machine). Default: any unexpected failure aborts the run.
    [switch]$AllowSignFailures = $false
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
$ExtModulesDir = Join-Path $ProjectDir "_build\_ext_modules"
$AppNodeModulesDir = Join-Path $BuildDir "Resources\app\node_modules"
$EmulatorDllSource = Join-Path $ProjectDir "emulator-bundle\libkkemu.dll"
$BundledEmulatorDll = Join-Path $BuildDir "Resources\app\emulator\libkkemu.dll"
$ArtifactsDir = Join-Path $RepoRoot $OutputDir

# Read version from package.json
$PackageJson = Get-Content (Join-Path $ProjectDir "package.json") | ConvertFrom-Json
$Version = $PackageJson.version
$AppName = "KeepKey Vault"

# ----------------------------------------------------------------------------
# Ensure GNU tar wins over System32 bsdtar.
#
# Electrobun's CLI bootstrap (node_modules/electrobun/bin/electrobun.cjs) extracts
# its downloaded core with `tar --force-local -xzf` (the --force-local is added on
# Windows by scripts/patch-electrobun.sh so tar does not treat the "C:" in the cache
# path as a remote host). That flag is GNU-tar-only; Windows' built-in System32 tar
# is bsdtar, which rejects it ("Option --force-local is not supported") and aborts
# the build. Git for Windows ships GNU tar at %ProgramFiles%\Git\usr\bin\tar.exe, so
# prepend that directory to PATH. It contains no link.exe/cl.exe, so MSVC native
# builds (usb, node-hid, cargo C deps) are unaffected.
# ----------------------------------------------------------------------------
$GitUsrBin = Join-Path $env:ProgramFiles "Git\usr\bin"
if ((Test-Path (Join-Path $GitUsrBin "tar.exe")) -and ($env:Path -notlike "*$GitUsrBin*")) {
    $env:Path = "$GitUsrBin;$env:Path"
}

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

# Zero out the Certificate Table (Security Directory) entry in a PE's Optional
# Header. Returns $true if an entry existed and was cleared, $false if the
# file already had no entry (no-op).
#
# Why this exists: rcedit (and some upstream Electrobun-built launcher.exe
# binaries) leave a non-zero Security Directory RVA/Size pointing at garbage
# data -- the file isn't actually signed (Get-AuthenticodeSignature reports
# NotSigned), but a stale ~10 KB cert-table-shaped chunk lives inside the PE.
# signtool then refuses to sign the file with the misleading error
# `0x800700C1 / ERROR_BAD_EXE_FORMAT` because it can't safely overwrite the
# malformed cert table. `signtool remove /s` also fails (`0x00000057`)
# because there's no valid signature to strip.
#
# The fix is purely a 8-byte zero write in the PE Optional Header -- the
# orphan cert blob at the end of the file is harmless (signtool overwrites
# or appends past it). No section table, no checksum, no relocation needs
# to change.
function Clear-PECertTableEntry {
    param([string]$FilePath)
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    if ($bytes.Length -lt 64) { return $false }
    if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { return $false }   # MZ
    $peOff = [BitConverter]::ToInt32($bytes, 60)
    if ($peOff -lt 0 -or $peOff + 24 -ge $bytes.Length) { return $false }
    if ($bytes[$peOff] -ne 0x50 -or $bytes[$peOff + 1] -ne 0x45) { return $false }  # PE
    $optOff = $peOff + 24
    $magic = [BitConverter]::ToUInt16($bytes, $optOff)
    # NumberOfRvaAndSizes lives at +108 for PE32+, +92 for PE32 -- pick the
    # right offset so we land on the actual DataDirectories array.
    $rvaCountOff = if ($magic -eq 0x20B) { $optOff + 108 } elseif ($magic -eq 0x10B) { $optOff + 92 } else { return $false }
    if ($rvaCountOff + 4 + (5 * 8) -gt $bytes.Length) { return $false }
    # Security Directory is entry index 4 in the DataDirectories array
    # (Export=0, Import=1, Resource=2, Exception=3, Security=4).
    $secDirOff = $rvaCountOff + 4 + (4 * 8)
    $secDirRva  = [BitConverter]::ToUInt32($bytes, $secDirOff)
    $secDirSize = [BitConverter]::ToUInt32($bytes, $secDirOff + 4)
    if ($secDirRva -eq 0 -and $secDirSize -eq 0) { return $false }
    for ($i = 0; $i -lt 8; $i++) { $bytes[$secDirOff + $i] = 0 }
    [System.IO.File]::WriteAllBytes($FilePath, $bytes)
    return $true
}

function Sign-File {
    param(
        [string]$FilePath,
        [string]$Description = "",
        [switch]$Force = $false
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

    if (-not $Force) {
        # Check if already signed
        try {
            $sig = Get-AuthenticodeSignature $FilePath
            if ($sig.Status -eq 'Valid') {
                Write-Success "Already signed: $fileName"
                return $true
            }
        } catch {}
    }

    # Try each timestamp URL in order. signtool failures with a timestamp
    # server are transient (network blip, server rotation) -- retry against the
    # next URL before declaring failure. Sign-without-timestamp is NOT a
    # fallback: an untimestamped sig is valid only while the cert is -- once
    # the cert expires, every signed binary becomes "publisher unknown".
    $lastResult = ""
    $exitCode = 1
    foreach ($tsUrl in $TimestampUrls) {
        $signArgs = @(
            "sign",
            "/sha1", $Thumbprint,
            "/fd", "sha256",
            "/tr", $tsUrl,
            "/td", "sha256"
        )

        if ($Description) {
            $signArgs += "/d"
            $signArgs += $Description
        }

        $signArgs += $FilePath

        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $lastResult = & $SIGNTOOL @signArgs 2>&1
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP

        if ($exitCode -eq 0) { break }

        # Distinguish a real signing failure (cert problem, file format) from
        # a transient timestamp problem. Only the latter is worth retrying.
        $resultStr = $lastResult -join ' '
        $isTimestampError = $resultStr -match "timestamp" -or $resultStr -match "RFC 3161" -or $resultStr -match "0x80096004"
        if (-not $isTimestampError) { break }
        Write-Host "    [RETRY] Timestamp $tsUrl failed for $fileName, trying next..." -ForegroundColor Yellow
    }

    if ($exitCode -eq 0) {
        Write-Success "Signed: $fileName"
        return $true
    }

    $resultStr = $lastResult -join ' '

    # 0x800700C1 / BAD_EXE_FORMAT on a syntactically-valid PE almost always
    # means the file has a non-zero Security Directory pointing at malformed
    # data (rcedit residue, or upstream Electrobun/launcher.exe shipped with
    # a stale cert table). Strip the entry and retry once. See
    # Clear-PECertTableEntry for the full rationale.
    if (($resultStr -match "0x800700C1" -or $resultStr -match "BAD_EXE_FORMAT") -and (Clear-PECertTableEntry -FilePath $FilePath)) {
        Write-Host "    [FIX] Stripped stale cert-table entry, retrying: $fileName" -ForegroundColor Yellow
        $signArgs = @(
            "sign",
            "/sha1", $Thumbprint,
            "/fd", "sha256",
            "/tr", $TimestampUrls[0],
            "/td", "sha256"
        )
        if ($Description) { $signArgs += "/d"; $signArgs += $Description }
        $signArgs += $FilePath

        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $retryResult = & $SIGNTOOL @signArgs 2>&1
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP

        if ($exitCode -eq 0) {
            Write-Success "Signed (after strip): $fileName"
            return $true
        }
        $resultStr = $retryResult -join ' '
    }

    # Genuinely-unsignable formats -- bun shims (handled above by path) and
    # native .node addons (handled above by extension) are the only files
    # that should land here. If we still match "not recognized", it's a
    # signtool-side rejection we can't fix; log and skip.
    if ($resultStr -match "not recognized") {
        Write-Host "    [SKIP] Not signable format: $fileName" -ForegroundColor Gray
        return $true
    }
    Write-Error "Failed to sign: $fileName"
    Write-Host "    $resultStr" -ForegroundColor Gray
    return $false
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

if (-not $SkipBuild) {
    if (-not (Test-Path $EmulatorDllSource)) {
        throw "Pinned 7.16 emulator DLL missing at $EmulatorDllSource.`nDownload emulator-build-input-libkkemu-7.16.0-win-x64.dll from the matching macOS CI artifact, rename it to libkkemu.dll, and place it in emulator-bundle before building."
    }
    $emuHeader = [System.IO.File]::ReadAllBytes($EmulatorDllSource)
    if ($emuHeader.Length -lt 2 -or $emuHeader[0] -ne 0x4D -or $emuHeader[1] -ne 0x5A) {
        throw "Emulator build input is not a Windows PE DLL (MZ header missing): $EmulatorDllSource"
    }
    Write-Success "Pinned 7.16 emulator DLL staged: $EmulatorDllSource"
}

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
    # Compile only host-side submodules here. The verified firmware DLL is a
    # required CI build input checked above, so Windows does not compile it.
    git submodule update --init modules/hdwallet
    git submodule update --init modules/proto-tx-builder
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
    if ($LASTEXITCODE -ne 0) { throw "bun install failed for proto-tx-builder (exit $LASTEXITCODE)" }
    # Build the dist (tsc -p .). WITHOUT this, the gitignored dist/ ships STALE
    # from a previous pin: this step only ran `bun install` and skipped the
    # build, so v1.4.6/1.4.7/1.4.8 shipped a pre-fix proto-tx-builder on Windows
    # and EVERY Cosmos tx crashed with "createFeegrantAminoConverters is not a
    # function". macOS rebuilds via the Makefile (+#290 stamp-clear); Windows
    # must run the build too (mirrors the hdwallet `yarn build` below).
    bun run build
    if ($LASTEXITCODE -ne 0) { throw "build failed for proto-tx-builder (exit $LASTEXITCODE) -- if tsc can't resolve osmosis codecimpl, copy modules/proto-tx-builder/osmosis-frontend/src/proto/generated/codecimpl.{js,d.ts} as in the macOS setup" }
    Pop-Location

    Write-Step "Building hdwallet"
    Push-Location (Join-Path $RepoRoot "modules\hdwallet")
    # Windows: hdwallet-keepkey depends on @keepkey/device-protocol as a GIT dependency.
    # yarn builds git deps by running their `prepare`, which here is
    #   mkdir -p ./lib && grpc_tools_node_protoc --plugin=protoc-gen-ts=./node_modules/.bin/protoc-gen-ts ...
    # That fails on Windows: `mkdir -p` is invalid under cmd.exe, and even under bash native
    # protoc cannot exec the extensionless plugin wrapper ("%1 is not a valid Win32 application").
    # yarn (even with --ignore-scripts) still runs git-dep prepare and returns non-zero, but by
    # then node_modules is fully linked. Tolerate ONLY that specific prepare failure, seed the
    # git-dep's gitignored lib/ from the top-level device-protocol lib (same pinned commit ->
    # identical output), and treat `yarn build` (tsc) as the real gate.
    $ErrorActionPreference = 'Continue'
    $hdwInstallOutput = yarn install 2>&1
    $hdwInstallExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($hdwInstallExit -ne 0) {
        $hdwInstallText = @($hdwInstallOutput) -join "`n"
        if ($hdwInstallText -match 'device-protocol@' -and $hdwInstallText -match 'build:js') {
            Write-Warning "hdwallet yarn install exited $hdwInstallExit on the device-protocol git-dep prepare (Windows protoc/mkdir limitation); seeding lib/ from top-level and continuing."
        } else {
            Write-Host $hdwInstallText -ForegroundColor Gray
            throw "yarn install failed for hdwallet (exit $hdwInstallExit)"
        }
    }
    $DpNestedLib = Join-Path (Get-Location) "node_modules\@keepkey\device-protocol\lib"
    $DpTopLib = Join-Path $RepoRoot "modules\device-protocol\lib"
    if (-not (Test-Path (Join-Path $DpTopLib "messages_pb.js"))) {
        throw "Top-level device-protocol lib missing at $DpTopLib -- build it before running (see WINDOWS-BUILD-QUIRKS.md quirk 8)."
    }
    New-Item -ItemType Directory -Force -Path $DpNestedLib | Out-Null
    Copy-Item -Path (Join-Path $DpTopLib "*") -Destination $DpNestedLib -Recurse -Force
    Write-Host "  Seeded hdwallet @keepkey/device-protocol/lib from top-level device-protocol (pinned commit)"
    yarn build
    if ($LASTEXITCODE -ne 0) { throw "yarn build failed for hdwallet (exit $LASTEXITCODE)" }
    Pop-Location

    Write-Step "Installing keepkey-vault dependencies"
    Push-Location $ProjectDir
    # bun install may exit non-zero due to ENOENT errors on deeply nested
    # transitive deps inside file-linked workspace packages. These are not
    # needed at build time (collect-externals resolves them). Tolerate this.
    $ErrorActionPreference = 'Continue'
    $vaultInstallOutput = bun install 2>&1
    $vaultInstallExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($vaultInstallExit -ne 0) {
        $vaultInstallText = @($vaultInstallOutput) -join "`n"
        if ($vaultInstallText -match 'ENOENT' -and $vaultInstallText -match 'node_modules') {
            Write-Warning "bun install exited $vaultInstallExit with nested node_modules ENOENT; continuing per Windows packaging workaround."
        } else {
            Write-Host $vaultInstallText -ForegroundColor Gray
            throw "bun install failed for keepkey-vault (exit $vaultInstallExit)"
        }
    }
    Pop-Location

    Write-Step "Building zcash-cli sidecar (Rust)"
    $ZcashCliDir = Join-Path $ProjectDir "zcash-cli"
    if (Test-Path $ZcashCliDir) {
        Push-Location $ZcashCliDir
        # zcash-cli/build.rs uses tonic-build/prost, which needs a system `protoc`.
        # Windows has none on PATH by default, so resolve one: honor an existing
        # $env:PROTOC, else protoc on PATH, else the protoc.exe bundled with
        # grpc-tools in device-protocol's node_modules (always present for the build).
        if (-not ($env:PROTOC -and (Test-Path $env:PROTOC))) {
            $protocCmd = Get-Command protoc.exe -ErrorAction SilentlyContinue
            if ($protocCmd) {
                $env:PROTOC = $protocCmd.Source
            } else {
                $bundledProtoc = Join-Path $RepoRoot "modules\device-protocol\node_modules\grpc-tools\bin\protoc.exe"
                if (Test-Path $bundledProtoc) {
                    $env:PROTOC = $bundledProtoc
                } else {
                    throw "protoc not found for zcash-cli build. Set `$env:PROTOC or install protobuf-compiler. Bundled fallback missing at $bundledProtoc (run the device-protocol install first)."
                }
            }
        }
        Write-Host "  Using protoc: $env:PROTOC"
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
    if ($LASTEXITCODE -ne 0) { throw "bun run build failed for keepkey-vault (exit $LASTEXITCODE)" }
    Pop-Location

    # Electrobun's Windows copy step can silently leave very deep nested
    # node_modules packages incomplete. collect-externals.ts stages the verified
    # runtime deps in _build/_ext_modules; mirror that exact tree into the final
    # app bundle with robocopy, which handles Windows paths more reliably.
    if (Test-Path $ExtModulesDir) {
        Write-Step "Mirroring external node_modules into app bundle"
        if (-not (Test-Path $AppNodeModulesDir)) {
            New-Item -ItemType Directory -Force -Path $AppNodeModulesDir | Out-Null
        }
        & robocopy $ExtModulesDir $AppNodeModulesDir /MIR /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS /NP /NS | Out-Null
        $mirrorExit = $LASTEXITCODE
        if ($mirrorExit -gt 7) {
            throw "robocopy failed while mirroring external node_modules (exit $mirrorExit)"
        }
        $global:LASTEXITCODE = 0
        Write-Success "Mirrored external node_modules into Resources\app"
    } else {
        throw "collect-externals did not produce $ExtModulesDir"
    }

    # Patch version.json: stable channel + force version to match package.json.
    # Electrobun's `bun run build` is an incremental build -- when a stale _build/
    # exists from a different branch, it can leave version.json with the wrong
    # version. We had a current-version-named installer shipped with stale
    # previous-version bits inside because
    # of this. Force the version field rather than trust Electrobun's output.
    $VersionJson = Join-Path $BuildDir "Resources\version.json"
    if (-not (Test-Path $VersionJson)) {
        throw "Electrobun build did not produce $VersionJson -- build was broken or skipped."
    }
    $vj = Get-Content $VersionJson -Raw | ConvertFrom-Json
    $electrobunSawVersion = $vj.version
    $vj.channel = "stable"
    $vj.name = "keepkey-vault"
    $vj.version = $Version
    $vj.hash = (Get-FileHash (Join-Path $BuildDir "Resources\app\bun\index.js") -Algorithm SHA256).Hash.ToLower().Substring(0, 16)
    # Use .NET WriteAllText to avoid BOM -- PowerShell 5's -Encoding UTF8 writes a BOM
    # which breaks JSON parsing in bun's require()
    [System.IO.File]::WriteAllText($VersionJson, ($vj | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    if ($electrobunSawVersion -ne $Version) {
        Write-Warning "version.json reported $electrobunSawVersion but package.json says $Version -- forced to $Version."
        Write-Warning "This usually means _build/ was stale from a prior branch. Consider deleting _build/ for next clean build."
    }
    Write-Success "Patched version.json: version=$Version channel=stable"

    Write-Success "Build completed"
} else {
    Write-Step "Skipping build (using existing artifacts)"
}

# Verify build exists
if (-not (Test-Path $BuildDir)) {
    throw "Build directory not found: $BuildDir`nRun without -SkipBuild flag."
}
if (-not (Test-Path $ExtModulesDir)) {
    throw "External modules staging directory not found: $ExtModulesDir`nRun without -SkipBuild to regenerate collect-externals output."
}
if (-not (Test-Path $BundledEmulatorDll)) {
    throw "Release gate failed: Electrobun did not bundle the 7.16 emulator at $BundledEmulatorDll"
}
if (-not $SkipBuild) {
    $sourceHash = (Get-FileHash $EmulatorDllSource -Algorithm SHA256).Hash
    $bundleHash = (Get-FileHash $BundledEmulatorDll -Algorithm SHA256).Hash
    if ($sourceHash -ne $bundleHash) {
        throw "Release gate failed: bundled emulator hash differs from the verified CI build input"
    }
}
Write-Success "Verified bundled Windows emulator: $BundledEmulatorDll"

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

# Abort the release if any file failed to sign. Shipping an installer with
# mixed signed/unsigned PE files triggers SmartScreen warnings on the unsigned
# ones and breaks enterprise allowlists. Use -AllowSignFailures to opt out
# (e.g. when iterating on a build machine without the USB token plugged in).
if ($failedCount -gt 0 -and -not $AllowSignFailures -and -not $SkipSign) {
    throw "Aborting: $failedCount file(s) failed to sign. Re-run with -AllowSignFailures if this is intentional."
}

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

if ((Test-Path $WrapperExe) -and $SkipBuild) {
    Write-Warning "Using existing wrapper EXE because -SkipBuild was supplied"
} else {
    # Zig version pin: wrapper-launcher.zig was last updated for 0.15.2
    # (commit cfd6ea4). Zig 0.16 shipped an IO-context refactor that broke
    # std.fs.cwd, std.time.milliTimestamp, and std.fs.selfExeDirPath. Refuse
    # to use anything outside the supported series.
    $SupportedZigPattern = '^0\.15\.'
    $SupportedZigDescr   = '0.15.x'
    $ZigExe = $null
    # Preferred locations (most-specific first): pinned tools dir, then any
    # 0.15.x install in tools/, then WinGet, then PATH. Only the explicit
    # pin and a known-good winget package satisfy the version check below.
    $zigSearchPaths = @(
        "$env:USERPROFILE\tools\zig-x86_64-windows-0.15.1\zig.exe",
        "$env:USERPROFILE\tools\zig-x86_64-windows-0.15.2\zig.exe"
    )
    foreach ($p in $zigSearchPaths) {
        if (Test-Path $p) { $ZigExe = $p; break }
    }
    if (-not $ZigExe) {
        $toolsZigs = Get-ChildItem "$env:USERPROFILE\tools" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'zig.*0\.15\.' } | Sort-Object Name -Descending
        foreach ($d in $toolsZigs) {
            $cand = Join-Path $d.FullName 'zig.exe'
            if (Test-Path $cand) { $ZigExe = $cand; break }
        }
    }
    if (-not $ZigExe) {
        $wingetZig = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\zig*" -Recurse -Filter "zig.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($wingetZig) { $ZigExe = $wingetZig.FullName }
    }
    if (-not $ZigExe) {
        $ZigExe = Get-Command "zig" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
    }

    if (-not $ZigExe) {
        throw "Zig compiler not found. Install Zig $SupportedZigDescr to `$env:USERPROFILE\tools\zig-x86_64-windows-0.15.1\ (download from https://ziglang.org/download/0.15.1/zig-x86_64-windows-0.15.1.zip)."
    }

    # Hard version check -- the source file is pinned to 0.15.x APIs.
    $zigVer = (& $ZigExe version 2>&1).Trim()
    if ($zigVer -notmatch $SupportedZigPattern) {
        throw "Zig $zigVer at $ZigExe is unsupported. wrapper-launcher.zig requires Zig $SupportedZigDescr. Install 0.15.1 to `$env:USERPROFILE\tools\zig-x86_64-windows-0.15.1\."
    }

    Write-Host "    Using Zig: $ZigExe (version $zigVer)" -ForegroundColor Gray
    Push-Location (Split-Path $WrapperSrc -Parent)
    # CRITICAL: pin the target ISA to -mcpu=baseline. Without it, Zig compiles
    # for the BUILD BOX's native CPU (AVX2-capable), baking VEX/AVX instructions
    # into KeepKeyVault.exe -- e.g. `vmovdqa %xmm6` in main()'s prologue. On a
    # no-AVX CPU (Intel Pentium Silver N5030 "Gemini Lake": SSE4.2, no AVX/AVX2)
    # the app dies instantly at launch with 0xC000001D STATUS_ILLEGAL_INSTRUCTION
    # before bun.exe ever runs. baseline = x86-64-v1, runs everywhere.
    # See docs/handoff-windows-non-avx-launcher-crash.md.
    & $ZigExe build-exe $WrapperSrc -target x86_64-windows -mcpu=baseline -O ReleaseSmall --subsystem windows "-femit-bin=$WrapperExe"
    Pop-Location

    if ($LASTEXITCODE -eq 0) {
        Write-Success "Built: KeepKeyVault.exe"
    } else {
        throw "Failed to compile wrapper EXE with Zig"
    }
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
#
# ORDER MATTERS: rcedit must run BEFORE signing, OR the affected EXEs must be
# re-signed AFTER rcedit. rcedit modifies the .rsrc section via the Windows
# BeginUpdateResource API which invalidates Authenticode signatures
# (https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-beginupdateresourcea).
# The bulk sign loop above runs before the wrapper EXE exists, and we touch
# launcher.exe here too -- so both get re-signed in the next step.
$RceditExe = Join-Path $ProjectDir "node_modules\rcedit\bin\rcedit-x64.exe"
$rceditTouched = @()
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
                $rceditTouched += $exePath
            } else {
                Write-Warning "Failed to embed icon into $exeName"
            }
        }
    }
} elseif (-not (Test-Path $RceditExe)) {
    Write-Warning "rcedit not found - EXEs will use default icon"
}

# Re-sign EXEs whose .rsrc was modified by rcedit (signatures invalidated above).
# Also sign the wrapper after the Zig build. On a clean build it did not exist
# during the bulk signing pass; when rcedit is unavailable it still must not ship
# unsigned.
$finalExeSignTargets = @()
if (Test-Path $WrapperExe) { $finalExeSignTargets += $WrapperExe }
foreach ($exePath in $rceditTouched) {
    if ($finalExeSignTargets -notcontains $exePath) { $finalExeSignTargets += $exePath }
}
if (-not $SkipSign -and $finalExeSignTargets.Count -gt 0) {
    Write-Step "Final signing wrapper/launcher EXEs"
    $resignFailed = 0
    foreach ($exePath in $finalExeSignTargets) {
        # Force re-sign because rcedit invalidates Authenticode signatures and
        # Get-AuthenticodeSignature can briefly report stale validity.
        if (-not (Sign-File -FilePath $exePath -Description $AppName -Force)) {
            $resignFailed++
        }
    }
    if ($resignFailed -gt 0 -and -not $AllowSignFailures) {
        throw "Aborting: $resignFailed wrapper/launcher EXE(s) failed final signing."
    }
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

Write-Step "Preparing short-path staging for Inno Setup (MAX_PATH workaround)"
# Inno Setup silently skips files whose FULL SOURCE PATH exceeds 260 chars.
# The build tree path is ~88 chars before any file, leaving only ~172 chars for
# nested node_modules paths (e.g. @walletconnect has 4+ levels of nesting).
# Fix: copy build output to a short temp path (C:\tmp\kk) before running ISCC.
$ShortStage = "C:\tmp\kk"
if (Test-Path $ShortStage) { Remove-Item -Recurse -Force $ShortStage }
Write-Host "    Copying build to $ShortStage ..."
# robocopy can handle source paths >260 chars when long-path support remains enabled.
# Critical flags (learned the hard way):
#   /MT:16     -- 16-thread copy. Single-threaded robocopy + Defender real-time
#                scan = ~30 min for 14k files. Multi-threaded = ~1-2 min.
#   /R:1 /W:1  -- retry ONCE with a 1-sec wait. Defaults are /R:1000000 /W:30
#                (one million retries, 30-sec wait), which means a single
#                Defender-locked file hangs the entire copy for hours.
#   /XJ        -- skip junction points / reparse points. Without this, symlink
#                loops inside nested node_modules can trap robocopy forever.
# robocopy exits 0-7 on success (0=no files, 1=copied, 2=extra, etc.) -- normalize to 0
$rcStart = Get-Date
robocopy $BuildDir $ShortStage /E /MT:16 /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS /NP /NS | Out-Null
$stageCopyExit = $LASTEXITCODE
if ($stageCopyExit -gt 7) {
    throw "robocopy failed while staging build for Inno Setup (exit $stageCopyExit)"
}
$global:LASTEXITCODE = 0
$rcSeconds = [math]::Round(((Get-Date) - $rcStart).TotalSeconds, 1)
$StagedFiles = (Get-ChildItem -Recurse -File $ShortStage -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "    Staged $StagedFiles files in ${rcSeconds}s (source path: $($ShortStage.Length) chars)"

# The build tree path itself is still long enough to drop very deep
# WalletConnect nested files while mirroring into Resources\app\node_modules.
# Overlay the collected externals directly into the short Inno source tree so
# installer packaging sees the complete dependency tree from a short path.
$StagedNodeModules = Join-Path $ShortStage "Resources\app\node_modules"
if (Test-Path $ExtModulesDir) {
    Write-Host "    Overlaying external node_modules into short stage ..."
    robocopy $ExtModulesDir $StagedNodeModules /MIR /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS /NP /NS | Out-Null
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed while overlaying external node_modules into short stage (exit $LASTEXITCODE)"
    }
    $global:LASTEXITCODE = 0
    $WalletConnectProbe = Join-Path $StagedNodeModules "@walletconnect\sign-client\node_modules\@walletconnect\core\node_modules\@walletconnect\relay-auth\node_modules\uint8arrays\cjs\src\concat.js"
    if (-not (Test-Path $WalletConnectProbe)) {
        throw "Short-stage node_modules is incomplete; missing WalletConnect probe file: $WalletConnectProbe"
    }
    Write-Success "Short-stage external node_modules overlay verified"
}

Write-Step "Building installer EXE with Inno Setup"

$IssFile = Join-Path $ScriptDir "installer.iss"
if (-not (Test-Path $IssFile)) {
    throw "Inno Setup script not found: $IssFile"
}

$isccArgs = @(
    "/DMyAppVersion=$Version",
    "/DMySourceDir=$ShortStage",
    "/DMyOutputDir=$ArtifactsDir",
    "/DMyScriptDir=$ScriptDir",
    $IssFile
)

& $ISCC @isccArgs

# Clean up staging
Remove-Item -Recurse -Force $ShortStage -ErrorAction SilentlyContinue

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
        if ($AllowSignFailures) {
            Write-Warning "Failed to sign the installer EXE; continuing because -AllowSignFailures was supplied."
        } else {
            throw "Failed to sign the installer EXE."
        }
    }
}

# ============================================================================
# Package as .zip (Smart App Control-safe distribution)
# ============================================================================
# installer.iss sets UseSetupLdr=no, so Inno emits setup.exe + setup-*.bin
# instead of a single self-extracting exe. That is deliberate: the normal
# single-exe extracts an UNSIGNED setup.tmp engine to %TEMP% and runs it, which
# Smart App Control blocks ("failed to initialize", Code Integrity 3077/3033).
# With no loader there is no tmp -- SAC only sees the EV-signed setup.exe. Ship
# the parts zipped; the user extracts and runs setup.exe. See
# docs/WINDOWS-BUILD-AND-SIGN.md "Smart App Control".
Write-Step "Packaging installer as .zip (Smart App Control-safe)"
$installerParts = Get-ChildItem -Path $ArtifactsDir -File | Where-Object {
    $_.Name -like "KeepKey-Vault-$Version-win-x64-setup*" -and ($_.Extension -eq '.exe' -or $_.Extension -eq '.bin')
}
if (-not $installerParts) { throw "No installer parts (setup.exe/.bin) found to package" }
$zipPath = Join-Path $ArtifactsDir "KeepKey-Vault-$Version-win-x64-setup.zip"
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $installerParts.FullName -DestinationPath $zipPath -CompressionLevel Optimal
# Drop the loose parts so ONLY the .zip is uploaded — a bare setup.exe won't run
# without its .bin siblings anyway, and leaving the SAC-blocked single exe around
# invites shipping the broken artifact.
$installerParts | Remove-Item -Force
Write-Success "Created: $(Split-Path $zipPath -Leaf) ($([math]::Round((Get-Item $zipPath).Length / 1MB, 1)) MB)"

# ============================================================================
# Generate Checksums
# ============================================================================

Write-Step "Generating checksums"

$checksumFile = Join-Path $ArtifactsDir "SHA256SUMS-windows.txt"
$artifacts = Get-ChildItem -Path $ArtifactsDir -File | Where-Object { $_.Name -notlike "*.txt" }

$checksums = @()
foreach ($file in $artifacts) {
    $hash = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
    $checksums += "$hash  $($file.Name)"
    Write-Host "    $($file.Name): $hash" -ForegroundColor Gray
}

$checksums | Out-File -FilePath $checksumFile -Encoding UTF8
Write-Success "Created: SHA256SUMS-windows.txt"

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
    if ($AllowSignFailures) {
        Write-Host "Signing was attempted; failures were allowed by -AllowSignFailures." -ForegroundColor Yellow
    } else {
        Write-Host "All executables have been signed with EV certificate." -ForegroundColor Green
    }
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Test on a Smart App Control (Enforce) machine: extract the .zip, run setup.exe" -ForegroundColor Gray
    Write-Host "  2. Upload the .zip (NOT a bare .exe) to the GitHub release" -ForegroundColor Gray
    Write-Host "  3. Verify SmartScreen/Smart App Control does not block it" -ForegroundColor Gray
} else {
    Write-Host "WARNING: Artifacts are NOT signed - test build only" -ForegroundColor Yellow
}

Write-Host ""
