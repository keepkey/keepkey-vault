import { describe, expect, test } from 'bun:test'
import { sendZcashByRoute, zcashPrivateSendRoute, zcashScanStatus, zcashShieldedAmounts } from '../src/shared/zcash-privacy'

describe('Zcash balance presentation', () => {
  test('preserves incoming value not yet scanned without counting immature notes twice', () => {
    const snapshot = { confirmed: 100_000_000, pending: 20_000_000, in_flight: 5_000_000, max_send: 79_990_000, max_deshield: 79_985_000 }
    expect(zcashShieldedAmounts(snapshot)).toEqual({ available: 80_000_000, pending: 25_000_000, total: 105_000_000 })
    expect(snapshot.max_send).toBe(79_990_000)
  })
  test('unknown and invalid balances never become a confirmed zero', () => {
    expect(zcashShieldedAmounts(null)).toBeNull()
    expect(zcashShieldedAmounts({ confirmed: 0, pending: 0 })).toEqual({ available: 0, pending: 0, total: 0 })
    expect(zcashShieldedAmounts({ confirmed: NaN, pending: 0 })).toBeNull()
    expect(zcashShieldedAmounts({ confirmed: 1, pending: 2 })).toBeNull()
    expect(zcashShieldedAmounts({ confirmed: 1, pending: 0, spendable_confirmed: -1 })).toBeNull()
  })
  test('uses the sidecar spendable amount rather than an optimistic total', () => {
    expect(zcashShieldedAmounts({ confirmed: 100, pending: 20, spendable_confirmed: 70 })?.available).toBe(70)
  })
  test('an old scanned height cannot hide a failed or unfinished scan', () => {
    const known = { height: 1234, balanceKnown: true, scanRequired: false, scanning: false }
    expect(zcashScanStatus(known)).toBe('last-scanned')
    expect(zcashScanStatus({ ...known, error: 'network offline' })).toBe('failed')
    expect(zcashScanStatus({ ...known, scanRequired: true })).toBe('needs-scan')
    expect(zcashScanStatus({ ...known, scanning: true })).toBe('scanning')
    expect(zcashScanStatus({ ...known, balanceKnown: false })).toBe('needs-scan')
    expect(zcashScanStatus({ ...known, height: null })).toBe('not-scanned')
  })
})

describe('Zcash private-balance send dispatch', () => {
  test('ordinary transparent recipients use the existing unshield builder directly', async () => {
    for (const recipient of ['t1recipient', ' t3recipient ']) {
      const called: string[] = []
      const tx = await sendZcashByRoute(recipient, undefined, {
        shielded: async () => { called.push('shielded'); return 'wrong' },
        unshield: async () => { called.push('unshield'); return 'direct-payout' },
        tex: async () => { called.push('tex'); return 'wrong' },
      })
      expect(tx).toBe('direct-payout'); expect(called).toEqual(['unshield'])
    }
  })
  test('keeps shielded and TEX payment flows distinct', () => {
    expect(zcashPrivateSendRoute('u1recipient', 'private memo')).toBe('shielded')
    expect(zcashPrivateSendRoute('tex1recipient')).toBe('tex')
    expect(() => zcashPrivateSendRoute('zs1sapling')).toThrow('unified address')
  })
  test('refuses a transparent memo before any builder or signer is called', async () => {
    let called = false
    const handler = async () => { called = true; return 'tx' }
    for (const recipient of ['t1recipient', 't3recipient', 'tex1recipient']) {
      try { await sendZcashByRoute(recipient, 'secret memo', { shielded: handler, unshield: handler, tex: handler }); throw new Error('unexpected send') }
      catch (error: any) { expect(error.message).toContain('Remove the memo') }
    }
    expect(called).toBe(false)
  })
})
