# One-shot provisioning of build toolchain via winget (run elevated).
# NOTE: deliberately does NOT install Zig via winget -- the repo needs Zig 0.15.x
# and winget ships 0.16 (breaks wrapper-launcher.zig, quirk #1). The pinned
# 0.15.1 at ~\tools\zig-x86_64-windows-0.15.1 is what the build script uses.
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot '_provision.log'
function Say($m) { $line = "[{0}] {1}" -f ((Get-Date).ToString('HH:mm:ss')), $m; Add-Content -Path $log -Value $line; Write-Output $line }

Set-Content -Path $log -Value "=== provisioning start ==="

$common = @('--exact','--accept-package-agreements','--accept-source-agreements','--disable-interactivity')

function Install($id, $extra) {
  Say "installing $id ..."
  $args = @('install','--id', $id) + $common + $extra
  & winget @args 2>&1 | ForEach-Object { Add-Content -Path $log -Value "    $_" }
  Say "...done $id (winget exit looked like above)"
}

Install 'OpenJS.NodeJS.LTS' @()
Install 'Yarn.Yarn' @()
Install 'Oven-sh.Bun' @()
Install 'Rustlang.Rustup' @()
Install 'JRSoftware.InnoSetup' @()
Install 'Microsoft.VisualStudio.2022.BuildTools' @('--override','--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')

Say "=== provisioning complete ==="
