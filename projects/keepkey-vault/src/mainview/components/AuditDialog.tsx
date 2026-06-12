/**
 * AuditDialog — the "where's my money" recovery/debug console.
 *
 * Initial light scan (identity → BTC sweep → EVM discovery → coverage), then a
 * chain-by-chain walkthrough with a top network-logo filmstrip. Landing on a
 * chain auto-scans accounts 1-3; "Dig deeper" reveals opt-in deep scanners
 * (EVM known-paths grid, BTC wrong-script-type + gap-limit, raw-path inspector),
 * custom paths, and a support handoff.
 *
 * Honest by construction: degraded/stale → "could not verify" (never "$0/clean");
 * single-address chains → "primary address only"; failed lookups → "could not
 * verify". Recovery is on-device; non-trackable finds route to the handoff.
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button, VStack, Spinner, Textarea } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { ChainLogo } from "./ChainLogo"
import { AuditCustomPath } from "./AuditCustomPath"
import { AuditKnownPaths } from "./AuditKnownPaths"
import { AuditBtcDeep } from "./AuditBtcDeep"
import { AuditInspector } from "./AuditInspector"
import type { ChainDef } from "../../shared/chains"
import type { AuditReport, AuditPortfolioSnapshot, AuditMode, AuditChainFinding, AuditDerivedAddress } from "../../shared/types"

const SUPPORT_URL = "https://support.keepkey.com"
const ANIM = `@keyframes auditPulse { 0%,100% { box-shadow: 0 0 0 2px rgba(80,200,120,0.5); } 50% { box-shadow: 0 0 0 5px rgba(80,200,120,0.15); } }`

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
  autoScanned: boolean        // accounts 1-3 auto-scan attempted on arrival
  autoScanning: boolean       // involuntary on-arrival scan in flight (does NOT block close)
  scanning: boolean           // user-initiated scan in flight (blocks close)
  scanned: AuditDerivedAddress[]
  nextLevel: number
  digDeeper: boolean          // deep-dive panels open
  customResults: AuditDerivedAddress[]
  extraFound: AuditDerivedAddress[]  // funded finds from known-paths/inspector → handoff
  showCustom: boolean
  recovering: boolean
  recovered: string | null
  recoverErr: string | null
  showHandoff: boolean
  handoffNote: string
  scanErr: string | null
}

const EMPTY_LADDER: Ladder = {
  autoScanned: false, autoScanning: false, scanning: false, scanned: [], nextLevel: 1, digDeeper: false,
  customResults: [], extraFound: [], showCustom: false, recovering: false, recovered: null,
  recoverErr: null, showHandoff: false, handoffNote: '', scanErr: null,
}

interface AuditDialogProps {
  onClose: () => void
  snapshot: AuditPortfolioSnapshot
  isHidden: boolean
  chainCatalog: ChainDef[]
  chainAddresses: Record<string, string>
  onRecovered?: () => void
}

export function AuditDialog({ onClose, snapshot, isHidden, chainCatalog, chainAddresses, onRecovered }: AuditDialogProps) {
  const [report, setReport] = useState<AuditReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [phase, setPhase] = useState<'scanning' | 'walkthrough'>('scanning')
  const [chainIdx, setChainIdx] = useState(0)
  const [ladders, setLadders] = useState<Record<string, Ladder>>({})
  const [sweepPreview, setSweepPreview] = useState<any>(null)
  const [sweeping, setSweeping] = useState(false)

  const auditIdRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollingRef = useRef(false)
  const unmountedRef = useRef(false)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const filmRef = useRef<HTMLDivElement | null>(null)

  const catalog = useRef(new Map<string, ChainDef>())
  catalog.current = new Map(chainCatalog.map(c => [c.id, c]))

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    pollingRef.current = false
  }, [])

  const start = useCallback(async (m: AuditMode) => {
    stopPoll()
    setReport(null); setError(null); setStale(false); setPhase('scanning'); setChainIdx(0); setLadders({})
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

  const patchLadder = useCallback((chainId: string, patch: Partial<Ladder>) => {
    setLadders(prev => ({ ...prev, [chainId]: { ...(prev[chainId] || EMPTY_LADDER), ...patch } }))
  }, [])
  const pushCustom = useCallback((chainId: string, r: AuditDerivedAddress) => {
    setLadders(prev => { const cur = prev[chainId] || EMPTY_LADDER; return { ...prev, [chainId]: { ...cur, customResults: [...cur.customResults, r] } } })
  }, [])
  const pushExtra = useCallback((chainId: string, r: AuditDerivedAddress) => {
    setLadders(prev => { const cur = prev[chainId] || EMPTY_LADDER; return { ...prev, [chainId]: { ...cur, extraFound: [...cur.extraFound, r] } } })
  }, [])

  const busy = sweeping || Object.values(ladders).some(l => l.scanning || l.recovering)
  const openUrl = (url: string) => rpcRequest('openUrl', { url }).catch(() => {})

  // Ordered walkthrough chains + current.
  const walk = report ? [...report.chains].sort((a, b) => coverageRank(a) - coverageRank(b)) : []
  const current = walk[chainIdx]
  const ladder = current ? (ladders[current.chainId] || EMPTY_LADDER) : EMPTY_LADDER
  const currentDef = current ? catalog.current.get(current.chainId) : undefined
  const levelScannable = !!currentDef && currentDef.chainFamily !== 'utxo' && !['zcash-shielded', 'hive'].includes(currentDef.chainFamily)
  const firstEvmId = walk.find(c => c.family === 'evm')?.chainId

  const runScan = useCallback(async (chain: AuditChainFinding, fromLevel: number, count: number, markAuto: boolean) => {
    // An on-arrival auto-scan is involuntary + read-only — it sets autoScanning,
    // which is NOT in `busy`, so it never blocks the close button. A user-clicked
    // "Search more" sets scanning, which does guard close.
    patchLadder(chain.chainId, markAuto ? { autoScanning: true, autoScanned: true, scanErr: null } : { scanning: true, scanErr: null })
    try {
      const { results } = await rpcRequest<{ results: AuditDerivedAddress[] }>('auditScanLevels', { chainId: chain.chainId, fromLevel, count }, 180000)
      setLadders(prev => {
        const cur = prev[chain.chainId] || EMPTY_LADDER
        return { ...prev, [chain.chainId]: { ...cur, scanning: false, autoScanning: false, scanned: [...cur.scanned, ...results], nextLevel: Math.max(cur.nextLevel, fromLevel + count) } }
      })
    } catch (e: any) {
      patchLadder(chain.chainId, markAuto ? { autoScanning: false, scanErr: e.message } : { scanning: false, scanErr: e.message })
    }
  }, [patchLadder])

  const handleClose = useCallback(() => {
    if (busy) return
    if (auditIdRef.current) rpcRequest('auditDismiss', { auditId: auditIdRef.current }).catch(() => {})
    onClose()
  }, [busy, onClose])

  // Auto-scan accounts 1-3 on arrival (lazy, default-on) for level-scannable chains.
  useEffect(() => {
    if (phase !== 'walkthrough' || !current || !levelScannable) return
    const l = ladders[current.chainId]
    if (l?.autoScanned || l?.autoScanning || l?.scanning) return
    const t = setTimeout(() => runScan(current, 1, 3, true), 450)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current?.chainId, levelScannable])

  // Keep the current logo visible in the filmstrip.
  useEffect(() => {
    const el = filmRef.current?.querySelector('[data-current="true"]') as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [chainIdx, phase])

  const trackLevel = useCallback(async (chain: AuditChainFinding, level: number) => {
    patchLadder(chain.chainId, { recovering: true, recoverErr: null })
    try {
      if (chain.chainId === 'bitcoin') {
        let set = await rpcRequest<any>('getBtcAccounts')
        let cur = set.accounts.length ? Math.max(...set.accounts.map((a: any) => a.accountIndex)) : 0
        while (cur < level) { set = await rpcRequest<any>('addBtcAccount', undefined, 60000); cur = set.accounts.length ? Math.max(...set.accounts.map((a: any) => a.accountIndex)) : cur + 1 }
      } else if (chain.family === 'evm') {
        await rpcRequest('addEvmAddressIndex', { index: level }, 60000)
      }
      patchLadder(chain.chainId, { recovering: false, recovered: isHidden ? `Tracking for this session.` : `Added — appears after the next sync.` })
      onRecovered?.()
    } catch (e: any) { patchLadder(chain.chainId, { recovering: false, recoverErr: e.message }) }
  }, [isHidden, onRecovered, patchLadder])

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
      setSweepPreview(null); onRecovered?.(); setError(null)
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
    const all = [...l.scanned, ...l.customResults, ...l.extraFound]
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

  const AddrRow = ({ chain, a }: { chain: AuditChainFinding; a: AuditDerivedAddress }) => {
    const canTrack = (chain.chainId === 'bitcoin' || chain.family === 'evm') && a.level != null
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
            {a.hasBalance && canTrack && <Box as="button" fontSize="10px" color="kk.gold" fontWeight="600" onClick={() => trackLevel(chain, a.level!)}>track</Box>}
          </Flex>
        </Flex>
        {fundedNoTrack && <Text fontSize="10px" color="kk.gold" mt="1">Funds here, but KeepKey can’t track this path in-app. <Box as="button" textDecoration="underline" onClick={() => patchLadder(chain.chainId, { digDeeper: true, showHandoff: true })}>Send to support →</Box></Text>}
      </Box>
    )
  }

  const running = !report || report.status === 'running'
  const fundedScanned = ladder.scanned.filter(a => a.hasBalance || a.balanceError)
  const currentCaip = currentDef?.caip
  const currentAddr = current ? chainAddresses[current.chainId] : undefined
  const explorerForCurrent = (currentAddr && currentDef?.explorerAddressUrl) ? currentDef.explorerAddressUrl.replace('{{address}}', currentAddr) : null

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog || 1500} display="flex" alignItems="center" justifyContent="center">
      <style>{ANIM}</style>
      <Box position="absolute" inset="0" bg="blackAlpha.700" onClick={handleClose} />

      <Box position="relative" w="480px" maxH="88vh" overflow="auto"
        bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="2xl" p="6" boxShadow="0 8px 40px rgba(0,0,0,0.5)">

        {/* Header */}
        <Flex align="center" justify="space-between" mb="4">
          <Flex align="center" gap="2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>
            <Text fontSize="lg" fontWeight="600" color="var(--teal)">Audit balances</Text>
          </Flex>
          <Flex align="center" gap="2">
            {phase === 'walkthrough' && <Text fontSize="11px" color="kk.textMuted">{chainIdx + 1} / {walk.length}</Text>}
            <Box as="button" onClick={handleClose} color="kk.textMuted" _hover={{ color: "white" }} p="1" opacity={busy ? 0.3 : 1} cursor={busy ? "not-allowed" : "pointer"}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </Box>
          </Flex>
        </Flex>

        {/* Filmstrip stepper */}
        {phase === 'walkthrough' && walk.length > 0 && (
          <Box mb="4">
            <Flex ref={filmRef} gap="2.5" overflowX="auto" pb="2" align="center"
              css={{ scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
              {walk.map((c, i) => {
                const def = catalog.current.get(c.chainId)
                const isCur = i === chainIdx
                const visited = i < chainIdx
                const ring = isCur ? 'var(--teal)' : c.coverage === 'funded' ? 'rgba(74,222,128,0.5)' : c.coverage === 'unverified' ? 'var(--rose)' : null
                return (
                  <Box key={c.chainId} data-current={isCur} onClick={() => setChainIdx(i)} cursor="pointer" flexShrink={0} pt="1">
                    <ChainLogo caip={def?.caip} symbol={c.symbol} size={isCur ? 34 : 26} ring={ring}
                      dim={!isCur && !visited && c.coverage !== 'funded' && c.coverage !== 'unverified'}
                      done={visited && c.coverage !== 'unverified'} scanning={isCur && !!(ladders[c.chainId]?.scanning || ladders[c.chainId]?.autoScanning)} />
                  </Box>
                )
              })}
            </Flex>
            <Box h="2px" bg="whiteAlpha.100" borderRadius="full" overflow="hidden">
              <Box h="100%" bg="var(--teal)" borderRadius="full" transition="width 0.3s" w={`${Math.round(((chainIdx + 1) / walk.length) * 100)}%`} />
            </Box>
          </Box>
        )}

        {/* Stale */}
        {stale && (
          <VStack gap="3" align="stretch" mb="2">
            <Text fontSize="sm" color="kk.gold">The wallet changed while auditing — these results are no longer reliable.</Text>
            <Button size="sm" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} onClick={() => start('light')}>Re-run audit</Button>
          </VStack>
        )}

        {!stale && error && (
          <Box mb="3" px="3" py="2" bg="rgba(255,99,99,0.08)" border="1px solid" borderColor="rgba(255,99,99,0.3)" borderRadius="md"><Text fontSize="xs" color="red.400">{error}</Text></Box>
        )}

        {/* Initial scanning */}
        {!stale && phase === 'scanning' && running && (
          <VStack gap="4" align="stretch" py="2">
            <Flex justify="center"><Box w="56px" h="56px" borderRadius="full" bg="rgba(80,200,120,0.08)" css={{ animation: "auditPulse 1.4s ease-in-out infinite" }} display="flex" alignItems="center" justifyContent="center">
              <Spinner size="md" color="var(--teal)" />
            </Box></Flex>
            <Text fontSize="xs" color="kk.textMuted" textAlign="center">{isHidden ? 'Auditing your hidden wallet — nothing is written to disk.' : 'Checking your funds across every chain…'}</Text>
            <VStack gap="2" align="stretch">
              {PHASES.map((p, i) => {
                const activeIdx = report ? PHASES.findIndex(x => x.key === report.phase) : 0
                const done = report ? i < activeIdx || report.status !== 'running' : false
                const active = report ? i === activeIdx && report.status === 'running' : i === 0
                return (
                  <Flex key={p.key} align="center" gap="2">
                    <Box w="16px" h="16px" display="flex" alignItems="center" justifyContent="center">
                      {done ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                        : active ? <Spinner size="xs" color="var(--teal)" /> : <Box w="6px" h="6px" borderRadius="full" bg="kk.border" />}
                    </Box>
                    <Text fontSize="sm" color={active ? "kk.textSecondary" : "kk.textMuted"}>{active && report ? report.progress.label : p.label}</Text>
                  </Flex>
                )
              })}
            </VStack>
            {report?.status === 'aborted' && <Text fontSize="xs" color="kk.gold" textAlign="center">Scan stopped early ({report.error || 'device interrupted'}). <Box as="button" textDecoration="underline" onClick={() => start('light')}>Retry</Box></Text>}
          </VStack>
        )}

        {/* Walkthrough */}
        {!stale && phase === 'walkthrough' && current && (
          <VStack gap="3" align="stretch">
            {/* Hero */}
            <VStack gap="1" pb="1">
              <ChainLogo caip={currentCaip} symbol={current.symbol} size={52} scanning={ladder.scanning || ladder.autoScanning} ring={(ladder.scanning || ladder.autoScanning) ? 'var(--teal)' : null} />
              <Text fontSize="lg" fontWeight="600" color="white" mt="1">{current.symbol}</Text>
              <Text fontSize="xl" fontWeight="700" color={current.balanceUsd > 0 ? 'var(--teal)' : 'kk.textMuted'}>${current.balanceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</Text>
              <Flex align="center" gap="2">
                <Text fontSize="10px" color={COVERAGE_STYLE[current.coverage].color}>{COVERAGE_STYLE[current.coverage].label}</Text>
                {explorerForCurrent && <Box as="button" fontSize="10px" color="var(--teal)" onClick={() => openUrl(explorerForCurrent)}>explorer ↗</Box>}
              </Flex>
            </VStack>

            {current.coverage === 'unverified' && <Text fontSize="11px" color="var(--rose)" textAlign="center">This chain didn’t report — the balance shown may be wrong. <Box as="button" textDecoration="underline" onClick={() => onRecovered?.()}>Sync now</Box></Text>}

            {/* BTC v1 sweep + track */}
            {current.chainId === 'bitcoin' && report && report.btc.findings.some(f => f.category !== 'higher-account') && (
              <Box bg="rgba(233,196,106,0.08)" border="1px solid" borderColor="rgba(233,196,106,0.2)" borderRadius="lg" p="3">
                <Text fontSize="sm" fontWeight="600" color="kk.gold">{formatSats(report.btc.findings.filter(f => f.category !== 'higher-account').reduce((s, f) => s + f.balanceSats, 0))} on non-standard paths</Text>
                {sweepPreview ? (
                  <>
                    <Box bg="whiteAlpha.50" borderRadius="md" p="2" my="2"><Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">You receive</Text><Text fontSize="xs" fontWeight="600" color="kk.gold">{formatSats(sweepPreview.outputSats)}</Text></Flex></Box>
                    <Flex gap="2"><Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" onClick={() => setSweepPreview(null)}>Back</Button><Button flex="1" size="sm" bg="kk.gold" color="black" fontWeight="600" loading={sweeping} onClick={sweepConfirm}>Confirm & broadcast</Button></Flex>
                  </>
                ) : <Button size="sm" w="100%" mt="2" bg="kk.gold" color="black" fontWeight="600" loading={sweeping} onClick={sweepDryRun}>Sweep to main address</Button>}
              </Box>
            )}
            {current.chainId === 'bitcoin' && report && report.btc.higherAccountMax > 0 && (
              <Button size="sm" w="100%" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} loading={ladder.recovering} onClick={() => trackLevel(current, report.btc.higherAccountMax)}>Track Bitcoin accounts up to #{report.btc.higherAccountMax}</Button>
            )}
            {current.chainId === firstEvmId && report && report.evm.discoveredIndices.length > 0 && (
              <Text fontSize="xs" color="var(--teal)" textAlign="center">Found funds on EVM address #{report.evm.discoveredIndices.join(', #')} — {report.evm.persisted ? 'added to your portfolio.' : 'found this session.'} (shared across all EVM chains)</Text>
            )}

            {/* Auto-scan summary */}
            {ladder.autoScanning && <Text fontSize="xs" color="kk.textMuted" textAlign="center">Checking accounts 1–3…</Text>}
            {fundedScanned.length > 0 && <VStack gap="1.5" align="stretch">{fundedScanned.map((a, i) => <AddrRow key={`f${i}`} chain={current} a={a} />)}</VStack>}
            {ladder.autoScanned && !ladder.scanning && fundedScanned.length === 0 && levelScannable && <Text fontSize="11px" color="kk.textMuted" textAlign="center">Accounts 1–3 checked — nothing beyond your main address.</Text>}
            {ladder.recovered && <Box bg="rgba(74,222,128,0.08)" border="1px solid" borderColor="rgba(74,222,128,0.2)" borderRadius="md" p="2"><Text fontSize="xs" color="var(--teal)">{ladder.recovered}</Text></Box>}
            {ladder.recoverErr && <Text fontSize="xs" color="red.400">{ladder.recoverErr}</Text>}
            {current.coverage === 'checked-shallow' && !levelScannable && <Text fontSize="10px" color="kk.gold" textAlign="center">KeepKey can’t auto-track extra accounts on this chain — dig deeper to search, then send a report to support.</Text>}

            {/* Primary actions */}
            {!ladder.digDeeper ? (
              <Flex gap="2">
                <Button flex="1" size="sm" variant="outline" borderColor="kk.border" color="var(--teal)" _hover={{ bg: "rgba(74,222,128,0.08)" }} onClick={() => { if (chainIdx + 1 < walk.length) setChainIdx(chainIdx + 1); else handleClose() }}>Looks right ✓</Button>
                <Button flex="1" size="sm" variant="outline" borderColor="kk.gold" color="kk.gold" _hover={{ bg: "rgba(233,196,106,0.08)" }} onClick={() => patchLadder(current.chainId, { digDeeper: true })}>Dig deeper</Button>
              </Flex>
            ) : (
              <Box borderTop="1px solid" borderColor="kk.border" pt="3">
                <VStack gap="2.5" align="stretch">
                  {ladder.scanErr && <Text fontSize="xs" color="red.400">{ladder.scanErr}</Text>}

                  {/* deeper account levels */}
                  {levelScannable && (
                    <Box>
                      <Text fontSize="11px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.08em" mb="1.5">More accounts</Text>
                      <VStack gap="1.5" align="stretch" maxH="160px" overflow="auto">
                        {ladder.scanned.filter(a => !a.hasBalance && !a.balanceError).map((a, i) => <AddrRow key={`s${i}`} chain={current} a={a} />)}
                      </VStack>
                      <Button size="xs" mt="1.5" variant="outline" borderColor="kk.border" color="kk.textSecondary" loading={ladder.scanning} onClick={() => runScan(current, ladder.nextLevel, 3, false)}>Search 3 more accounts</Button>
                    </Box>
                  )}

                  {/* EVM known-paths grid */}
                  {current.family === 'evm' && <AuditKnownPaths chainId={current.chainId} onFound={(r) => pushExtra(current.chainId, r)} onOpenUrl={openUrl} />}

                  {/* BTC deep scans */}
                  {current.chainId === 'bitcoin' && (
                    <Box>
                      <Text fontSize="11px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.08em" mb="1.5">Deep Bitcoin scans</Text>
                      <AuditBtcDeep onRecovered={() => onRecovered?.()} />
                    </Box>
                  )}

                  {/* custom path */}
                  {currentDef && (ladder.showCustom
                    ? <AuditCustomPath chainId={current.chainId} family={currentDef.chainFamily} defaultPath={currentDef.defaultPath} scriptType={currentDef.scriptType} onResult={(r) => pushCustom(current.chainId, r)} />
                    : <Box as="button" fontSize="11px" color="kk.textMuted" _hover={{ color: "var(--teal)" }} onClick={() => patchLadder(current.chainId, { showCustom: true })}>Try a custom path →</Box>)}
                  {ladder.customResults.map((a, i) => <AddrRow key={`c${i}`} chain={current} a={a} />)}

                  {/* inspector */}
                  {currentDef && <AuditInspector chainId={current.chainId} family={currentDef.chainFamily} defaultPath={currentDef.defaultPath} scriptType={currentDef.scriptType} onOpenUrl={openUrl} />}

                  {/* handoff */}
                  {ladder.showHandoff ? (
                    <Box bg="whiteAlpha.50" borderRadius="md" p="3">
                      <Text fontSize="xs" color="kk.textSecondary" mb="2">We’ll bundle everything checked into a report you can send to support.</Text>
                      <Textarea size="sm" placeholder="What balance did you expect? (optional)" value={ladder.handoffNote} onChange={e => patchLadder(current.chainId, { handoffNote: e.target.value })} bg="whiteAlpha.50" border="1px solid" borderColor="kk.border" fontSize="xs" rows={2} mb="2" />
                      <Button size="sm" w="100%" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} onClick={() => copyHandoff(current, ladder, current.balanceUsd)}>Copy report & open support ↗</Button>
                    </Box>
                  ) : <Box as="button" fontSize="11px" color="kk.textMuted" _hover={{ color: "var(--teal)" }} onClick={() => patchLadder(current.chainId, { showHandoff: true })}>Still missing? Send to support →</Box>}
                </VStack>
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
