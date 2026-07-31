import { describe, expect, test } from 'bun:test'
import { decodeEIP712 } from '../src/bun/eip712-decoder'

describe('x402 EVM signing presentation', () => {
  test('recognizes the official EIP-3009 exact-payment shape', () => {
    const decoded = decodeEIP712({
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      domain: {
        name: 'USDC',
        version: '2',
        chainId: 84532,
        verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      message: {
        from: '0x73d0385F4d8E00C5e6504C6030F47BF6212736A8',
        to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        value: '2000',
        validAfter: '0',
        validBefore: '2000000000',
        nonce: '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480',
      },
    })

    expect(decoded.operationName).toBe('x402 EIP-3009 Payment')
    expect(decoded.isKnownType).toBe(true)
    expect(decoded.domain).toEqual({
      name: 'USDC',
      version: '2',
      chainId: 84532,
      verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    })
    expect(decoded.fields.map(field => [field.label, field.raw])).toEqual([
      ['From', '0x73d0385F4d8E00C5e6504C6030F47BF6212736A8'],
      ['Pay To', '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'],
      ['Value', '2000'],
      ['Valid After', '0'],
      ['Valid Before', '2000000000'],
      ['Nonce', '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480'],
    ])
  })
})
