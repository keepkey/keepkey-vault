/**
 * Custom-path search for the Audit walkthrough — guided steppers (account /
 * index / script-type) with an advanced raw BIP32 expander. Derives the path on
 * the device + balance-checks via Pioneer (auditDeriveCustom). Used inside a
 * chain step when standard account discovery is exhausted.
 */
import { useState } from "react"
import { Box, Flex, Text, Button, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { BTC_SCRIPT_TYPES } from "../../shared/chains"
import type { AuditDerivedAddress } from "../../shared/types"

const BTC_SCRIPTS = BTC_SCRIPT_TYPES.map(s => s.scriptType)

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

function Stepper({ label, value, setValue }: { label: string; value: number; setValue: (n: number) => void }) {
  return (
    <Flex align="center" justify="space-between">
      <Text fontSize="xs" color="kk.textSecondary">{label}</Text>
      <Flex align="center" gap="2">
        <Button size="2xs" variant="outline" borderColor="kk.border" color="kk.textSecondary" onClick={() => setValue(Math.max(0, value - 1))}>−</Button>
        <Text fontSize="sm" minW="24px" textAlign="center" fontFamily="mono">{value}</Text>
        <Button size="2xs" variant="outline" borderColor="kk.border" color="kk.textSecondary" onClick={() => setValue(value + 1)}>+</Button>
      </Flex>
    </Flex>
  )
}

interface AuditCustomPathProps {
  chainId: string
  family: string
  defaultPath: number[]
  scriptType?: string
  onResult: (r: AuditDerivedAddress) => void
}

export function AuditCustomPath({ chainId, family, defaultPath, scriptType, onResult }: AuditCustomPathProps) {
  const [account, setAccount] = useState(0)
  const [index, setIndex] = useState(0)
  const [script, setScript] = useState(scriptType || 'p2wpkh')
  const [raw, setRaw] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isEvm = family === 'evm'
  const hasIndexSlot = defaultPath.length >= 4

  function guidedPath(): number[] {
    const p = [...defaultPath]
    // EVM: the address index IS the hardened account element [2] (evmAddressPath),
    // which is what the scan derives and addEvmAddressIndex tracks — vary only [2].
    if (isEvm) { if (p.length > 2) p[2] = 0x80000000 + account; return p }
    // UTXO: the chosen script type dictates the BIP44/49/84 purpose — remap [0]
    // so the path and scriptType agree (else the device derives a different addr).
    if (family === 'utxo') {
      const purpose = BTC_SCRIPT_TYPES.find(s => s.scriptType === script)?.purpose
      if (purpose != null && p.length > 0) p[0] = 0x80000000 + purpose
    }
    if (p.length > 2) p[2] = 0x80000000 + account
    if (hasIndexSlot) p[p.length - 1] = index
    return p
  }

  const previewPath = advanced ? (parsePath(raw) ? bip32(parsePath(raw)!) : '—') : bip32(guidedPath())

  async function check() {
    setErr(null)
    const path = advanced ? parsePath(raw) : guidedPath()
    if (!path) { setErr("Enter a valid path like m/44'/60'/0'/0/5"); return }
    setBusy(true)
    try {
      const r = await rpcRequest<AuditDerivedAddress>('auditDeriveCustom', {
        chainId, addressNList: path, scriptType: family === 'utxo' ? script : undefined,
      }, 900000)
      onResult(r)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box bg="whiteAlpha.50" borderRadius="md" p="3" mt="2">
      <Flex justify="space-between" align="center" mb="2">
        <Text fontSize="11px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.08em">Custom path</Text>
        <Button size="2xs" variant="ghost" color="kk.textMuted" onClick={() => setAdvanced(a => !a)}>{advanced ? 'Guided' : 'Advanced'}</Button>
      </Flex>

      {!advanced ? (
        <Flex direction="column" gap="2">
          <Stepper label={isEvm ? 'Address index' : 'Account'} value={account} setValue={setAccount} />
          {!isEvm && hasIndexSlot && <Stepper label="Receive index" value={index} setValue={setIndex} />}
          {family === 'utxo' && (
            <Flex gap="1">
              {BTC_SCRIPTS.map(s => (
                <Button key={s} size="2xs" flex="1"
                  variant={script === s ? 'solid' : 'outline'}
                  bg={script === s ? 'var(--teal)' : 'transparent'}
                  color={script === s ? 'black' : 'kk.textSecondary'}
                  borderColor="kk.border"
                  onClick={() => setScript(s)}>{s}</Button>
              ))}
            </Flex>
          )}
        </Flex>
      ) : (
        <Input size="sm" placeholder="m/44'/60'/0'/0/5" value={raw} onChange={e => setRaw(e.target.value)}
          bg="whiteAlpha.50" border="1px solid" borderColor="kk.border" fontFamily="mono" fontSize="xs" />
      )}

      <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" mt="2">{previewPath}</Text>
      {err && <Text fontSize="xs" color="red.400" mt="1">{err}</Text>}
      <Button size="sm" w="100%" mt="2" bg="var(--teal)" color="black" fontWeight="600" _hover={{ bg: "#22c55e" }} loading={busy} onClick={check}>
        Check this path
      </Button>
    </Box>
  )
}
