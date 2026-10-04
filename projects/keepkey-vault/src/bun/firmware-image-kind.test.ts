import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { classifyFirmwareImage } from './firmware-image-kind'

const releases = JSON.parse(readFileSync(join(import.meta.dir, '../../firmware-bundle/releases.json'), 'utf8'))
const BL = releases.hashes.bootloader as Record<string, string>
const official = readFileSync(join(import.meta.dir, '../../firmware-bundle/bl_v2.1.4/blupdater.bin'))

describe('classifyFirmwareImage', () => {
  test('the official 2.1.4 blupdater is a bootloader updater carrying official 2.1.4', () => {
    expect(classifyFirmwareImage(official, BL)).toEqual({
      kind: 'bootloader-updater',
      embeddedBootloader: { hash: 'fe98454e7ebd4aef4a6db5bd4c60f52cf3f58b974283a7c1e1fcc5fea02cf3eb', version: '2.1.4', official: true },
    })
  })

  test('its embedded bootloader alone is a raw bootloader, never firmware', () => {
    const raw = official.subarray(12804, 12804 + 0x40000)
    expect(classifyFirmwareImage(raw, BL)).toMatchObject({ kind: 'raw-bootloader', embeddedBootloader: { version: '2.1.4', official: true } })
  })

  test('a bootloader with any other bytes is reported as unofficial', () => {
    const edited = Buffer.from(official); edited[12804 + 0x16d4d] ^= 1
    expect(classifyFirmwareImage(edited, BL).embeddedBootloader).toMatchObject({ version: '2.1.4', official: false })
  })

  test('KPKY firmware stays firmware; junk is unknown', () => {
    const fw = Buffer.concat([Buffer.from('KPKY'), Buffer.alloc(4096)])
    expect(classifyFirmwareImage(fw, BL)).toEqual({ kind: 'firmware' })
    expect(classifyFirmwareImage(Buffer.alloc(1000), BL)).toEqual({ kind: 'unknown' })
  })

  // Local images only (never committed): skipped where absent.
  const local = join(homedir(), 'keepkey-test-images')
  test.skipIf(!existsSync(join(local, 'firmware.7.16.0-a0cd9bfed-TESTKEYS-TESTSIGNED.bin')))('local real firmware is firmware', () => {
    expect(classifyFirmwareImage(readFileSync(join(local, 'firmware.7.16.0-a0cd9bfed-TESTKEYS-TESTSIGNED.bin')), BL)).toEqual({ kind: 'firmware' })
  })
})
