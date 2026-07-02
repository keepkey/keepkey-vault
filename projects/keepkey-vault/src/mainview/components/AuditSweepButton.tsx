/**
 * AuditSweepButton — spend a funded address-level audit find (uncommon
 * path/scriptType combo or custom path) to the chain's standard receive
 * address, right in the audit flow. Two-step: quote (auditSweepPath dryRun —
 * re-derives the address on the CONNECTED device first, so a device swapped
 * since the scan is rejected before any signing), then sign + broadcast.
 */
import { useState } from "react"
import { Box, Flex, Text, Button, Spinner } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"

function fmtSats(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

interface SweepQuote {
  fromAddress: string
  destination: string
  inputCount: number
  totalSats: number
  fee: number
  outputSats: number
  symbol: string
  txid?: string
  explorerTxUrl?: string | null
}

interface AuditSweepButtonProps {
  chainId: string
  addressNList: number[]
  scriptType?: string
  address: string
  onOpenUrl: (url: string) => void
}

export function AuditSweepButton({ chainId, addressNList, scriptType, address, onOpenUrl }: AuditSweepButtonProps) {
  const [phase, setPhase] = useState<'idle' | 'quoting' | 'quoted' | 'signing' | 'done'>('idle')
  const [quote, setQuote] = useState<SweepQuote | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const params = { chainId, addressNList, scriptType, expectedAddress: address }

  async function getQuote() {
    setErr(null); setPhase('quoting')
    try {
      setQuote(await rpcRequest<SweepQuote>('auditSweepPath', { ...params, dryRun: true }, 120000))
      setPhase('quoted')
    } catch (e: any) {
      setErr(e.message); setPhase('idle')
    }
  }

  async function sweep() {
    setErr(null); setPhase('signing')
    try {
      setQuote(await rpcRequest<SweepQuote>('auditSweepPath', params, 300000))
      setPhase('done')
    } catch (e: any) {
      setErr(e.message); setPhase('quoted')
    }
  }

  if (phase === 'done' && quote?.txid) {
    return (
      <Flex mt="2" pt="2" borderTop="1px solid" borderColor="rgba(233,196,106,0.2)" align="center" gap="2" wrap="wrap">
        <Text fontSize="12px" color="var(--teal)" fontWeight="700">Swept ✓</Text>
        <Text fontSize="11px" color="var(--text-2)">{fmtSats(quote.outputSats)} {quote.symbol} → your main wallet</Text>
        <Text fontSize="10px" fontFamily="mono" color="var(--text-3)" truncate maxW="200px" title={quote.txid}>{quote.txid}</Text>
        {quote.explorerTxUrl && <Box as="button" fontSize="11px" color="var(--teal)" onClick={() => onOpenUrl(quote.explorerTxUrl!)}>view tx ↗</Box>}
      </Flex>
    )
  }

  return (
    <Box mt="2" pt="2" borderTop="1px solid" borderColor="rgba(233,196,106,0.2)">
      {phase === 'idle' || phase === 'quoting' ? (
        <Flex align="center" gap="3" wrap="wrap">
          <Button size="2xs" bg="var(--gold)" color="var(--ink-0)" fontWeight="700" _hover={{ bg: 'var(--gold-2)' }}
            loading={phase === 'quoting'} onClick={getQuote}>Sweep to main wallet</Button>
          <Text fontSize="11px" color="var(--text-3)">moves these funds to your standard address</Text>
        </Flex>
      ) : (
        <Box>
          {quote && (
            <Box fontSize="11px" color="var(--text-2)" mb="2">
              <Text>Send <Text as="span" color="var(--text-0)" fontWeight="700">{fmtSats(quote.outputSats)} {quote.symbol}</Text> (fee {fmtSats(quote.fee)} {quote.symbol}, {quote.inputCount} input{quote.inputCount > 1 ? 's' : ''})</Text>
              <Text fontFamily="mono" fontSize="10px" color="var(--text-3)" truncate title={quote.destination}>→ {quote.destination}</Text>
            </Box>
          )}
          {phase === 'signing' ? (
            <Flex align="center" gap="2"><Spinner size="xs" color="var(--gold)" /><Text fontSize="12px" color="var(--gold)">Confirm on your KeepKey…</Text></Flex>
          ) : (
            <Flex gap="2">
              <Button size="2xs" bg="var(--gold)" color="var(--ink-0)" fontWeight="700" _hover={{ bg: 'var(--gold-2)' }} onClick={sweep}>Confirm sweep</Button>
              <Button size="2xs" variant="outline" borderColor="var(--line-2)" color="var(--text-2)" onClick={() => { setPhase('idle'); setQuote(null) }}>Cancel</Button>
            </Flex>
          )}
        </Box>
      )}
      {err && <Text fontSize="11px" color="var(--rose)" mt="1.5">{err}</Text>}
    </Box>
  )
}
