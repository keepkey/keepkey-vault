/** A protocol status alone cannot prove a streaming swap has paid every leg. */
import { decimalToBaseUnitsStrict } from './max-send'

export function payoutBelowMinimum(receivedBaseUnits: string, minimumHuman: string): boolean {
  if (!minimumHuman || Number(minimumHuman) <= 0) return false
  try { return BigInt(receivedBaseUnits) < decimalToBaseUnitsStrict(minimumHuman, 8) }
  catch { return true }
}

export function isSwapFullySettled(input: {
  status: string
  integration?: string
  swapper?: string
  payouts?: Array<{ txid: string; amount: string }>
  receivedOutput?: string
  minimumOutput?: string
}): boolean {
  if (input.status !== 'completed') return false
  if (!/thor|maya/i.test(`${input.integration || ''} ${input.swapper || ''}`)) return true
  const received = Number(input.receivedOutput)
  const minimum = Number(input.minimumOutput || 0)
  return !!input.payouts?.some(p => !!p.txid && Number(p.amount) > 0)
    && Number.isFinite(received) && received > 0
    && (!Number.isFinite(minimum) || minimum <= 0 || received + 1e-8 >= minimum)
}
