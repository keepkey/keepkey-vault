/**
 * Wizard Messaging Tests
 *
 * Tests the OobSetupWizard rendering decisions for:
 *   1. Reboot messaging: bootloader vs firmware have DIFFERENT device behavior
 *      - Bootloader flash: OLD bootloader doesn't auto-reboot → device says
 *        "Please disconnect and reconnect" → yellow box, user must unplug
 *      - Firmware flash: NEW bootloader calls board_reset() → device says
 *        "Your device will now restart" → blue spinner, auto-reboots
 *   2. Seed phrase warning: must appear for 'create', must NOT appear for 'recover'
 *   3. Reboot elapsed-time escalation: different messages at 0s, 20s, 30s thresholds
 *
 * These mirror the conditional logic in OobSetupWizard.tsx without importing React.
 * When the wizard changes, update these mirrors and verify behavior matches.
 *
 * Run: bun test __tests__/wizard-messaging.test.ts
 */
import { describe, test, expect } from 'bun:test'

// ── Mirror of wizard rendering decisions ─────────────────────────────

type WizardStep = 'intro' | 'welcome' | 'bootloader' | 'firmware' | 'init-choose' | 'init-progress' | 'init-label' | 'verify-seed' | 'security-tips' | 'complete'
type RebootPhase = 'idle' | 'bootloader-rebooting' | 'firmware-rebooting'
type SetupType = 'create' | 'recover' | null

/**
 * Determines which reboot message category to show.
 * Mirrors the conditional rendering in OobSetupWizard.tsx:
 *   - step='bootloader' → 'bootloader-rebooting' → manual-disconnect (yellow box)
 *   - step='firmware'    → 'firmware-rebooting'   → auto-reboot (blue spinner)
 *   - otherwise → none
 */
function getRebootMessageType(
  step: WizardStep,
  rebootPhase: RebootPhase,
): 'manual-disconnect' | 'auto-reboot' | 'none' {
  if (rebootPhase === 'idle') return 'none'
  if (rebootPhase === 'bootloader-rebooting' && step === 'bootloader') return 'manual-disconnect'
  if (rebootPhase === 'firmware-rebooting' && step === 'firmware') return 'auto-reboot'
  return 'none'
}

/**
 * Determines the specific sub-message based on elapsed time.
 *
 * Bootloader (manual disconnect — OLD bootloader, no auto-reboot):
 *   - <20s: "Please disconnect and reconnect" — immediate action needed
 *   - >=20s: "Still waiting — make sure you unplug and re-plug"
 *   - >=30s: + manual reconnect steps
 *
 * Firmware (auto-reboot — NEW bootloader, board_reset()):
 *   - <30s: "Your device is restarting..." — blue spinner, no action needed
 *   - >=30s: + fallback unplug steps (in case auto-reboot didn't fire)
 */
function getRebootSubMessage(
  type: 'manual-disconnect' | 'auto-reboot' | 'none',
  rebootElapsedMs: number,
): { primary: string; showFallbackSteps: boolean } {
  if (type === 'none') return { primary: 'none', showFallbackSteps: false }

  if (type === 'manual-disconnect') {
    return {
      primary: rebootElapsedMs < 20000 ? 'disconnect-reconnect' : 'still-waiting',
      showFallbackSteps: rebootElapsedMs >= 30000,
    }
  }

  // auto-reboot (firmware step): blue spinner, fallback steps only at 30s+
  return {
    primary: 'restarting',
    showFallbackSteps: rebootElapsedMs >= 30000,
  }
}

/**
 * Determines whether the seed phrase warning banner should be shown.
 * Mirrors OobSetupWizard.tsx: only when step='init-progress' AND setupType='create'.
 */
