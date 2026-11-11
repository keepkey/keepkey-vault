import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'
import type { ExecuteSwapParams } from '../src/shared/types'

// Isolated suite: the real executeSwap builds a provider ERC-20 swap that needs
// an approval, stopping at the device boundary. No device or network is used.
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const basePioneer = {
  GetNonceByNetwork: async () => ({ data: { nonce: 7 } }),
  GetBalanceAddressByNetwork: async () => ({ data: { nativeBalance: '1' } }),
  GetTokenDecimals: async () => ({ data: { decimals: 6 } }),
  GetTokenBalance: async () => ({ data: { data: '100' } }),
  GetTokenAllowance: async () => ({ data: { data: { allowance: '0' } } }),
}
let pioneer: Record<string, unknown> = basePioneer
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => pioneer, getPioneerApiBase: () => 'https://fixture.invalid', getQueryKey: () => 'fixture' }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: '/private/tmp/vault-swap-execution-service-test' } } }))
const { executeSwap } = await import('../src/bun/swap')

const originalFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = (async () => { throw new Error('No network request expected') }) as typeof fetch })
afterEach(() => { globalThis.fetch = originalFetch; pioneer = basePioneer })

const params: ExecuteSwapParams = {
  fromChainId: 'ethereum', toChainId: 'ethereum', fromCaip: `eip155:1/erc20:${usdc}`, toCaip: 'eip155:1/slip44:60',
  amount: '10', expectedOutput: '0.004', inboundAddress: '', memo: '', integration: 'relay', swapper: 'Relay',
  fromAddressOverride: '0x000000000000000000000000000000000000bEEF', toAddressOverride: '0x000000000000000000000000000000000000bEEF',
  relayTx: { to: '0x000000000000000000000000000000000000c0fe', data: '0x12345678' + '0'.repeat(64), value: '0', chainId: 1,
    gasLimit: '200000', maxFeePerGas: '30000000000', maxPriorityFeePerGas: '1000000000' },
}
const run = async () => {
  const prompts: string[] = []
  const ctx: any = { wallet: {}, getAllChains: () => CHAINS, getEvmRpcSource: () => 'eip155:1', isAdvancedModeEnabled: () => true,
    pushSubStage: () => {}, wrapSign: async (_sign: unknown, meta: { operation: string }) => { prompts.push(meta.operation); throw new Error('TEST_STOP_BEFORE_DEVICE') } }
  const error = await executeSwap(params, ctx).then(() => undefined, (e: Error) => e)
  return { prompts, message: error?.message }
}

test('a Pioneer without EvmReadRpc refuses the swap before the approval prompt', async () => {
  const result = await run()
  expect(result.message).toMatch(/lacks EVM execution checks/)
  expect(result.prompts).toEqual([])
})

test('a Pioneer with EvmReadRpc continues to the approval prompt', async () => {
  pioneer = { ...basePioneer, EvmReadRpc: async () => ({ data: { data: '0x' } }) }
  const result = await run()
  expect(result.message).toBe('TEST_STOP_BEFORE_DEVICE')
  expect(result.prompts).toEqual(['erc20Approve'])
})
