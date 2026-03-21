/**
 * Wizard Messaging Tests
 *
 * Tests the OobSetupWizard rendering decisions for:
 *   1. Reboot messaging: bootloader vs firmware have DIFFERENT device behavior
 *      - Bootloader flash: OLD bootloader doesn't auto-reboot → device says
 *        "Please disconnect and reconnect" → user must unplug
 *      - Firmware flash: NEW bootloader calls board_reset() → device says
 *        "Your device will now restart" → auto-reboots
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
type RebootPhase = 'idle' | 'rebooting'
type SetupType = 'create' | 'recover' | null

/**
 * Determines which reboot message category to show.
 * Mirrors the conditional rendering in OobSetupWizard.tsx:
 *   - step='bootloader' + rebootPhase='rebooting' → manual-disconnect
 *     (OLD bootloader doesn't auto-reboot, device says "disconnect and reconnect")
 *   - step='firmware'    + rebootPhase='rebooting' → auto-reboot
 *     (NEW bootloader calls board_reset(), device says "will now restart")
 *   - otherwise → none
 */
function getRebootMessageType(
  step: WizardStep,
  rebootPhase: RebootPhase,
): 'manual-disconnect' | 'auto-reboot' | 'none' {
  if (rebootPhase !== 'rebooting') return 'none'
  if (step === 'bootloader') return 'manual-disconnect'
  if (step === 'firmware') return 'auto-reboot'
  return 'none'
}

/**
 * Determines the specific sub-message based on elapsed time.
 * Mirrors the time-based escalation in both reboot blocks.
 *
 * Bootloader (manual disconnect — OLD bootloader, no auto-reboot):
 *   - <20s: "Please disconnect and reconnect" — immediate action needed
 *   - >=20s: "Still waiting — make sure you unplug and re-plug"
 *   - >=30s: + manual reconnect steps
 *
 * Firmware (auto-reboot — NEW bootloader, board_reset()):
 *   - <20s: "Your device says 'Firmware Update Complete.' Unplug..."
 *   - >=20s: "Still waiting — make sure you unplug and re-plug..."
 *   - >=30s: + manual reconnect steps
 */
function getRebootSubMessage(
  type: 'manual-disconnect' | 'auto-reboot' | 'none',
  rebootElapsedMs: number,
): { primary: string; showFallbackSteps: boolean } {
  if (type === 'none') return { primary: 'none', showFallbackSteps: false }

  if (type === 'manual-disconnect') {
    // Bootloader step: user must unplug NOW
    return {
      primary: rebootElapsedMs < 20000 ? 'disconnect-reconnect' : 'still-waiting',
      showFallbackSteps: rebootElapsedMs >= 30000,
    }
  }

  // auto-reboot (firmware step): device usually auto-reboots, but may need manual action
  return {
    primary: rebootElapsedMs < 20000 ? 'disconnect-reconnect' : 'still-waiting',
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

describe('Reboot messaging: bootloader (manual) vs firmware (auto-reboot) (QA #1)', () => {
  describe('message type selection', () => {
    test('bootloader step + rebooting → manual-disconnect (OLD bootloader, no auto-reboot)', () => {
      expect(getRebootMessageType('bootloader', 'rebooting')).toBe('manual-disconnect')
    })

    test('firmware step + rebooting → auto-reboot (NEW bootloader, board_reset)', () => {
      expect(getRebootMessageType('firmware', 'rebooting')).toBe('auto-reboot')
    })

    test('bootloader step + idle → none', () => {
      expect(getRebootMessageType('bootloader', 'idle')).toBe('none')
    })

    test('firmware step + idle → none', () => {
      expect(getRebootMessageType('firmware', 'idle')).toBe('none')
    })

    test('other steps + rebooting → none', () => {
      for (const step of ['init-choose', 'init-progress', 'complete', 'welcome'] as WizardStep[]) {
        expect(getRebootMessageType(step, 'rebooting')).toBe('none')
      }
    })
  })

  describe('CRITICAL: bootloader and firmware message TYPES must differ', () => {
    test('bootloader = manual-disconnect, firmware = auto-reboot', () => {
      const bl = getRebootMessageType('bootloader', 'rebooting')
      const fw = getRebootMessageType('firmware', 'rebooting')
      expect(bl).toBe('manual-disconnect')
      expect(fw).toBe('auto-reboot')
      expect(bl).not.toBe(fw)
    })
  })

  describe('bootloader disconnect sub-messages (user must unplug)', () => {
    test('shows "disconnect-reconnect" at 0s', () => {
      const msg = getRebootSubMessage('manual-disconnect', 0)
      expect(msg.primary).toBe('disconnect-reconnect')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('shows "disconnect-reconnect" at 19s', () => {
      const msg = getRebootSubMessage('manual-disconnect', 19999)
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

  describe('firmware auto-reboot sub-messages', () => {
    test('shows "disconnect-reconnect" at 0s', () => {
      const msg = getRebootSubMessage('auto-reboot', 0)
      expect(msg.primary).toBe('disconnect-reconnect')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('escalates to "still-waiting" at 20s', () => {
      const msg = getRebootSubMessage('auto-reboot', 20000)
      expect(msg.primary).toBe('still-waiting')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('shows fallback steps at 30s', () => {
      const msg = getRebootSubMessage('auto-reboot', 30000)
      expect(msg.primary).toBe('still-waiting')
      expect(msg.showFallbackSteps).toBe(true)
    })
  })
})

describe('Seed phrase warning (QA #2)', () => {
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
    const blReboot = getRebootMessageType('bootloader', 'rebooting')
    expect(blReboot).toBe('manual-disconnect')
    const blMsg = getRebootSubMessage(blReboot, 5000)
    expect(blMsg.primary).toBe('disconnect-reconnect') // user must unplug

    // Phase 2: Device reconnects after manual replug, moves to firmware step
    // Firmware flashes via NEW bootloader which calls board_reset()
    // Device screen: "Firmware Update Complete — Your device will now restart"
    const fwReboot = getRebootMessageType('firmware', 'rebooting')
    expect(fwReboot).toBe('auto-reboot')
    const fwMsg = getRebootSubMessage(fwReboot, 5000)
    expect(fwMsg.primary).toBe('disconnect-reconnect') // fallback if auto-reboot doesn't fire
  })
})