function shouldShowSeedWarning(step: WizardStep, setupType: SetupType): boolean {
  return step === 'init-progress' && setupType === 'create'
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Reboot messaging: bootloader (manual) vs firmware (auto-reboot)', () => {
  describe('message type selection', () => {
    test('bootloader step + bootloader-rebooting → manual-disconnect', () => {
      expect(getRebootMessageType('bootloader', 'bootloader-rebooting')).toBe('manual-disconnect')
    })

    test('firmware step + firmware-rebooting → auto-reboot', () => {
      expect(getRebootMessageType('firmware', 'firmware-rebooting')).toBe('auto-reboot')
    })

    test('bootloader step + idle → none', () => {
      expect(getRebootMessageType('bootloader', 'idle')).toBe('none')
    })

    test('firmware step + idle → none', () => {
      expect(getRebootMessageType('firmware', 'idle')).toBe('none')
    })

    test('mismatched phase/step → none', () => {
      expect(getRebootMessageType('bootloader', 'firmware-rebooting')).toBe('none')
      expect(getRebootMessageType('firmware', 'bootloader-rebooting')).toBe('none')
    })

    test('other steps → none regardless of phase', () => {
      for (const step of ['init-choose', 'init-progress', 'complete', 'welcome'] as WizardStep[]) {
        expect(getRebootMessageType(step, 'bootloader-rebooting')).toBe('none')
        expect(getRebootMessageType(step, 'firmware-rebooting')).toBe('none')
      }
    })
  })

  describe('CRITICAL: bootloader and firmware produce DIFFERENT outputs', () => {
    test('bootloader = disconnect-reconnect, firmware = restarting', () => {
      const bl = getRebootSubMessage('manual-disconnect', 0)
      const fw = getRebootSubMessage('auto-reboot', 0)
      expect(bl.primary).toBe('disconnect-reconnect')
      expect(fw.primary).toBe('restarting')
      expect(bl.primary).not.toBe(fw.primary)
    })

    test('at 25s: bootloader = still-waiting, firmware = restarting', () => {
      const bl = getRebootSubMessage('manual-disconnect', 25000)
      const fw = getRebootSubMessage('auto-reboot', 25000)
      expect(bl.primary).toBe('still-waiting')
      expect(fw.primary).toBe('restarting')
      expect(bl.primary).not.toBe(fw.primary)
    })
  })

  describe('bootloader sub-messages (user must unplug)', () => {
    test('shows "disconnect-reconnect" at 0s', () => {
      const msg = getRebootSubMessage('manual-disconnect', 0)
      expect(msg.primary).toBe('disconnect-reconnect')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('escalates to "still-waiting" at 20s', () => {
      const msg = getRebootSubMessage('manual-disconnect', 20000)
      expect(msg.primary).toBe('still-waiting')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('shows fallback steps at 30s', () => {
      const msg = getRebootSubMessage('manual-disconnect', 30000)
      expect(msg.primary).toBe('still-waiting')
      expect(msg.showFallbackSteps).toBe(true)
    })
  })

  describe('firmware sub-messages (auto-reboot, spinner)', () => {
    test('shows "restarting" at 0s (no user action needed)', () => {
      const msg = getRebootSubMessage('auto-reboot', 0)
      expect(msg.primary).toBe('restarting')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('still "restarting" at 25s (device may be slow)', () => {
      const msg = getRebootSubMessage('auto-reboot', 25000)
      expect(msg.primary).toBe('restarting')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('shows fallback steps at 30s (auto-reboot may have failed)', () => {
      const msg = getRebootSubMessage('auto-reboot', 30000)
      expect(msg.primary).toBe('restarting')
      expect(msg.showFallbackSteps).toBe(true)
    })
  })
})

describe('Seed phrase warning', () => {
  test('shows warning during init-progress + create', () => {
    expect(shouldShowSeedWarning('init-progress', 'create')).toBe(true)
  })

  test('does NOT show warning during init-progress + recover', () => {
    expect(shouldShowSeedWarning('init-progress', 'recover')).toBe(false)
  })

  test('does NOT show warning during init-progress + null', () => {
    expect(shouldShowSeedWarning('init-progress', null)).toBe(false)
  })

  test('does NOT show warning on other steps even with create', () => {
    for (const step of ['welcome', 'bootloader', 'firmware', 'init-choose', 'init-label', 'verify-seed', 'complete'] as WizardStep[]) {
      expect(shouldShowSeedWarning(step, 'create')).toBe(false)
    }
  })
})

describe('Full OOB reboot sequence', () => {
  test('bootloader flash → manual disconnect, then firmware flash → auto-reboot', () => {
    // Phase 1: Bootloader just flashed — OLD bootloader doesn't auto-reboot
    // Device screen: "FIRMWARE UPDATE COMPLETE — Please disconnect and reconnect"
    const blType = getRebootMessageType('bootloader', 'bootloader-rebooting')
    expect(blType).toBe('manual-disconnect')
    const blMsg = getRebootSubMessage(blType, 5000)
    expect(blMsg.primary).toBe('disconnect-reconnect') // user must unplug

    // Phase 2: Device reconnects after manual replug, moves to firmware step
    // Firmware flashes via NEW bootloader which calls board_reset()
    // Device screen: "Firmware Update Complete — Your device will now restart"
    const fwType = getRebootMessageType('firmware', 'firmware-rebooting')
    expect(fwType).toBe('auto-reboot')
    const fwMsg = getRebootSubMessage(fwType, 5000)
    expect(fwMsg.primary).toBe('restarting') // device auto-reboots, user waits
  })
})
