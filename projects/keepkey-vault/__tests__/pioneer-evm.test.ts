import { describe, expect, test } from 'bun:test'

import { pioneerEvmRpc } from '../src/bun/pioneer-evm'

describe('Pioneer EVM adapter', () => {
  test('an older Pioneer without EvmReadRpc fails explicitly, never a direct node', async () => {
    await expect(pioneerEvmRpc({}, 'eip155:1', 'eth_call', [{
      to: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85',
      input: `0x3593564c${'00'.repeat(32)}`,
    }, 'latest'])).rejects.toThrow('Pioneer does not expose eth_call (server has no EvmReadRpc)')
    await expect(pioneerEvmRpc({}, 'eip155:8453', 'eth_simulateV1', [{}])).rejects.toThrow('server has no EvmReadRpc')
  })

  test('simulation reads go through EvmReadRpc on Pioneer', async () => {
    const sent: any[] = []
    const pioneer = { EvmReadRpc: async (body: any) => { sent.push(body); return { data: { success: true, data: body.method === 'eth_blockNumber' ? '0x10' : ['ok'] } } } }
    const call = [{ to: '0x00dc6100103bc402d490aee3f9a5560cbd91f1d4', input: '0x44bc937b' }, 'latest']
    expect(await pioneerEvmRpc(pioneer, 'eip155:8453', 'eth_blockNumber', [])).toBe('0x10')
    expect(await pioneerEvmRpc(pioneer, 'eip155:8453', 'eth_call', call)).toEqual(['ok'])
    expect(sent.map((b) => b.method)).toEqual(['eth_blockNumber', 'eth_call'])
    expect(sent[1]).toEqual({ networkId: 'eip155:8453', method: 'eth_call', params: call })
    await expect(pioneerEvmRpc({ EvmReadRpc: async () => ({ data: { success: false, error: 'execution reverted' } }) }, 'eip155:8453', 'eth_getCode', ['0x0', 'latest']))
      .rejects.toThrow('Pioneer EvmReadRpc failed: execution reverted')
  })

  test('rejects calls with neither data nor input', async () => {
    await expect(pioneerEvmRpc({}, 'eip155:1', 'eth_call', [{
      to: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85',
    }, 'latest'])).rejects.toThrow('Invalid EVM call data')
  })
})
