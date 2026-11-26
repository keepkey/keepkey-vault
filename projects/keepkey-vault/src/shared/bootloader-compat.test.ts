import { describe, expect, test } from 'bun:test'
import { bootloaderTooOldForFirmware } from './bootloader-compat'

describe('bootloaderTooOldForFirmware', () => {
  const fw = (firmwareVersion: string | null, bootloaderVersion: string | null, imageKind = 'firmware') =>
    bootloaderTooOldForFirmware({ imageKind, firmwareVersion, bootloaderVersion })

  test('blocks firmware 7.x on a 1.x bootloader', () => {
    expect(fw('7.17.0', '1.0.3')).toBe(true)
    expect(fw('7.0.0', '1.1.0')).toBe(true)
    expect(fw('7.17.0', 'v1.0.3')).toBe(true)
  })

  test('allows firmware 7.x on bootloader 2.0 and newer', () => {
    expect(fw('7.17.0', '2.0.0')).toBe(false)
    expect(fw('7.17.0', '2.1.4')).toBe(false)
  })

  test('older firmware is not judged by this rule', () => {
    expect(fw('6.7.0', '1.0.3')).toBe(false)
  })

  test('unknown versions never block on a guess', () => {
    expect(fw(null, '1.0.3')).toBe(false)
    expect(fw('7.17.0', null)).toBe(false)
    expect(fw('7.17.0', '')).toBe(false)
  })

  test('only firmware images are judged; a bootloader updater is the fix', () => {
    expect(fw('2.1.4', '1.0.3', 'bootloader-updater')).toBe(false)
    expect(fw('7.17.0', '1.0.3', 'raw-bootloader')).toBe(false)
  })
})
