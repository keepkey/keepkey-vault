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
