/**
 * AuditDialog — the "where's my money" wizard.
 *
 * Diagnoses then helps recover funds a user expects but doesn't see:
 *   - BTC on non-standard paths / higher accounts (sweep-engine)
 *   - EVM funds on higher address indices (auto-discover, already added)
 *   - chains that couldn't be verified (degraded/stale) — surfaced honestly
 *
 * Honest by construction: a chain whose re-check failed is shown as
 * "unverified", never folded into a false "all clear". Single-address chains
 * are flagged "checked at primary address only". Mirrors SweepDialog's
 * poll-driven shape (the backend owns the AuditReport; we poll auditGetStatus).
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button, VStack, Spinner } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { AuditReport, AuditPortfolioSnapshot, AuditMode, AuditChainFinding } from "../../shared/types"

function formatSats(sats: number): string {
  if (sats >= 100_000_000) return (sats / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' BTC'
  return sats.toLocaleString() + ' sats'
}

const PHASES: { key: AuditReport['phase']; label: string }[] = [
  { key: 'identity', label: 'Verifying device' },
  { key: 'btc', label: 'Scanning Bitcoin paths' },
  { key: 'evm', label: 'Discovering EVM addresses' },
  { key: 'coverage', label: 'Reviewing chains' },
]

const COVERAGE_STYLE: Record<AuditChainFinding['coverage'], { label: string; color: string }> = {
  'funded': { label: 'funded', color: 'var(--teal)' },
  'empty-confirmed': { label: 'empty', color: 'kk.textMuted' },
  'checked-shallow': { label: 'primary address only', color: 'kk.gold' },
  'unverified': { label: 'could not verify', color: 'var(--rose)' },
}

interface AuditDialogProps {
  onClose: () => void
  snapshot: AuditPortfolioSnapshot
  isHidden: boolean
  /** Called after a recovery action so the dashboard refreshes balances. */
  onRecovered?: () => void
}

