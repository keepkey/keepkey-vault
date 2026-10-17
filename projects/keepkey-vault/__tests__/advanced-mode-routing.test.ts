/**
 * A user must never get a dead reject for a transaction that AdvancedMode would
 * allow. They get an opt-in.
 *
 * SwapDialog decides which of those two happens by testing the raw error text:
 *
 *     if (/AdvancedMode/i.test(raw)) { setBlindSignCause('device');
 *                                      setPhase('blind-signing-required') }
 *
 * That opens the panel whose Enable button calls applyPolicy. Anything that
 * does NOT match falls through to the generic "Cancelled on device" error —
 * which is exactly the dead end this replaced (hdwallet flattens the device's
 * "Blind signing disabled by policy" to a bare "Action cancelled", matching
 * nothing).
 *
 * So the routing depends on a phrase inside a human-readable sentence. These
 * tests pin that contract, because rewording the copy is a normal, innocuous-
 * looking edit that would silently turn the prompt back into a reject.
 *
 * Run: bun test __tests__/advanced-mode-routing.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { evmAdvancedModeRequiredMessage, SOLANA_BLIND_SIGNING_REQUIRED } from '../src/shared/types'

/** Verbatim from SwapDialog.tsx — keep in sync with the branch it mirrors. */
const SWAP_DIALOG_ADVANCED_MODE_ROUTE = /AdvancedMode/i

describe('the EVM blind-sign message routes to the opt-in panel', () => {
  test('matches the SwapDialog route', () => {
    expect(SWAP_DIALOG_ADVANCED_MODE_ROUTE.test(evmAdvancedModeRequiredMessage('Ethereum'))).toBe(true)
  })

  test('matches for every chain name it can be built with', () => {
    for (const coin of ['Ethereum', 'Base', 'Arbitrum', 'Avalanche', 'Polygon', 'BNB Smart Chain']) {
      expect(SWAP_DIALOG_ADVANCED_MODE_ROUTE.test(evmAdvancedModeRequiredMessage(coin))).toBe(true)
    }
  })

  test('names the chain, so the panel is not generic', () => {
    expect(evmAdvancedModeRequiredMessage('Base')).toContain('Base')
  })

  test('does not tell the user to go and do it elsewhere', () => {
    // The panel offers a button. Copy that says "enable it on your KeepKey and
    // try again" sends the user to device settings for something the dialog is
    // about to do for them.
    const msg = evmAdvancedModeRequiredMessage('Ethereum').toLowerCase()
    expect(msg).not.toContain('try again')
    expect(msg).not.toContain('try the swap again')
  })

  test('says the setting does not survive a reboot', () => {
    // AdvancedMode is session state (firmware #373). Users who enable it once
    // and hit the same wall after a power cycle need to know why.
    expect(evmAdvancedModeRequiredMessage('Ethereum').toLowerCase()).toContain('reboot')
  })
})

describe('the routing predicate itself', () => {
  test('a bare device cancel does NOT match — this is the dead end being fixed', () => {
    // What hdwallet produces today: transport.ts constructs a fresh
    // core.ActionCancelled() and discards the firmware's
    // "Blind signing disabled by policy". Nothing downstream can tell a policy
    // refusal from the user pressing Cancel.
    expect(SWAP_DIALOG_ADVANCED_MODE_ROUTE.test('Action cancelled')).toBe(false)
  })

  test('a firmware-worded refusal DOES match', () => {
    // The route is content-based on purpose: it also catches refusals phrased
    // by firmware versions this code has never seen.
    expect(SWAP_DIALOG_ADVANCED_MODE_ROUTE.test('Blind signing requires AdvancedMode. Enable in device settings.')).toBe(true)
    expect(SWAP_DIALOG_ADVANCED_MODE_ROUTE.test('Enable AdvancedMode to blind-sign')).toBe(true)
    expect(SWAP_DIALOG_ADVANCED_MODE_ROUTE.test('AdvancedMode required for clearsign metadata')).toBe(true)
  })

  test('the Solana path keeps its own token and is unaffected', () => {
    // Solana routes on an exact sentinel, not on content, because it carries a
    // JSON outflow payload appended to the message.
    expect(SOLANA_BLIND_SIGNING_REQUIRED).toBe('SOLANA_BLIND_SIGNING_REQUIRED')
  })
})

describe('Solana schema fallback preserves the outflow check', () => {
  const swapSource = readFileSync(new URL('../src/bun/swap.ts', import.meta.url), 'utf8')

  test('both predicted and device-refused fallbacks use the shared safety helper', () => {
    const calls = swapSource.match(/throw await buildSolanaBlindSignRequirement\(\)/g) || []
    expect(calls).toHaveLength(2)
  })

  test('the shared helper runs the outflow simulation before building the sentinel', () => {
    const helperStart = swapSource.indexOf('const buildSolanaBlindSignRequirement')
    const helperEnd = swapSource.indexOf('\n  if (\n    needsOpaqueSolanaFallback', helperStart)
    const helper = swapSource.slice(helperStart, helperEnd)
    expect(helperStart).toBeGreaterThan(-1)
    expect(helperEnd).toBeGreaterThan(helperStart)
    expect(helper).toContain('checkSolanaOutflow')
    expect(helper).toContain('SOLANA_BLIND_SIGNING_REQUIRED')
    expect(helper.indexOf('checkSolanaOutflow')).toBeLessThan(helper.indexOf('SOLANA_BLIND_SIGNING_REQUIRED'))
  })
})

describe('ERC-20 approvals are checked before the device sees them', () => {
  // An approve for a token the firmware does not know, with no certified
  // entry, is refused on the device as a bare "Action cancelled". Each approve
  // must pass the same AdvancedMode prediction as the swap, so it reaches the
  // opt-in panel instead.
  const swapSource = readFileSync(new URL('../src/bun/swap.ts', import.meta.url), 'utf8')

  test('every approve signing site runs the gate first', () => {
    const parts = swapSource.split("stage('approve-signing')")
    expect(parts.length - 1).toBe(2)
    for (const before of parts.slice(0, -1)) {
      expect(before.slice(-300)).toMatch(/assert(EvmSignable|Signable)\((result\.)?approveTx\)/)
    }
  })

  test('the gate throws the message the panel routes on', () => {
    const gate = swapSource.slice(swapSource.indexOf('const assertEvmSignable'))
    expect(gate.slice(0, 1200)).toContain('throw new Error(evmAdvancedModeRequiredMessage(')
  })
})

describe('the approval card turns Advanced Mode on from its main button', () => {
  // Owner, 2026-10-16: the Enable control sat mid-card and was easy to miss,
  // while the main button read "Enable Advanced Mode to approve" but was locked.
  const card = readFileSync(new URL('../src/mainview/components/device/SigningApproval.tsx', import.meta.url), 'utf8')

  test('the main button enables Advanced Mode while it is the blocker', () => {
    expect(card).toContain('onClick={advancedModeBlocked ? handleEnableAdvancedMode : submitApproval}')
    expect(card).not.toContain('Enable Advanced Mode to approve')
  })

  test('one click, no client timeout: the device confirm and PIN re-entry can take a while', () => {
    const handler = card.slice(card.indexOf('const handleEnableAdvancedMode'), card.indexOf('const cardRef'))
    expect(handler).toContain(`rpcRequest("applyPolicy", { policyName: "AdvancedMode", enabled: true }, 0)`)
    expect(handler).not.toContain('setShowAdvancedConfirm(true)')
  })
})
