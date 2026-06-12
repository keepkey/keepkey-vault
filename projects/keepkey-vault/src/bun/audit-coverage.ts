/**
 * Audit coverage classifier — PURE logic, no device/Pioneer/db imports.
 *
 * Keeps the honesty model unit-testable in isolation (importing src/bun/* that
 * pulls ./db would boot the electrobun server in tests). The audit engine
 * (audit-engine.ts) consumes these; tests import only this file.
 */
import type { AuditChainFinding, AuditCoverage, AuditMode, AuditPortfolioSnapshot } from '../shared/types'

/** Minimal chain shape the classifier needs — a subset of ChainDef. */
export interface AuditChainInput {
  chainId: string
  symbol: string
  chainFamily: string // 'utxo' | 'evm' | 'cosmos' | 'xrp' | 'solana' | ...
}

export interface AuditScanConfig {
  /** BTC account-level key scan range (sweep-engine accountRange). */
  accountRange: [number, number]
  /** BTC purpose/scriptType mismatch accounts to probe. */
  mismatchAccounts: number
  /** BTC standard-combo scan ceiling beyond the user's tracked accounts. */
  higherAccountScanLimit: number
  /** EVM index-discovery ceiling (m/44'/60'/0'/0/{0..N}). */
  evmMaxIndex: number
}

// Light = the common case (funded EVM index or a scriptType mismatch within
// account 0-2), a few seconds of device occupancy. Deep matches the manual
// SweepDialog reach (accounts up to 19) — ~30-60s of continuous derivation.
export const AUDIT_CONFIGS: Record<AuditMode, AuditScanConfig> = {
  light: { accountRange: [0, 2], mismatchAccounts: 1, higherAccountScanLimit: 5, evmMaxIndex: 3 },
  deep: { accountRange: [0, 9], mismatchAccounts: 2, higherAccountScanLimit: 19, evmMaxIndex: 9 },
}

function familyOf(chainFamily: string): 'utxo' | 'evm' | 'fixed' {
  if (chainFamily === 'utxo') return 'utxo'
  if (chainFamily === 'evm') return 'evm'
  return 'fixed'
}

/**
 * Classify each enabled chain three-state (+ checked-shallow). Cardinal rule:
 * a chain in degraded/stale is `unverified` — NEVER folded into "$0/clean".
 * A fixed-address chain (one address, no gap scan) that's empty is
 * `checked-shallow` because funds at another index are undiscoverable here.
 * UTXO/EVM chains get deep coverage (xpub gap scan / index discovery) so an
 * empty result is `empty-confirmed`.
 *
 * Matches faults by chainId (NOT symbol): symbols collide (ETH spans 4 chains),
 * so a symbol match would over-flag healthy chains, and a fault carrying an
 * unresolvable symbol would slip through. The snapshot's residual fault count
 * (faults the backend couldn't resolve to a chainId) is handled by the caller.
 */
export function classifyCoverage(
  chains: AuditChainInput[],
  snapshot: AuditPortfolioSnapshot,
  /** True when the EVM index discovery phase found funds on a NEW index. The
   *  coverage snapshot is captured BEFORE discovery, so an EVM chain that holds
   *  those funds would otherwise read 'empty-confirmed' — a false absent. With
   *  discovery present, EVM empties are downgraded to 'checked-shallow' (the
   *  index isn't chain-specific, so we can't pin which EVM chain holds it). */
  evmHasDiscovery = false,
): AuditChainFinding[] {
  const balByChain = new Map(snapshot.chains.map(c => [c.chainId, c.balanceUsd]))
  const degraded = new Set(snapshot.degradedChainIds)
  const stale = new Set(snapshot.staleChainIds)

  return chains.map(c => {
    const family = familyOf(c.chainFamily)
    const balanceUsd = balByChain.get(c.chainId) ?? 0
    let coverage: AuditCoverage
    if (degraded.has(c.chainId) || stale.has(c.chainId)) {
      coverage = 'unverified'
    } else if (balanceUsd > 0) {
      coverage = 'funded'
    } else if (family === 'fixed') {
      coverage = 'checked-shallow'
    } else if (family === 'evm' && evmHasDiscovery) {
      coverage = 'checked-shallow' // discovery found funds at an index the snapshot predates
    } else {
      coverage = 'empty-confirmed'
    }
    return { chainId: c.chainId, symbol: c.symbol, family, coverage, balanceUsd }
  })
}

export interface CoverageSummary {
  anyUnverified: boolean
  anyShallow: boolean
}

/**
 * `anyUnverified` also trips on the snapshot's residual fault count — a degraded
 * or stale chain the backend couldn't resolve to a known chainId still forbids a
 * false "all clear", even though it can't be shown as a specific row.
 */
export function summarizeCoverage(findings: AuditChainFinding[], snapshot: AuditPortfolioSnapshot): CoverageSummary {
  return {
    anyUnverified: findings.some(f => f.coverage === 'unverified') || (snapshot.unresolvedFaultCount || 0) > 0,
    anyShallow: findings.some(f => f.coverage === 'checked-shallow'),
  }
}
