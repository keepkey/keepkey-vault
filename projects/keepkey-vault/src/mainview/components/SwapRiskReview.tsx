import { useUiTranslation } from "../i18n/ui"
import type { SwapRisk } from '../../shared/swap-risk'
import { useFiat } from '../lib/fiat-context'
import { PreflightCheck, PreflightList, type PreflightRow } from './preflight/PreflightConsole'

const pct = (value: number | undefined) => value === undefined ? 'Unavailable' : `${value.toFixed(2)}%`

/** Only exceptional costs need a row. Normal amounts and costs live in the
 * trade summary, using this same quote-bound risk snapshot. */
export function useSwapRiskRows(risk: SwapRisk, acknowledged: boolean, onAcknowledge: (value: boolean) => void): PreflightRow[] {
  const uiText = useUiTranslation()
  const { fmt } = useFiat()
  if (!risk.blocked && !risk.warning && !risk.requiresAcknowledgment) return []
  const severe = (risk.expectedLossPct ?? 0) > 25
  const ack = risk.requiresAcknowledgment ? <PreflightCheck checked={acknowledged} onChange={onAcknowledge}>
    {risk.expectedLossPct === undefined || risk.minimumLossPct === undefined || risk.tier === 'unknown'
      ? uiText("I understand that price data is missing and the trade value or loss cannot be fully checked.")
      : uiText("I accept the estimated swap cost of {{cost}} and a value difference of {{loss}} at minimum receive. The source network fee is separate.", { cost: fmt(risk.expectedLossUsd), loss: fmt(risk.minimumLossUsd) })}
  </PreflightCheck> : null
  if (risk.blocked) return [{ key: 'risk', status: 'block', tag: uiText("blocks"), attrs: { 'data-swap-risk': 'blocked' },
    title: uiText("This route exceeds the 5% cost limit. Change the amount or route and request a new quote.") }]
  return [{ key: 'risk', status: severe ? 'danger' : 'warn', attrs: { 'data-swap-risk': risk.warning ? 'warning' : 'acknowledge' },
    title: risk.warning
      ? uiText("High swap cost: {{cost}}, excluding the source network fee.", { cost: risk.expectedLossUsd === undefined ? pct(risk.expectedLossPct) : `${fmt(risk.expectedLossUsd)} (${pct(risk.expectedLossPct)})` })
      : uiText("Check the trade value"),
    detail: ack }]
}

/** The same rows as a standalone checklist. */
export function SwapRiskReview({ risk, acknowledged, onAcknowledge }: {
  risk: SwapRisk; acknowledged: boolean; onAcknowledge: (value: boolean) => void
}) {
  const rows = useSwapRiskRows(risk, acknowledged, onAcknowledge)
  return rows.length ? <PreflightList rows={rows} /> : null
}
