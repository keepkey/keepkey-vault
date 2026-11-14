/**
 * Setup asks the user to unplug (to reach the bootloader). A cached portfolio
 * from ANY earlier device switched on watch-only at that moment, and the
 * watch-only screen rendered before setup, unmounting the wizard mid-OOB and
 * mid-update (v1.5.3+). The setup lock must win.
 *
 * Run: bun test __tests__/app-phase.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { autoUnlockKey, resolveAppPhase, retainLivePortfolioSession, showWatchOnly, watchOnlyEndsForDevice } from '../src/shared/app-phase'

const base = { state: 'disconnected', oobLock: false, isClaimed: false, firmwareSkipped: false, wizardComplete: false }

describe('setup lock vs watch-only', () => {
  test('unplugging during setup keeps the wizard, even with a cached portfolio', () => {
    const phase = resolveAppPhase({ ...base, oobLock: true })
    expect(phase).toBe('setup')
    expect(showWatchOnly(true, phase)).toBe(false)
  })

  test('the lock also beats a transient claim error', () => {
    expect(resolveAppPhase({ ...base, state: 'connected_unpaired', isClaimed: true, oobLock: true })).toBe('setup')
  })

  test('outside setup, an unplugged device with a cache shows watch-only', () => {
    const phase = resolveAppPhase(base)
    expect(phase).toBe('splash')
    expect(showWatchOnly(true, phase)).toBe(true)
    expect(showWatchOnly(false, phase)).toBe(false)
  })
})

describe('resolveAppPhase', () => {
  test('device states', () => {
    expect(resolveAppPhase({ ...base, state: 'needs_firmware' })).toBe('setup')
    expect(resolveAppPhase({ ...base, state: 'bootloader' })).toBe('setup')
    expect(resolveAppPhase({ ...base, state: 'needs_init' })).toBe('setup')
    expect(resolveAppPhase({ ...base, state: 'ready' })).toBe('ready')
    expect(resolveAppPhase({ ...base, state: 'needs_pin' })).toBe('splash')
    expect(resolveAppPhase({ ...base, state: 'needs_firmware', firmwareSkipped: true })).toBe('ready')
    expect(resolveAppPhase({ ...base, state: 'needs_init', wizardComplete: true })).toBe('splash')
  })

  test('bootloader mode with nothing to install asks for a replug instead of looping setup', () => {
    expect(resolveAppPhase({ ...base, state: 'bootloader', bootloaderIdle: true })).toBe('leave-bootloader')
    expect(resolveAppPhase({ ...base, state: 'bootloader', bootloaderIdle: true, wizardComplete: true })).toBe('leave-bootloader')
    // A running setup (e.g. "Firmware Update Complete, replug") keeps the wizard.
    expect(resolveAppPhase({ ...base, state: 'bootloader', bootloaderIdle: true, oobLock: true })).toBe('setup')
    // Something to install: setup as before.
    expect(resolveAppPhase({ ...base, state: 'bootloader', bootloaderIdle: false })).toBe('setup')
  })
})

describe('browsing an already opened wallet while its device is locked', () => {
  const ready = { state: 'ready', deviceId: 'device-a', activeTransport: 'webusb', initialized: true, isHiddenWallet: false }
  const locked = { ...ready, state: 'needs_pin' }
  const opened = retainLivePortfolioSession(null, ready)

  test('a cold locked connection cannot open the portfolio', () => {
    expect(retainLivePortfolioSession(null, locked)).toBeNull()
    expect(resolveAppPhase({ ...base, state: 'needs_pin', lockedPortfolioAvailable: false })).toBe('splash')
  })

  test('a PIN lock keeps the same live portfolio, with its normal device actions', () => {
    expect(retainLivePortfolioSession(opened, locked)).toEqual(opened)
    const phase = resolveAppPhase({ ...base, state: 'needs_pin', lockedPortfolioAvailable: true })
    expect(phase).toBe('ready')
    expect(showWatchOnly(false, phase)).toBe(false)
  })

  test('a device, transport, or wallet-mode change cannot inherit the open portfolio', () => {
    expect(retainLivePortfolioSession(opened, { ...locked, deviceId: 'device-b' })).toBeNull()
    expect(retainLivePortfolioSession(opened, { ...locked, activeTransport: 'emulator' })).toBeNull()
    expect(retainLivePortfolioSession(opened, { ...locked, isHiddenWallet: true })).toBeNull()
    expect(retainLivePortfolioSession(opened, { ...locked, deviceId: undefined })).toBeNull()
    expect(retainLivePortfolioSession(opened, { ...locked, activeTransport: null })).toBeNull()
  })

  test('every transition is reduced, including a quick replug of the same device', () => {
    let session = opened
    for (const state of ['disconnected', 'connected_unpaired', 'needs_pin']) {
      session = retainLivePortfolioSession(session, { ...ready, state })
    }
    expect(session).toBeNull()
    expect(retainLivePortfolioSession(session, ready)).toEqual(opened)
  })

  test('passphrase, seed-purge, and setup boundaries invalidate a previously opened wallet', () => {
    for (const state of ['needs_passphrase', 'needs_init', 'needs_firmware', 'bootloader', 'error']) {
      const session = retainLivePortfolioSession(opened, { ...ready, state })
      expect(session).toBeNull()
      expect(retainLivePortfolioSession(session, locked)).toBeNull()
    }
    // wallet-data-purged clears the RAM-only session before the next device push.
    expect(retainLivePortfolioSession(null, locked)).toBeNull()
    expect(retainLivePortfolioSession(opened, { ...locked, initialized: false })).toBeNull()
    expect(retainLivePortfolioSession(opened, { ...locked, wipePending: 'confirm' })).toBeNull()
  })

  test('a hidden wallet may keep only its current in-memory view through a PIN lock', () => {
    const hidden = { ...ready, isHiddenWallet: true }
    const session = retainLivePortfolioSession(null, hidden)
    expect(retainLivePortfolioSession(session, { ...hidden, state: 'needs_pin' })).toEqual(session)
    expect(retainLivePortfolioSession(session, { ...hidden, state: 'needs_passphrase' })).toBeNull()
  })

  test('locked continuity never overrides setup, claim, passphrase, or disconnect precedence', () => {
    const retained = { ...base, lockedPortfolioAvailable: true }
    expect(resolveAppPhase({ ...retained, state: 'needs_pin', oobLock: true })).toBe('setup')
    expect(resolveAppPhase({ ...retained, state: 'needs_pin', isClaimed: true })).toBe('claimed')
    for (const state of ['needs_passphrase', 'disconnected', 'connected_unpaired', 'error']) {
      expect(resolveAppPhase({ ...retained, state })).toBe('splash')
    }
    expect(resolveAppPhase({ ...retained, state: 'needs_init' })).toBe('setup')
  })
})

describe('a KeepKey plugged in locked unlocks without a click', () => {
  const locked = { phase: 'splash' as const, state: 'needs_pin', deviceId: 'KK1', activeTransport: 'webusb' }
  test('the PIN and then the passphrase prompt open on their own, once per connection', () => {
    expect(autoUnlockKey(locked)).toBe('KK1:webusb')
    expect(autoUnlockKey({ ...locked, state: 'needs_passphrase' })).toBe('KK1:webusb')
    expect(autoUnlockKey({ ...locked, activeTransport: 'hid' })).toBe('KK1:hid') // a new connection asks again
  })
  test('never over a pending wipe, setup, or a portfolio the device locked while open', () => {
    expect(autoUnlockKey({ ...locked, wipePending: 'confirm' })).toBeNull()
    expect(autoUnlockKey({ ...locked, wipePending: 'replug' })).toBeNull()
    expect(autoUnlockKey({ ...locked, phase: 'setup' })).toBeNull()
    expect(autoUnlockKey({ ...locked, phase: 'ready' })).toBeNull() // auto-lock timer: the banner offers Unlock
  })
  test('only a locked device that is fully identified', () => {
    for (const state of ['disconnected', 'connected_unpaired', 'ready', 'error', 'needs_init']) expect(autoUnlockKey({ ...locked, state })).toBeNull()
    expect(autoUnlockKey({ ...locked, deviceId: undefined })).toBeNull()
    expect(autoUnlockKey({ ...locked, activeTransport: null })).toBeNull()
  })
})

describe('view-only with the same KeepKey plugged in (audit v4 H3)', () => {
  test('locked device keeps its view-only wallet open', () => {
    expect(watchOnlyEndsForDevice('dev1', { state: 'needs_pin', deviceId: 'dev1' })).toBe(false)
    expect(watchOnlyEndsForDevice('dev1', { state: 'needs_passphrase', deviceId: 'dev1' })).toBe(false)
  })
  test('unlocked device takes over', () => {
    expect(watchOnlyEndsForDevice('dev1', { state: 'ready', deviceId: 'dev1' })).toBe(true)
    expect(watchOnlyEndsForDevice('dev1', { state: 'ready', deviceId: 'dev2' })).toBe(false)
  })
})
