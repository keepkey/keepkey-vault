/** A protocol status alone cannot prove a streaming swap has paid every leg. */
import { decimalToBaseUnitsStrict } from './max-send'

/** The quote's expected output is an estimate; the real output always differs
 *  a little (outbound fee, price move). A payout at or above the minimum is the
 *  whole swap, not a partial one with more to come. */
export function payoutReachesMinimum(receivedHuman?: string, minimumHuman?: string): boolean {
  const minimum = Number(minimumHuman || 0)
  return minimum > 0 && Number(receivedHuman || 0) + 1e-8 >= minimum
}

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
