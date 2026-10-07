import { describe, expect, test } from 'bun:test'

import { EthSignTransactionRequest } from './schemas'

const id = `0x${'11'.repeat(32)}`

describe('ERC-7730 transaction catalog schema', () => {
  test('accepts a real-world EVM transaction with a signed catalog', () => {
    const parsed = EthSignTransactionRequest.parse({
      addressNList: [0x8000002c, 0x8000003c, 0x80000000, 0, 0],
      to: '0x111111125421ca6dc452d289314280a0f8842a65',
      data: '0x12aa3caf',
      chainId: 1,
      erc7730: {
        primaryDefinitionId: id,
        definitions: [{
          definitionId: id,
          envelope: '0x4b3737330201',
          kind: 1,
          chainId: 1,
          contractAddress: '0x111111125421ca6dc452d289314280a0f8842a65',
          selectorOrTypeHash: '0x12aa3caf',
        }],
      },
    })
    expect(parsed.erc7730?.definitions[0]?.selectorOrTypeHash).toBe('0x12aa3caf')
  })

  test('rejects malformed ids, odd envelopes, and unbounded catalogs', () => {
    const base = { addressNList: [1], to: '0x0', erc7730: { primaryDefinitionId: id, definitions: [] as any[] } }
    expect(() => EthSignTransactionRequest.parse(base)).toThrow()
    base.erc7730.definitions = [{ definitionId: '0x11', envelope: '0x123', kind: 1, chainId: 1 }]
    expect(() => EthSignTransactionRequest.parse(base)).toThrow()
  })
})
