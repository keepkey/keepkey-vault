param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$SignToolPath,
    [Parameter(Mandatory = $true)][string]$Thumbprint
)

$ErrorActionPreference = 'Stop'
$timestamps = @(
    'http://timestamp.digicert.com',
    'http://timestamp.sectigo.com',
    'http://timestamp.globalsign.com/tsa/r6advanced1'
)

foreach ($timestamp in $timestamps) {
    & $SignToolPath sign /sha1 $Thumbprint /fd sha256 /tr $timestamp /td sha256 /d 'KeepKey Vault Installer' $FilePath
    if ($LASTEXITCODE -eq 0) { exit 0 }
}

throw "Failed to Authenticode-sign Inno-generated file: $FilePath"
