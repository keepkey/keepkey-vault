import { describe, expect, test } from 'bun:test'
import { bufferedSwapGasLimit } from '../src/shared/swap-gas'
import { assertPrebuiltSwapExecution, assertSwapExecutionService } from '../src/bun/swap-preflight'

const tx = {
  chainId: 1,
  from: '0x1111111111111111111111111111111111111111',
  to: '0x0729e2a4716d9f7dd17858d5d504426d228697f7',
  data: '0xcd6e13f7', value: '0x00', gas: '0x070d60',
  maxFeePerGas: '0x0871a12a', maxPriorityFeePerGas: '0x05f5e100',
}

describe('prebuilt swap gas', () => {
  test('adds execution headroom to the gas limit exhausted by the failed ETH→USDT swap', () => {
    expect(bufferedSwapGasLimit('462176', tx.data)).toBe('554612')
    expect(bufferedSwapGasLimit('0x70d60', tx.data)).toBe('554612')
    expect(bufferedSwapGasLimit('150000', tx.data)).toBe('180000')
  })

  test('does not inflate plain deposit-channel transfers', () => {
    expect(bufferedSwapGasLimit('21000', '0x')).toBe('21000')
  })

  test('rejects invalid quote limits instead of preparing an unusable transaction', () => {
    for (const limit of ['0', '0x0', '-1', '123.4', '', 'invalid']) {
      expect(() => bufferedSwapGasLimit(limit, tx.data)).toThrow(/invalid gas limit/)
    }
  })
})

describe('swap execution check before signing', () => {
  test('identifies a missing Pioneer operation before any approval can be requested', () => {
    expect(() => assertSwapExecutionService('eip155:1', {})).toThrow(/select a compatible server in Settings/i)
    expect(() => assertSwapExecutionService('eip155:1', { EvmReadRpc: async () => ({}) })).not.toThrow()
    expect(() => assertSwapExecutionService('https://custom.example/rpc', {})).not.toThrow()
  })

  test('calls the configured service with canonical quantities and final transaction fields', async () => {
    let checked = false
    await assertPrebuiltSwapExecution('eip155:1', tx, async (endpoint, method, params) => {
      expect(endpoint).toBe('eip155:1')
      expect(method).toBe('eth_call')
      expect(params).toEqual([{
        from: tx.from, to: tx.to, input: tx.data, value: '0x0', gas: '0x70d60',
        maxFeePerGas: '0x871a12a', maxPriorityFeePerGas: '0x5f5e100',
      }, 'pending'])
      checked = true
      return '0x'
    })
    expect(checked).toBe(true)
  })

  test('out-of-gas, reverts, and RPC failures stop before the swap signature', async () => {
    for (const reason of ['out of gas', 'execution reverted: Too little received', 'RPC HTTP 502']) {
      await expect(assertPrebuiltSwapExecution('eip155:1', tx, async () => { throw new Error(reason) }))
        .rejects.toThrow(`Swap execution check failed: ${reason}`)
    }
  })

  test('requires an endpoint and a valid execution answer', async () => {
    await expect(assertPrebuiltSwapExecution(undefined, tx)).rejects.toThrow(/no EVM service/)
    for (const answer of [undefined, null, {}, 'error', '0x1']) {
      await expect(assertPrebuiltSwapExecution('eip155:1', tx, async () => answer)).rejects.toThrow(/no valid execution result/)
    }
  })
})
