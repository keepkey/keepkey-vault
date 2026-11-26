import { versionCompare } from './firmware-versions'

/** Firmware 7.x does not run on the 1.x bootloaders; they must be updated first. */
export const MIN_BOOTLOADER_FOR_FIRMWARE_7 = '2.0.0'

const plain = (v: string | null | undefined) => (v ? v.trim().replace(/^v/i, '') : '')

/**
 * True when flashing this image would put firmware 7.x on a bootloader older
 * than 2.0. Only firmware images are judged (a bootloader updater is how the
 * bootloader gets fixed), and an unknown bootloader or image version never
 * blocks on a guess.
 */
export function bootloaderTooOldForFirmware(p: {
  imageKind: string
  firmwareVersion: string | null | undefined
  bootloaderVersion: string | null | undefined
}): boolean {
  if (p.imageKind !== 'firmware') return false
  const fw = plain(p.firmwareVersion)
  const bl = plain(p.bootloaderVersion)
  if (!/^\d+\.\d+/.test(fw) || !/^\d+\.\d+/.test(bl)) return false
  if (versionCompare(fw, '7.0.0') < 0) return false
  return versionCompare(bl, MIN_BOOTLOADER_FOR_FIRMWARE_7) < 0
}
