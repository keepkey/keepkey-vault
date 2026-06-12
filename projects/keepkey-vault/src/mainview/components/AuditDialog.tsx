/**
 * AuditDialog — the "where's my money" wizard, guided step-through.
 *
 * Runs an initial light scan (identity → BTC sweep → EVM discovery → coverage),
 * then walks the user chain-by-chain. Each chain is an escalation ladder:
 *   verify (balance + explorer) → "expected more?" → auto-scan 3 account/index
 *   levels → "search more" → custom paths (guided + raw) → support handoff.
 *
 * Honest by construction: degraded/stale chains read "could not verify" (never
 * "$0/clean"); single-address chains read "primary address only". Recovery is
 * on-device (BTC track account / EVM track index / sweep non-standard); chains
 * without multi-account infra surface the address + explorer + handoff.
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button, VStack, Spinner, Textarea } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { AuditCustomPath } from "./AuditCustomPath"
import type { ChainDef } from "../../shared/chains"
import type { AuditReport, AuditPortfolioSnapshot, AuditMode, AuditChainFinding, AuditDerivedAddress } from "../../shared/types"

const SUPPORT_URL = "https://support.keepkey.com"
const AUTO_SCAN_COUNT = 3

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

function coverageRank(c: AuditChainFinding): number {
  switch (c.coverage) {
    case 'funded': return 0
    case 'unverified': return 1
    case 'checked-shallow': return 2
    default: return 3
  }
}

interface Ladder {
  expanded: boolean
  scanning: boolean
  scanned: AuditDerivedAddress[]
  nextLevel: number
  customResults: AuditDerivedAddress[]
  showCustom: boolean
  recovering: boolean
  recovered: string | null
  recoverErr: string | null
  showHandoff: boolean
  handoffNote: string
  scanErr: string | null
}

const EMPTY_LADDER: Ladder = {
  expanded: false, scanning: false, scanned: [], nextLevel: 1, customResults: [],
  showCustom: false, recovering: false, recovered: null, recoverErr: null,
  showHandoff: false, handoffNote: '', scanErr: null,
}

interface AuditDialogProps {
  onClose: () => void
  snapshot: AuditPortfolioSnapshot
  isHidden: boolean
  /** Full chain catalog (CHAINS + custom) for explorer links + derivation meta. */
  chainCatalog: ChainDef[]
  /** Current (level-0) receive address per chainId, from the dashboard balances. */
  chainAddresses: Record<string, string>
  /** Called after a recovery action so the dashboard refreshes balances. */
  onRecovered?: () => void
}

