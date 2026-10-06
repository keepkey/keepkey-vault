/**
 * Setup asks the user to unplug (to reach the bootloader). A cached portfolio
 * from ANY earlier device switched on watch-only at that moment, and the
 * watch-only screen rendered before setup, unmounting the wizard mid-OOB and
 * mid-update (v1.5.3+). The setup lock must win.
 *
 * Run: bun test __tests__/app-phase.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { resolveAppPhase, showWatchOnly } from '../src/shared/app-phase'

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
})
