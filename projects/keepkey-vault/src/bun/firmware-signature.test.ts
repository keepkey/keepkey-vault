import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { verifyFirmwareSignatures } from './firmware-signature'

const bundled = (version: string) => new Uint8Array(readFileSync(join(import.meta.dir, '../../firmware-bundle', version, 'firmware.keepkey.bin')))

describe('firmware signature verification (the "SIGNED" badge)', () => {
  test('official release images verify against KeepKey\'s keys', () => {
    for (const version of ['v7.10.0', 'v7.14.0', 'v7.14.1']) expect(verifyFirmwareSignatures(bundled(version))).toBe(true)
  })

  test('filled signature slots that do not verify are not signed', () => {
    const image = bundled('v7.14.1')
    const flipped = new Uint8Array(image)
    flipped[256 + 1000] ^= 0x01 // one code byte changed: the digest no longer matches
    expect(verifyFirmwareSignatures(flipped)).toBe(false)
    const forged = new Uint8Array(image)
    forged.fill(0x22, 64, 256) // indexes still 1,2,3; signatures are junk
    expect(verifyFirmwareSignatures(forged)).toBe(false)
    const reused = new Uint8Array(image)
    reused[9] = reused[8] // duplicate index, as the bootloader refuses
    expect(verifyFirmwareSignatures(reused)).toBe(false)
    const truncated = image.subarray(0, image.length - 1) // code_len past the end
    expect(verifyFirmwareSignatures(truncated)).toBe(false)
    expect(verifyFirmwareSignatures(image.subarray(256))).toBe(false) // no KPKY header
  })

  // A test-key build (sigindex 1,2,3 filled) used to read "SIGNED".
  const testImage = join(process.env.HOME || '', 'keepkey-test-images', 'firmware.7.16.0-51f85368e-uniswap-v4-stream-TESTKEYS-TESTSIGNED.bin')
  test.skipIf(!existsSync(testImage))('a test-key-signed image is not KeepKey-signed', () => {
    const image = new Uint8Array(readFileSync(testImage))
    expect([image[8], image[9], image[10]]).toEqual([1, 2, 3])
    expect(verifyFirmwareSignatures(image)).toBe(false)
  })
})