export function AuditDialog({ onClose, snapshot, isHidden, chainCatalog, chainAddresses, onRecovered }: AuditDialogProps) {
  const [report, setReport] = useState<AuditReport | null>(null)
  const [mode, setMode] = useState<AuditMode>('light')
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [phase, setPhase] = useState<'scanning' | 'walkthrough'>('scanning')
  const [chainIdx, setChainIdx] = useState(0)
  const [ladders, setLadders] = useState<Record<string, Ladder>>({})
  // BTC v1-sweep recovery (non-standard paths) — surfaced on the bitcoin step.
  const [sweepPreview, setSweepPreview] = useState<any>(null)
  const [sweeping, setSweeping] = useState(false)

  const auditIdRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollingRef = useRef(false)
  const unmountedRef = useRef(false)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const catalog = useRef(new Map<string, ChainDef>())
  catalog.current = new Map(chainCatalog.map(c => [c.id, c]))

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    pollingRef.current = false
  }, [])

  const start = useCallback(async (m: AuditMode) => {
    stopPoll()
    setReport(null); setError(null); setStale(false); setPhase('scanning'); setChainIdx(0); setLadders({})
    setMode(m)
    try {
      const { auditId } = await rpcRequest<{ auditId: string }>('auditStart', { mode: m, snapshot: snapshotRef.current }, 60000)
      if (unmountedRef.current) return
      auditIdRef.current = auditId
      pollRef.current = setInterval(async () => {
        if (pollingRef.current) return
        pollingRef.current = true
        try {
          const r = await rpcRequest<AuditReport>('auditGetStatus', { auditId })
          if (auditId !== auditIdRef.current || unmountedRef.current) return
          setReport(r)
          if (r.status !== 'running') {
            stopPoll()
            if (r.status === 'complete') setPhase('walkthrough')
          }
        } catch { /* transient */ }
        finally { pollingRef.current = false }
      }, 1500)
    } catch (e: any) {
      if (!unmountedRef.current) setError(e.message)
    }
  }, [stopPoll])

  useEffect(() => { start('light') }, [start])
  useEffect(() => () => { unmountedRef.current = true; stopPoll() }, [stopPoll])
  useEffect(() => onRpcMessage('wallet-data-purged', () => { setStale(true); stopPoll() }), [stopPoll])

  const busy = sweeping || Object.values(ladders).some(l => l.scanning || l.recovering)
  const handleClose = useCallback(() => {
    if (busy) return
    if (auditIdRef.current) rpcRequest('auditDismiss', { auditId: auditIdRef.current }).catch(() => {})
    onClose()
  }, [busy, onClose])

  // Ordered walkthrough chains.
  const walk = report ? [...report.chains].sort((a, b) => coverageRank(a) - coverageRank(b)) : []
  const current = walk[chainIdx]
  const ladder = current ? (ladders[current.chainId] || EMPTY_LADDER) : EMPTY_LADDER
  // UTXO (and zcash-shielded/hive) can't be account-level-scanned via a single
  // address — BTC discovery is the sweep's job. For those, "Expected more" goes
  // straight to custom paths + handoff instead of a misleading single-address scan.
  const currentDef = current ? catalog.current.get(current.chainId) : undefined
  const levelScannable = !!currentDef && currentDef.chainFamily !== 'utxo' && !['zcash-shielded', 'hive'].includes(currentDef.chainFamily)
  const firstEvmId = walk.find(c => c.family === 'evm')?.chainId // EVM discovery is per-key, not per-chain — surface it once
  const patchLadder = useCallback((chainId: string, patch: Partial<Ladder>) => {
    setLadders(prev => ({ ...prev, [chainId]: { ...(prev[chainId] || EMPTY_LADDER), ...patch } }))
  }, [])

  const openUrl = (url: string) => rpcRequest('openUrl', { url }).catch(() => {})

  const scanMore = useCallback(async (chain: AuditChainFinding) => {
    const fromLevel = (ladders[chain.chainId]?.nextLevel) ?? EMPTY_LADDER.nextLevel
    patchLadder(chain.chainId, { expanded: true, scanning: true, scanErr: null })
    try {
      const { results } = await rpcRequest<{ results: AuditDerivedAddress[] }>('auditScanLevels',
        { chainId: chain.chainId, fromLevel, count: AUTO_SCAN_COUNT }, 180000)
      // Functional update — never clobber patches (e.g. a custom result) that
      // landed while the device scan was in flight.
      setLadders(prev => {
        const cur = prev[chain.chainId] || EMPTY_LADDER
        return { ...prev, [chain.chainId]: { ...cur, scanning: false, scanned: [...cur.scanned, ...results], nextLevel: cur.nextLevel + AUTO_SCAN_COUNT } }
      })
    } catch (e: any) {
      patchLadder(chain.chainId, { scanning: false, scanErr: e.message })
    }
  }, [ladders, patchLadder])

  const pushCustom = useCallback((chainId: string, r: AuditDerivedAddress) => {
    setLadders(prev => {
      const cur = prev[chainId] || EMPTY_LADDER
      return { ...prev, [chainId]: { ...cur, customResults: [...cur.customResults, r] } }
    })
  }, [])

  const trackLevel = useCallback(async (chain: AuditChainFinding, level: number) => {
    patchLadder(chain.chainId, { recovering: true, recoverErr: null })
    try {
      if (chain.chainId === 'bitcoin') {
        let set = await rpcRequest<any>('getBtcAccounts')
        let cur = set.accounts.length ? Math.max(...set.accounts.map((a: any) => a.accountIndex)) : 0
        while (cur < level) {
          set = await rpcRequest<any>('addBtcAccount', undefined, 60000)
          cur = set.accounts.length ? Math.max(...set.accounts.map((a: any) => a.accountIndex)) : cur + 1
        }
      } else if (chain.family === 'evm') {
        await rpcRequest('addEvmAddressIndex', { index: level }, 60000)
      }
      patchLadder(chain.chainId, { recovering: false, recovered: isHidden ? `Tracking for this session.` : `Added — appears after the next sync.` })
      onRecovered?.()
    } catch (e: any) {
      patchLadder(chain.chainId, { recovering: false, recoverErr: e.message })
    }
  }, [isHidden, onRecovered, patchLadder])

  // BTC v1 sweep (non-standard paths) — dry-run then confirm.
  const sweepDryRun = useCallback(async () => {
    if (!auditIdRef.current) return
    setSweeping(true)
    try { setSweepPreview(await rpcRequest('auditSweep', { auditId: auditIdRef.current, dryRun: true }, 600000)) }
    catch (e: any) { setError(e.message) } finally { setSweeping(false) }
  }, [])
  const sweepConfirm = useCallback(async () => {
    if (!auditIdRef.current) return
    setSweeping(true)
    try {
      const res = await rpcRequest<any>('auditSweep', { auditId: auditIdRef.current, dryRun: false }, 600000)
      setSweepPreview(null)
      onRecovered?.()
      setError(null)
      patchLadder('bitcoin', { recovered: `Swept ${formatSats(res.outputSats)} — txid ${String(res.txid).slice(0, 12)}…` })
    } catch (e: any) { setError(e.message) } finally { setSweeping(false) }
  }, [onRecovered, patchLadder])

  const copyHandoff = useCallback((chain: AuditChainFinding, l: Ladder, balanceUsd: number) => {
    const lines: string[] = []
    lines.push('KeepKey Vault — Balance Audit handoff')
    lines.push(`Time: ${new Date().toISOString()}`)
    lines.push(`Chain: ${chain.symbol} (${chain.chainId})`)
    lines.push(`Dashboard balance: $${balanceUsd.toFixed(2)}`)
    if (l.handoffNote.trim()) lines.push(`User expected: ${l.handoffNote.trim()}`)
    lines.push('')
    lines.push('Addresses checked:')
    if (isHidden) lines.push('  [hidden wallet — addresses redacted]')
    const all = [...l.scanned, ...l.customResults]
    for (const a of all) {
      const bal = a.balanceError ? '(unverified — balance check failed)' : `${a.native} ${a.symbol}${a.hasBalance ? ' (FUNDED)' : ''}`
      lines.push(isHidden ? `  ${a.pathStr}: ${bal}` : `  ${a.pathStr}  ${a.address}  ${bal}`)
    }
    if (!all.length) lines.push('  (none beyond the default address)')
    lines.push('')
    lines.push(`Support: ${SUPPORT_URL}`)
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {})
    openUrl(SUPPORT_URL)
  }, [isHidden])

  // ── Address row (scanned level / custom result) ──
  const AddrRow = ({ chain, a }: { chain: AuditChainFinding; a: AuditDerivedAddress }) => {
    const canTrack = (chain.chainId === 'bitcoin' || chain.family === 'evm') && a.level != null
    // A funded address we can't auto-track (custom path, or a non-BTC/EVM chain)
    // — never a silent dead-end; point to the support handoff.
    const fundedNoTrack = a.hasBalance && !canTrack
    return (
      <Box bg="whiteAlpha.50" borderRadius="md" px="3" py="1.5">
        <Flex justify="space-between" align="center">
          <Text fontSize="xs" color="kk.textSecondary">{a.level != null ? (chain.family === 'evm' ? `Address #${a.level}` : `Account #${a.level}`) : 'Custom'}</Text>
          {a.balanceError
            ? <Text fontSize="xs" fontWeight="600" color="var(--rose)">could not verify</Text>
            : <Text fontSize="xs" fontWeight="600" color={a.hasBalance ? 'var(--teal)' : 'kk.textMuted'}>{a.native} {a.symbol}</Text>}
        </Flex>
        <Flex justify="space-between" align="center" mt="0.5">
          <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" truncate maxW="220px" title={a.address}>{a.address}</Text>
          <Flex gap="2">
            {a.explorerUrl && <Box as="button" fontSize="10px" color="var(--teal)" onClick={() => openUrl(a.explorerUrl!)}>explorer ↗</Box>}
            {a.hasBalance && canTrack && (
              <Box as="button" fontSize="10px" color="kk.gold" fontWeight="600" onClick={() => trackLevel(chain, a.level!)}>track</Box>
            )}
          </Flex>
        </Flex>
        {fundedNoTrack && (
          <Text fontSize="10px" color="kk.gold" mt="1">
            Funds here, but KeepKey can’t track this path in-app. <Box as="button" textDecoration="underline" onClick={() => patchLadder(chain.chainId, { showHandoff: true })}>Send to support →</Box>
          </Text>
        )}
      </Box>
    )
  }

  const running = !report || report.status === 'running'

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog || 1500} display="flex" alignItems="center" justifyContent="center">
      <Box position="absolute" inset="0" bg="blackAlpha.700" onClick={handleClose} />

      <Box position="relative" w="480px" maxH="86vh" overflow="auto"
        bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="2xl" p="6" boxShadow="0 8px 40px rgba(0,0,0,0.5)">

        {/* Header */}
        <Flex align="center" justify="space-between" mb="4">
          <Flex align="center" gap="2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <Text fontSize="lg" fontWeight="600" color="var(--teal)">Audit balances</Text>
          </Flex>
          <Box as="button" onClick={handleClose} color="kk.textMuted" _hover={{ color: "white" }} p="1" opacity={busy ? 0.3 : 1} cursor={busy ? "not-allowed" : "pointer"}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </Box>
        </Flex>

        {/* Stale */}
        {stale && (
          <VStack gap="3" align="stretch" mb="2">
            <Text fontSize="sm" color="kk.gold">The wallet changed while auditing — these results are no longer reliable.</Text>
            <Button size="sm" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} onClick={() => start('light')}>Re-run audit</Button>
          </VStack>
        )}

        {!stale && error && (
          <Box mb="3" px="3" py="2" bg="rgba(255,99,99,0.08)" border="1px solid" borderColor="rgba(255,99,99,0.3)" borderRadius="md">
            <Text fontSize="xs" color="red.400">{error}</Text>
          </Box>
        )}

        {/* Scanning */}
        {!stale && phase === 'scanning' && running && (
          <VStack gap="3" align="stretch">
            <Text fontSize="xs" color="kk.textMuted">
              {isHidden ? 'Auditing your hidden wallet — nothing is written to disk.' : 'Checking your funds across every chain…'}
            </Text>
            <VStack gap="2" align="stretch">
              {PHASES.map((p, i) => {
                const activeIdx = report ? PHASES.findIndex(x => x.key === report.phase) : 0
                const done = report ? i < activeIdx || report.status !== 'running' : false
                const active = report ? i === activeIdx && report.status === 'running' : i === 0
                return (
                  <Flex key={p.key} align="center" gap="2">
                    <Box w="16px" h="16px" display="flex" alignItems="center" justifyContent="center">
                      {done ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                        : active ? <Spinner size="xs" color="var(--teal)" />
                        : <Box w="6px" h="6px" borderRadius="full" bg="kk.border" />}
                    </Box>
                    <Text fontSize="sm" color={active ? "kk.textSecondary" : "kk.textMuted"}>{active && report ? report.progress.label : p.label}</Text>
                  </Flex>
                )
              })}
            </VStack>
            {report && report.progress.total > 1 && (
              <Box bg="whiteAlpha.100" borderRadius="full" h="5px" overflow="hidden">
                <Box bg="var(--teal)" h="100%" borderRadius="full" transition="width 0.3s" w={`${Math.round((report.progress.current / Math.max(report.progress.total, 1)) * 100)}%`} />
              </Box>
            )}
            {report?.status === 'aborted' && <Text fontSize="xs" color="kk.gold">Scan stopped early ({report.error || 'device interrupted'}). <Box as="button" textDecoration="underline" onClick={() => start('light')}>Retry</Box></Text>}
          </VStack>
        )}

        {/* Walkthrough */}
        {!stale && phase === 'walkthrough' && current && (
          <VStack gap="3" align="stretch">
            {/* Progress */}
            <Flex justify="space-between" align="center">
              <Text fontSize="11px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.08em">Chain {chainIdx + 1} of {walk.length}</Text>
              <Text fontSize="10px" color={COVERAGE_STYLE[current.coverage].color}>{COVERAGE_STYLE[current.coverage].label}</Text>
            </Flex>

            {/* Current balance + explorer */}
            <Box bg="whiteAlpha.50" borderRadius="lg" p="3">
              <Flex justify="space-between" align="center">
                <Text fontSize="md" fontWeight="600" color="white">{current.symbol}</Text>
                <Text fontSize="md" fontWeight="600" color={current.balanceUsd > 0 ? 'var(--teal)' : 'kk.textMuted'}>${current.balanceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</Text>
              </Flex>
              {(() => {
                const addr = chainAddresses[current.chainId]
                const tmpl = catalog.current.get(current.chainId)?.explorerAddressUrl
                const url = addr && tmpl ? tmpl.replace('{{address}}', addr) : null
                return url ? (
                  <Flex justify="space-between" align="center" mt="1">
                    <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" truncate maxW="280px" title={addr}>{addr}</Text>
                    <Box as="button" fontSize="10px" color="var(--teal)" flexShrink={0} onClick={() => openUrl(url)}>explorer ↗</Box>
                  </Flex>
                ) : null
              })()}
              {current.coverage === 'unverified' && <Text fontSize="10px" color="var(--rose)" mt="1">This chain didn’t report — the balance shown may be wrong. <Box as="button" textDecoration="underline" onClick={() => { onRecovered?.(); }}>Sync now</Box></Text>}
              {current.coverage === 'checked-shallow' && (
                <Text fontSize="10px" color="kk.gold" mt="1">
                  {levelScannable
                    ? 'Only the primary address was checked — search below for funds on other accounts.'
                    : 'Only the primary address was checked. KeepKey can’t auto-track extra accounts on this chain — search below, then use “Still missing?” to send a recovery report to support.'}
                </Text>
              )}
            </Box>

            {/* BTC v1-sweep findings on the bitcoin step */}
            {current.chainId === 'bitcoin' && report && report.btc.findings.some(f => f.category !== 'higher-account') && (
              <Box bg="rgba(233,196,106,0.08)" border="1px solid" borderColor="rgba(233,196,106,0.2)" borderRadius="lg" p="3">
                <Text fontSize="sm" fontWeight="600" color="kk.gold">{formatSats(report.btc.findings.filter(f => f.category !== 'higher-account').reduce((s, f) => s + f.balanceSats, 0))} on non-standard paths</Text>
                <Text fontSize="xs" color="kk.textMuted" mt="1" mb="2">Mismatched script types or account-level keys — swept to your main address.</Text>
                {sweepPreview ? (
                  <>
                    <Box bg="whiteAlpha.50" borderRadius="md" p="2" mb="2">
                      <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">You receive</Text><Text fontSize="xs" fontWeight="600" color="kk.gold">{formatSats(sweepPreview.outputSats)}</Text></Flex>
                    </Box>
                    <Flex gap="2">
                      <Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" onClick={() => setSweepPreview(null)}>Back</Button>
                      <Button flex="1" size="sm" bg="kk.gold" color="black" fontWeight="600" loading={sweeping} onClick={sweepConfirm}>Confirm & broadcast</Button>
                    </Flex>
                  </>
                ) : (
                  <Button size="sm" w="100%" bg="kk.gold" color="black" fontWeight="600" loading={sweeping} onClick={sweepDryRun}>Sweep to main address</Button>
                )}
              </Box>
            )}
            {current.chainId === 'bitcoin' && report && report.btc.higherAccountMax > 0 && (
              <Button size="sm" w="100%" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} loading={ladder.recovering} onClick={() => trackLevel(current, report.btc.higherAccountMax)}>
                Track Bitcoin accounts up to #{report.btc.higherAccountMax}
              </Button>
            )}
            {current.chainId === firstEvmId && report && report.evm.discoveredIndices.length > 0 && (
              <Text fontSize="xs" color="var(--teal)">Found funds on EVM address #{report.evm.discoveredIndices.join(', #')} — {report.evm.persisted ? 'added to your portfolio.' : 'found this session.'} (shared across all EVM chains)</Text>
            )}

            {/* The escalation ladder */}
            {!ladder.expanded ? (
              <Flex gap="2">
                <Button flex="1" size="sm" variant="outline" borderColor="kk.border" color="var(--teal)" _hover={{ bg: "rgba(74,222,128,0.08)" }} onClick={() => { if (chainIdx + 1 < walk.length) setChainIdx(chainIdx + 1) }}>Looks right ✓</Button>
                <Button flex="1" size="sm" variant="outline" borderColor="kk.gold" color="kk.gold" _hover={{ bg: "rgba(233,196,106,0.08)" }} onClick={() => levelScannable ? scanMore(current) : patchLadder(current.chainId, { expanded: true, showCustom: true })}>Expected more</Button>
              </Flex>
            ) : (
              <Box>
                {ladder.scanning && <Flex align="center" gap="2" py="2"><Spinner size="sm" color="var(--teal)" /><Text fontSize="sm" color="kk.textSecondary">Scanning more accounts on device…</Text></Flex>}
                {ladder.scanErr && <Text fontSize="xs" color="red.400" mb="2">{ladder.scanErr}</Text>}

                {ladder.scanned.length > 0 && (
                  <VStack gap="1.5" align="stretch" mb="2" maxH="180px" overflow="auto">
                    {ladder.scanned.map((a, i) => <AddrRow key={`s${i}`} chain={current} a={a} />)}
                  </VStack>
                )}
                {ladder.customResults.map((a, i) => <Box key={`c${i}`} mb="1.5"><AddrRow chain={current} a={a} /></Box>)}

                {ladder.recovered && <Box bg="rgba(74,222,128,0.08)" border="1px solid" borderColor="rgba(74,222,128,0.2)" borderRadius="md" p="2" mb="2"><Text fontSize="xs" color="var(--teal)">{ladder.recovered}</Text></Box>}
                {ladder.recoverErr && <Text fontSize="xs" color="red.400" mb="2">{ladder.recoverErr}</Text>}

                {!ladder.scanning && (
                  <Flex gap="2" wrap="wrap">
                    {levelScannable && <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary" onClick={() => scanMore(current)}>Search {AUTO_SCAN_COUNT} more</Button>}
                    {!ladder.showCustom && <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary" onClick={() => patchLadder(current.chainId, { showCustom: true })}>Try custom paths</Button>}
                    {!ladder.showHandoff && <Button size="xs" variant="ghost" color="kk.textMuted" onClick={() => patchLadder(current.chainId, { showHandoff: true })}>Still missing?</Button>}
                  </Flex>
                )}

                {ladder.showCustom && (() => {
                  const def = catalog.current.get(current.chainId)
                  return def ? (
                    <AuditCustomPath chainId={current.chainId} family={def.chainFamily} defaultPath={def.defaultPath} scriptType={def.scriptType}
                      onResult={(r) => pushCustom(current.chainId, r)} />
                  ) : null
                })()}

                {ladder.showHandoff && (
                  <Box bg="whiteAlpha.50" borderRadius="md" p="3" mt="2">
                    <Text fontSize="xs" color="kk.textSecondary" mb="2">We’ll bundle everything checked into a report you can send to support.</Text>
                    <Textarea size="sm" placeholder="What balance did you expect? (optional)" value={ladder.handoffNote}
                      onChange={e => patchLadder(current.chainId, { handoffNote: e.target.value })}
                      bg="whiteAlpha.50" border="1px solid" borderColor="kk.border" fontSize="xs" rows={2} mb="2" />
                    <Button size="sm" w="100%" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }}
                      onClick={() => copyHandoff(current, ladder, current.balanceUsd)}>Copy report & open support ↗</Button>
                  </Box>
                )}
              </Box>
            )}

            {/* Nav */}
            <Flex gap="2" pt="1" borderTop="1px solid" borderColor="kk.border">
              <Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" disabled={chainIdx === 0} onClick={() => setChainIdx(Math.max(0, chainIdx - 1))}>← Back</Button>
              {chainIdx + 1 < walk.length
                ? <Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" onClick={() => setChainIdx(chainIdx + 1)}>Next →</Button>
                : <Button flex="1" size="sm" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} onClick={handleClose}>Finish</Button>}
            </Flex>
          </VStack>
        )}
      </Box>
    </Box>
  )
}