export function AuditDialog({ onClose, snapshot, isHidden, onRecovered }: AuditDialogProps) {
  const [report, setReport] = useState<AuditReport | null>(null)
  const [mode, setMode] = useState<AuditMode>('light')
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [sweepPreview, setSweepPreview] = useState<any>(null)
  const [acting, setActing] = useState<null | 'sweep' | 'track'>(null)
  const [actionResult, setActionResult] = useState<string | null>(null)

  const auditIdRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollingRef = useRef(false)
  const unmountedRef = useRef(false)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    pollingRef.current = false
  }, [])

  const start = useCallback(async (m: AuditMode) => {
    stopPoll()
    setReport(null); setError(null); setSweepPreview(null); setActionResult(null); setStale(false)
    setMode(m)
    try {
      const { auditId } = await rpcRequest<{ auditId: string }>('auditStart', { mode: m, snapshot: snapshotRef.current }, 60000)
      // The await above can resolve after unmount, or after a newer start() —
      // don't install an orphan interval in either case.
      if (unmountedRef.current) return
      auditIdRef.current = auditId
      pollRef.current = setInterval(async () => {
        if (pollingRef.current) return
        pollingRef.current = true
        try {
          const r = await rpcRequest<AuditReport>('auditGetStatus', { auditId })
          // Drop a late response from a superseded run (re-run / deep scan).
          if (auditId !== auditIdRef.current || unmountedRef.current) return
          setReport(r)
          if (r.status !== 'running') stopPoll()
        } catch { /* transient — keep polling */ }
        finally { pollingRef.current = false }
      }, 1500)
    } catch (e: any) {
      if (!unmountedRef.current) setError(e.message)
    }
  }, [stopPoll])

  // Start on mount; tear down poll on unmount.
  useEffect(() => { start('light') }, [start])
  useEffect(() => () => { unmountedRef.current = true; stopPoll() }, [stopPoll])
  // A seed purge underneath the wizard invalidates its findings.
  useEffect(() => onRpcMessage('wallet-data-purged', () => { setStale(true); stopPoll() }), [stopPoll])

  const busy = acting !== null
  const handleClose = useCallback(() => {
    if (busy) return
    if (auditIdRef.current) rpcRequest('auditDismiss', { auditId: auditIdRef.current }).catch(() => {})
    onClose()
  }, [busy, onClose])

  const higher = report?.btc.findings.filter(f => f.category === 'higher-account') || []
  const nonStandard = report?.btc.findings.filter(f => f.category !== 'higher-account') || []
  const higherSats = higher.reduce((s, f) => s + f.balanceSats, 0)
  const nonStandardSats = nonStandard.reduce((s, f) => s + f.balanceSats, 0)
  const evmCount = report?.evm.discoveredIndices.length || 0
  const foundSomething = (report?.btc.findings.length || 0) > 0 || evmCount > 0

  const trackAccounts = useCallback(async () => {
    if (!report) return
    setActing('track'); setError(null)
    try {
      let set = await rpcRequest<any>('getBtcAccounts')
      let cur = set.accounts.length ? Math.max(...set.accounts.map((a: any) => a.accountIndex)) : 0
      while (cur < report.btc.higherAccountMax) {
        set = await rpcRequest<any>('addBtcAccount', undefined, 60000)
        cur = set.accounts.length ? Math.max(...set.accounts.map((a: any) => a.accountIndex)) : cur + 1
      }
      setActionResult(isHidden
        ? `Tracking accounts up to #${cur} for this session.`
        : `Now tracking accounts up to #${cur}. Balances appear after the next sync.`)
      onRecovered?.()
    } catch (e: any) {
      setError(`Failed to add account: ${e.message}`)
    } finally {
      setActing(null)
    }
  }, [report, isHidden, onRecovered])

  const sweepDryRun = useCallback(async () => {
    if (!auditIdRef.current) return
    setActing('sweep'); setError(null)
    try {
      const res = await rpcRequest<any>('auditSweep', { auditId: auditIdRef.current, dryRun: true }, 600000)
      setSweepPreview(res)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActing(null)
    }
  }, [])

  const sweepConfirm = useCallback(async () => {
    if (!auditIdRef.current) return
    setActing('sweep'); setError(null)
    try {
      const res = await rpcRequest<any>('auditSweep', { auditId: auditIdRef.current, dryRun: false }, 600000)
      setActionResult(`Swept ${formatSats(res.outputSats)} to your main address — txid ${String(res.txid).slice(0, 16)}…`)
      setSweepPreview(null)
      onRecovered?.()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActing(null)
    }
  }, [onRecovered])

  const running = !report || report.status === 'running'
  const activePhaseIdx = report ? PHASES.findIndex(p => p.key === report.phase) : 0

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog || 1500} display="flex" alignItems="center" justifyContent="center">
      <Box position="absolute" inset="0" bg="blackAlpha.700" onClick={handleClose} />

      <Box
        position="relative" w="460px" maxH="82vh" overflow="auto"
        bg="kk.cardBg" border="1px solid" borderColor="kk.border"
        borderRadius="2xl" p="6" boxShadow="0 8px 40px rgba(0,0,0,0.5)"
      >
        {/* Header */}
        <Flex align="center" justify="space-between" mb="4">
          <Flex align="center" gap="2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <Text fontSize="lg" fontWeight="600" color="var(--teal)">Audit balances</Text>
          </Flex>
          <Box as="button" onClick={handleClose} color="kk.textMuted" _hover={{ color: "white" }} p="1" opacity={busy ? 0.3 : 1} cursor={busy ? "not-allowed" : "pointer"}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </Box>
        </Flex>

        {/* Stale (purged mid-run) */}
        {stale && (
          <VStack gap="3" align="stretch" mb="2">
            <Text fontSize="sm" color="kk.gold">The wallet changed while auditing — these results are no longer reliable.</Text>
            <Button size="sm" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} onClick={() => start('light')}>Re-run audit</Button>
          </VStack>
        )}

        {/* Error */}
        {!stale && error && (
          <Box mb="3" px="3" py="2" bg="rgba(255,99,99,0.08)" border="1px solid" borderColor="rgba(255,99,99,0.3)" borderRadius="md">
            <Text fontSize="xs" color="red.400">{error}</Text>
          </Box>
        )}

        {/* Running — phase checklist + progress */}
        {!stale && running && (
          <VStack gap="3" align="stretch">
            <Text fontSize="xs" color="kk.textMuted">
              {isHidden ? 'Auditing your hidden wallet — nothing is written to disk.' : 'Checking for funds on alternate paths, higher accounts, and chains that didn’t report.'}
            </Text>
            <VStack gap="2" align="stretch">
              {PHASES.map((p, i) => {
                const done = report ? i < activePhaseIdx || report.status !== 'running' : false
                const active = report ? i === activePhaseIdx && report.status === 'running' : i === 0
                return (
                  <Flex key={p.key} align="center" gap="2">
                    <Box w="16px" h="16px" display="flex" alignItems="center" justifyContent="center">
                      {done ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                      ) : active ? (
                        <Spinner size="xs" color="var(--teal)" />
                      ) : (
                        <Box w="6px" h="6px" borderRadius="full" bg="kk.border" />
                      )}
                    </Box>
                    <Text fontSize="sm" color={active ? "kk.textSecondary" : done ? "kk.textMuted" : "kk.textMuted"}>
                      {active && report ? report.progress.label : p.label}
                    </Text>
                  </Flex>
                )
              })}
            </VStack>
            {report && report.progress.total > 1 && (
              <Box bg="whiteAlpha.100" borderRadius="full" h="5px" overflow="hidden">
                <Box bg="var(--teal)" h="100%" borderRadius="full" transition="width 0.3s"
                  w={`${Math.round((report.progress.current / Math.max(report.progress.total, 1)) * 100)}%`} />
              </Box>
            )}
            {mode === 'deep' && <Text fontSize="10px" color="kk.textMuted" textAlign="center">Deep scan — this can take up to a minute; your portfolio won’t refresh until it finishes.</Text>}
          </VStack>
        )}

        {/* Summary */}
        {!stale && report && report.status !== 'running' && (
          <VStack gap="4" align="stretch">
            {report.status === 'aborted' && (
              <Text fontSize="sm" color="kk.gold">Audit stopped early ({report.error || 'device interrupted'}). Results may be incomplete — re-run to finish.</Text>
            )}

            {/* Identity mismatch */}
            {report.identityMismatch && (
              <Box bg="rgba(255,99,99,0.08)" border="1px solid" borderColor="rgba(255,99,99,0.3)" borderRadius="lg" p="3">
                <Text fontSize="sm" fontWeight="600" color="red.400">Device identity changed</Text>
                <Text fontSize="xs" color="kk.textMuted" mt="1">The connected device differs from the tracked wallet. Refresh your balances before trusting totals.</Text>
              </Box>
            )}

            {/* Headline — the unqualified green "all clear" is gated on BOTH
                anyUnverified (degraded/stale) AND anyShallow (single-address
                chains we could only check at one index), so the wizard never
                over-claims comprehensiveness. */}
            {foundSomething ? (
              <Text fontSize="sm" fontWeight="600" color="var(--teal)">Found funds you can recover</Text>
            ) : report.anyUnverified ? (
              <Text fontSize="sm" fontWeight="600" color="kk.gold">Some chains couldn’t be verified — see below</Text>
            ) : report.anyShallow ? (
              <Flex align="center" gap="2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                <Text fontSize="sm" fontWeight="600" color="var(--teal)">No missing funds on the paths we could fully scan</Text>
              </Flex>
            ) : (
              <Flex align="center" gap="2">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                <Text fontSize="sm" fontWeight="600" color="var(--teal)">No missing funds found</Text>
              </Flex>
            )}

            {/* Higher BTC accounts */}
            {higher.length > 0 && (
              <Box bg="rgba(74,222,128,0.08)" border="1px solid" borderColor="rgba(74,222,128,0.2)" borderRadius="lg" p="3">
                <Text fontSize="sm" fontWeight="600" color="var(--teal)">{formatSats(higherSats)} on un-tracked Bitcoin accounts</Text>
                <Text fontSize="xs" color="kk.textMuted" mt="1" mb="2">Standard paths on accounts you haven’t added yet (up to #{report.btc.higherAccountMax}).{isHidden ? ' Session-scoped in a hidden wallet.' : ''}</Text>
                <Button size="sm" w="100%" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} loading={acting === 'track'} onClick={trackAccounts}>
                  Track account{report.btc.higherAccountMax > 1 ? 's' : ''} (up to #{report.btc.higherAccountMax})
                </Button>
              </Box>
            )}

            {/* Non-standard BTC paths → sweep */}
            {nonStandard.length > 0 && (
              <Box bg="rgba(233,196,106,0.08)" border="1px solid" borderColor="rgba(233,196,106,0.2)" borderRadius="lg" p="3">
                <Text fontSize="sm" fontWeight="600" color="kk.gold">{formatSats(nonStandardSats)} on non-standard paths</Text>
                <Text fontSize="xs" color="kk.textMuted" mt="1" mb="2">Mismatched script types or account-level keys — swept to your main Bitcoin address.</Text>
                {sweepPreview ? (
                  <Box bg="whiteAlpha.50" borderRadius="md" p="3" mb="2">
                    <VStack gap="1" align="stretch">
                      <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Inputs</Text><Text fontSize="xs">{sweepPreview.inputCount}</Text></Flex>
                      <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Fee</Text><Text fontSize="xs">{formatSats(sweepPreview.fee)}</Text></Flex>
                      <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">You receive</Text><Text fontSize="xs" fontWeight="600" color="kk.gold">{formatSats(sweepPreview.outputSats)}</Text></Flex>
                    </VStack>
                  </Box>
                ) : null}
                {sweepPreview ? (
                  <Flex gap="2">
                    <Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" onClick={() => setSweepPreview(null)}>Back</Button>
                    <Button flex="1" size="sm" bg="kk.gold" color="black" fontWeight="600" _hover={{ bg: "kk.goldHover" }} loading={acting === 'sweep'} onClick={sweepConfirm}>Confirm & broadcast</Button>
                  </Flex>
                ) : (
                  <Button size="sm" w="100%" bg="kk.gold" color="black" fontWeight="600" _hover={{ bg: "kk.goldHover" }} loading={acting === 'sweep'} onClick={sweepDryRun}>Sweep to main address</Button>
                )}
              </Box>
            )}

            {/* EVM discovery (already added) */}
            {evmCount > 0 && (
              <Box bg="whiteAlpha.50" borderRadius="lg" p="3">
                <Text fontSize="sm" fontWeight="600" color="var(--teal)">{evmCount} EVM address{evmCount > 1 ? 'es' : ''} with funds</Text>
                <Text fontSize="xs" color="kk.textMuted" mt="1">
                  {report.evm.persisted
                    ? `Added to your portfolio (index ${report.evm.discoveredIndices.join(', ')}) — appears after the next sync.`
                    : `Found this session (index ${report.evm.discoveredIndices.join(', ')}) — re-runs each time you unlock the hidden wallet.`}
                </Text>
              </Box>
            )}

            {/* Action result */}
            {actionResult && (
              <Box bg="rgba(74,222,128,0.08)" border="1px solid" borderColor="rgba(74,222,128,0.2)" borderRadius="md" p="3">
                <Text fontSize="xs" color="var(--teal)">{actionResult}</Text>
              </Box>
            )}

            {/* Coverage list */}
            {report.chains.length > 0 && (
              <Box>
                <Text fontSize="11px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.08em" mb="1.5">Chain coverage</Text>
                <VStack gap="1" align="stretch" maxH="160px" overflow="auto">
                  {[...report.chains].sort((a, b) => coverageRank(a) - coverageRank(b)).map((c) => {
                    const s = COVERAGE_STYLE[c.coverage]
                    return (
                      <Flex key={c.chainId} justify="space-between" align="center" px="2" py="1" borderRadius="sm" bg="whiteAlpha.50">
                        <Text fontSize="xs" color="kk.textSecondary">{c.symbol}</Text>
                        <Text fontSize="10px" color={s.color}>{s.label}</Text>
                      </Flex>
                    )
                  })}
                </VStack>
                {report.anyShallow && (
                  <Text fontSize="10px" color="kk.textMuted" mt="1.5">Single-address chains were checked at their primary address only — funds on other accounts can’t be detected here.</Text>
                )}
                {report.anyUnverified && (
                  <Flex gap="2" mt="2">
                    <Button flex="1" size="xs" variant="outline" borderColor="kk.border" color="var(--teal)" onClick={() => { onRecovered?.(); start(mode) }}>Sync & re-check</Button>
                  </Flex>
                )}
              </Box>
            )}

            {/* Footer */}
            <Flex gap="2" pt="1">
              {mode === 'light' && (
                <Button flex="1" size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "var(--teal)", color: "var(--teal)" }} onClick={() => start('deep')}>
                  Run deeper scan
                </Button>
              )}
              <Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" onClick={handleClose}>Close</Button>
            </Flex>
          </VStack>
        )}
      </Box>
    </Box>
  )
}

// Sort coverage: funded first, then unverified (needs attention), shallow, empty.
function coverageRank(c: AuditChainFinding): number {
  switch (c.coverage) {
    case 'funded': return 0
    case 'unverified': return 1
    case 'checked-shallow': return 2
    default: return 3
  }
}
