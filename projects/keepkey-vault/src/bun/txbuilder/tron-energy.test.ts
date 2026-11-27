import { expect, test } from 'bun:test'
import { assertTronEnergyAffordable } from './tron-energy'

test('a TRC-20 send whose energy burn exceeds the TRX balance is refused (audit v8 B7)', () => {
  // 130k energy at 100 sun = 13 TRX burn.
  expect(() => assertTronEnergyAffordable(130_000, 100, 0, 5_000_000n)).toThrow(/Insufficient TRX for gas/)
  assertTronEnergyAffordable(130_000, 100, 0, 13_000_000n)
  // Staked energy covers part of it: 30k left to burn = 3 TRX.
  assertTronEnergyAffordable(130_000, 100, 100_000, 3_000_000n)
  expect(() => assertTronEnergyAffordable(130_000, 100, 100_000, 2_999_999n)).toThrow(/TRX/)
})
