/**
 * AuditDialog — the "where's my money" recovery wizard.
 *
 * A large guided dialog (onboarding-wizard feel) in three acts:
 *   1. SCAN  — a brief, honest confidence beat. The backend audit is lazy
 *      (identity check + coverage classify, both fast), so this is intentionally
 *      minimal: verify the device, light up the chains, hand off to the walk.
 *      No fake multi-step "scanning Bitcoin paths…" — that work runs per page.
 *   2. WALK  — one chain per page. A coin-roll carousel pins the current chain;
 *      the body explains coverage and offers real recovery (sweep stranded BTC,
 *      track higher accounts, scan common/custom paths, support handoff).
 *   3. FINISH — a summary: total verified, what we recovered, per-chain status.
 *
 * Honest by construction: degraded/stale → "couldn't verify" (never "$0/clean");
 * single-address chains → "primary address only"; failed lookups → "couldn't
 * verify". Recovery is on-device; non-trackable finds route to a support handoff.
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button, VStack, HStack, Spinner, Textarea, Image } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { ChainLogo } from "./ChainLogo"
import { getAssetIcon } from "../../shared/assetLookup"
import { AuditCustomPath } from "./AuditCustomPath"
import { AuditKnownPaths } from "./AuditKnownPaths"
import { AuditBtcDeep } from "./AuditBtcDeep"
import { AuditInspector } from "./AuditInspector"
import type { ChainDef } from "../../shared/chains"
import type { AuditReport, AuditPortfolioSnapshot, AuditMode, AuditChainFinding, AuditDerivedAddress } from "../../shared/types"

const SUPPORT_URL = "https://support.keepkey.com"
const ANIM = `
  @keyframes auditPulse { 0%,100% { box-shadow: 0 0 0 2px rgba(233,196,106,0.55); } 50% { box-shadow: 0 0 0 6px rgba(233,196,106,0.10); } }
  @keyframes auditGlow { 0%,100% { box-shadow: 0 0 14px rgba(233,196,106,0.18); } 50% { box-shadow: 0 0 34px rgba(233,196,106,0.45); } }
  @keyframes auditSonar { 0% { transform: scale(0.5); opacity: 0.7; } 100% { transform: scale(2.7); opacity: 0; } }
  @keyframes auditGold { 0%,100% { box-shadow: 0 0 24px rgba(233,196,106,0.24); } 50% { box-shadow: 0 0 50px rgba(233,196,106,0.5); } }
  @keyframes auditPop { 0% { opacity: 0; transform: scale(0.96) translateY(8px); } 60% { transform: scale(1.012) translateY(0); } 100% { opacity: 1; transform: scale(1); } }
  @keyframes auditRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
`

function formatSats(sats: number): string {
  if (sats >= 100_000_000) return (sats / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' BTC'
  return sats.toLocaleString() + ' sats'
}
function usd(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const COVERAGE_PILL: Record<AuditChainFinding['coverage'], { label: string; color: string; bg: string; border: string }> = {
  'funded': { label: 'funded', color: 'var(--teal)', bg: 'rgba(139,227,196,0.12)', border: 'rgba(139,227,196,0.28)' },
  'empty-confirmed': { label: 'empty', color: 'var(--text-2)', bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.10)' },
  'checked-shallow': { label: 'primary address only', color: 'var(--gold)', bg: 'rgba(233,196,106,0.12)', border: 'rgba(233,196,106,0.28)' },
  'unverified': { label: 'couldn’t verify', color: 'var(--rose)', bg: 'rgba(224,140,123,0.12)', border: 'rgba(224,140,123,0.28)' },
}

// Walk the chains people actually hold first — Bitcoin, then Ethereum, then the
// majors — so the audit front-loads what matters and leaves the long tail last.
// (Ordering only; every classified chain is still walked.)
const WALK_ORDER = [
  'bitcoin', 'ethereum', 'ripple', 'solana', 'dogecoin', 'litecoin', 'bitcoincash',
  'thorchain', 'cosmos', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc',
  'avalanche', 'gnosis', 'osmosis', 'mayachain', 'dash', 'zcash', 'tron', 'ton',
  'digibyte', 'monad', 'hyperliquid', 'hive',
]
function walkRank(chainId: string): number {
  const i = WALK_ORDER.indexOf(chainId)
  return i === -1 ? WALK_ORDER.length : i
}

// Human-readable token amount — trims long decimal tails to 6 significant places.
function fmtAmt(s: string): string {
  const n = parseFloat(s)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : s
}

/** Split a CAIP-19 ("eip155:1/slip44:60") into its chain + asset halves. */
function parseCaip(caip: string): { chain: string; asset: string | null } {
  const slash = caip.indexOf('/')
  return slash === -1 ? { chain: caip, asset: null } : { chain: caip.slice(0, slash), asset: caip.slice(slash + 1) }
}

/** The full CAIP shown as a mono chip, with a tap-to-open "what's a CAIP?"
 *  popover that breaks it into its chain and asset halves. */
