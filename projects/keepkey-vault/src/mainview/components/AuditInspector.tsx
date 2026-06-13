/**
 * AuditInspector — raw-path debug panel. Derive any path and read back the
 * device's address + pubkey + xpub + balance (read-only). For power users
 * verifying exactly what an address derives to.
 */
import { useState } from "react"
import { Box, Flex, Text, Button, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import type { AuditInspectResult } from "../../shared/types"

function bip32(path: number[]): string {
  return 'm/' + path.map(n => (n >= 0x80000000 ? `${n - 0x80000000}'` : String(n))).join('/')
}
function parsePath(input: string): number[] | null {
  const t = input.trim().replace(/^m\//i, '')
  if (!t) return null
  const out: number[] = []
  for (const raw of t.split('/')) {
    const hardened = /['h]$/i.test(raw)
    const ns = hardened ? raw.slice(0, -1) : raw
    if (!/^\d+$/.test(ns)) return null
    const num = parseInt(ns, 10)
    if (num < 0 || num >= 0x80000000) return null
    out.push(hardened ? num + 0x80000000 : num)
  }
  return out.length >= 2 && out.length <= 10 ? out : null
}

function CopyRow({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <Flex justify="space-between" align="center" gap="2">
      <Text fontSize="10px" color="kk.textMuted" flexShrink={0}>{label}</Text>
      <Box as="button" textAlign="right"
        onClick={() => navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }).catch(() => {})}
        fontSize="10px" fontFamily="mono" color={copied ? "var(--teal)" : "kk.textSecondary"} truncate maxW="300px" title={value}>
        {copied ? 'copied ✓' : value}
      </Box>
    </Flex>
  )
}

interface AuditInspectorProps {
  chainId: string
  family: string
  defaultPath: number[]
  scriptType?: string
  onOpenUrl: (url: string) => void
}

export function AuditInspector({ chainId, family, defaultPath, scriptType, onOpenUrl }: AuditInspectorProps) {
  const [opened, setOpened] = useState(false)
  const [raw, setRaw] = useState(bip32(defaultPath))
  const [result, setResult] = useState<AuditInspectResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function inspect() {
    const path = parsePath(raw)
    if (!path) { setErr("Enter a valid path like m/44'/60'/0'/0/0"); return }
    setBusy(true); setErr(null)
    try {
      setResult(await rpcRequest<AuditInspectResult>('auditInspectPath', { chainId, addressNList: path, scriptType: family === 'utxo' ? scriptType : undefined }, 120000))
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  if (!opened) {
    return (
      <Box as="button" fontSize="10px" color="kk.textMuted" _hover={{ color: "var(--teal)" }} onClick={() => setOpened(true)}>
        Path inspector (debug) →
      </Box>
    )
  }

  return (
    <Box bg="whiteAlpha.50" borderRadius="md" p="3" mt="1">
      <Text fontSize="11px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.08em" mb="2">Path inspector</Text>
      <Flex gap="2">
        <Input size="sm" value={raw} onChange={e => setRaw(e.target.value)} bg="whiteAlpha.50" border="1px solid" borderColor="kk.border" fontFamily="mono" fontSize="xs" />
        <Button size="sm" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} loading={busy} onClick={inspect}>Derive</Button>
      </Flex>
      {err && <Text fontSize="xs" color="red.400" mt="1">{err}</Text>}
      {result && (
        <Box mt="2">
          <Flex justify="space-between" align="center" mb="1">
            <Text fontSize="xs" fontWeight="600" color={result.hasBalance ? "var(--teal)" : "kk.textSecondary"}>
              {result.balanceError ? 'balance unknown' : `${result.native} ${result.symbol}`}
            </Text>
            {result.explorerUrl && <Box as="button" fontSize="10px" color="var(--teal)" onClick={() => onOpenUrl(result.explorerUrl!)}>explorer ↗</Box>}
          </Flex>
          <Box bg="whiteAlpha.50" borderRadius="sm" p="2">
            <CopyRow label="address" value={result.address} />
            <CopyRow label="xpub" value={result.xpub} />
            <CopyRow label="pubkey" value={result.pubkey} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
