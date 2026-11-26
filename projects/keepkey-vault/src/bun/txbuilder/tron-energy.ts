import { balanceErrorMessage } from '../../shared/send-balance-errors'

/** TRC-20 energy the account lacks is paid by burning TRX. Refuse a transfer
 * whose estimated burn exceeds the TRX balance: on chain it would run out of
 * energy, revert, and still burn what the account had. */
export function assertTronEnergyAffordable(energyNeeded: number, energyPriceSun: number, energyAvailable: number, balanceSun: bigint): void {
  const burnSun = BigInt(Math.max(0, Math.ceil(energyNeeded - Math.max(0, energyAvailable)) * energyPriceSun))
  if (burnSun > balanceSun) {
    throw new Error(balanceErrorMessage('gas', { symbol: 'TRX', have: Number(balanceSun) / 1e6, need: Number(burnSun) / 1e6 }))
  }
}
