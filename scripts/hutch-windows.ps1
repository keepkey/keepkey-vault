# Hutch on Windows, pinned the way .github/actions/install-hutch pins it for
# macOS and Linux CI: the 0.29.0 windows-x64 archive must match a reviewed
# sha256 before anything in it runs, and an installed Hutch is accepted only if
# its binaries are the ones in that archive. Hutch builds the Electrobun devkit
# and packs the app that then gets Authenticode-signed, so a different build
# must never get that far. Bump every value together when moving Hutch.
#
#   . scripts\hutch-windows.ps1; $problem = Test-PinnedHutch   # $null when pinned
#   powershell -ExecutionPolicy Bypass -File scripts\hutch-windows.ps1 -Install
param([switch]$Install)

$HutchVersion = "0.29.0"
$HutchRevision = "a2c9255ed54f93225814d7d7cf04ad5a613e44eb"
$HutchPlatform = "windows-x64"
$HutchArchiveSha256 = "5689e643748c6569f0d40e702300555ca08c93790fe69f4327797279b2a75213"
# bin/hutch.exe and bin/hutch-engine.exe inside that archive.
$HutchExeSha256 = "a35e7620abfe0192109822493c02017d8bf3d2c1c270f699825104aeffa84415"
$HutchEngineSha256 = "a129599ce42162e3bc86e1db2cb75096e25fa4a9b65e54a5920b6ef2a58ef264"
$HutchHome = if ($env:HUTCH_HOME) { $env:HUTCH_HOME } else { Join-Path $HOME ".hutch" }
$HutchReleaseRoot = Join-Path $HutchHome "releases/hutch/$HutchVersion/$HutchRevision/$HutchPlatform"

function Get-HutchSha256([string]$Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

# Returns $null when the installed Hutch is the pinned build, else the problem.
function Test-PinnedHutch {
    $files = @(
        @{ Path = Join-Path $HutchHome "bin/hutch.exe"; Sha256 = $HutchExeSha256 },
        @{ Path = Join-Path $HutchReleaseRoot "bin/hutch.exe"; Sha256 = $HutchExeSha256 },
        @{ Path = Join-Path $HutchReleaseRoot "bin/hutch-engine.exe"; Sha256 = $HutchEngineSha256 }
    )
    foreach ($f in $files) {
        if (-not (Test-Path -LiteralPath $f.Path)) { return "$($f.Path) is missing" }
        if ((Get-HutchSha256 $f.Path) -ne $f.Sha256) { return "$($f.Path) is not the pinned Hutch $HutchVersion build" }
    }
    $installed = Join-Path $HutchReleaseRoot ".dash-installed"
    if (-not (Test-Path -LiteralPath $installed) -or (Get-Content -Raw -LiteralPath $installed).Trim() -ne $HutchArchiveSha256) {
        return "Hutch $HutchVersion was not installed from the pinned archive ($installed)"
    }
    $others = @(Get-ChildItem -Directory -LiteralPath (Join-Path $HutchHome "releases/hutch/$HutchVersion") |
        Where-Object { $_.Name -ne $HutchRevision })
    if ($others.Count -gt 0) {
        return "other Hutch $HutchVersion builds are installed ($($others.Name -join ', ')); remove them"
    }
    return $null
}

# The steps of Hutch's install.ps1, on an archive checked before it is unpacked.
function Install-PinnedHutch {
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("hutch-install-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $work | Out-Null
    $stage = $null
    try {
        $archive = Join-Path $work "hutch.tar.gz"
        Invoke-WebRequest -UseBasicParsing -OutFile $archive `
            -Uri "https://hutch.blackboard.sh/hutch/builds/$HutchRevision/$HutchPlatform/hutch.tar.gz"
        if ((Get-HutchSha256 $archive) -ne $HutchArchiveSha256) {
            throw "Hutch archive is not the pinned $HutchVersion $HutchPlatform build; nothing was installed"
        }

        $parent = Split-Path $HutchReleaseRoot
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        $stage = Join-Path $parent (".hutch-install-$HutchPlatform-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $stage | Out-Null
        # System32 bsdtar: Git's GNU tar would read "C:\..." as a remote host.
        $tar = if ($env:SystemRoot -and (Test-Path "$env:SystemRoot\System32\tar.exe")) { "$env:SystemRoot\System32\tar.exe" } else { "tar" }
        & $tar -xzf $archive --strip-components=1 -C $stage
        if ($LASTEXITCODE -ne 0) { throw "Hutch archive extraction failed" }
        $metadata = Get-Content -Raw (Join-Path $stage "hutch-release.json") | ConvertFrom-Json
        if ($metadata.product -ne "hutch" -or $metadata.version -ne $HutchVersion -or
            $metadata.revision -ne $HutchRevision -or $metadata.platform -ne $HutchPlatform) {
            throw "Hutch archive metadata does not match the pin"
        }
        [System.IO.File]::WriteAllBytes((Join-Path $stage ".dash-installed"),
            [System.Text.Encoding]::ASCII.GetBytes($HutchArchiveSha256))

        $engine = Join-Path $work "hutch-engine.exe"
        Copy-Item (Join-Path $stage "bin/hutch-engine.exe") $engine
        $previousHome = $env:HUTCH_HOME
        try {
            $env:HUTCH_HOME = $HutchHome
            & $engine self bootstrap-install production $stage
            if ($LASTEXITCODE -ne 0) { throw "Hutch bootstrap-install failed (exit $LASTEXITCODE)" }
        } finally {
            $env:HUTCH_HOME = $previousHome
        }

        $bin = Join-Path $HutchHome "bin"
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        Copy-Item -Force (Join-Path $HutchReleaseRoot "bin/hutch.exe") (Join-Path $bin "hutch.exe")
    } finally {
        if ($stage) { Remove-Item -Recurse -Force -LiteralPath $stage -ErrorAction SilentlyContinue }
        Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
    }
}

if ($Install) {
    $ErrorActionPreference = "Stop"
    Install-PinnedHutch
    $problem = Test-PinnedHutch
    if ($problem) { throw $problem }
    Write-Host "Installed Hutch $HutchVersion ($HutchRevision) in $HutchHome. Add $HutchHome\bin to PATH."
}
