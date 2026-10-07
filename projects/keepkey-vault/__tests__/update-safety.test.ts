/**
 * Firmware-update safety gates.
 *
 * An interrupted upload wipes the seed (bootloader storage-protection marker),
 * so: require a recovery-phrase confirmation before flashing any device that
 * may hold a wallet, and never tell the user their wallet survived when the
 * device came back empty.
 *
 * Run: bun test __tests__/update-safety.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { requiresBackupConfirmation, updateDoneWalletMessage } from '../src/mainview/lib/update-safety'

describe('requiresBackupConfirmation', () => {
  test('app mode: initialized device requires it, uninitialized does not', () => {
    expect(requiresBackupConfirmation({ bootloaderMode: false, initialized: true, isOob: false }, null)).toBe(true)
    expect(requiresBackupConfirmation({ bootloaderMode: false, initialized: false, isOob: true }, null)).toBe(false)
  })

  test('bootloader mode with no prior app-mode read fails closed', () => {
    expect(requiresBackupConfirmation({ bootloaderMode: true, initialized: true, isOob: false }, null)).toBe(true)
  })

  test('bootloader mode trusts an earlier app-mode read', () => {
    expect(requiresBackupConfirmation({ bootloaderMode: true, initialized: true, isOob: false }, false)).toBe(false)
    expect(requiresBackupConfirmation({ bootloaderMode: true, initialized: true, isOob: false }, true)).toBe(true)
  })

  test('bootloader mode with no firmware on flash (OOB) skips', () => {
    expect(requiresBackupConfirmation({ bootloaderMode: true, initialized: true, isOob: true }, null)).toBe(false)
  })
})

describe('updateDoneWalletMessage', () => {
  test('wallet present after update -> kept', () => {
    expect(updateDoneWalletMessage({ state: 'ready', bootloaderMode: false, initialized: true })).toBe('kept')
    expect(updateDoneWalletMessage({ state: 'needs_pin', bootloaderMode: false, initialized: true })).toBe('kept')
  })

  test('device came back empty -> never the reassurance', () => {
    expect(updateDoneWalletMessage({ state: 'needs_init', bootloaderMode: false, initialized: false })).toBe('empty')
  })

  test('unknown / bootloader -> claim nothing', () => {
    expect(updateDoneWalletMessage({ state: 'bootloader', bootloaderMode: true, initialized: true })).toBe(null)
    expect(updateDoneWalletMessage({ state: 'connected_unpaired', bootloaderMode: false, initialized: true })).toBe(null)
  })
})
