/**
 * What a dropped .bin actually is, from its bytes. The firmware updater writes
 * any KPKY image into the application region, so a bootloader updater
 * (blupdater) flashes like firmware, but it then runs once and rewrites the
 * bootloader. A raw bootloader must never go through the firmware updater.
 */
import { createHash } from 'node:crypto'

export type FirmwareImageKind = 'firmware' | 'bootloader-updater' | 'raw-bootloader' | 'unknown'

export interface EmbeddedBootloader {
  /** sha256(sha256(256 KB)): the bootloaderHash a device reports. */
  hash: string
  /** From the release manifest when official, else the image's own version string. */
  version: string | null
  official: boolean
}

const BOOTLOADER_LEN = 0x40000
const BLUPDATER_MARKERS = ['Updating Bootloader. DO NOT UNPLUG', 'Bootloader Update Complete']

const doubleSha = (b: Buffer) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest('hex')

/** Cortex-M vector table of an image linked at the bootloader base (0x08020000). */
function isBootloaderVectorTable(b: Buffer, at: number): boolean {
  if (at + 8 > b.length) return false
  const sp = b.readUInt32LE(at)
  const reset = b.readUInt32LE(at + 4)
  return (sp & 0xfff00000) === 0x20000000 && reset >= 0x08020000 && reset < 0x08060000 && (reset & 1) === 1
}

function describe(region: Buffer, manifest: Record<string, string>): EmbeddedBootloader {
  const padded = region.length < BOOTLOADER_LEN
    ? Buffer.concat([region, Buffer.alloc(BOOTLOADER_LEN - region.length, 0xff)])
    : region
  const hash = doubleSha(padded)
  const listed = manifest[hash]
  const own = padded.toString('latin1').match(/Bootloader Version: (\d+\.\d+\.\d+)/)
  return { hash, version: listed ? listed.replace(/^v/, '') : own?.[1] ?? null, official: !!listed }
}

export function classifyFirmwareImage(data: Buffer, bootloaderManifest: Record<string, string> = {}):
  { kind: FirmwareImageKind; embeddedBootloader?: EmbeddedBootloader } {
  const kpky = data.length >= 256 && data.subarray(0, 4).toString('latin1') === 'KPKY'
  if (!kpky) {
    return data.length <= BOOTLOADER_LEN && isBootloaderVectorTable(data, 0)
      ? { kind: 'raw-bootloader', embeddedBootloader: describe(data, bootloaderManifest) }
      : { kind: 'unknown' }
  }
  const text = data.toString('latin1')
  if (!BLUPDATER_MARKERS.every((m) => text.includes(m))) return { kind: 'firmware' }
  // The updater's own vector table (payload offset 0) points into the app
  // region; the first table pointing into the bootloader region is the payload.
  for (let at = 256 + 4; at + BOOTLOADER_LEN <= data.length; at += 4) {
    if (isBootloaderVectorTable(data, at)) {
      return { kind: 'bootloader-updater', embeddedBootloader: describe(data.subarray(at, at + BOOTLOADER_LEN), bootloaderManifest) }
    }
  }
  return { kind: 'unknown' }
}
