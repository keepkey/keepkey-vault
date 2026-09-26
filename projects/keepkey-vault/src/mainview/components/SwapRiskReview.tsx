import { Box, Flex, Text } from '@chakra-ui/react'
import type { SwapRisk } from '../../shared/swap-risk'

const usd = (value: number | undefined) => value === undefined ? 'USD unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
const pct = (value: number | undefined) => value === undefined ? 'Unavailable' : `${value.toFixed(2)}%`

export function SwapRiskReview({ risk, expected, minimum, symbol, minimumSource, acknowledged, onAcknowledge }: {
  risk: SwapRisk; expected: string; minimum: string; symbol: string
  minimumSource?: string; acknowledged: boolean; onAcknowledge: (value: boolean) => void
}) {
  const loss = Math.min(100, risk.expectedLossPct ?? 0)
  const worst = Math.min(100, risk.minimumLossPct ?? loss)
  const color = risk.blocked ? 'var(--rose)' : risk.warning || risk.requiresAcknowledgment ? 'var(--gold)' : 'var(--teal)'
  return (
    <Box w="full" p="3" border="1px solid" borderColor={color} borderRadius="lg" bg="rgba(255,255,255,0.025)">
      <Flex justify="space-between" gap="2" mb="2">
        <Text fontSize="12px" fontWeight="700">What this trade can cost</Text>
        <Text fontSize="10px" color={color}>{risk.tier === 'large' ? '$1,000+ review' : risk.tier === 'small' ? 'Under $1,000' : 'Value unverified'}</Text>
      </Flex>
      {risk.expectedLossPct !== undefined && risk.minimumLossPct !== undefined && (
        <>
          <Flex h="12px" borderRadius="full" overflow="hidden" role="img"
            aria-label={`Minimum retained value ${(100 - worst).toFixed(2)}%, additional slippage allowance ${(worst - loss).toFixed(2)}%, quoted cost ${loss.toFixed(2)}%`}>
            <Box w={`${100 - worst}%`} bg="var(--teal)" />
            <Box w={`${Math.max(0, worst - loss)}%`} bg="var(--gold)" />
            <Box w={`${loss}%`} bg="var(--rose)" />
          </Flex>
          <Flex gap="3" flexWrap="wrap" my="2" fontSize="10px">
            <Text color="var(--teal)">● Minimum value</Text><Text color="var(--gold)">● Slippage allowance</Text><Text color="var(--rose)">● Quoted cost</Text>
          </Flex>
        </>
      )}
      <Flex justify="space-between" fontSize="11px" mt="1"><Text>Trade value</Text><Text>{usd(risk.inputUsd)}</Text></Flex>
      <Flex justify="space-between" fontSize="11px" mt="1"><Text>Expected cost vs input</Text><Text color={color}>{pct(risk.expectedLossPct)} · {usd(risk.expectedLossUsd)}</Text></Flex>
      <Flex justify="space-between" fontSize="11px" mt="1"><Text>Loss at minimum receive</Text><Text>{pct(risk.minimumLossPct)} · {usd(risk.minimumLossUsd)}</Text></Flex>
      <Flex justify="space-between" fontSize="11px" mt="1"><Text>Expected receive</Text><Text>{expected} {symbol}</Text></Flex>
      <Flex justify="space-between" fontSize="11px" mt="1"><Text>{minimumSource === 'memo' ? 'Minimum in transaction memo' : minimumSource === 'estimate' ? 'Estimated minimum' : 'Provider minimum'}</Text><Text>{minimum} {symbol}</Text></Flex>
      <Text fontSize="10px" color="kk.textMuted" mt="2">
        Expected cost includes the quoted rate and route fees. The additional allowance is {pct(risk.allowancePct)} of expected output. Source gas and later market movements are separate. Minimum amounts are execution limits, not guaranteed refunds after fees.
      </Text>
      {risk.tier === 'large' && <Text fontSize="10px" color="kk.textMuted" mt="2">$1,000+ trades: warn at 0.5% expected cost; acknowledge at 1% expected cost or 2% loss at the minimum; block at 5% expected cost.</Text>}
      {risk.tier === 'small' && <Text fontSize="10px" color="kk.textMuted" mt="2">For smaller trades, fixed fees can dominate. Fee warnings start at 10% of trade value.</Text>}
      {risk.blocked && <Text fontSize="12px" color="var(--rose)" fontWeight="700" mt="2">This route exceeds the 5% cost limit. Change the amount or route and request a new quote.</Text>}
      {risk.requiresAcknowledgment && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={acknowledged} onChange={event => onAcknowledge(event.target.checked)} />
          <span>{risk.expectedLossPct === undefined || risk.minimumLossPct === undefined || risk.tier === 'unknown'
            ? 'I understand that price data is missing and the trade value or loss cannot be fully checked.'
            : `I accept the expected cost of ${usd(risk.expectedLossUsd)} and loss of up to ${usd(risk.minimumLossUsd)} at the stated minimum.`}</span>
        </label>
      )}
    </Box>
  )
}
