/**
 * SweepDialog — scans non-standard BTC derivation paths and recovers funds.
 *
 * Two recovery modes:
 *   1. Higher accounts: funds on standard paths at accounts the user hasn't added yet → add those accounts
 *   2. Non-standard paths: mismatched scriptTypes or account-level keys → sweep to standard address
 *
 * Fetches authoritative account state from the backend before scanning —
 * never relies on a potentially-stale frontend snapshot.
 */
import { useState, useEffect, useRef, useCallback } from "react"
import { Box, Flex, Text, Button, VStack, Spinner } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { BtcAccountSet } from "../../shared/types"

type Phase = 'idle' | 'scanning' | 'results' | 'adding' | 'sweeping' | 'done' | 'error'

interface SweepResult {
  path: string
  scriptType: string
  address: string
  category: 'account-key' | 'mismatch' | 'higher-account'
  accountIndex?: number
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

interface SweepDialogProps {
  onClose: () => void
  /** Hint for the idle-screen display — the actual scan fetches fresh state from the backend. */
  currentMaxAccountHint: number
  /** Called after accounts are added so the parent hook state refreshes. */
  refreshAccounts?: () => Promise<void>
}

export function SweepDialog({ onClose, currentMaxAccountHint, refreshAccounts }: SweepDialogProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [scanId, setScanId] = useState<string | null>(null)
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [sweepResult, setSweepResult] = useState<any>(null)
  const [accountsAdded, setAccountsAdded] = useState(0)
  const [accountsTarget, setAccountsTarget] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Authoritative max account index, fetched fresh from backend before scan
  const [backendMaxAccount, setBackendMaxAccount] = useState<number>(currentMaxAccountHint)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  // Categorize results
  const higherAccounts = scanStatus?.results.filter(r => r.category === 'higher-account') || []
  const nonStandard = scanStatus?.results.filter(r => r.category !== 'higher-account') || []
  const higherSats = higherAccounts.reduce((s, r) => s + r.balanceSats, 0)
  const nonStandardSats = nonStandard.reduce((s, r) => s + r.balanceSats, 0)

  // Unique higher account indices found
  const discoveredAccountIndices = [...new Set(higherAccounts.map(r => r.accountIndex!))].sort((a, b) => a - b)
  const maxDiscoveredAccount = discoveredAccountIndices.length > 0 ? Math.max(...discoveredAccountIndices) : 0

  const startScan = useCallback(async () => {
    setPhase('scanning')
    setError(null)
    try {
      // Fetch authoritative account state from backend before scanning
      const freshAccounts = await rpcRequest<BtcAccountSet>('getBtcAccounts')
      const authMaxAccount = freshAccounts.accounts.length > 0
        ? Math.max(...freshAccounts.accounts.map(a => a.accountIndex))
        : 0
      setBackendMaxAccount(authMaxAccount)

      const { scanId: id } = await rpcRequest<{ scanId: string }>('sweepScan', {
        accountRange: [0, Math.max(authMaxAccount, 2)],
        mismatchAccounts: 1,
        currentMaxAccount: authMaxAccount,
        higherAccountScanLimit: 9,
      }, 0)
      setScanId(id)

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

  const handleAddAccounts = useCallback(async () => {
    setPhase('adding')
    setError(null)
    setAccountsAdded(0)
    const needed = maxDiscoveredAccount - backendMaxAccount
    setAccountsTarget(needed)
    try {
      // Call the RPC directly (not the hook) so failures throw properly
      for (let i = 0; i < needed; i++) {
        await rpcRequest<BtcAccountSet>('addBtcAccount', undefined, 60000)
        setAccountsAdded(i + 1)
      }
      // Sync the hook state in the parent
      if (refreshAccounts) await refreshAccounts()

      // If there's also non-standard funds to sweep, go to results so user can sweep
      if (nonStandardSats > 0) {
        setPhase('results')
      } else {
        setPhase('done')
      }
    } catch (e: any) {
      setError(`Failed adding account: ${e.message}`)
      setPhase('error')
    }
  }, [maxDiscoveredAccount, backendMaxAccount, refreshAccounts, nonStandardSats])

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

  const nothingFound = scanStatus && scanStatus.results.length === 0
  // Once accounts have been added, hide that section
  const showHigherSection = higherAccounts.length > 0 && accountsAdded === 0

  return (
    <Box
      position="fixed" inset="0" zIndex={Z.dialog || 1500}
      display="flex" alignItems="center" justifyContent="center"
    >
      <Box position="absolute" inset="0" bg="blackAlpha.700" onClick={onClose} />

      <Box
        position="relative" w="440px" maxH="80vh" overflow="auto"
        bg="kk.cardBg" border="1px solid" borderColor="kk.border"
        borderRadius="2xl" p="6" boxShadow="0 8px 40px rgba(0,0,0,0.5)"
      >
        {/* Header */}
        <Flex align="center" justify="space-between" mb="4">
          <Flex align="center" gap="2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 21h4l-1-3-3 3z" />
              <path d="M6 18L18 6" />
              <path d="M14 6h4v4" />
              <path d="M18 2l4 4-4 4" />
            </svg>
            <Text fontSize="lg" fontWeight="600" color="#4ade80">BTC Sweep Scanner</Text>
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
              Scans for BTC on non-standard derivation paths and higher accounts you haven't added yet.
            </Text>
            <Text fontSize="xs" color="kk.textMuted">
              Checks account-level keys, mismatched script types, and standard paths up to account #9.
              No funds will be moved without your confirmation.
            </Text>
            <Text fontSize="xs" color="kk.textMuted">
              Currently tracking accounts 0{currentMaxAccountHint > 0 ? `–${currentMaxAccountHint}` : ''}.
            </Text>
            <Button
              size="md" bg="#4ade80" color="black" fontWeight="600"
              _hover={{ bg: "#22c55e" }}
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
              <Spinner size="sm" color="#4ade80" />
              <Text fontSize="sm" color="kk.textSecondary">
                {scanStatus.progress.phase === 'deriving' ? 'Deriving addresses from device...' : 'Checking balances...'}
              </Text>
            </Flex>
            <Box bg="whiteAlpha.100" borderRadius="full" h="6px" overflow="hidden">
              <Box
                bg="#4ade80" h="100%" borderRadius="full"
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
            <Spinner size="sm" color="#4ade80" />
            <Text fontSize="sm" color="kk.textSecondary">Starting scan...</Text>
          </Flex>
        )}

        {/* ── Results ───────────────────────────────────────────── */}
        {phase === 'results' && scanStatus && (
          <VStack gap="4" align="stretch">
            {nothingFound && (
              <>
                <Flex align="center" gap="2" py="2">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <Text fontSize="sm" color="#4ade80" fontWeight="500">All clear — no funds on non-standard paths or higher accounts</Text>
                </Flex>
                <Button size="sm" variant="ghost" color="kk.textSecondary" onClick={onClose}>Close</Button>
              </>
            )}

            {/* Higher accounts section */}
            {showHigherSection && (
              <Box>
                <Box bg="rgba(74,222,128,0.08)" border="1px solid" borderColor="rgba(74,222,128,0.2)" borderRadius="lg" p="3" mb="2">
                  <Text fontSize="sm" fontWeight="600" color="#4ade80">
                    {formatSats(higherSats)} on {discoveredAccountIndices.length} undiscovered account{discoveredAccountIndices.length > 1 ? 's' : ''}
                  </Text>
                  <Text fontSize="xs" color="kk.textMuted" mt="1">
                    Standard paths — will add account{discoveredAccountIndices.length > 1 ? 's' : ''} #{discoveredAccountIndices.join(', #')} to your wallet
                  </Text>
                </Box>

                <VStack gap="1.5" align="stretch" maxH="140px" overflow="auto" mb="2">
                  {higherAccounts.map((r, i) => (
                    <Box key={i} bg="whiteAlpha.50" borderRadius="md" px="3" py="1.5">
                      <Flex justify="space-between" align="center">
                        <Text fontSize="xs" color="kk.textSecondary">
                          Account #{r.accountIndex} · {r.scriptType}
                        </Text>
                        <Text fontSize="xs" fontWeight="600" color="#4ade80">{formatSats(r.balanceSats)}</Text>
                      </Flex>
                      <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" truncate maxW="300px">{r.address}</Text>
                    </Box>
                  ))}
                </VStack>

                <Button
                  size="sm" w="100%" bg="#4ade80" color="black" fontWeight="600"
                  _hover={{ bg: "#22c55e" }}
                  onClick={handleAddAccounts}
                >
                  Add Account{discoveredAccountIndices.length > 1 ? 's' : ''} ({discoveredAccountIndices.map(i => `#${i}`).join(', ')})
                </Button>
              </Box>
            )}

            {/* Separator if both sections exist */}
            {showHigherSection && nonStandard.length > 0 && (
              <Box borderBottom="1px solid" borderColor="kk.border" />
            )}

            {/* Non-standard section */}
            {nonStandard.length > 0 && (
              <Box>
                <Box bg="rgba(255,215,0,0.08)" border="1px solid" borderColor="rgba(255,215,0,0.2)" borderRadius="lg" p="3" mb="2">
                  <Text fontSize="sm" fontWeight="600" color="kk.gold">
                    {formatSats(nonStandardSats)} on {nonStandard.length} non-standard path{nonStandard.length > 1 ? 's' : ''}
                  </Text>
                  <Text fontSize="xs" color="kk.textMuted" mt="1">
                    Mismatched script types or account-level keys — will sweep to your standard address
                  </Text>
                </Box>

                <VStack gap="1.5" align="stretch" maxH="140px" overflow="auto" mb="2">
                  {nonStandard.map((r, i) => (
                    <Box key={i} bg="whiteAlpha.50" borderRadius="md" px="3" py="1.5">
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
              </Box>
            )}
          </VStack>
        )}

        {/* ── Adding accounts ──────────────────────────────────── */}
        {phase === 'adding' && (
          <Flex align="center" gap="3" py="4">
            <Spinner size="sm" color="#4ade80" />
            <Text fontSize="sm" color="kk.textSecondary">
              Adding account {accountsAdded + 1} of {accountsTarget}...
            </Text>
          </Flex>
        )}

        {/* ── Sweeping ─────────────────────────────────────────── */}
        {phase === 'sweeping' && (
          <Flex align="center" gap="3" py="4">
            <Spinner size="sm" color="kk.gold" />
            <Text fontSize="sm" color="kk.textSecondary">Building & signing sweep transaction... confirm on device</Text>
          </Flex>
        )}

        {/* ── Done ─────────────────────────────────────────────── */}
        {phase === 'done' && (
          <VStack gap="3" align="stretch">
            {sweepResult ? (
              sweepResult.dryRun ? (
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
              )
            ) : (
              /* Accounts-only done state */
              <>
                <Flex align="center" gap="2">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <Text fontSize="sm" fontWeight="600" color="#4ade80">
                    Added {accountsAdded} account{accountsAdded > 1 ? 's' : ''}
                  </Text>
                </Flex>
                <Text fontSize="xs" color="kk.textMuted">
                  Your wallet now tracks accounts up to #{maxDiscoveredAccount}.
                  Balances will appear after the next refresh.
                </Text>
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
              <Button flex="1" size="sm" variant="outline" borderColor="kk.border" color="#4ade80" onClick={startScan}>Retry</Button>
            </Flex>
          </VStack>
        )}
      </Box>
    </Box>
  )
}
