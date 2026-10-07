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
  test('unknown signing status claims no boundary', () => {
    expect(flashWipeReason({ isSigned: true, currentFirmwareVerified: undefined, isDowngrade: false })).toBeUndefined()
  })
  test('installed firmware of unknown version is never silent', () => {
    expect(flashWipeReason({ isSigned: true, isDowngrade: false, installedUnknown: true })).toBe('unknown-installed')
  })
})

describe('flashWipeReason: Bitcoin-only storage band', () => {
  const signed = { isSigned: true, currentFirmwareVerified: true }
  test('onto multi-chain (same or newer) locks the wallet', () => {
    expect(flashWipeReason({ ...signed, isDowngrade: false, currentBitcoinOnly: true, targetBitcoinOnly: false })).toBe('bitcoin-only-lock')
  })
  test('onto OLDER multi-chain wipes (predates the band)', () => {
    expect(flashWipeReason({ ...signed, isDowngrade: true, currentBitcoinOnly: true, targetBitcoinOnly: false })).toBe('downgrade')
  })
  test('onto an older Bitcoin-only build refuses, does not wipe', () => {
    expect(flashWipeReason({ ...signed, isDowngrade: true, currentBitcoinOnly: true, targetBitcoinOnly: true })).toBe('bitcoin-only-lock')
  })
  test('Bitcoin-only upgrade is safe', () => {
    expect(flashWipeReason({ ...signed, isDowngrade: false, currentBitcoinOnly: true, targetBitcoinOnly: true })).toBeUndefined()
  })
  test('the signed/unsigned boundary still wins', () => {
    expect(flashWipeReason({ isSigned: false, currentFirmwareVerified: true, isDowngrade: false, currentBitcoinOnly: true, targetBitcoinOnly: false })).toBe('signed-to-unsigned')
  })
})
