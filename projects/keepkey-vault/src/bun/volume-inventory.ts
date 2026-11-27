import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { ConnectedVolume, VolumeInventory } from '../shared/volumes'

// Both utilities receive explicit argument vectors. Limit output and runtime so a
// stalled Disk Arbitration session can't hold the desktop request indefinitely.
function readOutput(executable: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(executable, args, {
      encoding: 'utf8', timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(new Error('macOS could not read storage information. Refresh to try again.'))
      else resolve(stdout)
    })
    proc.stdin?.on('error', reject)
    proc.stdin?.end(input)
  })
}

export async function runMacPlist<T>(executable: string, args: string[]): Promise<T> {
  const plist = await readOutput(executable, args)
  const json = await readOutput('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], plist)
  return JSON.parse(json) as T
}

interface Disk {
  DeviceIdentifier: string
  Content?: string
  OSInternal?: boolean
  Partitions?: Disk[]
  Name?: string
  VolumeName?: string
  MediaName?: string
  Size?: number
  TotalSize?: number
  VolumeUUID?: string
  APFSVolumeUUID?: string
  FilesystemUserVisibleName?: string
  FilesystemType?: string
  MountPoint?: string
  Encryption?: boolean
  FileVault?: boolean
  Locked?: boolean
  CryptoMigrationOn?: boolean
  Roles?: string[]
  WritableVolume?: boolean
  WritableMedia?: boolean
}

interface DiskList { AllDisksAndPartitions: Disk[] }
interface Container { PhysicalStores: Disk[]; Volumes: Disk[] }
interface APFSList { Containers: Container[] }
type ReadDiskutil = <T>(args: string[]) => Promise<T>

const helperPartitions = new Set(['EFI', '0xEF', 'Apple_APFS', 'Apple_Boot', 'Apple_Recovery', 'Apple_partition_map',
  'Apple_Free', 'Apple_CoreStorage', 'Apple_RAID', 'Apple_RAID_Offline', 'Microsoft Reserved'])

function encrypted(disk: Disk) {
  if (disk.CryptoMigrationOn) return null
  if (disk.Encryption === true || disk.FileVault === true) return true
  return disk.Encryption ?? disk.FileVault ?? null
}

async function mountedStorage(disk: Disk) {
  if (!disk.MountPoint || disk.Locked) return { writable: false, availableBytes: null }
  const stats = await statfs(disk.MountPoint).catch(() => null)
  const writable = !disk.Roles?.length && disk.WritableVolume !== false && disk.WritableMedia !== false
    && await access(disk.MountPoint, constants.W_OK).then(() => true, () => false)
  return { writable, availableBytes: stats ? stats.bsize * stats.bavail : null }
}

async function describeDisk(drive: Disk, containers: Container[], read: ReadDiskutil) {
  const info = (id: string) => read<Disk>(['info', '-plist', id])
  const hardware = await info(drive.DeviceIdentifier)
  const partitions = drive.Partitions ?? []
  const physicalIds = new Set([drive.DeviceIdentifier, ...partitions.map(partition => partition.DeviceIdentifier)])
  const apfsVolumes = containers.filter(c => c.PhysicalStores.some(p => physicalIds.has(p.DeviceIdentifier)))
    .flatMap(c => c.Volumes)
    // Show Data and Time Machine volumes for reference. All role-assigned volumes
    // are excluded from creation destinations, including unknown future roles.
    .filter(v => (v.Roles ?? []).every(role => role === 'Data' || role === 'Backup'))
  const regularVolumes = partitions.filter(p => !helperPartitions.has(p.Content ?? ''))
  // Some external media have a filesystem directly on the whole device.
  if (!partitions.length && !apfsVolumes.length && hardware.FilesystemType) regularVolumes.push(hardware)
  const volumes = await Promise.all([...apfsVolumes, ...regularVolumes].map(async (volume): Promise<ConnectedVolume> => {
    const details = volume === hardware ? hardware : await info(volume.DeviceIdentifier)
    const listedUUID = volume.APFSVolumeUUID ?? volume.VolumeUUID
    const actualUUID = details.APFSVolumeUUID ?? details.VolumeUUID
    if ((listedUUID && actualUUID && listedUUID !== actualUUID)
      || (details.DeviceIdentifier && details.DeviceIdentifier !== volume.DeviceIdentifier)) {
      throw new Error('A connected volume changed during the scan. Refresh to try again.')
    }
    const disk = { ...volume, ...details, MountPoint: details.MountPoint }
    return {
      ...await mountedStorage(disk),
      id: disk.DeviceIdentifier,
      uuid: disk.APFSVolumeUUID ?? disk.VolumeUUID ?? null,
      name: disk.Name || disk.VolumeName || disk.DeviceIdentifier,
      format: disk.FilesystemUserVisibleName || disk.FilesystemType || (disk.APFSVolumeUUID ? 'APFS' : disk.Content || 'Unknown'),
      mountPoint: disk.Locked ? null : disk.MountPoint || null,
      encrypted: encrypted(disk),
      locked: disk.Locked ?? null,
    }
  }))
  return {
    id: drive.DeviceIdentifier,
    name: hardware.MediaName || hardware.VolumeName || drive.DeviceIdentifier,
    sizeBytes: drive.Size ?? hardware.TotalSize ?? 0,
    volumes,
  }
}

export async function getVolumeInventory(
  platform: NodeJS.Platform = process.platform,
  read: ReadDiskutil = args => runMacPlist('/usr/sbin/diskutil', args),
  homeSpace = async () => {
    const space = await statfs(homedir())
    return { totalBytes: space.blocks * space.bsize, availableBytes: space.bavail * space.bsize }
  },
): Promise<VolumeInventory> {
  if (platform !== 'darwin') return { supported: false, local: null, drives: [] }
  const [startup, external, capacity] = await Promise.all([
    read<Disk>(['info', '-plist', '/']),
    read<DiskList>(['list', '-plist', 'external', 'physical']),
    homeSpace().catch(() => null),
  ])
  const disks = external.AllDisksAndPartitions.filter(disk => disk.OSInternal !== true)
  const hasAPFS = disks.some(disk => [disk, ...(disk.Partitions ?? [])].some(p => p.Content === 'Apple_APFS'))
  const containers = hasAPFS ? (await read<APFSList>(['apfs', 'list', '-plist'])).Containers : []
  return {
    supported: true,
    local: capacity ? {
      name: startup.VolumeName || 'Startup disk', ...capacity,
      fileVault: startup.FileVault === true ? 'on' : startup.FileVault === false ? 'off' : 'unknown',
    } : null,
    drives: await Promise.all(disks.map(disk => describeDisk(disk, containers, read))),
  }
}