function CaipBadge({ caip }: { caip: string }) {
  const [open, setOpen] = useState(false)
  const { chain, asset } = parseCaip(caip)
  return (
    <Box position="relative" display="inline-flex">
      <Flex as="button" align="center" gap="1.5" px="2" py="1px" borderRadius="full" bg="var(--ink-2)"
        border="1px solid" borderColor={open ? 'var(--gold)' : 'var(--line)'} _hover={{ borderColor: 'var(--gold)' }}
        onClick={() => setOpen(o => !o)}>
        <Text fontSize="11px" fontFamily="mono" color="var(--text-2)">{caip}</Text>
        <Box w="13px" h="13px" borderRadius="full" border="1px solid" borderColor="var(--text-3)" color="var(--text-3)"
          fontSize="9px" fontWeight="700" fontFamily="serif" lineHeight="1" display="flex" alignItems="center" justifyContent="center">i</Box>
      </Flex>
      {open && (
        <>
          <Box position="fixed" inset="0" zIndex={1} onClick={() => setOpen(false)} />
          <Box position="absolute" bottom="calc(100% + 9px)" left="50%" transform="translateX(-50%)" zIndex={2} w="320px"
            bg="var(--ink-4)" border="1px solid" borderColor="rgba(233,196,106,0.35)" borderRadius="14px" p="4" textAlign="left"
            boxShadow="0 16px 44px rgba(0,0,0,0.55)">
            <Text fontSize="13px" fontWeight="700" color="var(--gold)" mb="1.5">What’s a CAIP?</Text>
            <Text fontSize="12px" color="var(--text-1)" lineHeight="1.55" mb="3">
              A Chain-Agnostic identifier — it names this asset the same way everywhere, so ETH on Ethereum is never confused with ETH on Arbitrum.
            </Text>
            <VStack gap="1.5" align="stretch" mb="3">
              <Flex justify="space-between" gap="3" align="center">
                <Text fontSize="11px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.06em">chain</Text>
                <Text fontSize="11.5px" fontFamily="mono" color="var(--text-0)">{chain}</Text>
              </Flex>
              {asset && (
                <Flex justify="space-between" gap="3" align="center">
                  <Text fontSize="11px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.06em">asset</Text>
                  <Text fontSize="11.5px" fontFamily="mono" color="var(--text-0)">{asset}</Text>
                </Flex>
              )}
            </VStack>
            <Text fontSize="11px" color="var(--text-3)" lineHeight="1.5">KeepKey and Pioneer use CAIPs internally for every balance and address.</Text>
          </Box>
        </>
      )}
    </Box>
  )
}

