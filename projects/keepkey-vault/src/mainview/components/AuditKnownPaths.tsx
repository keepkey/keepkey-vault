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
import { AuditSweepButton } from "./AuditSweepButton"
import { EVM_KNOWN_SCHEMES } from "../../shared/evm-paths"
import type { AuditDerivedAddress } from "../../shared/types"

function bip32(path: number[]): string {
  return 'm/' + path.map(n => (n >= 0x80000000 ? `${n - 0x80000000}'` : String(n))).join('/')
}

interface KnownScheme {
  label: string
  path: (i: number) => number[]
  /** UTXO only — the script type the addresses were generated with. */
  scriptType?: string
  /** Uncommon path+scriptType combo the Send page can't spend from — offer the
   *  in-place sweep on funded rows. Standard/common rows never get it (the
   *  standard receive address is the sweep DESTINATION). */
  sweepable?: boolean
}

// Litecoin: pre-1.4.10 Vault releases derived Native SegWit (ltc1…) addresses
// on the BIP44 path — a non-standard combo no other wallet scans. The audit
// account scan covers it via xpubs; this address-level grid makes it explicit
// and verifiable for support cases.
const LTC_KNOWN_SCHEMES: KnownScheme[] = [
  { label: 'Uncommon — Native SegWit on BIP44 path', path: (i) => [0x8000002C, 0x80000002, 0x80000000, 0, i], scriptType: 'p2wpkh', sweepable: true },
  { label: 'Standard BIP44 — Legacy (L…)', path: (i) => [0x8000002C, 0x80000002, 0x80000000, 0, i], scriptType: 'p2pkh' },
  { label: 'Standard BIP84 — Native SegWit (ltc1…)', path: (i) => [0x80000054, 0x80000002, 0x80000000, 0, i], scriptType: 'p2wpkh' },
]

function schemesFor(chainId: string): KnownScheme[] {
  return chainId === 'litecoin' ? LTC_KNOWN_SCHEMES : EVM_KNOWN_SCHEMES
}

/** Unique (path, scriptType) combos (deduped across schemes) for index range,
 *  each with the wallet labels that use it. */
function buildPaths(chainId: string, fromIdx: number, toIdx: number): { pathStr: string; path: number[]; scriptType?: string; labels: string[]; sweepable: boolean }[] {
  const map = new Map<string, { path: number[]; scriptType?: string; labels: Set<string>; sweepable: boolean }>()
  for (const s of schemesFor(chainId)) {
    for (let i = fromIdx; i <= toIdx; i++) {
      const path = s.path(i)
      const key = `${bip32(path)}|${s.scriptType || ''}`
      const e = map.get(key)
      if (e) { e.labels.add(s.label); e.sweepable = e.sweepable || !!s.sweepable }
      else map.set(key, { path, scriptType: s.scriptType, labels: new Set([s.label]), sweepable: !!s.sweepable })
    }
  }
  return [...map.values()].map(v => ({ pathStr: bip32(v.path), path: v.path, scriptType: v.scriptType, labels: [...v.labels], sweepable: v.sweepable }))
}

interface Row extends AuditDerivedAddress {
  labels: string[]
  isDefault: boolean
  scriptType?: string
  sweepable?: boolean
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
    const specs = buildPaths(chainId, fromIdx, toIdx)
    setScanning(true); setErr(null); setOpened(true)
    try {
      // auditScanPaths takes ONE scriptType per call — group the specs (UTXO
      // combos differ per scheme; EVM is a single undefined group).
      const groups = new Map<string, typeof specs>()
      for (const s of specs) {
        const k = s.scriptType || ''
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k)!.push(s)
      }
      const newRows: Row[] = []
      for (const [st, group] of groups) {
        // Generous timeout: the backend now retries patiently when the balance
        // API blips instead of failing rows fast.
        const { results } = await rpcRequest<{ results: AuditDerivedAddress[] }>('auditScanPaths', { chainId, paths: group.map(s => s.path), scriptType: st || undefined }, 900000)
        const specByPath = new Map(group.map(s => [s.pathStr, s]))
        for (const r of results) {
          const spec = specByPath.get(r.pathStr)
          newRows.push({
            ...r,
            scriptType: st || undefined,
            labels: spec?.labels || [],
            sweepable: spec?.sweepable,
            isDefault: !!lowerDefault && r.address.toLowerCase() === lowerDefault,
          })
        }
      }
      // Surface funded / couldn't-verify NON-default paths to the handoff.
      newRows.filter(r => !r.isDefault && (r.hasBalance || r.balanceError)).forEach(onFound)
      setRows(prev => {
        const key = (p: Row) => `${p.pathStr}|${p.scriptType || ''}`
        const seen = new Set(prev.map(key))
        return [...prev, ...newRows.filter(r => !seen.has(key(r)))]
      })
      setScannedTo(toIdx)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setScanning(false)
    }
  }

  const isLtc = chainId === 'litecoin'

  if (!opened) {
    return (
      <Button size="sm" w="100%" variant="outline" borderColor="var(--line-2)" color="var(--text-1)" fontWeight="600"
        _hover={{ borderColor: "var(--teal)", color: "var(--teal)", bg: "rgba(139,227,196,0.06)" }} onClick={() => scanRange(0, 0)}>
        {isLtc ? 'Scan uncommon paths (older Vault versions)' : 'Check common wallet paths (Ledger, MEW, …)'}
      </Button>
    )
  }

  return (
    <Box>
      <Text fontSize="sm" color="var(--text-1)" mb="2.5">{isLtc
        ? 'Funds can sit on uncommon path and address-type combinations. Here’s what each branch holds:'
        : 'Other wallets derive addresses differently from the same seed. Here’s what each common path holds:'}</Text>
      <VStack gap="2" align="stretch">
        {rows.map((r, i) => (
          <Box key={i} bg="var(--ink-2)" borderRadius="lg" px="3.5" py="2.5">
            <Flex justify="space-between" align="center" gap="4">
              <Box minW="0">
                <Flex align="center" gap="2" wrap="wrap">
                  <Text fontSize="12px" fontFamily="mono" color="var(--text-1)">{r.pathStr}{r.scriptType ? ` · ${r.scriptType}` : ''}</Text>
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
            {/* Funded UNCOMMON combos only: spend from the exact found path to
                the standard receive address, right in the grid. Standard rows
                never get this — they're Send-page spendable, and the default
                receive address is the sweep destination itself. */}
            {isLtc && r.hasBalance && r.sweepable && !r.isDefault && !!r.addressNList?.length && (
              <AuditSweepButton chainId={chainId} addressNList={r.addressNList} scriptType={r.scriptType} address={r.address} onOpenUrl={onOpenUrl} />
            )}
          </Box>
        ))}
      </VStack>
      <Flex gap="3" mt="2.5" align="center">
        <Button size="xs" variant="outline" borderColor="var(--line-2)" color="var(--text-2)" loading={scanning} onClick={() => scanRange(scannedTo + 1, scannedTo + 2)}>Check the next addresses</Button>
        {err && <Text fontSize="xs" color="var(--rose)">{err}</Text>}
      </Flex>
      <Text fontSize="11px" color="var(--text-3)" mt="2">{isLtc
        ? 'Funds on any of these Litecoin branches ARE tracked — they show in your portfolio and are spendable.'
        : 'Funds on a non-standard path can’t be tracked in-app — use “Still missing?” to send them to support.'}</Text>
    </Box>
  )
}
