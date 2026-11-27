/** Cosmos SDK send fees, shared by the builder (bun/txbuilder/cosmos.ts) and the
 *  send form, which warns while the amount is typed when amount + fee is more
 *  than the balance (KEEPKEY-177). Moved unchanged from cosmos.ts. */
import { decimalToBaseUnits } from './max-send'


// Native transaction fee reserved on a MAX send/deposit (in display units).
// THORChain/Maya charge this fee on top of the deposited/sent amount at the
// bank layer (the tx `fee.amount` is '0' — the network deducts it from the
// account), so a MAX must leave headroom: account needs amount + fee. Maya's
// NativeTransactionFee is 0.2 CACAO (2000000000 base @ 10 decimals); reserving
// 0 swept 100% of the balance and every MAX CACAO swap reverted with
// "insufficient funds". THORChain's native_tx_fee is 0.02 RUNE.
// Only THOR/Maya belong here: Cosmos Hub and Osmosis pay their fee through the
// tx's own `fee.amount`, so a floor here overstated it (Osmosis showed and
// balance-checked 0.035 OSMO while the tx paid 0.01/0.015/0.02).
export const COSMOS_NATIVE_FEES: Record<string, number> = {
  thorchain: 0.02,
  mayachain: 0.2,
}

export const COSMOS_FEE_TEMPLATES: Record<string, { gas: string; amount: { denom: string; amount: string }[] }> = {
  thorchain: { gas: '500000000', amount: [{ denom: 'rune', amount: '0' }] },
  mayachain: { gas: '500000000', amount: [{ denom: 'cacao', amount: '0' }] },
  cosmos: { gas: '1000000', amount: [{ denom: 'uatom', amount: '5000' }] },
  osmosis: { gas: '1000000', amount: [{ denom: 'uosmo', amount: '10000' }] },
}

/** The tx fee for a fee level (1-2 slow, 3-4 average, 5+ fast), as the builder signs it. */
export function cosmosSendFee(chainId: string, feeLevel = 5): { gas: string; amount: { denom: string; amount: string }[] } {
  const baseFee = COSMOS_FEE_TEMPLATES[chainId] || COSMOS_FEE_TEMPLATES.cosmos
  const gasMultiplier = feeLevel <= 2 ? 1 : feeLevel <= 4 ? 1.5 : 2
  const adjustedGas = String(Math.ceil(Number(baseFee.gas) * gasMultiplier))
  const adjustedFeeAmount = baseFee.amount.map(a => ({
    ...a,
    amount: String(Math.ceil(Number(a.amount) * gasMultiplier)),
  }))
  return { gas: adjustedGas, amount: adjustedFeeAmount }
}

/** Fee the user actually pays, in display units. THOR/Maya put '0' in
 *  `fee.amount` and charge COSMOS_NATIVE_FEES at the bank layer. */
export function cosmosDisplayFee(chainId: string, decimals: number, fee: { amount: { amount: string }[] }): string {
  const txFee = Number(fee.amount[0]?.amount || 0) / 10 ** decimals
  return String(Math.max(txFee, COSMOS_NATIVE_FEES[chainId] || 0))
}

/** True when amount + fee is more than the balance, compared in base units so a
 *  float sum (0.29 + 0.01 = 0.30000000000000004) never warns wrongly. An
 *  unreadable figure gives false: the builder still checks the live balance. */
export function amountPlusFeeExceedsBalance(amount: string, fee: string, balance: string, decimals: number): boolean {
  const units = [amount, fee, balance].map(value => decimalToBaseUnits(value, decimals))
  if (units.some(value => value === null)) return false
  const [a, f, b] = units as bigint[]
  return a + f > b
}
