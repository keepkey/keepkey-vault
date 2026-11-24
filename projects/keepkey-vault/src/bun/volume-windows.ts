import { execFile, spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { VolumeInventory } from '../shared/volumes'

const exec = promisify(execFile)

// Query storage metadata in the current user's session. The script takes no renderer input.
const inventoryScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$local = $null
try {
  $root = [IO.Path]::GetPathRoot([Environment]::GetFolderPath('UserProfile'))
  $drive = New-Object System.IO.DriveInfo($root)
  $label = $drive.VolumeLabel
  if (!$label) { $label = $drive.Name }
  $local = @{ name = $label; totalBytes = $drive.TotalSize; availableBytes = $drive.AvailableFreeSpace; fileVault = 'unknown' }
} catch {}
$edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name EditionID -ErrorAction SilentlyContinue).EditionID
$bitlocker = @{}
if (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue) {
  try {
    foreach ($entry in (Get-BitLockerVolume -WarningAction SilentlyContinue -ErrorAction Stop |
        Select-Object MountPoint, VolumeStatus, LockStatus)) {
      if ($entry.MountPoint) { $bitlocker[[string]$entry.MountPoint] = $entry }
    }
  } catch {}
}
$groups = [Security.Principal.WindowsIdentity]::GetCurrent().Groups
$adminAccount = @($groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }).Count -gt 0
$engine = $true
foreach ($required in @('Get-DiskImage','Mount-DiskImage','Dismount-DiskImage','Get-Disk','Initialize-Disk','Set-Disk',
      'New-Partition','Get-Partition','Add-PartitionAccessPath','Get-Volume','Format-Volume','Get-BitLockerVolume','Unlock-BitLocker',
      'Lock-BitLocker','Enable-BitLocker','Disable-BitLockerAutoUnlock')) {
  if (!(Get-Command $required -ErrorAction SilentlyContinue)) { $engine = $false; break }
}
$scanFailed = $false
$drives = @(
  try {
    foreach ($disk in (Get-Disk)) {
      if ($disk.IsBoot -or $disk.IsSystem -or [string]$disk.BusType -notin @('USB','SD','MMC','1394')) { continue }
      $volumes = @(
        foreach ($partition in (Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue)) {
          if ($partition.IsHidden -or $partition.IsBoot -or $partition.IsSystem -or $partition.Type -in @('System','Reserved','Recovery')) { continue }
          $vol = Get-Volume -Partition $partition -ErrorAction SilentlyContinue
          if (!$vol) { continue }
          $mount = $null
          $status = $null
          if ([string]$vol.DriveLetter -match '^[A-Z]$') {
            $letter = [string]$vol.DriveLetter + ':'
            $mount = $letter + '\'
            $status = $bitlocker[$letter]
          }
          $locked = $null
          $encrypted = $null
          if ($status) {
            if ($status.LockStatus -eq 'Locked') { $locked = $true; $mount = $null }
            if ($status.LockStatus -eq 'Unlocked') { $locked = $false }
            if ($status.VolumeStatus -eq 'FullyEncrypted') { $encrypted = $true }
            if ($status.VolumeStatus -eq 'FullyDecrypted') { $encrypted = $false }
          }
          $name = $vol.FileSystemLabel
          if (!$name) { $name = $vol.Path }
          $uuid = $null
          if ($vol.Path -match 'Volume\{([a-fA-F0-9-]{36})\}') { $uuid = $Matches[1] }
          $available = $null
          if ($mount -and $vol.Size -gt 0) { $available = $vol.SizeRemaining }
          @{
            id = [string]$disk.Number + '/' + [string]$partition.PartitionNumber; uuid = $uuid; name = [string]$name
            format = [string]$vol.FileSystemType; mountPoint = $mount; locked = $locked; encrypted = $encrypted
            availableBytes = $available; writable = [bool]($mount -and !$disk.IsReadOnly -and !$partition.IsReadOnly)
          }
        }
      )
      @{ id = [string]$disk.Number; name = [string]$disk.FriendlyName; sizeBytes = $disk.Size; volumes = $volumes }
    }
  } catch { $scanFailed = $true }
)
@{ local = $local; drives = $drives; edition = [string]$edition; scanFailed = $scanFailed; engine = $engine; adminAccount = $adminAccount } | ConvertTo-Json -Depth 5 -Compress
`

const bytes = z.number().finite().nonnegative()
const snapshot = z.object({
  edition: z.string(),
  scanFailed: z.boolean(),
  engine: z.boolean(),
  adminAccount: z.boolean(),
  local: z.object({ name: z.string(), totalBytes: bytes, availableBytes: bytes, fileVault: z.literal('unknown') }).nullable(),
  drives: z.array(z.object({
    id: z.string(), name: z.string(), sizeBytes: bytes,
    volumes: z.array(z.object({
      id: z.string(), uuid: z.guid().nullable(), name: z.string(), format: z.string(),
      mountPoint: z.string().regex(/^[A-Z]:\\$/i).nullable(), locked: z.boolean().nullable(), encrypted: z.boolean().nullable(),
      writable: z.boolean(), availableBytes: bytes.nullable(),
    })),
  })),
})

const unavailable = 'Windows volume management requires the BitLocker and Storage PowerShell modules.'
const accountUnavailable = 'To manage KeepKey volumes, sign in to Windows with an administrator account and approve the Windows prompts.'
const homeUnavailable = 'Windows Home supports drive browsing. BitLocker volume management requires a supported Windows edition.'
const scanUnavailable = 'Windows could not scan connected drives. KeepKey volume creation and unlock are unavailable.'

function systemPath(...parts: string[]) {
  if (process.platform !== 'win32') throw new Error('Windows storage is unavailable on this computer.')
  return win32.join(process.env.SystemRoot || 'C:\\Windows', ...parts)
}

export async function queryWindowsJson(script: string, variables?: Record<string, string>) {
  const command = systemPath('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const { stdout } = await exec(command, ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script], {
    timeout: 20_000, windowsHide: true, env: { ...process.env, ...variables }, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
  })
  return JSON.parse(stdout.replace(/^\uFEFF/, ''))
}

export async function getWindowsVolumeInventory(query: () => Promise<unknown> = () => queryWindowsJson(inventoryScript)): Promise<VolumeInventory> {
  const data = snapshot.parse(await query())
  const unavailableReason = data.scanFailed ? scanUnavailable : /^Core/i.test(data.edition) ? homeUnavailable : !data.engine ? unavailable : !data.adminAccount ? accountUnavailable : undefined
  return { supported: true, ...(unavailableReason && { unavailableReason }), local: data.local, drives: data.drives }
}

export function openWindowsDrive(path: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(systemPath('explorer.exe'), [path], { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export async function openWindowsExternalVolume(
  target: { id: string; uuid: string | null },
  inventory = getWindowsVolumeInventory,
  launch = openWindowsDrive,
) {
  const volume = (await inventory()).drives.flatMap(drive => drive.volumes)
    .find(item => item.id === target?.id && item.uuid && item.uuid === target.uuid)
  if (!volume?.mountPoint || !/^[A-Z]:\\$/i.test(volume.mountPoint) || volume.locked) {
    throw new Error('The selected volume is no longer mounted. Refresh the drive list.')
  }
  await launch(volume.mountPoint)
}
