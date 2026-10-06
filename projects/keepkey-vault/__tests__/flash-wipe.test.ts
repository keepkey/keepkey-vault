/**
 * The firmware drop zone's red "this will wipe the device" warning.
 * Run: bun test __tests__/flash-wipe.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { flashWipeReason } from '../src/shared/flash-wipe'

describe('flashWipeReason', () => {
  test('signed downgrade (7.14.1 → 7.0.3) wipes', () => {
    expect(flashWipeReason({ isSigned: true, currentFirmwareVerified: true, isDowngrade: true })).toBe('downgrade')
  })
  test('signed upgrade over signed firmware does not wipe', () => {
    expect(flashWipeReason({ isSigned: true, currentFirmwareVerified: true, isDowngrade: false })).toBeUndefined()
  })
  test('crossing the signed/unsigned boundary wipes, either way', () => {
    expect(flashWipeReason({ isSigned: false, currentFirmwareVerified: true, isDowngrade: false })).toBe('signed-to-unsigned')
    expect(flashWipeReason({ isSigned: true, currentFirmwareVerified: false, isDowngrade: false })).toBe('unsigned-to-signed')
  })
  test('unknown installed firmware claims no boundary', () => {
    expect(flashWipeReason({ isSigned: true, currentFirmwareVerified: undefined, isDowngrade: false })).toBeUndefined()
  })
})
