/**
 * AuditKnownPaths — checks the derivation paths OTHER wallets use, so funds a
 * user moved in via Ledger Live / MEW / legacy MetaMask still surface.
 *
 * Distinct paths are DEDUPED across schemes: at index 0, BIP44 and Ledger Live
 * both derive m/44'/60'/0'/0/0 — the user's main address — so we show that path
 * once, tagged "your main address", with every wallet that uses it. Each row
 * shows the full derived path so the result is verifiable. Funded /
 * couldn't-verify non-default paths route to the support handoff (the vault
 * only tracks the standard scheme).
 */
import { useState } from "react"
import { Box, Flex, Text, Button, VStack, HStack, Spinner } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { EVM_KNOWN_SCHEMES } from "../../shared/evm-paths"
import type { AuditDerivedAddress } from "../../shared/types"

function bip32(path: number[]): string {
  return 'm/' + path.map(n => (n >= 0x80000000 ? `${n - 0x80000000}'` : String(n))).join('/')
}

/** Unique derivation paths (deduped across schemes) for index range, each with
 *  the wallet labels that use it. */
function buildPaths(fromIdx: number, toIdx: number): { pathStr: string; path: number[]; labels: string[] }[] {
  const map = new Map<string, { path: number[]; labels: Set<string> }>()
  for (const s of EVM_KNOWN_SCHEMES) {
    for (let i = fromIdx; i <= toIdx; i++) {
      const path = s.path(i)
      const ps = bip32(path)
      const e = map.get(ps)
      if (e) e.labels.add(s.label)
      else map.set(ps, { path, labels: new Set([s.label]) })
    }
  }
  return [...map.entries()].map(([pathStr, v]) => ({ pathStr, path: v.path, labels: [...v.labels] }))
}

interface Row extends AuditDerivedAddress {
  labels: string[]
  isDefault: boolean
}

interface AuditKnownPathsProps {
  chainId: string
  defaultAddress?: string
  onFound: (r: AuditDerivedAddress) => void
  onOpenUrl: (url: string) => void
}

export function AuditKnownPaths({ chainId, defaultAddress, onFound, onOpenUrl }: AuditKnownPathsProps) {
  const [opened, setOpened] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [scannedTo, setScannedTo] = useState(-1)
  const [scanning, setScanning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const lowerDefault = defaultAddress?.toLowerCase()

  async function scanRange(fromIdx: number, toIdx: number) {
    const specs = buildPaths(fromIdx, toIdx)
    const labelByPath = new Map(specs.map(s => [s.pathStr, s.labels]))
    setScanning(true); setErr(null); setOpened(true)
    try {
      const { results } = await rpcRequest<{ results: AuditDerivedAddress[] }>('auditScanPaths', { chainId, paths: specs.map(s => s.path) }, 180000)
      const newRows: Row[] = results.map(r => ({
        ...r,
        labels: labelByPath.get(r.pathStr) || [],
        isDefault: !!lowerDefault && r.address.toLowerCase() === lowerDefault,
      }))
      // Surface funded / couldn't-verify NON-default paths to the handoff.
      newRows.filter(r => !r.isDefault && (r.hasBalance || r.balanceError)).forEach(onFound)
      setRows(prev => {
        const seen = new Set(prev.map(p => p.pathStr))
        return [...prev, ...newRows.filter(r => !seen.has(r.pathStr))]
      })
      setScannedTo(toIdx)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setScanning(false)
    }
  }

  if (!opened) {
    return (
      <Button size="sm" w="100%" variant="outline" borderColor="var(--line-2)" color="var(--text-1)" fontWeight="600"
        _hover={{ borderColor: "var(--teal)", color: "var(--teal)", bg: "rgba(139,227,196,0.06)" }} onClick={() => scanRange(0, 0)}>
        Check common wallet paths (Ledger, MEW, …)
      </Button>
    )
  }

  return (
    <Box>
      <Text fontSize="sm" color="var(--text-1)" mb="2.5">Other wallets derive addresses differently from the same seed. Here’s what each common path holds:</Text>
      <VStack gap="2" align="stretch">
        {rows.map((r, i) => (
          <Flex key={i} bg="var(--ink-2)" borderRadius="lg" px="3.5" py="2.5" justify="space-between" align="center" gap="4">
            <Box minW="0">
              <Flex align="center" gap="2" wrap="wrap">
                <Text fontSize="12px" fontFamily="mono" color="var(--text-1)">{r.pathStr}</Text>
                {r.isDefault && <Text fontSize="10px" color="var(--teal)" bg="rgba(139,227,196,0.1)" px="1.5" borderRadius="sm">your main address</Text>}
              </Flex>
              <Text fontSize="11px" color="var(--text-3)" truncate>{r.labels.join(' · ')}</Text>
              <Text fontSize="10px" fontFamily="mono" color="var(--text-3)" truncate maxW="320px" title={r.address}>{r.address}</Text>
            </Box>
            <HStack gap="3" flexShrink={0}>
              {r.balanceError ? <Text fontSize="xs" color="var(--rose)">couldn’t verify</Text>
                : <Text fontSize="sm" fontWeight={r.hasBalance ? '700' : '400'} color={r.hasBalance ? 'var(--teal)' : 'var(--text-3)'}>{!r.hasBalance ? 'empty' : (parseFloat(r.native) > 0 || !r.tokens?.length) ? `${r.native} ${r.symbol}` : `${r.tokens.length} token${r.tokens.length > 1 ? 's' : ''}`}</Text>}
              {r.explorerUrl && <Box as="button" fontSize="11px" color="var(--teal)" onClick={() => onOpenUrl(r.explorerUrl!)}>explorer ↗</Box>}
            </HStack>
          </Flex>
        ))}
      </VStack>
      <Flex gap="3" mt="2.5" align="center">
        <Button size="xs" variant="outline" borderColor="var(--line-2)" color="var(--text-2)" loading={scanning} onClick={() => scanRange(scannedTo + 1, scannedTo + 2)}>Check the next addresses</Button>
        {err && <Text fontSize="xs" color="var(--rose)">{err}</Text>}
      </Flex>
      <Text fontSize="11px" color="var(--text-3)" mt="2">Funds on a non-standard path can’t be tracked in-app — use “Still missing?” to send them to support.</Text>
    </Box>
  )
}
