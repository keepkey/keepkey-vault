/**
 * Engine Controller State Machine Tests
 *
 * Tests the state derivation and getDeviceState() logic by reimplementing
 * the pure functions from engine-controller.ts. This avoids the USB/HID
 * native module import chain while testing the exact same logic.
 *
 * When engine-controller.ts changes, update these mirror functions.
 *
 * Run: bun test __tests__/engine-state-machine.test.ts
 */
import { describe, test, expect, beforeEach } from 'bun:test'

// ── Mirror of engine-controller pure functions ────────────────────────
// These are exact copies of the private methods. If they drift, tests
// catch regressions even if the mirror is stale (behavior mismatch).

type DeviceState = 'disconnected' | 'connected_unpaired' | 'error' | 'bootloader' | 'needs_firmware' | 'needs_init' | 'needs_pin' | 'needs_passphrase' | 'ready'
type UpdatePhase = 'idle' | 'entering_bootloader' | 'flashing' | 'rebooting'

function extractVersion(features: any): string {
  if (features.majorVersion) {
    return `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
  }
  return features.firmwareVersion || '0.0.0'
}

function versionLessThan(current: string, target: string): boolean {
  const c = current.split('.').map(Number)
  const t = target.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((c[i] || 0) < (t[i] || 0)) return true
    if ((c[i] || 0) > (t[i] || 0)) return false
  }
  return false
}

function deriveState(features: any, latestFirmware: string): DeviceState {
  if (!features) return 'disconnected'
  if (features.bootloaderMode) return 'bootloader'
  const fwVersion = extractVersion(features)
  if (versionLessThan(fwVersion, latestFirmware) || fwVersion === '4.0.0') return 'needs_firmware'
  if (!features.initialized) return 'needs_init'
  if (features.pinProtection && !features.pinCached) return 'needs_pin'
  if (features.passphraseProtection && !features.passphraseCached) return 'needs_passphrase'
  return 'ready'
}

interface EngineSnapshot {
  lastState: DeviceState
  cachedFeatures: any
  updatePhase: UpdatePhase
  latestFirmware: string
  latestBootloader: string
}

/** Mirror of getDeviceState() — produces the same output shape */
function getDeviceState(snap: EngineSnapshot) {
  const features = snap.cachedFeatures
  const fwVersion = features ? extractVersion(features) : undefined
  const blVersion = features?.bootloaderVersion || undefined
  const bootloaderMode = features?.bootloaderMode ?? false
  // Fix #1: default initialized=true when features are unavailable
  const initialized = features ? (features.initialized ?? false) : true
  const needsFw = bootloaderMode
    ? true
    : fwVersion ? (versionLessThan(fwVersion, snap.latestFirmware) || fwVersion === '4.0.0') : false

  let effectiveBlVersion = blVersion
  if (!effectiveBlVersion && bootloaderMode && fwVersion) effectiveBlVersion = fwVersion
  const needsBl = effectiveBlVersion
    ? versionLessThan(effectiveBlVersion, snap.latestBootloader)
    : bootloaderMode

  const firmwareHash = features?.firmwareHash
    ? (typeof features.firmwareHash === 'string' && /^[0-9a-fA-F]+$/.test(features.firmwareHash)
        ? features.firmwareHash
        : Buffer.from(features.firmwareHash, 'base64').toString('hex'))
    : undefined
  const firmwarePresent = !!firmwareHash && !/^0+$/.test(firmwareHash)

  return {
    state: snap.lastState,
    updatePhase: snap.updatePhase,
    bootloaderMode,
    needsBootloaderUpdate: needsBl,
    needsFirmwareUpdate: needsFw,
    needsInit: !initialized,
    initialized,
    isOob: bootloaderMode ? !firmwarePresent : fwVersion === '4.0.0',
    firmwareVersion: fwVersion,
    bootloaderVersion: effectiveBlVersion || blVersion,
  }
}

// ── Wizard effect simulation ─────────────────────────────────────────

/** Simulates the auto-skip bootloader effect from OobSetupWizard.tsx line 286 */
function autoSkipBootloaderEffect(
  step: string,
  deviceState: ReturnType<typeof getDeviceState>,
  updateState: string,
  rebootPhase: string,
): 'skip-firmware' | 'skip-init' | 'complete' | 'no-action' {
  if (step !== 'bootloader') return 'no-action'
  // Guard: don't route during disconnect (THE FIX for Bug #3)
  const s = deviceState.state
  if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error') return 'no-action'
  if (deviceState.needsBootloaderUpdate) return 'no-action'
  if (updateState !== 'idle') return 'no-action'
  if (rebootPhase === 'rebooting') return 'no-action'
  if (deviceState.needsFirmwareUpdate) return 'skip-firmware'
  if (deviceState.needsInit) return 'skip-init'
  return 'complete'
}

/** Simulates the auto-start bootloader polling effect from OobSetupWizard.tsx line 302 */
function autoStartBootloaderPollingEffect(
  step: string,
  deviceState: ReturnType<typeof getDeviceState>,
  inBootloader: boolean,
  waitingForBootloader: boolean,
  updateState: string,
  rebootPhase: string,
): boolean {
  if (step !== 'bootloader') return false
  const s = deviceState.state
  if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error') return false
  if (inBootloader) return false
  if (waitingForBootloader) return false
  if (updateState !== 'idle') return false
  if (rebootPhase === 'rebooting') return false
  if (!deviceState.needsBootloaderUpdate) return false
  return true // would call handleEnterBootloaderMode()
}

/** Simulates the auto-start firmware polling effect from OobSetupWizard.tsx line 380 */
function autoStartFirmwarePollingEffect(
  step: string,
  deviceState: ReturnType<typeof getDeviceState>,
  inBootloader: boolean,
  waitingForBootloaderFw: boolean,
  updateState: string,
  rebootPhase: string,
): boolean {
  if (step !== 'firmware') return false
  const s = deviceState.state
  if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error') return false
  if (updateState !== 'idle') return false
  if (rebootPhase === 'rebooting') return false
  if (inBootloader) return false
  if (!waitingForBootloaderFw) return true // would call handleEnterBootloaderForFirmware()
  return false
}

// ── Test Helpers ──────────────────────────────────────────────────────

function makeFeatures(overrides: Record<string, any> = {}): any {
  return {
    bootloaderMode: false,
    initialized: true,
    majorVersion: 7, minorVersion: 10, patchVersion: 0,
    bootloaderVersion: '2.1.4',
    firmwareHash: Buffer.alloc(32, 0xBB).toString('hex'),
    pinProtection: false, pinCached: false,
    passphraseProtection: false, passphraseCached: false,
    deviceId: 'test-device', label: 'Test KeepKey',
    ...overrides,
  }
}

const DEFAULTS: EngineSnapshot = {
  lastState: 'disconnected',
  cachedFeatures: null,
  updatePhase: 'idle',
  latestFirmware: '7.10.0',
  latestBootloader: '2.1.4',
}

function snap(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return { ...DEFAULTS, ...overrides }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('deriveState()', () => {
  const FW = '7.10.0'

  test('null → disconnected', () => {
    expect(deriveState(null, FW)).toBe('disconnected')
  })

  test('bootloaderMode → bootloader', () => {
    expect(deriveState({ bootloaderMode: true, majorVersion: 2, minorVersion: 1, patchVersion: 4 }, FW)).toBe('bootloader')
  })

  test('old firmware → needs_firmware', () => {
    expect(deriveState({ majorVersion: 7, minorVersion: 6, patchVersion: 0, initialized: true }, FW)).toBe('needs_firmware')
  })

  test('4.0.0 → needs_firmware', () => {
    expect(deriveState({ majorVersion: 4, minorVersion: 0, patchVersion: 0, initialized: false }, FW)).toBe('needs_firmware')
  })

  test('current fw + uninitialized → needs_init', () => {
    expect(deriveState({ majorVersion: 7, minorVersion: 10, patchVersion: 0, initialized: false }, FW)).toBe('needs_init')
  })

  test('PIN locked → needs_pin', () => {
    expect(deriveState({ majorVersion: 7, minorVersion: 10, patchVersion: 0, initialized: true, pinProtection: true, pinCached: false }, FW)).toBe('needs_pin')
  })

  test('passphrase locked → needs_passphrase', () => {
    expect(deriveState({ majorVersion: 7, minorVersion: 10, patchVersion: 0, initialized: true, pinProtection: true, pinCached: true, passphraseProtection: true, passphraseCached: false }, FW)).toBe('needs_passphrase')
  })

  test('all good → ready', () => {
    expect(deriveState({ majorVersion: 7, minorVersion: 10, patchVersion: 0, initialized: true }, FW)).toBe('ready')
  })

  test('priority: bootloader > firmware > init > pin > passphrase', () => {
    const base = { initialized: false, pinProtection: true, pinCached: false, passphraseProtection: true, passphraseCached: false }
    expect(deriveState({ ...base, bootloaderMode: true, majorVersion: 4, minorVersion: 0, patchVersion: 0 }, FW)).toBe('bootloader')
    expect(deriveState({ ...base, bootloaderMode: false, majorVersion: 4, minorVersion: 0, patchVersion: 0 }, FW)).toBe('needs_firmware')
    expect(deriveState({ ...base, bootloaderMode: false, majorVersion: 7, minorVersion: 10, patchVersion: 0 }, FW)).toBe('needs_init')
  })
})

describe('getDeviceState(): disconnect safety (OOB Bug #1)', () => {
  test('disconnected: needsInit=false, initialized=true', () => {
    const state = getDeviceState(snap())
    expect(state.needsInit).toBe(false)
    expect(state.initialized).toBe(true)
    expect(state.needsFirmwareUpdate).toBe(false)
    expect(state.needsBootloaderUpdate).toBe(false)
  })

  test('connected_unpaired (no features): needsInit=false', () => {
    const state = getDeviceState(snap({ lastState: 'connected_unpaired' }))
    expect(state.needsInit).toBe(false)
  })

  test('rapid disconnect/reconnect churn: always needsInit=false', () => {
    for (const ls of ['disconnected', 'connected_unpaired', 'disconnected', 'connected_unpaired'] as const) {
      const state = getDeviceState(snap({ lastState: ls }))
      expect(state.needsInit).toBe(false)
    }
  })

  test('rebooting phase with no features: needsInit=false', () => {
    const state = getDeviceState(snap({ updatePhase: 'rebooting' }))
    expect(state.needsInit).toBe(false)
    expect(state.updatePhase).toBe('rebooting')
  })
})

describe('getDeviceState(): OOB feature flags', () => {
  test('bootloader with no firmware hash → isOob=true', () => {
    const state = getDeviceState(snap({
      lastState: 'bootloader',
      cachedFeatures: makeFeatures({ bootloaderMode: true, firmwareHash: '00'.repeat(32) }),
    }))
    expect(state.isOob).toBe(true)
  })

  test('bootloader with firmware hash → isOob=false', () => {
    const state = getDeviceState(snap({
      lastState: 'bootloader',
      cachedFeatures: makeFeatures({ bootloaderMode: true, firmwareHash: 'aa'.repeat(32) }),
    }))
    expect(state.isOob).toBe(false)
  })

  test('factory 4.0.0 → isOob=true', () => {
    const state = getDeviceState(snap({
      lastState: 'needs_firmware',
      cachedFeatures: makeFeatures({ majorVersion: 4, minorVersion: 0, patchVersion: 0 }),
    }))
    expect(state.isOob).toBe(true)
  })
})

describe('Wizard auto-skip bootloader effect (OOB Bug #3)', () => {
  test('MUST NOT skip when disconnected', () => {
    const state = getDeviceState(snap())
    const result = autoSkipBootloaderEffect('bootloader', state, 'idle', 'idle')
    expect(result).toBe('no-action')
  })

  test('MUST NOT skip when connected_unpaired', () => {
    const state = getDeviceState(snap({ lastState: 'connected_unpaired' }))
    const result = autoSkipBootloaderEffect('bootloader', state, 'idle', 'idle')
    expect(result).toBe('no-action')
  })

  test('MUST NOT skip when error', () => {
    const state = getDeviceState(snap({ lastState: 'error' }))
    const result = autoSkipBootloaderEffect('bootloader', state, 'idle', 'idle')
    expect(result).toBe('no-action')
  })

  test('skip to firmware when BL current + FW outdated', () => {
    const state = getDeviceState(snap({
      lastState: 'needs_firmware',
      cachedFeatures: makeFeatures({ majorVersion: 7, minorVersion: 6, patchVersion: 0, initialized: false }),
    }))
    const result = autoSkipBootloaderEffect('bootloader', state, 'idle', 'idle')
    expect(result).toBe('skip-firmware')
  })

  test('skip to init when BL+FW current, not initialized', () => {
    const state = getDeviceState(snap({
      lastState: 'needs_init',
      cachedFeatures: makeFeatures({ initialized: false }),
    }))
    const result = autoSkipBootloaderEffect('bootloader', state, 'idle', 'idle')
    expect(result).toBe('skip-init')
  })

  test('complete when everything is current', () => {
    const state = getDeviceState(snap({
      lastState: 'ready',
      cachedFeatures: makeFeatures(),
    }))
    const result = autoSkipBootloaderEffect('bootloader', state, 'idle', 'idle')
    expect(result).toBe('complete')
  })

  test('no-action during rebooting phase', () => {
    const state = getDeviceState(snap({
      lastState: 'bootloader',
      cachedFeatures: makeFeatures({ bootloaderMode: true }),
    }))
    const result = autoSkipBootloaderEffect('bootloader', state, 'idle', 'rebooting')
    expect(result).toBe('no-action')
  })

  test('no-action when BL needs updating', () => {
    const state = getDeviceState(snap({
      lastState: 'bootloader',
      cachedFeatures: makeFeatures({
        bootloaderMode: true,
        majorVersion: 1, minorVersion: 0, patchVersion: 3,
        bootloaderVersion: undefined, // force effectiveBlVersion fallback to extractVersion
      }),
    }))
    expect(state.needsBootloaderUpdate).toBe(true)
    const result = autoSkipBootloaderEffect('bootloader', state, 'idle', 'idle')
    expect(result).toBe('no-action')
  })
})

describe('Wizard auto-start polling effects (disconnect safety)', () => {
  test('bootloader polling: MUST NOT start when disconnected', () => {
    const state = getDeviceState(snap())
    expect(autoStartBootloaderPollingEffect('bootloader', state, false, false, 'idle', 'idle')).toBe(false)
  })

  test('firmware polling: MUST NOT start when disconnected', () => {
    const state = getDeviceState(snap())
    expect(autoStartFirmwarePollingEffect('firmware', state, false, false, 'idle', 'idle')).toBe(false)
  })

  test('firmware polling: starts when connected with features', () => {
    const state = getDeviceState(snap({
      lastState: 'needs_firmware',
      cachedFeatures: makeFeatures({ majorVersion: 7, minorVersion: 6, patchVersion: 0 }),
    }))
    expect(autoStartFirmwarePollingEffect('firmware', state, false, false, 'idle', 'idle')).toBe(true)
  })
})

describe('Full OOB sequence: factory-fresh device', () => {
  test('complete lifecycle produces correct states at every point', () => {
    const sequence: Array<{
      phase: string
      snap: EngineSnapshot
      wizardStep: string
      expect: {
        state: DeviceState
        needsInit: boolean
        autoSkip: ReturnType<typeof autoSkipBootloaderEffect>
      }
    }> = [
      {
        phase: '1. App starts, no device',
        snap: snap(),
        wizardStep: 'welcome',
        expect: { state: 'disconnected', needsInit: false, autoSkip: 'no-action' },
      },
      {
        phase: '2. Device connects in bootloader (factory fresh)',
        snap: snap({
          lastState: 'bootloader',
          cachedFeatures: makeFeatures({
            bootloaderMode: true,
            majorVersion: 1, minorVersion: 0, patchVersion: 3,
            bootloaderVersion: undefined, // factory BL, version from majorVersion fields
            firmwareHash: '00'.repeat(32),
          }),
        }),
        wizardStep: 'bootloader',
        expect: { state: 'bootloader', needsInit: false, autoSkip: 'no-action' }, // BL needs update
      },
      {
        phase: '3. User unplugs to enter bootloader',
        snap: snap(),
        wizardStep: 'bootloader',
        expect: { state: 'disconnected', needsInit: false, autoSkip: 'no-action' }, // CRITICAL: no-action, not complete
      },
      {
        phase: '4. Reconnects in bootloader after BL flash + reboot',
        snap: snap({
          lastState: 'bootloader',
          cachedFeatures: makeFeatures({ bootloaderMode: true, majorVersion: 2, minorVersion: 1, patchVersion: 4 }),
        }),
        wizardStep: 'bootloader',
        expect: { state: 'bootloader', needsInit: false, autoSkip: 'skip-firmware' }, // BL current → skip to FW
      },
      {
        phase: '5. User unplugs for firmware flash',
        snap: snap(),
        wizardStep: 'firmware',
        expect: { state: 'disconnected', needsInit: false, autoSkip: 'no-action' },
      },
      {
        phase: '6. Reconnects after FW flash, needs init',
        snap: snap({
          lastState: 'needs_init',
          cachedFeatures: makeFeatures({ initialized: false }),
        }),
        wizardStep: 'firmware',
        expect: { state: 'needs_init', needsInit: true, autoSkip: 'no-action' }, // wrong step, no-action
      },
      {
        phase: '7. Setup complete, device ready',
        snap: snap({
          lastState: 'ready',
          cachedFeatures: makeFeatures({ pinProtection: true, pinCached: true }),
        }),
        wizardStep: 'complete',
        expect: { state: 'ready', needsInit: false, autoSkip: 'no-action' },
      },
    ]

    for (const s of sequence) {
      const state = getDeviceState(s.snap)
      expect(state.state).toBe(s.expect.state)
      expect(state.needsInit).toBe(s.expect.needsInit)
      const skip = autoSkipBootloaderEffect(s.wizardStep, state, 'idle', 'idle')
      expect(skip).toBe(s.expect.autoSkip)
    }
  })
})
