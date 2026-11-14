import { expect, mock, test } from 'bun:test'

// V16: swap history recorded Base native ETH as "BASE" (raw discovery symbol).
const unused = () => { throw new Error('No database in this test') }
mock.module('../src/bun/db', () => ({ insertSwapHistory: unused, updateSwapHistoryStatus: unused, getSwapHistory: unused, getSwapHistoryByTxid: unused, setSwapRelayRequestId: unused }))
mock.module('../src/bun/ledger', () => ({ recordSwap: () => {} }))
mock.module('../src/bun/engine-controller', () => ({ withTimeout: async (operation: Promise<any>) => operation }))
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => { throw new Error('No network in this test') } }))
const { resolveDisplayFromCaip } = await import('../src/bun/swap-tracker')

test('swap history records Base/Arbitrum/Optimism native ETH as ETH', () => {
  expect(resolveDisplayFromCaip('eip155:8453/slip44:60')).toMatchObject({ symbol: 'ETH', asset: 'BASE.ETH' })
  expect(resolveDisplayFromCaip('eip155:42161/slip44:60').symbol).toBe('ETH')
  expect(resolveDisplayFromCaip('eip155:10/slip44:60').symbol).toBe('ETH')
  expect(resolveDisplayFromCaip('eip155:56/slip44:60').symbol).toBe('BNB')
  // Tokens keep their discovery symbol.
  expect(resolveDisplayFromCaip('eip155:42161/erc20:0x912ce59144191c1204e64559fe8253a0e49e6548').symbol).toBe('ARB')
})
