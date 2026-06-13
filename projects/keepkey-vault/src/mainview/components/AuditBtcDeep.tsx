/**
 * AuditBtcDeep — Bitcoin deep-recovery scanners, opt-in. Drives the existing
 * sweepScan/sweepGetStatus/sweepExecute engine with custom config:
 *   - wrong-script-type: scriptType-mismatch + account-level-key matrix
 *   - gap-limit: deeper receive + change indices within accounts
 * Findings are swept to the user's main address via the device-confirmed sweep.
 */
import { useState, useRef, useEffect, useCallback } from "react"
import { Box, Flex, Text, Button, VStack, Spinner } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"

function formatSats(sats: number): string {
  if (sats >= 100_000_000) return (sats / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' BTC'
  return sats.toLocaleString() + ' sats'
}

function scriptLabel(st: string): string {
  if (st === 'p2pkh') return 'Legacy'
  if (st === 'p2sh-p2wpkh') return 'SegWit'
  if (st === 'p2wpkh') return 'Native SegWit'
  return st
}

// Live progress streamed per-path from the backend (audit-sweep-progress).
interface LiveProgress { current: string | null; scriptType: string; checked: number; total: number; found: number }
const EMPTY_LIVE: LiveProgress = { current: null, scriptType: '', checked: 0, total: 0, found: 0 }

type Mode = 'scripttype' | 'gaplimit'
type Phase = 'idle' | 'scanning' | 'results' | 'sweeping' | 'done' | 'error'

interface AuditBtcDeepProps {
  onRecovered: () => void
}

export function AuditBtcDeep({ onRecovered }: AuditBtcDeepProps) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [scanId, setScanId] = useState<string | null>(null)
  const [status, setStatus] = useState<any>(null)
  const [sweepResult, setSweepResult] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [live, setLive] = useState<LiveProgress>(EMPTY_LIVE)
  const [foundLog, setFoundLog] = useState<Array<{ pathStr: string; scriptType: string; balanceSats: number }>>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollingRef = useRef(false)
  const scanIdRef = useRef<string | null>(null)

  const stop = useCallback(() => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } pollingRef.current = false }, [])
  useEffect(() => () => stop(), [stop])

  // Stream each path the backend is checking (filtered to the active scan).
  useEffect(() => onRpcMessage('audit-sweep-progress', (evt: any) => {
    if (!scanIdRef.current || evt.scanId !== scanIdRef.current) return
    if (evt.phase === 'deriving') {
      setLive(l => ({ ...l, current: evt.pathStr, scriptType: evt.scriptType, checked: evt.current ?? l.checked, total: evt.total ?? l.total }))
    } else if (evt.phase === 'found') {
      setFoundLog(log => [{ pathStr: evt.pathStr, scriptType: evt.scriptType, balanceSats: evt.balanceSats ?? 0 }, ...log].slice(0, 8))
      setLive(l => ({ ...l, found: l.found + 1 }))
    }
  }), [])

  const start = useCallback(async (m: Mode) => {
    stop()
    setMode(m); setPhase('scanning'); setErr(null); setStatus(null); setSweepResult(null); setScanId(null)
    setLive(EMPTY_LIVE); setFoundLog([]); scanIdRef.current = null
    // higherAccountScanLimit:0 disables the standard higher-account (Category C)
    // probe — that's the main audit's "Track Bitcoin accounts" job. This panel
    // only surfaces sweepable non-standard finds, so the total never counts
    // higher-account funds we then can't show/sweep here.
    // streamProgress: stream each path to the UI as it's checked.
    const config = m === 'scripttype'
      ? { accountRange: [0, 4] as [number, number], mismatchAccounts: 3, higherAccountScanLimit: 0, streamProgress: true }
      : { accountRange: [0, 2] as [number, number], mismatchAccounts: 2, gapLimitReceive: 20, gapLimitChange: 5, higherAccountScanLimit: 0, streamProgress: true }
    try {
      const { scanId: id } = await rpcRequest<{ scanId: string }>('sweepScan', config, 0)
      setScanId(id); scanIdRef.current = id
      pollRef.current = setInterval(async () => {
        if (pollingRef.current) return
        pollingRef.current = true
        try {
          const s = await rpcRequest<any>('sweepGetStatus', { scanId: id })
          setStatus(s)
          if (s.status === 'complete' || s.status === 'error') {
            stop()
            setPhase(s.status === 'error' ? 'error' : 'results')
            if (s.error) setErr(s.error)
          }
        } catch { /* transient */ }
        finally { pollingRef.current = false }
      }, 2000)
    } catch (e: any) { setErr(e.message); setPhase('error') }
  }, [stop])

  const sweep = useCallback(async (dryRun: boolean) => {
    if (!scanId) return
    setPhase('sweeping'); setErr(null)
    try {
      const r = await rpcRequest<any>('sweepExecute', { scanId, dryRun }, 600000)
      setSweepResult(r)
      setPhase('done')
      if (!dryRun) onRecovered()
    } catch (e: any) { setErr(e.message); setPhase('error') }
  }, [scanId, onRecovered])

  // The sweepable (non-higher-account) findings.
  const results = status?.results || []
  const nonStandard = results.filter((r: any) => r.category !== 'higher-account')
  const nonStandardSats = nonStandard.reduce((s: number, r: any) => s + (r.balanceSats || 0), 0)

  if (phase === 'idle') {
    return (
      <Flex gap="2" wrap="wrap">
        <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={() => start('scripttype')}>Scan wrong script types</Button>
        <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary" _hover={{ borderColor: "kk.gold", color: "kk.gold" }} onClick={() => start('gaplimit')}>Expand gap limit</Button>
      </Flex>
    )
  }

  return (
    <Box bg="whiteAlpha.50" borderRadius="md" p="3" mt="1">
      <Flex justify="space-between" align="center" mb="2">
        <Text fontSize="xs" fontWeight="600" color="kk.gold">{mode === 'scripttype' ? 'Wrong script-type scan' : 'Gap-limit expansion'}</Text>
        {phase !== 'scanning' && phase !== 'sweeping' && <Box as="button" fontSize="10px" color="kk.textMuted" onClick={() => { stop(); setPhase('idle') }}>reset</Box>}
      </Flex>

      {phase === 'scanning' && (
        <Text fontSize="11px" color="kk.textMuted" mb="2.5" lineHeight="1.5">
          {mode === 'scripttype'
            ? 'Checking your accounts under every other address style — coins from an old wallet that used a different format show up here.'
            : 'Looking deeper into each account (receive addresses 0–19 and change), in case funds landed past the usual range.'}
        </Text>
      )}

      {err && <Text fontSize="xs" color="red.400" mb="2">{err}</Text>}

      {phase === 'scanning' && (
        <VStack align="stretch" gap="2">
          <Flex align="center" gap="2">
            <Spinner size="xs" color="kk.gold" />
            <Text fontSize="xs" color="kk.textSecondary">
              Checking path {live.checked || status?.progress?.current || 0}{(live.total || status?.progress?.total) ? ` of ${live.total || status.progress.total}` : ''}
              {live.found > 0 && ` · ${live.found} with funds`}
            </Text>
          </Flex>
          {live.current
            ? <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" truncate>{live.current} · {scriptLabel(live.scriptType)}</Text>
            : <Text fontSize="10px" color="kk.textMuted">Starting scan…</Text>}
          {foundLog.length > 0 && (
            <VStack align="stretch" gap="1" maxH="84px" overflow="auto" pt="1" borderTop="1px solid" borderColor="kk.border">
              {foundLog.map((f, i) => (
                <Flex key={i} justify="space-between" gap="2">
                  <Text fontSize="10px" fontFamily="mono" color="kk.gold" truncate maxW="220px">{f.pathStr} · {scriptLabel(f.scriptType)}</Text>
                  <Text fontSize="10px" color="kk.gold" flexShrink={0}>{formatSats(f.balanceSats)}</Text>
                </Flex>
              ))}
            </VStack>
          )}
        </VStack>
      )}

      {phase === 'results' && (
        nonStandard.length === 0
          ? <Text fontSize="xs" color="var(--teal)">No funds found on these paths.</Text>
          : (
            <>
              <Text fontSize="xs" fontWeight="600" color="kk.gold" mb="1">{formatSats(nonStandardSats)} on {nonStandard.length} path{nonStandard.length > 1 ? 's' : ''}</Text>
              <VStack gap="1" align="stretch" maxH="120px" overflow="auto" mb="2">
                {nonStandard.map((r: any, i: number) => (
                  <Flex key={i} justify="space-between"><Text fontSize="10px" fontFamily="mono" color="kk.textMuted" truncate maxW="240px">{r.path} · {r.scriptType}</Text><Text fontSize="10px" color="kk.gold">{formatSats(r.balanceSats)}</Text></Flex>
                ))}
              </VStack>
              <Button size="sm" w="100%" bg="kk.gold" color="black" fontWeight="600" _hover={{ bg: "kk.goldHover" }} onClick={() => sweep(true)}>Sweep to main address</Button>
            </>
          )
      )}

      {phase === 'sweeping' && <Flex align="center" gap="2"><Spinner size="xs" color="kk.gold" /><Text fontSize="xs" color="kk.textSecondary">Building & signing… confirm on device</Text></Flex>}

      {phase === 'done' && sweepResult && (
        sweepResult.dryRun ? (
          <>
            <Box bg="whiteAlpha.50" borderRadius="md" p="2" mb="2">
              <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">You receive</Text><Text fontSize="xs" fontWeight="600" color="kk.gold">{formatSats(sweepResult.outputSats)}</Text></Flex>
              <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Fee</Text><Text fontSize="xs">{formatSats(sweepResult.fee)}</Text></Flex>
            </Box>
            <Flex gap="2">
              <Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" onClick={() => setPhase('results')}>Back</Button>
              <Button flex="1" size="sm" bg="kk.gold" color="black" fontWeight="600" _hover={{ bg: "kk.goldHover" }} onClick={() => sweep(false)}>Confirm & broadcast</Button>
            </Flex>
          </>
        ) : (
          <Text fontSize="xs" color="var(--teal)">Swept {formatSats(sweepResult.outputSats)} — txid {String(sweepResult.txid).slice(0, 16)}…</Text>
        )
      )}
    </Box>
  )
}
