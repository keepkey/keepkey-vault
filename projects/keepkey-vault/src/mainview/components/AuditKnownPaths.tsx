/**
 * AuditKnownPaths — MyEtherWallet-style grid of well-known EVM derivation
 * schemes (Ledger Live, Ledger Legacy/MEW, MetaMask/Trezor, legacy, …). Opt-in:
 * a button reveals the grid and checks index 0 of every scheme; each scheme can
 * be expanded to scan more indices. Funded results can't be auto-tracked (the
 * vault only tracks the standard scheme) so they bubble to the support handoff.
 */
import { useState } from "react"
import { Box, Flex, Text, Button, VStack, Spinner } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { EVM_KNOWN_SCHEMES } from "../../shared/evm-paths"
import type { AuditDerivedAddress } from "../../shared/types"

interface AuditKnownPathsProps {
  chainId: string
  onFound: (r: AuditDerivedAddress) => void
  onOpenUrl: (url: string) => void
}

interface SchemeState {
  results: AuditDerivedAddress[]
  depth: number
  scanning: boolean
  err: string | null
}

const EMPTY: SchemeState = { results: [], depth: 0, scanning: false, err: null }

export function AuditKnownPaths({ chainId, onFound, onOpenUrl }: AuditKnownPathsProps) {
  const [opened, setOpened] = useState(false)
  const [states, setStates] = useState<Record<string, SchemeState>>({})

  async function scanScheme(key: string, fromDepth: number, count: number) {
    const scheme = EVM_KNOWN_SCHEMES.find(s => s.key === key)
    if (!scheme) return
    const paths = Array.from({ length: count }, (_, i) => scheme.path(fromDepth + i))
    setStates(p => ({ ...p, [key]: { ...(p[key] || EMPTY), scanning: true, err: null } }))
    try {
      const { results } = await rpcRequest<{ results: AuditDerivedAddress[] }>('auditScanPaths', { chainId, paths }, 180000)
      // Route funded AND could-not-verify results to the handoff — a balance-fetch
      // failure must never silently dead-end as "empty".
      results.filter(r => r.hasBalance || r.balanceError).forEach(onFound)
      setStates(p => {
        const cur = p[key] || EMPTY
        return { ...p, [key]: { results: [...cur.results, ...results], depth: fromDepth + count, scanning: false, err: null } }
      })
    } catch (e: any) {
      setStates(p => ({ ...p, [key]: { ...(p[key] || EMPTY), scanning: false, err: e.message } }))
    }
  }

  async function checkAll() {
    setOpened(true)
    for (const s of EVM_KNOWN_SCHEMES) {
      await scanScheme(s.key, 0, 1) // index 0 of each — fast first pass
    }
  }

  if (!opened) {
    return (
      <Button size="sm" w="100%" variant="outline" borderColor="kk.border" color="kk.textSecondary"
        _hover={{ borderColor: "var(--teal)", color: "var(--teal)" }} onClick={checkAll}>
        Check known wallet paths (Ledger, MEW, …)
      </Button>
    )
  }

  return (
    <Box>
      <Text fontSize="11px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.08em" mb="2">Known wallet derivation paths</Text>
      <VStack gap="1.5" align="stretch">
        {EVM_KNOWN_SCHEMES.map(s => {
          const st = states[s.key]
          const funded = st?.results.filter(r => r.hasBalance) || []
          const unverified = st?.results.filter(r => r.balanceError) || []
          return (
            <Box key={s.key} bg="whiteAlpha.50" borderRadius="md" p="2.5">
              <Flex justify="space-between" align="center">
                <Box minW={0}>
                  <Text fontSize="xs" fontWeight="600" color={funded.length ? "var(--teal)" : "kk.textSecondary"}>{s.label}</Text>
                  <Text fontSize="10px" fontFamily="mono" color="kk.textMuted">{s.template}</Text>
                </Box>
                {st?.scanning ? <Spinner size="xs" color="var(--teal)" flexShrink={0} />
                  : funded.length ? <Text fontSize="xs" color="var(--teal)" fontWeight="600" flexShrink={0}>{funded[0].native} {funded[0].symbol}</Text>
                  : st?.err ? <Text fontSize="10px" color="var(--rose)" flexShrink={0}>error</Text>
                  : unverified.length ? <Text fontSize="10px" color="var(--rose)" flexShrink={0}>could not verify</Text>
                  : st ? <Text fontSize="10px" color="kk.textMuted" flexShrink={0}>empty</Text> : null}
              </Flex>
              {funded.map((r, i) => (
                <Flex key={i} justify="space-between" align="center" mt="1">
                  <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" truncate maxW="200px" title={r.address}>{r.address}</Text>
                  {r.explorerUrl && <Box as="button" fontSize="10px" color="var(--teal)" flexShrink={0} onClick={() => onOpenUrl(r.explorerUrl!)}>explorer ↗</Box>}
                </Flex>
              ))}
              {st && !st.scanning && (
                <Box as="button" fontSize="10px" color="kk.textMuted" mt="1" _hover={{ color: "var(--teal)" }} onClick={() => scanScheme(s.key, st.depth, 3)}>
                  scan more indices →
                </Box>
              )}
            </Box>
          )
        })}
      </VStack>
      <Text fontSize="10px" color="kk.textMuted" mt="2">Funds on these paths can’t be tracked in-app — use “Still missing?” to send them to support.</Text>
    </Box>
  )
}
