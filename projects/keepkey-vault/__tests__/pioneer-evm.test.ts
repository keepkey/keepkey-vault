import { describe, expect, test } from 'bun:test'

import { pioneerEvmRpc } from '../src/bun/pioneer-evm'

describe('Pioneer EVM adapter', () => {
  test('accepts normalized eth_call input and reports unsupported selectors accurately', async () => {
    await expect(pioneerEvmRpc({}, 'eip155:1', 'eth_call', [{
      to: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85',
      input: `0x3593564c${'00'.repeat(32)}`,
    }, 'latest'])).rejects.toThrow('Pioneer does not expose this eth_call selector: 0x3593564c')
  })

  test('rejects calls with neither data nor input', async () => {
    await expect(pioneerEvmRpc({}, 'eip155:1', 'eth_call', [{
      to: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85',
    }, 'latest'])).rejects.toThrow('Invalid EVM call data')
  })
})
