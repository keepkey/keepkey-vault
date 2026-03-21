/**
 * Wizard Messaging Tests
 *
 * Tests the OobSetupWizard rendering decisions for:
 *   1. Reboot messaging: bootloader (auto-reboot, wait) vs firmware (manual disconnect/reconnect)
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
 *   - step='bootloader' + rebootPhase='rebooting' → auto-reboot (wait)
 *   - step='firmware'    + rebootPhase='rebooting' → manual disconnect/reconnect
 *   - otherwise → none
 */
function getRebootMessageType(
  step: WizardStep,
  rebootPhase: RebootPhase,
): 'auto-reboot' | 'manual-disconnect' | 'none' {
  if (rebootPhase !== 'rebooting') return 'none'
  if (step === 'bootloader') return 'auto-reboot'
  if (step === 'firmware') return 'manual-disconnect'
  return 'none'
}

/**
 * Determines the specific sub-message based on elapsed time.
 * Mirrors the time-based escalation in both reboot blocks.
 *
 * Bootloader (auto-reboot):
 *   - always: "Device is rebooting..."
 *   - >=30s: + "Taking longer than expected?" fallback
 *
 * Firmware (manual disconnect):
 *   - <20s: "Your device says 'Firmware Update Complete.' Unplug..."
 *   - >=20s: "Still waiting — make sure you unplug and re-plug..."
 *   - >=30s: + manual reconnect steps
 */
function getRebootSubMessage(
  type: 'auto-reboot' | 'manual-disconnect' | 'none',
  rebootElapsedMs: number,
): { primary: string; showFallbackSteps: boolean } {
  if (type === 'none') return { primary: 'none', showFallbackSteps: false }

  if (type === 'auto-reboot') {
    return {
      primary: 'rebooting-wait',
      showFallbackSteps: rebootElapsedMs >= 30000,
    }
  }

  // manual-disconnect (firmware step)
  return {
    primary: rebootElapsedMs < 20000 ? 'disconnect-reconnect' : 'still-waiting',
    showFallbackSteps: rebootElapsedMs >= 30000,
  }
}

/**
 * Determines whether the seed phrase warning banner should be shown.
 * Mirrors OobSetupWizard.tsx line ~2005: only when step='init-progress' AND setupType='create'.
 */
function shouldShowSeedWarning(step: WizardStep, setupType: SetupType): boolean {
  return step === 'init-progress' && setupType === 'create'
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Reboot messaging: bootloader vs firmware (QA #1)', () => {
  describe('message type selection', () => {
    test('bootloader step + rebooting → auto-reboot (wait)', () => {
      expect(getRebootMessageType('bootloader', 'rebooting')).toBe('auto-reboot')
    })

    test('firmware step + rebooting → manual-disconnect', () => {
      expect(getRebootMessageType('firmware', 'rebooting')).toBe('manual-disconnect')
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

  describe('bootloader auto-reboot sub-messages', () => {
    test('shows "rebooting-wait" at 0s (no manual action needed)', () => {
      const msg = getRebootSubMessage('auto-reboot', 0)
      expect(msg.primary).toBe('rebooting-wait')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('still "rebooting-wait" at 15s', () => {
      const msg = getRebootSubMessage('auto-reboot', 15000)
      expect(msg.primary).toBe('rebooting-wait')
      expect(msg.showFallbackSteps).toBe(false)
    })

    test('shows fallback steps at 30s', () => {
      const msg = getRebootSubMessage('auto-reboot', 30000)
      expect(msg.primary).toBe('rebooting-wait')
      expect(msg.showFallbackSteps).toBe(true)
    })

    test('shows fallback steps at 60s', () => {
      const msg = getRebootSubMessage('auto-reboot', 60000)
      expect(msg.showFallbackSteps).toBe(true)
    })
  })

  describe('firmware manual-disconnect sub-messages', () => {
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

  describe('CRITICAL: bootloader and firmware messages must differ', () => {
    test('at 0s elapsed, bootloader shows wait vs firmware shows disconnect', () => {
      const bl = getRebootSubMessage('auto-reboot', 0)
      const fw = getRebootSubMessage('manual-disconnect', 0)
      expect(bl.primary).not.toBe(fw.primary)
      expect(bl.primary).toBe('rebooting-wait')
      expect(fw.primary).toBe('disconnect-reconnect')
    })

    test('at 25s elapsed, bootloader still shows wait vs firmware shows still-waiting', () => {
      const bl = getRebootSubMessage('auto-reboot', 25000)
      const fw = getRebootSubMessage('manual-disconnect', 25000)
      expect(bl.primary).not.toBe(fw.primary)
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
  test('bootloader flash → auto-reboot → firmware flash → manual disconnect', () => {
    // Phase 1: Bootloader just flashed, device auto-reboots
    const blReboot = getRebootMessageType('bootloader', 'rebooting')
    expect(blReboot).toBe('auto-reboot')
    const blMsg = getRebootSubMessage(blReboot, 5000)
    expect(blMsg.primary).toBe('rebooting-wait') // user waits, no action

    // Phase 2: Device reconnects, moves to firmware step, firmware flashes
    // Phase 3: Firmware flashed, device needs manual disconnect/reconnect
    const fwReboot = getRebootMessageType('firmware', 'rebooting')
    expect(fwReboot).toBe('manual-disconnect')
    const fwMsg = getRebootSubMessage(fwReboot, 5000)
    expect(fwMsg.primary).toBe('disconnect-reconnect') // user must unplug
  })
})
