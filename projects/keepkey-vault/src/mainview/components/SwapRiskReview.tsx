import { useUiTranslation } from "../i18n/ui"
import { Box, Text } from '@chakra-ui/react'
import type { SwapRisk } from '../../shared/swap-risk'
import { useFiat } from '../lib/fiat-context'

const pct = (value: number | undefined) => value === undefined ? 'Unavailable' : `${value.toFixed(2)}%`

/** Only exceptional costs need a separate notice. Normal amounts and costs
 * live in the trade summary, using this same quote-bound risk snapshot. */
export function SwapRiskReview({ risk, acknowledged, onAcknowledge }: {
  risk: SwapRisk; acknowledged: boolean; onAcknowledge: (value: boolean) => void
}) {
  const uiText = useUiTranslation()
  const { fmt } = useFiat()

  if (!risk.blocked && !risk.warning && !risk.requiresAcknowledgment) return null

  const color = risk.blocked || (risk.expectedLossPct ?? 0) > 25 ? 'var(--rose)' : 'var(--gold)'
  return (
    <Box w="full" p="3" border="1px solid" borderColor={color} borderRadius="lg" bg="rgba(255,255,255,0.025)" role="note">
      {risk.warning && !risk.blocked && (
        <Text fontSize="12px" color={color}>
          {uiText("High swap cost: {{cost}}, excluding the source network fee.", { cost: risk.expectedLossUsd === undefined ? pct(risk.expectedLossPct) : `${fmt(risk.expectedLossUsd)} (${pct(risk.expectedLossPct)})` })}
        </Text>
      )}
      {risk.blocked && <Text fontSize="12px" color="var(--rose)" fontWeight="700">{uiText("This route exceeds the 5% cost limit. Change the amount or route and request a new quote.")}</Text>}
      {risk.requiresAcknowledgment && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: risk.warning ? 8 : 0, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={acknowledged} onChange={event => onAcknowledge(event.target.checked)} />
          <span>{risk.expectedLossPct === undefined || risk.minimumLossPct === undefined || risk.tier === 'unknown'
            ? uiText("I understand that price data is missing and the trade value or loss cannot be fully checked.")
            : uiText("I accept the estimated swap cost of {{cost}} and a value difference of {{loss}} at minimum receive. The source network fee is separate.", { cost: fmt(risk.expectedLossUsd), loss: fmt(risk.minimumLossUsd) })}</span>
        </label>
      )}
    </Box>
  )
}
