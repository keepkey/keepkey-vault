/**
 * The setup wizard's first screen says "Genuine KeepKey" on a pass. That claim
 * must stay earned: an unofficial firmware hash never passes, and a known
 * bootloader only vouches for factory firmware that reports no hash.
 *
 * Run: bun test __tests__/firmware-authenticity-verdict.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { authenticityVerdict } from '../src/shared/firmware-authenticity'

describe('authenticityVerdict', () => {
  test('official firmware hash → verified', () => {
    expect(authenticityVerdict('ab12', true, true)).toBe('verified')
  })
  test('new-box factory firmware (no hash) with an official bootloader → genuine', () => {
    expect(authenticityVerdict(undefined, undefined, true)).toBe('genuine')
  })
  test('unofficial firmware hash stays unrecognized even on an official bootloader', () => {
    expect(authenticityVerdict('ab12', false, true)).toBe('unrecognized')
    expect(authenticityVerdict('ab12', undefined, true)).toBe('unrecognized')
  })
  test('no firmware hash and an unknown or unrecognized bootloader → unreported', () => {
    expect(authenticityVerdict(undefined, undefined, undefined)).toBe('unreported')
    expect(authenticityVerdict(undefined, undefined, false)).toBe('unreported')
  })
})
