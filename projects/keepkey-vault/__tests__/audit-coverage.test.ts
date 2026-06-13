/**
 * Audit coverage-classifier tests — the honesty model.
 *
 * Pins the cardinal rule the design-hardening review demanded: a chain whose
 * re-check failed (degraded/stale) is `unverified` and NEVER folded into a
 * false "$0/clean"; a single-address chain reached only at its primary address
 * is `checked-shallow` (funds at another index are undiscoverable). Both gate
 * the aggregate "all clear" claim. Faults are matched by chainId (symbols
 * collide across chains), and an unresolvable fault still forbids all-clear.
 *
 * Imports ONLY src/bun/audit-coverage (pure) — importing the engine or any
 * db-touching module would boot the electrobun server under bun test.
 *
 * Run: bun test __tests__/audit-coverage.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { classifyCoverage, summarizeCoverage, AUDIT_CONFIGS, type AuditChainInput } from '../src/bun/audit-coverage'
import type { AuditPortfolioSnapshot } from '../src/shared/types'

const CHAINS: AuditChainInput[] = [
  { chainId: 'bitcoin', symbol: 'BTC', chainFamily: 'utxo' },
  { chainId: 'ethereum', symbol: 'ETH', chainFamily: 'evm' },
  { chainId: 'base', symbol: 'ETH', chainFamily: 'evm' }, // same symbol as ethereum — collision
  { chainId: 'thorchain', symbol: 'RUNE', chainFamily: 'thorchain' },
  { chainId: 'cosmos', symbol: 'ATOM', chainFamily: 'cosmos' },
]

function snapshot(over: Partial<AuditPortfolioSnapshot> = {}): AuditPortfolioSnapshot {
  return { chains: [], degradedChainIds: [], staleChainIds: [], unresolvedFaultCount: 0, ...over }
}

describe('classifyCoverage — three-state honesty', () => {
  test('a balance >0 (and not degraded) is funded', () => {
    const out = classifyCoverage(CHAINS, snapshot({ chains: [{ chainId: 'ethereum', balanceUsd: 12.5 }] }))
    expect(out.find(c => c.chainId === 'ethereum')!.coverage).toBe('funded')
  })

  test('a degraded chain is UNVERIFIED even with a zero/absent balance — never folded into clean', () => {
    const out = classifyCoverage(CHAINS, snapshot({ degradedChainIds: ['ethereum'] }))
    expect(out.find(c => c.chainId === 'ethereum')!.coverage).toBe('unverified')
  })

  test('a stale chain is UNVERIFIED', () => {
    const out = classifyCoverage(CHAINS, snapshot({ staleChainIds: ['bitcoin'] }))
    expect(out.find(c => c.chainId === 'bitcoin')!.coverage).toBe('unverified')
  })

  test('faults are matched by chainId, NOT symbol — a degraded Base does not flag healthy Ethereum mainnet', () => {
    const out = classifyCoverage(CHAINS, snapshot({
      chains: [{ chainId: 'ethereum', balanceUsd: 50 }],
      degradedChainIds: ['base'],
    }))
    expect(out.find(c => c.chainId === 'base')!.coverage).toBe('unverified')
    expect(out.find(c => c.chainId === 'ethereum')!.coverage).toBe('funded')
  })

  test('an empty single-address (fixed-family) chain is checked-shallow, not empty-confirmed', () => {
    const out = classifyCoverage(CHAINS, snapshot())
    expect(out.find(c => c.chainId === 'thorchain')!.coverage).toBe('checked-shallow')
    expect(out.find(c => c.chainId === 'cosmos')!.coverage).toBe('checked-shallow')
  })

  test('an empty utxo/evm chain (deep-scanned) is empty-confirmed', () => {
    const out = classifyCoverage(CHAINS, snapshot())
    expect(out.find(c => c.chainId === 'bitcoin')!.coverage).toBe('empty-confirmed')
    expect(out.find(c => c.chainId === 'ethereum')!.coverage).toBe('empty-confirmed')
  })

  test('lazy mode: non-funded non-degraded chains are checked-shallow (page confirms later), never empty-confirmed', () => {
    const out = classifyCoverage(CHAINS, snapshot({ chains: [{ chainId: 'ethereum', balanceUsd: 5 }] }), false, true)
    expect(out.find(c => c.chainId === 'ethereum')!.coverage).toBe('funded')       // funded stays funded
    expect(out.find(c => c.chainId === 'bitcoin')!.coverage).toBe('checked-shallow') // utxo not yet deep-scanned
    expect(out.find(c => c.chainId === 'base')!.coverage).toBe('checked-shallow')   // evm not yet deep-scanned
    expect(out.every(c => c.coverage !== 'empty-confirmed')).toBe(true)
  })

  test('lazy mode still marks degraded as unverified (honesty preserved)', () => {
    const out = classifyCoverage(CHAINS, snapshot({ degradedChainIds: ['ethereum'] }), false, true)
    expect(out.find(c => c.chainId === 'ethereum')!.coverage).toBe('unverified')
  })

  test('an empty EVM chain is NOT "empty-confirmed" when index discovery found funds (snapshot predates discovery)', () => {
    const withDiscovery = classifyCoverage(CHAINS, snapshot(), true)
    expect(withDiscovery.find(c => c.chainId === 'ethereum')!.coverage).toBe('checked-shallow')
    expect(withDiscovery.find(c => c.chainId === 'base')!.coverage).toBe('checked-shallow')
    // UTXO is unaffected by EVM discovery.
    expect(withDiscovery.find(c => c.chainId === 'bitcoin')!.coverage).toBe('empty-confirmed')
  })

  test('degraded supersedes a present balance (suspect data is never shown as funded-clean)', () => {
    const out = classifyCoverage(CHAINS, snapshot({
      chains: [{ chainId: 'ethereum', balanceUsd: 50 }],
      degradedChainIds: ['ethereum'],
    }))
    expect(out.find(c => c.chainId === 'ethereum')!.coverage).toBe('unverified')
  })
})

describe('summarizeCoverage — gates the all-clear claim', () => {
  test('any unverified chain sets anyUnverified', () => {
    const snap = snapshot({ degradedChainIds: ['ethereum'] })
    expect(summarizeCoverage(classifyCoverage(CHAINS, snap), snap).anyUnverified).toBe(true)
  })

  test('any fixed-address chain present sets anyShallow (forbids a blanket all-clear)', () => {
    const snap = snapshot()
    expect(summarizeCoverage(classifyCoverage(CHAINS, snap), snap).anyShallow).toBe(true)
  })

  test('an unresolvable fault (no matching chainId) still forbids all-clear via anyUnverified', () => {
    const evmOnly: AuditChainInput[] = [{ chainId: 'ethereum', symbol: 'ETH', chainFamily: 'evm' }]
    const snap = snapshot({ chains: [{ chainId: 'ethereum', balanceUsd: 5 }], unresolvedFaultCount: 1 })
    const out = classifyCoverage(evmOnly, snap)
    // No chain row is unverified, but the residual fault count must still trip it.
    expect(out.every(c => c.coverage !== 'unverified')).toBe(true)
    expect(summarizeCoverage(out, snap).anyUnverified).toBe(true)
  })

  test('a portfolio of only funded/empty utxo+evm chains is clean (no shallow, no unverified)', () => {
    const evmOnly: AuditChainInput[] = [
      { chainId: 'bitcoin', symbol: 'BTC', chainFamily: 'utxo' },
      { chainId: 'ethereum', symbol: 'ETH', chainFamily: 'evm' },
    ]
    const snap = snapshot({ chains: [{ chainId: 'ethereum', balanceUsd: 5 }] })
    const s = summarizeCoverage(classifyCoverage(evmOnly, snap), snap)
    expect(s.anyUnverified).toBe(false)
    expect(s.anyShallow).toBe(false)
  })
})

describe('AUDIT_CONFIGS — light is bounded, deep is thorough', () => {
  test('light is strictly cheaper than deep on every device-occupancy axis', () => {
    const l = AUDIT_CONFIGS.light
    const d = AUDIT_CONFIGS.deep
    expect(l.accountRange[1]).toBeLessThan(d.accountRange[1])
    expect(l.evmMaxIndex).toBeLessThan(d.evmMaxIndex)
    expect(l.higherAccountScanLimit).toBeLessThanOrEqual(d.higherAccountScanLimit)
  })

  test('deep never scans past BTC account 19 (sweep-engine schema ceiling)', () => {
    expect(AUDIT_CONFIGS.deep.higherAccountScanLimit).toBeLessThanOrEqual(19)
  })

  test('deep sets explicit BTC gap-limit depths deeper than generatePathMatrix defaults (5/1/3)', () => {
    const d = AUDIT_CONFIGS.deep
    // These are forwarded to generatePathMatrix; without them the deep scan
    // silently fell back to the shallow defaults and missed funds past the gap.
    expect(d.gapLimitReceive!).toBeGreaterThan(5)
    expect(d.gapLimitChange!).toBeGreaterThan(1)
    expect(d.higherReceiveLimit!).toBeGreaterThan(3)
  })

  test('light inherits the default gap depths (fields unset) — stays cheap', () => {
    const l = AUDIT_CONFIGS.light
    expect(l.gapLimitReceive).toBeUndefined()
    expect(l.gapLimitChange).toBeUndefined()
    expect(l.higherReceiveLimit).toBeUndefined()
  })
})
