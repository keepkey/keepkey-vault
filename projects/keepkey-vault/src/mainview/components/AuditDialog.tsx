/**
 * AuditDialog — the "where's my money" recovery wizard.
 *
 * A large, wide guided dialog (onboarding-wizard feel) that walks EVERY chain on
 * the device one page at a time, explaining what it's checking. After an initial
 * light scan it auto-checks accounts 1-3 per chain on arrival, then offers four
 * explicit actions: Looks right · Scan more accounts · Scan common (other-wallet)
 * paths · Scan a custom path. Recovery is on-device; non-trackable finds route
 * to a support handoff.
 *
 * Honest by construction: degraded/stale → "couldn't verify" (never "$0/clean");
 * single-address chains → "primary address only"; failed lookups → "couldn't
 * verify".
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button, VStack, HStack, Spinner, Textarea } from "@chakra-ui/react"
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
const ANIM = `
  @keyframes auditPulse { 0%,100% { box-shadow: 0 0 0 2px rgba(139,227,196,0.55); } 50% { box-shadow: 0 0 0 6px rgba(139,227,196,0.10); } }
  @keyframes auditGlow { 0%,100% { box-shadow: 0 0 14px rgba(139,227,196,0.20); } 50% { box-shadow: 0 0 30px rgba(139,227,196,0.45); } }
`

function formatSats(sats: number): string {
  if (sats >= 100_000_000) return (sats / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' BTC'
  return sats.toLocaleString() + ' sats'
}

const PHASES: { key: AuditReport['phase']; label: string }[] = [
  { key: 'identity', label: 'Verifying your device' },
  { key: 'coverage', label: 'Lining up your chains' },
]

const COVERAGE_STYLE: Record<AuditChainFinding['coverage'], { label: string; color: string }> = {
  'funded': { label: 'funded', color: 'var(--teal)' },
  'empty-confirmed': { label: 'empty', color: 'var(--text-2)' },
  'checked-shallow': { label: 'primary address only', color: 'var(--gold)' },
  'unverified': { label: 'couldn’t verify', color: 'var(--rose)' },
}

function coverageRank(c: AuditChainFinding): number {
  switch (c.coverage) {
    case 'funded': return 0
    case 'unverified': return 1
    case 'checked-shallow': return 2
    default: return 3
  }
}

function statusCopy(c: AuditChainFinding, levelScannable: boolean): string {
  switch (c.coverage) {
    case 'funded': return `Your ${c.symbol} is accounted for. If you expected more, check for funds on other accounts.`
    case 'unverified': return `We couldn’t reach ${c.symbol} just now — the balance above may be incomplete. Sync, or scan its paths directly.`
    case 'checked-shallow': return `We checked your main ${c.symbol} address. This chain can hold funds on other accounts we can’t see automatically — scan if you expected more.`
    default: return levelScannable ? `Nothing on your main ${c.symbol} address — and the next few accounts are empty too.` : `Nothing on your main ${c.symbol} address.`
  }
}

interface Ladder {
  autoScanned: boolean
  autoScanning: boolean
  scanning: boolean
  scanned: AuditDerivedAddress[]
  nextLevel: number
  showCommon: boolean
  showCustom: boolean
  customResults: AuditDerivedAddress[]
  extraFound: AuditDerivedAddress[]
  recovering: boolean
  recovered: string | null
  recoverErr: string | null
  showHandoff: boolean
  handoffNote: string
  scanErr: string | null
}

const EMPTY_LADDER: Ladder = {
  autoScanned: false, autoScanning: false, scanning: false, scanned: [], nextLevel: 1,
  showCommon: false, showCustom: false, customResults: [], extraFound: [], recovering: false,
  recovered: null, recoverErr: null, showHandoff: false, handoffNote: '', scanErr: null,
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
  const [btcTriggerFailed, setBtcTriggerFailed] = useState(false)

  const auditIdRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollingRef = useRef(false)
  const unmountedRef = useRef(false)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const filmRef = useRef<HTMLDivElement | null>(null)
  const btcTriggeredRef = useRef(false)

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
          if (r.status !== 'running') { stopPoll(); if (r.status === 'complete') setPhase('walkthrough') }
        } catch { /* transient */ }
        finally { pollingRef.current = false }
      }, 1500)
    } catch (e: any) { if (!unmountedRef.current) setError(e.message) }
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

  const walk = report ? [...report.chains].sort((a, b) => coverageRank(a) - coverageRank(b)) : []
  const current = walk[chainIdx]
  const ladder = current ? (ladders[current.chainId] || EMPTY_LADDER) : EMPTY_LADDER
  const currentDef = current ? catalog.current.get(current.chainId) : undefined
  const levelScannable = !!currentDef && currentDef.chainFamily !== 'utxo' && !['zcash-shielded', 'hive'].includes(currentDef.chainFamily)
  const hasCommon = current?.family === 'evm' || current?.chainId === 'bitcoin'

  const runScan = useCallback(async (chain: AuditChainFinding, fromLevel: number, count: number, markAuto: boolean) => {
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

  // Auto-scan accounts 1-3 on arrival (read-only; does NOT block close).
  useEffect(() => {
    if (phase !== 'walkthrough' || !current || !levelScannable) return
    const l = ladders[current.chainId]
    if (l?.autoScanned || l?.autoScanning || l?.scanning) return
    const t = setTimeout(() => runScan(current, 1, 3, true), 450)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current?.chainId, levelScannable])

  useEffect(() => {
    const el = filmRef.current?.querySelector('[data-current="true"]') as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [chainIdx, phase])

  // Lazy Bitcoin scan: trigger once when the user first opens the Bitcoin page.
  useEffect(() => {
    if (phase !== 'walkthrough' || current?.chainId !== 'bitcoin' || !report || !auditIdRef.current) return
    if (report.btcScanState === 'idle' && !btcTriggeredRef.current) {
      btcTriggeredRef.current = true
      setBtcTriggerFailed(false)
      rpcRequest('auditScanBtc', { auditId: auditIdRef.current }).catch(() => setBtcTriggerFailed(true))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current?.chainId, report?.btcScanState])

  // Retry a failed/stuck Bitcoin scan (error state OR a rejected trigger).
  const retryBtc = useCallback(() => {
    if (!auditIdRef.current) return
    btcTriggeredRef.current = true
    setBtcTriggerFailed(false)
    rpcRequest('auditScanBtc', { auditId: auditIdRef.current }).catch(() => setBtcTriggerFailed(true))
  }, [])

  // Poll for BTC scan progress while on the Bitcoin page and it's running.
  useEffect(() => {
    if (phase !== 'walkthrough' || current?.chainId !== 'bitcoin' || !auditIdRef.current) return
    if (report?.btcScanState !== 'idle' && report?.btcScanState !== 'scanning') return
    const id = auditIdRef.current
    const iv = setInterval(async () => {
      try {
        const r = await rpcRequest<AuditReport>('auditGetStatus', { auditId: id })
        if (unmountedRef.current) return
        setReport(r)
        if (r.btcScanState !== 'idle' && r.btcScanState !== 'scanning') clearInterval(iv)
      } catch { /* transient */ }
    }, 1200)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current?.chainId, report?.btcScanState])

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
      <Box bg="var(--ink-2)" borderRadius="lg" px="3.5" py="2.5">
        <Flex justify="space-between" align="center">
          <Text fontSize="sm" color="var(--text-1)">{a.level != null ? (chain.family === 'evm' ? `Address #${a.level}` : `Account #${a.level}`) : 'Custom path'}</Text>
          {a.balanceError
            ? <Text fontSize="sm" fontWeight="600" color="var(--rose)">couldn’t verify</Text>
            : <Text fontSize="sm" fontWeight="700" color={a.hasBalance ? 'var(--teal)' : 'var(--text-2)'}>{a.native} {a.symbol}</Text>}
        </Flex>
        <Flex justify="space-between" align="center" mt="1" gap="3">
          <Text flex="1" minW="0" fontSize="11px" fontFamily="mono" color="var(--text-3)" truncate title={`${a.pathStr} · ${a.address}`}>{a.pathStr} · {a.address}</Text>
          <HStack gap="3" flexShrink={0}>
            {a.explorerUrl && <Box as="button" fontSize="11px" color="var(--teal)" onClick={() => openUrl(a.explorerUrl!)}>explorer ↗</Box>}
            {a.hasBalance && canTrack && <Box as="button" fontSize="11px" color="var(--gold)" fontWeight="700" onClick={() => trackLevel(chain, a.level!)}>track</Box>}
          </HStack>
        </Flex>
        {fundedNoTrack && <Text fontSize="11px" color="var(--gold)" mt="1.5">Funds here, but KeepKey can’t track this path in-app. <Box as="button" textDecoration="underline" onClick={() => patchLadder(chain.chainId, { showHandoff: true })}>Send to support →</Box></Text>}
      </Box>
    )
  }

  const running = !report || report.status === 'running'
  const fundedScanned = ladder.scanned.filter(a => a.hasBalance || a.balanceError)
  const currentCaip = currentDef?.caip
  const currentAddr = current ? chainAddresses[current.chainId] : undefined
  const explorerForCurrent = (currentAddr && currentDef?.explorerAddressUrl) ? currentDef.explorerAddressUrl.replace('{{address}}', currentAddr) : null
  const scanningNow = ladder.scanning || ladder.autoScanning

  const btnOutline = {
    size: 'sm' as const, variant: 'outline' as const, borderColor: 'var(--line-2)', color: 'var(--text-1)', fontWeight: '600',
    _hover: { borderColor: 'var(--teal)', color: 'var(--teal)', bg: 'rgba(139,227,196,0.06)' }, transition: 'all 0.15s ease',
  }

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog || 1500} display="flex" alignItems="center" justifyContent="center" p="4">
      <style>{ANIM}</style>
      <Box position="absolute" inset="0" bg="blackAlpha.700" backdropFilter="blur(2px)" onClick={handleClose} />

      <Box position="relative" w="880px" maxW="94vw" maxH="90vh" overflow="auto"
        bg="var(--ink-1)" border="2px solid" borderColor="var(--gold)" borderRadius="xl" boxShadow="0 12px 48px rgba(0,0,0,0.6)">

        {/* Header */}
        <Box px="6" py="4" borderBottom="1px solid" borderColor="var(--ink-3)">
          <Flex align="center" justify="space-between">
            <Flex align="center" gap="2.5">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>
              <Box>
                <Text fontSize="lg" fontWeight="700" color="var(--teal)" letterSpacing="-0.01em" lineHeight="1.1">Audit balances</Text>
                <Text fontSize="xs" color="var(--text-2)">Let’s walk every chain and make sure nothing’s hiding.</Text>
              </Box>
            </Flex>
            <Flex align="center" gap="3">
              {phase === 'walkthrough' && <Text fontSize="sm" color="var(--text-2)" fontFamily="mono">{chainIdx + 1} / {walk.length}</Text>}
              <Box as="button" onClick={handleClose} color="var(--text-2)" _hover={{ color: "white" }} p="1" opacity={busy ? 0.3 : 1} cursor={busy ? "not-allowed" : "pointer"}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </Box>
            </Flex>
          </Flex>
        </Box>

        {/* Stale / error */}
        {stale && (
          <Box p="6"><VStack gap="3" align="stretch">
            <Text fontSize="sm" color="var(--gold)">The wallet changed while auditing — these results are no longer reliable.</Text>
            <Button size="sm" alignSelf="flex-start" bg="var(--gold)" color="black" fontWeight="700" _hover={{ bg: "var(--gold-2)" }} onClick={() => start('light')}>Re-run audit</Button>
          </VStack></Box>
        )}
        {!stale && error && <Box mx="6" mt="4" px="3.5" py="2.5" bg="rgba(224,140,123,0.08)" border="1px solid" borderColor="rgba(224,140,123,0.3)" borderRadius="md"><Text fontSize="sm" color="var(--rose)">{error}</Text></Box>}

        {/* Initial scanning */}
        {!stale && phase === 'scanning' && running && (
          <VStack gap="5" align="center" py="14" px="6">
            <Box w="84px" h="84px" borderRadius="full" bg="rgba(139,227,196,0.07)" border="2px solid" borderColor="var(--teal)" display="flex" alignItems="center" justifyContent="center" css={{ animation: "auditGlow 1.8s ease-in-out infinite" }}>
              <Spinner size="lg" color="var(--teal)" />
            </Box>
            <Text fontSize="md" color="var(--text-1)" textAlign="center" maxW="420px" lineHeight="1.6">
              {isHidden ? 'Auditing your hidden wallet — nothing is written to disk.' : 'Checking your funds across every chain. This only takes a moment.'}
            </Text>
            <VStack gap="2.5" align="stretch" w="100%" maxW="360px">
              {PHASES.map((p, i) => {
                const activeIdx = report ? PHASES.findIndex(x => x.key === report.phase) : 0
                const done = report ? i < activeIdx || report.status !== 'running' : false
                const active = report ? i === activeIdx && report.status === 'running' : i === 0
                return (
                  <Flex key={p.key} align="center" gap="3">
                    <Box w="22px" h="22px" borderRadius="full" display="flex" alignItems="center" justifyContent="center" bg={done ? 'var(--teal)' : active ? 'rgba(139,227,196,0.12)' : 'var(--ink-3)'}>
                      {done ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3.5"><polyline points="20 6 9 17 4 12" /></svg>
                        : active ? <Spinner size="xs" color="var(--teal)" /> : <Box w="5px" h="5px" borderRadius="full" bg="var(--text-3)" />}
                    </Box>
                    <Text fontSize="sm" color={active ? "var(--text-0)" : done ? "var(--text-2)" : "var(--text-3)"}>{active && report ? report.progress.label : p.label}</Text>
                  </Flex>
                )
              })}
            </VStack>
            {report?.status === 'aborted' && <Text fontSize="sm" color="var(--gold)">Scan stopped early ({report.error || 'device interrupted'}). <Box as="button" textDecoration="underline" onClick={() => start('light')}>Retry</Box></Text>}
          </VStack>
        )}

        {/* Walkthrough */}
        {!stale && phase === 'walkthrough' && current && (
          <Box>
            {/* progress + filmstrip */}
            <Box px="6" pt="4">
              <Box h="3px" bg="var(--ink-3)" borderRadius="full" overflow="hidden" mb="3">
                <Box h="100%" bg="var(--teal)" borderRadius="full" transition="width 0.3s" w={`${Math.round(((chainIdx + 1) / walk.length) * 100)}%`} />
              </Box>
              <Flex ref={filmRef} gap="2.5" overflowX="auto" pb="1" align="center" css={{ scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
                {walk.map((c, i) => {
                  const def = catalog.current.get(c.chainId)
                  const isCur = i === chainIdx
                  const visited = i < chainIdx
                  const ring = isCur ? 'var(--teal)' : c.coverage === 'funded' ? 'rgba(139,227,196,0.45)' : c.coverage === 'unverified' ? 'var(--rose)' : null
                  return (
                    <Box key={c.chainId} data-current={isCur} onClick={() => setChainIdx(i)} cursor="pointer" flexShrink={0} pt="1">
                      <ChainLogo caip={def?.caip} symbol={c.symbol} size={isCur ? 30 : 22} ring={ring}
                        dim={!isCur && !visited && c.coverage !== 'funded' && c.coverage !== 'unverified'}
                        done={visited && c.coverage !== 'unverified'} scanning={isCur && scanningNow} />
                    </Box>
                  )
                })}
              </Flex>
            </Box>

            {/* two-column body */}
            <Flex px="6" py="5" gap="6" align="stretch" direction={{ base: 'column', md: 'row' }}>
              {/* hero */}
              <VStack gap="2" w={{ base: '100%', md: '264px' }} flexShrink={0} textAlign="center" justify="flex-start" pt="2">
                <Box w="92px" h="92px" borderRadius="full" display="flex" alignItems="center" justifyContent="center" bg="rgba(139,227,196,0.05)"
                  css={scanningNow ? { animation: "auditGlow 1.8s ease-in-out infinite" } : undefined}>
                  <ChainLogo caip={currentCaip} symbol={current.symbol} size={56} scanning={scanningNow} ring={scanningNow ? 'var(--teal)' : null} />
                </Box>
                <Text fontSize="xl" fontWeight="700" color="white" mt="1">{current.symbol}</Text>
                <Text fontSize="2xl" fontWeight="800" color={current.balanceUsd > 0 ? 'var(--teal)' : 'var(--text-2)'} lineHeight="1">${current.balanceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</Text>
                <HStack gap="2.5" mt="0.5">
                  <Text fontSize="11px" color={COVERAGE_STYLE[current.coverage].color}>{COVERAGE_STYLE[current.coverage].label}</Text>
                  {explorerForCurrent && <Box as="button" fontSize="11px" color="var(--teal)" onClick={() => openUrl(explorerForCurrent)}>explorer ↗</Box>}
                </HStack>
              </VStack>

              {/* content */}
              <Box flex="1" minW="0">
                <Text fontSize="sm" color="var(--text-1)" lineHeight="1.6" mb="3">
                  {scanningNow && !ladder.autoScanned ? `Checking the first few ${current.symbol} accounts…` : statusCopy(current, levelScannable)}
                </Text>

                {/* BTC lazy scan — runs when you open the Bitcoin page */}
                {current.chainId === 'bitcoin' && (report?.btcScanState === 'scanning' || (report?.btcScanState === 'idle' && !btcTriggerFailed)) && (
                  <Flex align="center" gap="3" bg="var(--ink-2)" borderRadius="lg" p="3.5" mb="3">
                    <Spinner size="sm" color="var(--gold)" />
                    <Box minW="0">
                      <Text fontSize="sm" color="var(--text-1)">Scanning your Bitcoin paths for stranded funds…</Text>
                      {report?.btcScanState === 'scanning' && report.progress.total > 1 && <Text fontSize="11px" color="var(--text-3)">{report.progress.label} {report.progress.current}/{report.progress.total}</Text>}
                    </Box>
                  </Flex>
                )}
                {current.chainId === 'bitcoin' && (report?.btcScanState === 'error' || (report?.btcScanState === 'idle' && btcTriggerFailed)) && (
                  <Flex align="center" justify="space-between" bg="rgba(224,140,123,0.08)" border="1px solid" borderColor="rgba(224,140,123,0.25)" borderRadius="lg" p="3" mb="3" gap="3">
                    <Text fontSize="sm" color="var(--rose)">{report?.btcScanState === 'error' ? 'Bitcoin scan stopped early.' : 'Couldn’t start the Bitcoin scan.'}</Text>
                    <Box as="button" fontSize="xs" color="var(--teal)" fontWeight="600" flexShrink={0} onClick={retryBtc}>Retry</Box>
                  </Flex>
                )}

                {/* BTC findings (after the scan completes) */}
                {current.chainId === 'bitcoin' && report?.btcScanState === 'done' && report.btc.findings.some(f => f.category !== 'higher-account') && (
                  <Box bg="rgba(233,196,106,0.07)" border="1px solid" borderColor="rgba(233,196,106,0.22)" borderRadius="lg" p="3.5" mb="3">
                    <Text fontSize="sm" fontWeight="700" color="var(--gold)">{formatSats(report.btc.findings.filter(f => f.category !== 'higher-account').reduce((s, f) => s + f.balanceSats, 0))} on non-standard paths</Text>
                    <Text fontSize="xs" color="var(--text-2)" mt="0.5" mb="2.5">Stranded by a wallet bug — we can sweep it to your main address.</Text>
                    {sweepPreview ? (
                      <>
                        <Box bg="var(--ink-2)" borderRadius="md" p="2.5" mb="2.5"><Flex justify="space-between"><Text fontSize="xs" color="var(--text-2)">You receive</Text><Text fontSize="xs" fontWeight="700" color="var(--gold)">{formatSats(sweepPreview.outputSats)}</Text></Flex></Box>
                        <Flex gap="2"><Button flex="1" size="sm" variant="ghost" color="var(--text-2)" onClick={() => setSweepPreview(null)}>Back</Button><Button flex="1" size="sm" bg="var(--gold)" color="black" fontWeight="700" loading={sweeping} onClick={sweepConfirm}>Confirm & broadcast</Button></Flex>
                      </>
                    ) : <Button size="sm" w="100%" bg="var(--gold)" color="black" fontWeight="700" _hover={{ bg: "var(--gold-2)" }} loading={sweeping} onClick={sweepDryRun}>Sweep to main address</Button>}
                  </Box>
                )}
                {current.chainId === 'bitcoin' && report?.btcScanState === 'done' && report.btc.higherAccountMax > 0 && (
                  <Button size="sm" w="100%" mb="3" bg="var(--teal)" color="black" fontWeight="700" _hover={{ bg: "var(--teal-2)" }} loading={ladder.recovering} onClick={() => trackLevel(current, report.btc.higherAccountMax)}>Track Bitcoin accounts up to #{report.btc.higherAccountMax}</Button>
                )}
                {current.chainId === 'bitcoin' && report?.btcScanState === 'done' && report.btc.findings.length === 0 && (
                  <Text fontSize="sm" color="var(--teal)" mb="3">✓ No funds stranded on non-standard Bitcoin paths.</Text>
                )}

                {/* auto-scan finds */}
                {fundedScanned.length > 0 && <VStack gap="2" align="stretch" mb="3">{fundedScanned.map((a, i) => <AddrRow key={`f${i}`} chain={current} a={a} />)}</VStack>}
                {ladder.recovered && <Box bg="rgba(139,227,196,0.08)" border="1px solid" borderColor="rgba(139,227,196,0.2)" borderRadius="md" p="2.5" mb="3"><Text fontSize="sm" color="var(--teal)">{ladder.recovered}</Text></Box>}
                {ladder.recoverErr && <Text fontSize="sm" color="var(--rose)" mb="2">{ladder.recoverErr}</Text>}
                {ladder.scanErr && <Text fontSize="sm" color="var(--rose)" mb="2">{ladder.scanErr}</Text>}

                {/* deeper account levels (only the empty ones — funded shown above) */}
                {ladder.scanned.filter(a => !a.hasBalance && !a.balanceError).length > 0 && (
                  <VStack gap="2" align="stretch" mb="3" maxH="180px" overflow="auto">
                    {ladder.scanned.filter(a => !a.hasBalance && !a.balanceError).map((a, i) => <AddrRow key={`s${i}`} chain={current} a={a} />)}
                  </VStack>
                )}

                {/* common (other-wallet) paths */}
                {ladder.showCommon && current.family === 'evm' && <Box mb="3"><AuditKnownPaths chainId={current.chainId} defaultAddress={currentAddr} onFound={(r) => pushExtra(current.chainId, r)} onOpenUrl={openUrl} /></Box>}
                {ladder.showCommon && current.chainId === 'bitcoin' && <Box mb="3"><Text fontSize="11px" color="var(--text-2)" textTransform="uppercase" letterSpacing="0.08em" mb="1.5">Deep Bitcoin scans</Text><AuditBtcDeep onRecovered={() => onRecovered?.()} /></Box>}

                {/* custom + inspector */}
                {ladder.showCustom && currentDef && (
                  <Box mb="3">
                    <AuditCustomPath chainId={current.chainId} family={currentDef.chainFamily} defaultPath={currentDef.defaultPath} scriptType={currentDef.scriptType} onResult={(r) => pushCustom(current.chainId, r)} />
                    {ladder.customResults.map((a, i) => <Box key={`c${i}`} mt="2"><AddrRow chain={current} a={a} /></Box>)}
                    <Box mt="2"><AuditInspector chainId={current.chainId} family={currentDef.chainFamily} defaultPath={currentDef.defaultPath} scriptType={currentDef.scriptType} onOpenUrl={openUrl} /></Box>
                  </Box>
                )}

                {/* handoff */}
                {ladder.showHandoff && (
                  <Box bg="var(--ink-2)" borderRadius="lg" p="3.5" mb="3">
                    <Text fontSize="sm" color="var(--text-1)" mb="2">We’ll bundle everything we checked into a report you can hand to support.</Text>
                    <Textarea size="sm" placeholder="What balance did you expect? (optional)" value={ladder.handoffNote} onChange={e => patchLadder(current.chainId, { handoffNote: e.target.value })} bg="var(--ink-1)" border="1px solid" borderColor="var(--ink-3)" fontSize="sm" rows={2} mb="2.5" />
                    <Button size="sm" w="100%" bg="var(--teal)" color="black" fontWeight="700" _hover={{ bg: "var(--teal-2)" }} onClick={() => copyHandoff(current, ladder, current.balanceUsd)}>Copy report & open support ↗</Button>
                  </Box>
                )}

                {/* action buttons */}
                <Flex gap="2" wrap="wrap" mt="1">
                  {levelScannable && <Button {...btnOutline} loading={ladder.scanning} onClick={() => runScan(current, ladder.nextLevel, 3, false)}>Scan more accounts</Button>}
                  {hasCommon && <Button {...btnOutline} onClick={() => patchLadder(current.chainId, { showCommon: !ladder.showCommon })}>{current.family === 'evm' ? 'Scan common wallet paths' : 'Scan unusual paths'}</Button>}
                  <Button {...btnOutline} onClick={() => patchLadder(current.chainId, { showCustom: !ladder.showCustom })}>Scan a custom path</Button>
                  {!ladder.showHandoff && <Button size="sm" variant="ghost" color="var(--text-2)" fontWeight="600" _hover={{ color: "white" }} onClick={() => patchLadder(current.chainId, { showHandoff: true })}>Still missing?</Button>}
                </Flex>
              </Box>
            </Flex>

            {/* footer nav */}
            <Flex px="6" py="4" gap="3" align="center" justify="space-between" borderTop="1px solid" borderColor="var(--ink-3)">
              <Button size="sm" variant="ghost" color="var(--text-2)" fontWeight="600" disabled={chainIdx === 0} _hover={{ color: "white" }} onClick={() => setChainIdx(Math.max(0, chainIdx - 1))}>← Back</Button>
              <Button size="lg" px="8" bg="var(--teal)" color="black" fontWeight="700" _hover={{ bg: "var(--teal-2)", transform: "translateY(-1px)", boxShadow: "0 4px 14px rgba(139,227,196,0.3)" }} _active={{ transform: "scale(0.98)" }} transition="all 0.15s ease"
                onClick={() => { if (chainIdx + 1 < walk.length) setChainIdx(chainIdx + 1); else handleClose() }}>
                {chainIdx + 1 < walk.length ? 'Looks right ✓' : 'Finish ✓'}
              </Button>
              <Button size="sm" variant="ghost" color="var(--text-2)" fontWeight="600" visibility={chainIdx + 1 < walk.length ? 'visible' : 'hidden'} _hover={{ color: "white" }} onClick={() => setChainIdx(chainIdx + 1)}>Skip →</Button>
            </Flex>
          </Box>
        )}
      </Box>
    </Box>
  )
}