function statusCopy(c: AuditChainFinding, levelScannable: boolean): string {
  switch (c.coverage) {
    case 'funded': return `Your ${c.symbol} is accounted for. If you expected more, scan deeper below — we’ll check every account.`
    case 'unverified': return `We couldn’t reach ${c.symbol}’s node just now — so we won’t pretend it’s empty. The number above may be incomplete. Confirm it before moving on.`
    case 'checked-shallow': return `We checked your main ${c.symbol} address. This chain can hold funds on accounts we can’t see automatically — look deeper if you expected more.`
    default: return levelScannable ? `Nothing on your main ${c.symbol} address — and the next few accounts are empty too. You’re all set here.` : `Nothing on your main ${c.symbol} address.`
  }
}
function finishStatus(c: AuditChainFinding): { label: string; color: string } {
  switch (c.coverage) {
    case 'funded': return { label: 'verified', color: 'var(--teal)' }
    case 'unverified': return { label: 'confirm in wallet', color: 'var(--rose)' }
    case 'checked-shallow': return { label: 'primary address', color: 'var(--gold)' }
    default: return { label: 'empty — confirmed', color: 'var(--text-2)' }
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
  showEmpties: boolean
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
  showCommon: false, showCustom: false, showEmpties: false, customResults: [], extraFound: [], recovering: false,
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
  const [phase, setPhase] = useState<'scanning' | 'walkthrough' | 'finish'>('scanning')
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
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const btcTriggeredRef = useRef(false)

  const catalog = useRef(new Map<string, ChainDef>())
  catalog.current = new Map(chainCatalog.map(c => [c.id, c]))

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    pollingRef.current = false
  }, [])

  const start = useCallback(async (m: AuditMode) => {
    stopPoll()
    btcTriggeredRef.current = false
    setReport(null); setError(null); setStale(false); setPhase('scanning'); setChainIdx(0); setLadders({}); setSweepPreview(null); setBtcTriggerFailed(false)
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
          // Do NOT auto-advance — the scan screen reveals "Walk me through it"
          // when complete and lets the user enter on their own beat.
          if (r.status !== 'running') stopPoll()
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
  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) })
  }, [])
  const scrollTop = useCallback(() => {
    requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollTo({ top: 0 }) })
  }, [])

  const walk = report ? [...report.chains].sort((a, b) => walkRank(a.chainId) - walkRank(b.chainId)) : []
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
      // Honest persistence promise: EVM indices are written to disk (show from
      // now on); BTC accounts are NOT persisted yet (session only); hidden-wallet
      // indices are never persisted by design.
      const recovered = isHidden
        ? `Tracking for this session.`
        : chain.chainId === 'bitcoin'
          ? `Tracking for now — re-run the audit after you reconnect to bring it back.`
          : `Added — it’ll show in your portfolio from now on.`
      patchLadder(chain.chainId, { recovering: false, recovered })
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
      patchLadder('bitcoin', { recovered: `Swept ${formatSats(res.outputSats)} home — txid ${String(res.txid).slice(0, 12)}…` })
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

  // Navigation
  const goWalk = useCallback(() => { setPhase('walkthrough'); scrollTop() }, [scrollTop])
  const goChain = useCallback((i: number) => { setChainIdx(i); scrollTop() }, [scrollTop])
  const advance = useCallback(() => {
    if (chainIdx + 1 < walk.length) { setChainIdx(chainIdx + 1); scrollTop() }
    else setPhase('finish')
  }, [chainIdx, walk.length, scrollTop])

  const running = !report || report.status === 'running'
  const scanReady = !!report && report.status === 'complete'
  const finds = [...ladder.scanned, ...ladder.extraFound, ...ladder.customResults]
  const fundedFinds = finds.filter(a => a.hasBalance)
  const errFinds = finds.filter(a => a.balanceError)
  const emptyFinds = finds.filter(a => !a.hasBalance && !a.balanceError)
  const checkedPrimary = finds.some(a => a.level === 0)
  const currentDef0 = currentDef
  const currentCaip = currentDef0?.caip
  const currentAddr = current ? chainAddresses[current.chainId] : undefined
  const explorerForCurrent = (currentAddr && currentDef0?.explorerAddressUrl) ? currentDef0.explorerAddressUrl.replace('{{address}}', currentAddr) : null
  const scanningNow = ladder.scanning || ladder.autoScanning

  // Constellation source — real chains if classified, else the enabled catalog.
  const constChains = report?.chains?.length
    ? report.chains.map(c => ({ chainId: c.chainId, symbol: c.symbol, caip: catalog.current.get(c.chainId)?.caip }))
    : chainCatalog.filter(c => !c.hidden).map(c => ({ chainId: c.id, symbol: c.symbol, caip: c.caip }))

  // Finish totals. NB: the sum includes chains we couldn't verify (degraded/
  // stale), so it's only labelled "verified" when none are unverified — otherwise
  // it's "Total balance" (honest: some figures may be incomplete).
  const totalBalance = walk.reduce((t, c) => t + c.balanceUsd, 0)
  const recoveredCount = walk.filter(c => ladders[c.chainId]?.recovered).length

  const chip = {
    display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
    background: 'var(--ink-4)', border: '1px solid var(--line-2)', borderRadius: '10px',
    padding: '9px 15px', fontSize: '12.5px', color: 'var(--text-1)', whiteSpace: 'nowrap' as const,
  }
  const goldBtn = {
    bg: 'var(--gold)', color: 'var(--ink-0)', fontWeight: '700',
    _hover: { bg: 'var(--gold-2)' }, transition: 'all 0.15s ease',
  }

  const AddrRow = ({ chain, a, gold }: { chain: AuditChainFinding; a: AuditDerivedAddress; gold?: boolean }) => {
    const canTrack = (chain.chainId === 'bitcoin' || chain.family === 'evm') && a.level != null
    const fundedNoTrack = a.hasBalance && !canTrack
    return (
      <Box bg={gold ? 'var(--ink-1)' : 'var(--ink-3)'} border="1px solid" borderColor={gold ? 'rgba(233,196,106,0.22)' : 'var(--line)'} borderRadius="12px" px="3.5" py="3">
        <Flex justify="space-between" align="center" gap="3">
          <Text fontSize="sm" color="var(--text-0)" whiteSpace="nowrap">{a.level != null ? (chain.family === 'evm' ? `Address #${a.level}` : `Account #${a.level}`) : 'Custom path'}</Text>
          {a.balanceError
            ? <Text fontSize="sm" fontWeight="600" color="var(--rose)" whiteSpace="nowrap">couldn’t verify</Text>
            : <Text fontSize="sm" fontWeight="700" whiteSpace="nowrap" color={parseFloat(a.native) > 0 ? 'var(--gold)' : 'var(--text-2)'}>{fmtAmt(a.native)} {a.symbol}</Text>}
        </Flex>
        <Flex justify="space-between" align="center" mt="1.5" gap="3">
          <Text flex="1" minW="0" fontSize="11px" color="var(--text-3)" truncate title={`${a.pathStr} · ${a.address}`}>{a.pathStr} · {a.address}</Text>
          <HStack gap="3" flexShrink={0}>
            {a.explorerUrl && <Box as="button" fontSize="11px" color="var(--teal)" onClick={() => openUrl(a.explorerUrl!)}>explorer ↗</Box>}
            {a.hasBalance && canTrack && <Box as="button" fontSize="11px" color="var(--gold)" fontWeight="700" onClick={() => trackLevel(chain, a.level!)}>track</Box>}
          </HStack>
        </Flex>
        {a.tokens && a.tokens.length > 0 && (
          <VStack gap="1.5" align="stretch" mt="2.5" pt="2.5" borderTop="1px solid" borderColor={gold ? 'rgba(233,196,106,0.2)' : 'var(--line)'}>
            {a.tokens.map((t, i) => (
              <Flex key={i} align="center" justify="space-between" gap="3">
                <Flex align="center" gap="2" minW="0">
                  <Image src={getAssetIcon(t.caip)} alt={t.symbol} w="17px" h="17px" borderRadius="full" bg="var(--ink-2)" flexShrink={0} />
                  <Text fontSize="12px" color="var(--text-1)" truncate>{t.symbol}</Text>
                </Flex>
                <Text fontSize="12px" color="var(--text-1)" whiteSpace="nowrap">{fmtAmt(t.balance)} {t.symbol}{t.balanceUsd > 0 ? ` · ${usd(t.balanceUsd)}` : ''}</Text>
              </Flex>
            ))}
          </VStack>
        )}
        {fundedNoTrack && <Text fontSize="11px" color="var(--gold)" mt="1.5">Funds here, but KeepKey can’t track this path in-app. <Box as="button" textDecoration="underline" onClick={() => patchLadder(chain.chainId, { showHandoff: true })}>Send to support →</Box></Text>}
      </Box>
    )
  }

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog || 1500} display="flex" alignItems="center" justifyContent="center" p="4">
      <style>{ANIM}</style>
      <Box position="absolute" inset="0" bg="blackAlpha.700" backdropFilter="blur(3px)" onClick={handleClose} />

      <Flex position="relative" direction="column" w="1040px" maxW="96vw" h="min(880px, 94vh)" overflow="hidden"
        style={{ background: 'linear-gradient(180deg, var(--ink-4), var(--ink-3))' }}
        border="1px solid" borderColor="rgba(233,196,106,0.4)" borderRadius="24px" boxShadow="0 30px 90px rgba(0,0,0,0.66)">

        {/* Header */}
        <Flex flexShrink={0} px="7" py="4.5" align="center" justify="space-between" borderBottom="1px solid" borderColor="var(--line)">
          <Flex align="center" gap="3">
            <Box w="36px" h="36px" borderRadius="11px" display="flex" alignItems="center" justifyContent="center"
              style={{ background: 'linear-gradient(145deg, var(--ink-4), var(--ink-3))' }} border="1px solid" borderColor="rgba(233,196,106,0.42)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2.5" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            </Box>
            <Box>
              <Text fontSize="lg" fontWeight="700" color="var(--gold)" letterSpacing="-0.01em" lineHeight="1.15">Audit balances</Text>
              <Text fontSize="xs" color="var(--text-2)">Let’s walk every chain and make sure nothing’s hiding.</Text>
            </Box>
          </Flex>
          <Flex align="center" gap="4">
            {phase === 'walkthrough' && <Text fontSize="sm" color="var(--text-2)">{chainIdx + 1} / {walk.length}</Text>}
            {phase !== 'scanning' && (
              <Box as="button" onClick={() => start('light')} color="var(--text-3)" _hover={{ color: "var(--text-0)" }} title="Restart audit" opacity={busy ? 0.3 : 1} cursor={busy ? "not-allowed" : "pointer"}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
              </Box>
            )}
            <Box as="button" onClick={handleClose} color="var(--text-3)" _hover={{ color: "var(--text-0)" }} opacity={busy ? 0.3 : 1} cursor={busy ? "not-allowed" : "pointer"}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </Box>
          </Flex>
        </Flex>

        {/* Stale / error banners (shown above any phase) */}
        {stale && (
          <Box p="6"><VStack gap="3" align="stretch">
            <Text fontSize="sm" color="var(--gold)">The wallet changed while auditing — these results are no longer reliable.</Text>
            <Button size="sm" alignSelf="flex-start" {...goldBtn} onClick={() => start('light')}>Re-run audit</Button>
          </VStack></Box>
        )}
        {!stale && error && <Box mx="7" mt="4" px="3.5" py="2.5" bg="rgba(224,140,123,0.08)" border="1px solid" borderColor="rgba(224,140,123,0.3)" borderRadius="md"><Text fontSize="sm" color="var(--rose)">{error}</Text></Box>}

        {/* ============ SCAN PHASE ============ */}
        {!stale && phase === 'scanning' && (
          <Flex flex="1" direction="column" align="center" justify="center" px="6" py="8" overflow="auto">
            <Box position="relative" w="300px" h="300px" flexShrink={0} mb="2">
              {/* sonar rings */}
              {running && [0, 0.85, 1.7].map((d, i) => (
                <Box key={i} position="absolute" inset="0" m="auto" w="120px" h="120px" borderRadius="full" border="1px solid" borderColor="rgba(233,196,106,0.4)" css={{ animation: `auditSonar 2.6s ${d}s ease-out infinite` }} />
              ))}
              {/* center lock */}
              <Box position="absolute" inset="0" m="auto" w="84px" h="84px" borderRadius="22px" display="flex" alignItems="center" justifyContent="center"
                style={{ background: 'linear-gradient(145deg, var(--ink-4), var(--ink-3))' }} border="1px solid" borderColor="rgba(233,196,106,0.5)" css={{ animation: "auditGold 2s ease-in-out infinite" }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2.5" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              </Box>
              {/* constellation */}
              {constChains.map((c, i) => {
                const N = constChains.length, R = 116, CX = 150, CY = 150
                const ang = (i / N) * Math.PI * 2 - Math.PI / 2
                const x = Math.round(CX + Math.cos(ang) * R - 17), y = Math.round(CY + Math.sin(ang) * R - 17)
                return (
                  <Box key={c.chainId} position="absolute" left={`${x}px`} top={`${y}px`} css={scanReady ? { animation: "auditPop 0.5s cubic-bezier(0.16,1,0.3,1) both" } : undefined}>
                    <ChainLogo caip={c.caip} symbol={c.symbol} size={34} dim={!scanReady} ring={scanReady ? 'rgba(233,196,106,0.6)' : null} />
                  </Box>
                )
              })}
            </Box>

            <Box textAlign="center" maxW="460px" mb="2">
              <Text fontSize="lg" color="var(--text-0)" lineHeight="1.5">{scanReady ? 'All chains lined up.' : 'Checking your funds across every chain.'}</Text>
              <Text fontSize="sm" color="var(--text-2)" mt="2" lineHeight="1.55">
                {scanReady
                  ? 'Nothing’s hiding that we couldn’t reach. Let’s walk through them together, chain by chain.'
                  : isHidden ? 'Auditing your hidden wallet — nothing is written to disk.' : 'Reading your device and lining up every chain. Nothing is written to disk.'}
              </Text>
            </Box>

            <Box mt="6" minH="52px" display="flex" alignItems="center">
              {report && report.status !== 'running' && report.status !== 'complete'
                ? <Text fontSize="sm" color="var(--gold)">Scan stopped early ({report.error || 'device interrupted'}). <Box as="button" textDecoration="underline" onClick={() => start('light')}>Retry</Box></Text>
                : scanReady
                  ? <Button size="lg" px="9" py="6" borderRadius="full" {...goldBtn} boxShadow="0 8px 26px -8px rgba(233,196,106,0.6)" onClick={goWalk}>
                      Walk me through it
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 8 }}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    </Button>
                  : <Spinner size="md" color="var(--gold)" />}
            </Box>
          </Flex>
        )}

        {/* ============ WALKTHROUGH PHASE ============ */}
        {!stale && phase === 'walkthrough' && current && (
          <Flex direction="column" flex="1" minH="0">

            {/* pinned: progress + coin roll + identity */}
            <Box flexShrink={0} px="7" pt="4.5" pb="5" borderBottom="1px solid" borderColor="var(--line)">
              <Box h="3px" bg="var(--ink-2)" borderRadius="full" overflow="hidden" mb="5">
                <Box h="100%" borderRadius="full" transition="width 0.45s cubic-bezier(0.16,1,0.3,1)" w={`${Math.round(((chainIdx + 1) / walk.length) * 100)}%`} style={{ background: 'linear-gradient(90deg, var(--gold), var(--gold-2))' }} />
              </Box>

              {/* coin roll (windowed around current) */}
              <Flex align="center" justify="center" gap="4.5" h="74px" css={{ WebkitMaskImage: 'linear-gradient(90deg,transparent,#000 16%,#000 84%,transparent)', maskImage: 'linear-gradient(90deg,transparent,#000 16%,#000 84%,transparent)' }}>
                {(() => {
                  const out: any[] = []
                  for (let off = -2; off <= 2; off++) {
                    const i = chainIdx + off
                    if (i < 0 || i >= walk.length) continue
                    const c = walk[i]
                    const def = catalog.current.get(c.chainId)
                    const cur0 = off === 0
                    const size = cur0 ? 66 : Math.abs(off) === 1 ? 44 : 32
                    const ring = cur0 ? 'var(--gold)' : i < chainIdx ? 'rgba(139,227,196,0.5)' : null
                    out.push(
                      <Box key={c.chainId} onClick={() => goChain(i)} cursor="pointer" opacity={cur0 ? 1 : Math.abs(off) === 1 ? 0.6 : 0.32} transition="all 0.4s cubic-bezier(0.16,1,0.3,1)" css={cur0 ? { animation: "auditGlow 2.4s ease-in-out infinite" } : undefined} borderRadius="full">
                        <ChainLogo caip={def?.caip} symbol={c.symbol} size={size} ring={ring} scanning={cur0 && scanningNow} />
                      </Box>
                    )
                  }
                  return out
                })()}
              </Flex>

              {/* identity */}
              <Box textAlign="center" mt="3.5">
                <Flex align="baseline" justify="center" gap="2.5">
                  <Text fontSize="xl" fontWeight="700" color="var(--text-0)">{currentDef?.coin ?? current.symbol}</Text>
                  <Text fontSize="13px" fontWeight="600" color="var(--text-3)">{current.symbol}</Text>
                  <Text fontSize="2xl" fontWeight="700" color={current.balanceUsd > 0 ? 'var(--teal)' : 'var(--text-2)'}>{usd(current.balanceUsd)}</Text>
                </Flex>
                <HStack gap="2.5" justify="center" mt="2" wrap="wrap">
                  <Flex align="center" gap="1.5" px="3" py="1" borderRadius="full" fontSize="11.5px" bg={COVERAGE_PILL[current.coverage].bg} color={COVERAGE_PILL[current.coverage].color} border="1px solid" borderColor={COVERAGE_PILL[current.coverage].border}>
                    <Box w="6px" h="6px" borderRadius="full" bg={COVERAGE_PILL[current.coverage].color} />{COVERAGE_PILL[current.coverage].label}
                  </Flex>
                  {currentCaip && <CaipBadge key={currentCaip} caip={currentCaip} />}
                  {explorerForCurrent && <Box as="button" fontSize="11.5px" color="var(--text-3)" _hover={{ color: "var(--teal)" }} onClick={() => openUrl(explorerForCurrent)}>explorer ↗</Box>}
                </HStack>
              </Box>
            </Box>

            {/* scrolling content */}
            <Box ref={scrollRef} flex="1" overflow="auto" px="7" pt="5" pb="2" minH="0">
              <Box maxW="640px" mx="auto">
                <Text fontSize="sm" color="var(--text-1)" lineHeight="1.65" textAlign="center" mb="4.5">
                  {scanningNow && !ladder.autoScanned ? `Checking the first few ${current.symbol} accounts…` : statusCopy(current, levelScannable)}
                </Text>

                {/* BTC lazy scan — runs when you open the Bitcoin page */}
                {current.chainId === 'bitcoin' && (report?.btcScanState === 'scanning' || (report?.btcScanState === 'idle' && !btcTriggerFailed)) && (
                  <Flex align="center" gap="3" bg="var(--ink-3)" borderRadius="13px" p="3.5" mb="4">
                    <Spinner size="sm" color="var(--gold)" />
                    <Box minW="0">
                      <Text fontSize="sm" color="var(--text-0)">Scanning your Bitcoin paths for stranded funds…</Text>
                      {report?.btcScanState === 'scanning' && report.progress.total > 1 && <Text fontSize="11px" color="var(--text-3)">{report.progress.label} {report.progress.current}/{report.progress.total}</Text>}
                    </Box>
                  </Flex>
                )}
                {current.chainId === 'bitcoin' && (report?.btcScanState === 'error' || (report?.btcScanState === 'idle' && btcTriggerFailed)) && (
                  <Flex align="center" justify="space-between" bg="rgba(224,140,123,0.09)" border="1px solid" borderColor="rgba(224,140,123,0.28)" borderRadius="13px" p="3.5" mb="4" gap="3">
                    <Text fontSize="sm" color="var(--rose)">{report?.btcScanState === 'error' ? 'Bitcoin scan stopped early.' : 'Couldn’t start the Bitcoin scan.'}</Text>
                    <Box as="button" fontSize="xs" color="var(--teal)" fontWeight="700" flexShrink={0} onClick={retryBtc}>Try again</Box>
                  </Flex>
                )}

                {/* BTC sweep recovery (after the scan completes) */}
                {current.chainId === 'bitcoin' && report?.btcScanState === 'done' && report.btc.findings.some(f => f.category !== 'higher-account') && (
                  <Box style={{ background: 'linear-gradient(135deg, rgba(233,196,106,0.12), rgba(233,196,106,0.04))' }} border="1px solid" borderColor="rgba(233,196,106,0.3)" borderRadius="16px" p="4.5" mb="4" css={{ animation: "auditPop 0.5s cubic-bezier(0.16,1,0.3,1)" }}>
                    <Flex align="center" gap="2.5" mb="1.5">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M5 9l7-7 7 7" /></svg>
                      <Text fontSize="sm" fontWeight="700" color="var(--gold)">{formatSats(report.btc.findings.filter(f => f.category !== 'higher-account').reduce((s, f) => s + f.balanceSats, 0))} on a non-standard path</Text>
                    </Flex>
                    <Text fontSize="xs" color="var(--text-2)" mb="3.5" lineHeight="1.55">An old wallet left these coins on a legacy path. We can sweep them safely to your main address — nothing leaves your device unsigned.</Text>
                    {sweepPreview ? (
                      <>
                        <Box bg="var(--ink-1)" borderRadius="md" p="3" mb="3"><Flex justify="space-between"><Text fontSize="xs" color="var(--text-2)">You receive</Text><Text fontSize="xs" fontWeight="700" color="var(--gold)">{formatSats(sweepPreview.outputSats)}</Text></Flex></Box>
                        <Flex gap="2"><Button flex="1" size="sm" variant="ghost" color="var(--text-2)" onClick={() => setSweepPreview(null)}>Back</Button><Button flex="1" size="sm" {...goldBtn} loading={sweeping} onClick={sweepConfirm}>Confirm & broadcast</Button></Flex>
                      </>
                    ) : <Button size="sm" {...goldBtn} loading={sweeping} onClick={sweepDryRun}>Sweep it to my main address</Button>}
                  </Box>
                )}
                {current.chainId === 'bitcoin' && report?.btcScanState === 'done' && report.btc.higherAccountMax > 0 && (
                  <Button size="sm" w="100%" mb="4" {...goldBtn} loading={ladder.recovering} onClick={() => trackLevel(current, report.btc.higherAccountMax)}>Track Bitcoin accounts up to #{report.btc.higherAccountMax}</Button>
                )}
                {current.chainId === 'bitcoin' && report?.btcScanState === 'done' && report.btc.findings.length === 0 && (
                  <Flex align="flex-start" gap="2.5" mb="4"><svg width="15" height="15" style={{ flexShrink: 0, marginTop: 2 }} viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg><Text fontSize="sm" color="var(--text-2)">No funds stranded on non-standard Bitcoin paths. Your BTC is fully accounted for.</Text></Flex>
                )}

                {/* unverified — offer a real, independent re-check of the primary
                    address (derive + native balance), bypassing the degraded
                    portfolio fetch. Only where a level scan is meaningful. */}
                {current.coverage === 'unverified' && levelScannable && !ladder.scanning && !checkedPrimary && (
                  <Box bg="rgba(224,140,123,0.09)" border="1px solid" borderColor="rgba(224,140,123,0.28)" borderRadius="16px" p="4.5" mb="4">
                    <Text fontSize="13px" color="var(--rose)" mb="3.5" lineHeight="1.55">We couldn’t reach {current.symbol}’s node just now — so we won’t pretend it’s empty. Let’s read your primary address straight from the device.</Text>
                    <Button size="sm" variant="outline" borderColor="var(--line-2)" color="var(--text-0)" _hover={{ borderColor: "var(--teal)", color: "var(--teal)" }} onClick={() => runScan(current, 0, 1, false)}>Check it directly</Button>
                  </Box>
                )}

                {/* funded finds — the "found money" reveal */}
                {fundedFinds.length > 0 && (
                  <Box style={{ background: 'linear-gradient(135deg, rgba(233,196,106,0.15), rgba(233,196,106,0.05))' }} border="1px solid" borderColor="rgba(233,196,106,0.42)" borderRadius="16px" p="4.5" mb="4" css={{ animation: "auditPop 0.55s cubic-bezier(0.16,1,0.3,1)" }}>
                    <Flex align="center" gap="2.5" mb="2.5">
                      <Box w="26px" h="26px" borderRadius="full" bg="var(--gold)" display="flex" alignItems="center" justifyContent="center" flexShrink={0}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-0)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg></Box>
                      <Text fontSize="15px" fontWeight="700" color="var(--gold)">{current.family === 'evm' ? 'Found funds you weren’t tracking' : `Found ${current.symbol} you weren’t tracking`}</Text>
                    </Flex>
                    <Text fontSize="12.5px" color="var(--text-1)" lineHeight="1.55" mb="3.5">It was sitting on a higher account from an earlier setup. {isHidden ? 'We’ll track it for this hidden-wallet session.' : 'Add it to your portfolio and it’ll always show up from now on.'}</Text>
                    <VStack gap="2" align="stretch">{fundedFinds.map((a, i) => <AddrRow key={`f${i}`} chain={current} a={a} gold />)}</VStack>
                  </Box>
                )}

                {ladder.recovered && <Box bg="rgba(139,227,196,0.09)" border="1px solid" borderColor="rgba(139,227,196,0.26)" borderRadius="13px" p="3.5" mb="4" css={{ animation: "auditPop 0.5s cubic-bezier(0.16,1,0.3,1)" }}><Flex align="center" gap="2"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg><Text fontSize="sm" color="var(--teal)">{ladder.recovered}</Text></Flex></Box>}
                {ladder.recoverErr && <Text fontSize="sm" color="var(--rose)" mb="3">{ladder.recoverErr}</Text>}
                {ladder.scanErr && <Text fontSize="sm" color="var(--rose)" mb="3">{ladder.scanErr}</Text>}

                {/* unverified-but-confirmed-funded callouts come through fundedFinds above */}
                {errFinds.length > 0 && <VStack gap="2" align="stretch" mb="4">{errFinds.map((a, i) => <AddrRow key={`e${i}`} chain={current} a={a} />)}</VStack>}

                {/* empty accounts — one-line summary, expandable */}
                {emptyFinds.length > 0 && (
                  <Box mb="4">
                    <Flex align="flex-start" gap="2.5"><svg width="15" height="15" style={{ flexShrink: 0, marginTop: 2 }} viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      <Text fontSize="sm" color="var(--text-2)">Checked {emptyFinds.length} more {emptyFinds.length === 1 ? 'account' : 'accounts'} — {emptyFinds.length === 1 ? 'it’s' : 'they’re'} empty. <Box as="button" color="var(--text-3)" textDecoration="underline" onClick={() => patchLadder(current.chainId, { showEmpties: !ladder.showEmpties })}>{ladder.showEmpties ? 'hide' : 'show'}</Box></Text>
                    </Flex>
                    {ladder.showEmpties && <VStack gap="2" align="stretch" mt="2.5" maxH="180px" overflow="auto">{emptyFinds.map((a, i) => <AddrRow key={`s${i}`} chain={current} a={a} />)}</VStack>}
                  </Box>
                )}

                {/* common (other-wallet) paths */}
                {ladder.showCommon && current.family === 'evm' && <Box mb="4"><AuditKnownPaths chainId={current.chainId} defaultAddress={currentAddr} onFound={(r) => pushExtra(current.chainId, r)} onOpenUrl={openUrl} /></Box>}
                {ladder.showCommon && current.chainId === 'bitcoin' && <Box mb="4"><Text fontSize="11px" color="var(--text-2)" textTransform="uppercase" letterSpacing="0.08em" mb="1.5">Deep Bitcoin scans</Text><AuditBtcDeep onRecovered={() => onRecovered?.()} /></Box>}

                {/* custom + inspector */}
                {ladder.showCustom && currentDef0 && (
                  <Box mb="4">
                    <AuditCustomPath chainId={current.chainId} family={currentDef0.chainFamily} defaultPath={currentDef0.defaultPath} scriptType={currentDef0.scriptType} onResult={(r) => pushCustom(current.chainId, r)} />
                    <Box mt="2"><AuditInspector chainId={current.chainId} family={currentDef0.chainFamily} defaultPath={currentDef0.defaultPath} scriptType={currentDef0.scriptType} onOpenUrl={openUrl} /></Box>
                  </Box>
                )}

                {/* handoff */}
                {ladder.showHandoff && (
                  <Box bg="var(--ink-3)" border="1px solid" borderColor="var(--line)" borderRadius="13px" p="4" mb="4">
                    <Text fontSize="sm" color="var(--text-0)" mb="2.5">We’ll bundle everything we checked into a report you can hand to support.</Text>
                    <Textarea size="sm" placeholder="What balance did you expect? (optional)" value={ladder.handoffNote} onChange={e => patchLadder(current.chainId, { handoffNote: e.target.value })} bg="var(--ink-1)" border="1px solid" borderColor="var(--line-2)" fontSize="sm" rows={2} mb="3" />
                    <Button size="sm" w="100%" {...goldBtn} onClick={() => copyHandoff(current, ladder, current.balanceUsd)}>Copy report & open support ↗</Button>
                  </Box>
                )}
              </Box>
            </Box>

            {/* persistent action bar */}
            <Flex flexShrink={0} align="center" gap="3" wrap="wrap" px="7" py="3.5" borderTop="1px solid" borderColor="var(--line)" bg="rgba(255,255,255,0.022)">
              <Text fontSize="12px" color="var(--text-2)" whiteSpace="nowrap">Expected more?</Text>
              {levelScannable && (
                <Box as="button" style={chip} onClick={() => { runScan(current, ladder.nextLevel, 3, false); scrollDown() }}>
                  {ladder.scanning && <Spinner size="xs" color="var(--gold)" />}Scan more accounts
                </Box>
              )}
              {hasCommon && (
                <Box as="button" style={chip} onClick={() => { patchLadder(current.chainId, { showCommon: !ladder.showCommon }); scrollDown() }}>
                  {current.family === 'evm' ? 'Scan common wallet paths' : 'Scan unusual paths'}
                </Box>
              )}
              <Box as="button" style={chip} onClick={() => { patchLadder(current.chainId, { showCustom: !ladder.showCustom }); scrollDown() }}>Scan a custom path</Box>
              {!ladder.showHandoff && <Box as="button" ml="auto" fontSize="12px" color="var(--text-3)" _hover={{ color: "var(--text-1)" }} onClick={() => { patchLadder(current.chainId, { showHandoff: true }); scrollDown() }}>Still missing? →</Box>}
            </Flex>

            {/* footer nav */}
            <Flex flexShrink={0} px="7" py="4" gap="3" align="center" justify="space-between" borderTop="1px solid" borderColor="var(--line)">
              <Box as="button" fontSize="13.5px" color={chainIdx === 0 ? 'var(--text-3)' : 'var(--text-2)'} cursor={chainIdx === 0 ? 'default' : 'pointer'} onClick={() => { if (chainIdx > 0) goChain(chainIdx - 1) }}>← Back</Box>
              <Button size="lg" px="9" borderRadius="full" {...goldBtn} boxShadow="0 8px 24px -8px rgba(233,196,106,0.6)" _hover={{ bg: "var(--gold-2)", transform: "translateY(-1px)" }} _active={{ transform: "scale(0.98)" }} onClick={advance}>
                {chainIdx + 1 < walk.length ? 'Looks right' : 'Finish'}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 8 }}><polyline points="20 6 9 17 4 12" /></svg>
              </Button>
              <Box as="button" fontSize="13.5px" color="var(--text-2)" _hover={{ color: "var(--text-1)" }} visibility={chainIdx + 1 < walk.length ? 'visible' : 'hidden'} onClick={() => goChain(chainIdx + 1)}>Skip →</Box>
            </Flex>
          </Flex>
        )}

        {/* ============ FINISH PHASE ============ */}
        {!stale && phase === 'finish' && (
          <Box flex="1" overflow="auto" px="8" py="9" css={{ animation: "auditRise 0.5s cubic-bezier(0.16,1,0.3,1)" }}>
            <Box textAlign="center" mb="7">
              <Box w="80px" h="80px" borderRadius="full" mx="auto" mb="4.5" display="flex" alignItems="center" justifyContent="center"
                style={{ background: 'linear-gradient(145deg, var(--ink-4), var(--ink-3))' }} border="1px solid" borderColor="rgba(233,196,106,0.5)" css={{ animation: "auditGold 2.4s ease-in-out infinite" }}>
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>
              </Box>
              <Text fontSize="2xl" fontWeight="700" color="var(--text-0)" letterSpacing="-0.02em">{report?.anyUnverified ? 'Audit complete — a couple chains need a second look.' : 'Everything’s accounted for.'}</Text>
              <Text fontSize="13.5px" color="var(--text-2)" mt="3" maxW="460px" mx="auto" lineHeight="1.6">We walked all {walk.length} chains on your device and checked every tracked address. Here’s what we found.</Text>
            </Box>

            <Flex gap="4" maxW="580px" mx="auto" mb="6">
              <Box flex="1" bg="var(--ink-3)" border="1px solid" borderColor="var(--line)" borderRadius="16px" p="4.5" textAlign="center">
                <Text fontSize="11px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.06em">{report?.anyUnverified ? 'Total balance' : 'Total verified'}</Text>
                <Text fontSize="26px" fontWeight="700" color="var(--text-0)" mt="1.5">{usd(totalBalance)}</Text>
              </Box>
              <Box flex="1" style={{ background: 'linear-gradient(135deg, rgba(233,196,106,0.14), rgba(233,196,106,0.04))' }} border="1px solid" borderColor="rgba(233,196,106,0.32)" borderRadius="16px" p="4.5" textAlign="center">
                <Text fontSize="11px" color="var(--gold)" textTransform="uppercase" letterSpacing="0.06em">Recovered</Text>
                <Text fontSize="26px" fontWeight="700" color="var(--gold)" mt="1.5">{recoveredCount > 0 ? `${recoveredCount} ${recoveredCount === 1 ? 'account' : 'accounts'}` : 'none'}</Text>
              </Box>
            </Flex>

            <VStack gap="2" align="stretch" maxW="580px" mx="auto">
              {walk.map(c => {
                const def = catalog.current.get(c.chainId)
                const st = finishStatus(c)
                return (
                  <Flex key={c.chainId} align="center" gap="3.5" bg="var(--ink-3)" border="1px solid" borderColor="var(--line)" borderRadius="12px" px="4" py="2.5">
                    <ChainLogo caip={def?.caip} symbol={c.symbol} size={26} />
                    <Box w="130px" flexShrink={0}>
                      <Text fontSize="13.5px" color="var(--text-0)" truncate title={def?.coin}>{def?.coin ?? c.symbol}</Text>
                      <Text fontSize="10.5px" color="var(--text-3)" lineHeight="1.1">{c.symbol}</Text>
                    </Box>
                    <Text flex="1" fontSize="12px" color={st.color}>{st.label}</Text>
                    <Text fontSize="13.5px" fontWeight="700" color="var(--text-1)">{usd(c.balanceUsd)}</Text>
                  </Flex>
                )
              })}
            </VStack>

            <Flex gap="3" justify="center" mt="8">
              <Button size="lg" px="6" borderRadius="full" variant="outline" borderColor="var(--line-2)" color="var(--text-1)" _hover={{ borderColor: "var(--text-2)", color: "var(--text-0)" }} onClick={() => start('light')}>Run it again</Button>
              <Button size="lg" px="8" borderRadius="full" {...goldBtn} onClick={handleClose}>Done — back to wallet</Button>
            </Flex>
          </Box>
        )}
      </Flex>
    </Box>
  )
}
