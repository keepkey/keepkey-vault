# Unprivileged query. The image path is passed as data, and only a drive root
# obtained through the image/disk/partition association can reach Explorer.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$path = $env:KEEPKEY_VOLUME_QUERY_PATH
$result = @{ state = 'unavailable'; mount = $null }
try {
    $images = @(Get-DiskImage -ImagePath $path -StorageType VHDX)
    if ($images.Count -ne 1 -or $images[0].ImagePath -ne $path -or [int]$images[0].CimInstanceProperties['StorageType'].Value -ne 3) { throw 'image' }
    $image = $images[0]
    if ($image.Attached -eq $false) {
        $result.state = 'locked'
    } elseif ($image.Attached -eq $true) {
        $disks = @($image | Get-Disk)
        if ($disks.Count -ne 1 -or $disks[0].Number -ne $image.Number -or [int]$disks[0].CimInstanceProperties['BusType'].Value -ne 15 -or
            $disks[0].IsBoot -ne $false -or $disks[0].IsSystem -ne $false) { throw 'disk' }
        $result.state = 'attached'
        $parts = @($disks[0] | Get-Partition | Where-Object {
            ([guid]$_.GptType) -eq [guid]'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7' -and !$_.IsBoot -and !$_.IsSystem
        })
        if ($parts.Count -eq 1) {
            $volume = $parts[0] | Get-Volume
            if ($volume.FileSystemType -eq 'NTFS' -and [string]$volume.DriveLetter -match '^[A-Z]$') {
                $letter = [string]$volume.DriveLetter + ':\'
                if ((New-Object System.IO.DriveInfo($letter)).IsReady) {
                    $result.state = 'mounted'
                    $result.mount = $letter
                }
            }
        }
    }
} catch { $result = @{ state = 'unavailable'; mount = $null } }
if ($env:KEEPKEY_VOLUME_CHECK_DETACHED -eq '1' -and $result.state -eq 'unavailable') {
    # A malformed VHDX can fail Get-DiskImage even while detached. An exclusive
    # read open cannot coexist with a mounted VHDX's backing-file handle.
    try {
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        $stream.Dispose()
        $result.state = 'locked'
    } catch {}
}
$result | ConvertTo-Json -Compress
