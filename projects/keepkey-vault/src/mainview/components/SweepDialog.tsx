/**
 * SweepDialog — scans non-standard BTC derivation paths and sweeps found funds.
 *
 * Triggered by the broom button on the Dashboard.
 * Phases: idle → scanning → results → sweeping → done
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button, VStack, Spinner } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"

type Phase = 'idle' | 'scanning' | 'results' | 'sweeping' | 'done' | 'error'

interface SweepResult {
  path: string
  scriptType: string
  address: string
  category: 'account-key' | 'mismatch'
  balanceSats: number
  utxoCount: number
}

interface ScanStatus {
  id: string
  status: 'scanning' | 'complete' | 'error'
  progress: { current: number; total: number; phase: string }
  totalFoundSats: number
  results: SweepResult[]
  error?: string
}

function formatSats(sats: number): string {
  if (sats >= 100_000_000) return (sats / 100_000_000).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' BTC'
  return sats.toLocaleString() + ' sats'
}

export function SweepDialog({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [scanId, setScanId] = useState<string | null>(null)
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [sweepResult, setSweepResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Cleanup polling on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const startScan = useCallback(async () => {
    setPhase('scanning')
    setError(null)
    try {
      const { scanId: id } = await rpcRequest<{ scanId: string }>('sweepScan', {
        accountRange: [0, 2],
        mismatchAccounts: 1,
      }, 0) // no timeout — scan can take 60s+
      setScanId(id)

      // Poll for status
      pollRef.current = setInterval(async () => {
        try {
          const status = await rpcRequest<ScanStatus>('sweepGetStatus', { scanId: id })
          setScanStatus(status)
          if (status.status === 'complete' || status.status === 'error') {
            if (pollRef.current) clearInterval(pollRef.current)
            pollRef.current = null
            setPhase(status.status === 'error' ? 'error' : 'results')
            if (status.error) setError(status.error)
          }
        } catch (e: any) {
          console.warn('[sweep] Poll error:', e.message)
        }
      }, 2000)
    } catch (e: any) {
      setError(e.message)
      setPhase('error')
    }
  }, [])

  const executeSweep = useCallback(async (dryRun: boolean) => {
    if (!scanId) return
    setPhase('sweeping')
    setError(null)
    try {
      const result = await rpcRequest('sweepExecute', { scanId, dryRun }, 600000)
      setSweepResult(result)
      setPhase('done')
    } catch (e: any) {
      setError(e.message)
      setPhase('error')
    }
  }, [scanId])

  return (
    <Box
      position="fixed" inset="0" zIndex={Z.dialog || 1500}
      display="flex" alignItems="center" justifyContent="center"
    >
      {/* Backdrop */}
      <Box position="absolute" inset="0" bg="blackAlpha.700" onClick={onClose} />

      {/* Dialog */}
      <Box
        position="relative" w="420px" maxH="80vh" overflow="auto"
        bg="kk.cardBg" border="1px solid" borderColor="kk.border"
        borderRadius="2xl" p="6" boxShadow="0 8px 40px rgba(0,0,0,0.5)"
      >
        {/* Header */}
        <Flex align="center" justify="space-between" mb="4">
          <Flex align="center" gap="2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 21h4l-1-3-3 3z" />
              <path d="M6 18L18 6" />
              <path d="M14 6h4v4" />
              <path d="M18 2l4 4-4 4" />
            </svg>
            <Text fontSize="lg" fontWeight="600" color="kk.gold">Sweep Scanner</Text>
          </Flex>
          <Box as="button" onClick={onClose} color="kk.textMuted" _hover={{ color: "white" }} p="1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </Box>
        </Flex>

        {/* ── Idle ──────────────────────────────────────────────── */}
        {phase === 'idle' && (
          <VStack gap="4" align="stretch">
            <Text fontSize="sm" color="kk.textSecondary" lineHeight="1.5">
              Scans for BTC stuck on non-standard derivation paths — account-level keys,
              mismatched script types, and other uncommon paths that normal wallets don't check.
            </Text>
            <Text fontSize="xs" color="kk.textMuted">
              This will derive ~80 addresses from your device (takes 30-60 seconds).
              No funds will be moved until you confirm.
            </Text>
            <Button
              size="md" bg="kk.gold" color="black" fontWeight="600"
              _hover={{ bg: "kk.goldHover" }}
              onClick={startScan}
            >
              Start Scan
            </Button>
          </VStack>
        )}

        {/* ── Scanning ──────────────────────────────────────────── */}
        {phase === 'scanning' && scanStatus && (
          <VStack gap="3" align="stretch">
            <Flex align="center" gap="3">
              <Spinner size="sm" color="kk.gold" />
              <Text fontSize="sm" color="kk.textSecondary">
                {scanStatus.progress.phase === 'deriving' ? 'Deriving addresses from device...' : 'Checking balances...'}
              </Text>
            </Flex>
            <Box bg="whiteAlpha.100" borderRadius="full" h="6px" overflow="hidden">
              <Box
                bg="kk.gold" h="100%" borderRadius="full"
                w={`${Math.round((scanStatus.progress.current / Math.max(scanStatus.progress.total, 1)) * 100)}%`}
                transition="width 0.3s"
              />
            </Box>
            <Text fontSize="xs" color="kk.textMuted" textAlign="center">
              {scanStatus.progress.current} / {scanStatus.progress.total}
              {scanStatus.totalFoundSats > 0 && ` — found ${formatSats(scanStatus.totalFoundSats)} so far`}
            </Text>
          </VStack>
        )}

        {phase === 'scanning' && !scanStatus && (
          <Flex align="center" gap="3" py="4">
            <Spinner size="sm" color="kk.gold" />
            <Text fontSize="sm" color="kk.textSecondary">Starting scan...</Text>
          </Flex>
        )}

        {/* ── Results ───────────────────────────────────────────── */}
        {phase === 'results' && scanStatus && (
          <VStack gap="4" align="stretch">
            {scanStatus.results.length === 0 ? (
              <>
                <Flex align="center" gap="2" py="2">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <Text fontSize="sm" color="#4ade80" fontWeight="500">All clear — no funds on non-standard paths</Text>
                </Flex>
                <Button size="sm" variant="ghost" color="kk.textSecondary" onClick={onClose}>Close</Button>
              </>
            ) : (
              <>
                <Box bg="rgba(255,215,0,0.08)" border="1px solid" borderColor="rgba(255,215,0,0.2)" borderRadius="lg" p="3">
                  <Text fontSize="sm" fontWeight="600" color="kk.gold">
                    Found {formatSats(scanStatus.totalFoundSats)} on {scanStatus.results.length} non-standard path{scanStatus.results.length > 1 ? 's' : ''}
                  </Text>
                </Box>

                <VStack gap="2" align="stretch" maxH="200px" overflow="auto">
                  {scanStatus.results.map((r, i) => (
                    <Box key={i} bg="whiteAlpha.50" borderRadius="md" px="3" py="2">
                      <Flex justify="space-between" align="center">
                        <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary" truncate maxW="240px" title={r.address}>
                          {r.address}
                        </Text>
                        <Text fontSize="xs" fontWeight="600" color="kk.gold">{formatSats(r.balanceSats)}</Text>
                      </Flex>
                      <Text fontSize="10px" color="kk.textMuted">
                        {r.path} as {r.scriptType} ({r.category === 'account-key' ? 'account key' : 'mismatch'}) — {r.utxoCount} UTXO{r.utxoCount !== 1 ? 's' : ''}
                      </Text>
                    </Box>
                  ))}
                </VStack>

                <Flex gap="2">
                  <Button
                    flex="1" size="sm" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                    _hover={{ borderColor: "kk.gold", color: "kk.gold" }}
                    onClick={() => executeSweep(true)}
                  >
                    Dry Run
                  </Button>
                  <Button
                    flex="1" size="sm" bg="kk.gold" color="black" fontWeight="600"
                    _hover={{ bg: "kk.goldHover" }}
                    onClick={() => executeSweep(false)}
                  >
                    Sweep to Standard Address
                  </Button>
                </Flex>
              </>
            )}
          </VStack>
        )}

        {/* ── Sweeping ──────────────────────────────────────────── */}
        {phase === 'sweeping' && (
          <Flex align="center" gap="3" py="4">
            <Spinner size="sm" color="kk.gold" />
            <Text fontSize="sm" color="kk.textSecondary">Building & signing sweep transaction... confirm on device</Text>
          </Flex>
        )}

        {/* ── Done ──────────────────────────────────────────────── */}
        {phase === 'done' && sweepResult && (
          <VStack gap="3" align="stretch">
            {sweepResult.dryRun ? (
              <>
                <Text fontSize="sm" fontWeight="600" color="#4ade80">Dry Run Complete</Text>
                <Box bg="whiteAlpha.50" borderRadius="md" p="3">
                  <VStack gap="1" align="stretch">
                    <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Inputs</Text><Text fontSize="xs">{sweepResult.inputCount}</Text></Flex>
                    <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Total</Text><Text fontSize="xs">{formatSats(sweepResult.totalSweptSats)}</Text></Flex>
                    <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Fee</Text><Text fontSize="xs">{formatSats(sweepResult.fee)}</Text></Flex>
                    <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Output</Text><Text fontSize="xs" fontWeight="600" color="kk.gold">{formatSats(sweepResult.outputSats)}</Text></Flex>
                    <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">To</Text><Text fontSize="xs" fontFamily="mono" truncate maxW="240px">{sweepResult.destination}</Text></Flex>
                  </VStack>
                </Box>
                <Flex gap="2">
                  <Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" onClick={() => setPhase('results')}>Back</Button>
                  <Button flex="1" size="sm" bg="kk.gold" color="black" fontWeight="600" _hover={{ bg: "kk.goldHover" }} onClick={() => executeSweep(false)}>
                    Confirm & Broadcast
                  </Button>
                </Flex>
              </>
            ) : (
              <>
                <Flex align="center" gap="2">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <Text fontSize="sm" fontWeight="600" color="#4ade80">Sweep Broadcast</Text>
                </Flex>
                <Box bg="whiteAlpha.50" borderRadius="md" p="3">
                  <VStack gap="1" align="stretch">
                    <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Swept</Text><Text fontSize="xs" fontWeight="600" color="kk.gold">{formatSats(sweepResult.outputSats)}</Text></Flex>
                    <Flex justify="space-between"><Text fontSize="xs" color="kk.textMuted">Fee</Text><Text fontSize="xs">{formatSats(sweepResult.fee)}</Text></Flex>
                    <Text fontSize="xs" color="kk.textMuted" mt="1">TXID:</Text>
                    <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" wordBreak="break-all">{sweepResult.txid}</Text>
                  </VStack>
                </Box>
                <Button size="sm" variant="ghost" color="kk.textSecondary" onClick={onClose}>Close</Button>
              </>
            )}
          </VStack>
        )}

        {/* ── Error ─────────────────────────────────────────────── */}
        {phase === 'error' && (
          <VStack gap="3" align="stretch">
            <Text fontSize="sm" color="red.400">{error || 'An error occurred'}</Text>
            <Flex gap="2">
              <Button flex="1" size="sm" variant="ghost" color="kk.textSecondary" onClick={onClose}>Close</Button>
              <Button flex="1" size="sm" variant="outline" borderColor="kk.border" color="kk.gold" onClick={startScan}>Retry</Button>
            </Flex>
          </VStack>
        )}
      </Box>
    </Box>
  )
}
