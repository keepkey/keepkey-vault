import coinSelectSplit from 'coinselect/split'
// @ts-ignore — coinselect does not publish types for its size helpers
import { transactionBytes } from 'coinselect/utils'

/** Select transparent inputs with the ZIP-317 floor included before choosing change. */
export function selectZcashCoins(utxos: any[], to: string, amount: number, feeRate: number, isMax: boolean, memo?: string, isSwapDeposit = false) {
  const memoOutputs = memo?.trim() ? 1 : 0
  const requiredFee = (inputs: any[], outputs: any[]) => Math.max(
    Math.ceil(transactionBytes(inputs, outputs) * feeRate),
    5000 * Math.max(2, inputs.length, outputs.length + memoOutputs),
  )
  if (isMax) {
    const result = coinSelectSplit(utxos, [{ address: to }], feeRate)
    if (!result.inputs || !result.outputs) return result
    const fee = Math.max(result.fee, requiredFee(result.inputs, result.outputs))
    const value = result.inputs.reduce((sum: number, input: any) => sum + input.value, 0) - fee
    if (value <= 5000) return { fee }
    return { inputs: result.inputs, outputs: [{ address: to, value }], fee }
  }

  const inputs: any[] = []
  let total = 0
  let fee = 0
  for (const input of [...utxos].sort((a, b) => b.value - a.value)) {
    inputs.push(input)
    total += input.value
    const outputs = [{ address: to, value: amount }]
    fee = requiredFee(inputs, outputs)
    if (total < amount + fee) continue
    const changeFee = requiredFee(inputs, [...outputs, { value: 0 }])
    const change = total - amount - changeFee
    if (change >= 5000) {
      return { inputs, outputs: [...outputs, { value: change }], fee: changeFee }
    }
    // Dropping change can reduce the action count. All remaining value pays
    // the fee; the exact quoted recipient amount is preserved.
    return { inputs, outputs, fee: total - amount }
  }
  // Swap providers need the largest deliverable deposit when the quoted
  // amount was based on a stale/full balance. Trim the recipient output by
  // the ZIP-317 fee instead of attempting to overspend the wallet.
  if (isSwapDeposit && total > 0) {
    const outputs = [{ address: to, value: amount }]
    const swapFee = requiredFee(inputs, outputs)
    const net = total - swapFee
    if (net > 5000) return { inputs, outputs: [{ address: to, value: net }], fee: swapFee }
  }
  return { fee }
}
