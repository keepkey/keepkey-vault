import { describe, expect, test } from 'bun:test'

import { getClearSignProtectionCaseStudies } from '../src/bun/clearsign-case-studies'

const EVM_HASH = '0x686f1cfeb70836bd052e79686393834fc5afb935b9f8badcd1e42bfc94b5870b'

describe('real-world ClearSign protection evidence', () => {
  test('derives claims from public-chain responses and states the unsupported boundary', async () => {
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      const result = request.method === 'eth_getTransactionByHash' ? {
        hash: EVM_HASH, blockNumber: '0x123', blockTimestamp: '0x65000000',
        to: '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', value: '0x64',
        input: `0xcd6e13f7${'00'.repeat(300)}`,
      } : request.method === 'eth_getTransactionReceipt' ? {
        transactionHash: EVM_HASH, blockNumber: '0x123', status: '0x1', gasUsed: '0x5208', logs: [],
      } : {
        slot: 99, blockTime: 1_800_000_000,
        meta: {
          err: null, fee: 5000, logMessages: ['Program log: Instruction: DepositNative'],
          innerInstructions: [{ index: 0, instructions: [{ program: 'system', parsed: { type: 'transfer', info: { lamports: 569336560 } } }] }],
        },
        transaction: { signatures: ['5ikNh4NekadNDnioJDa52vjdzdjRS5tAJ4w1QNi8wVorZJ6wGuRxLdwUFBbUeuXPxhF3mLhVBfGDGfXCJrt6Aiyz'], message: { instructions: [{ programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2' }] } },
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
    }) as typeof fetch

    const studies = await getClearSignProtectionCaseStudies({ fetcher })
    expect(studies).toHaveLength(2)
    expect(studies[0].status).toBe('verified')
    expect(studies[0].protectionLevel).toBe('P3')
    expect(studies[0].limits.join(' ')).toContain('exceeds the firmware v2')
    expect(studies[1].status).toBe('verified')
    expect(studies[1].protectionLevel).toBe('P4')
    expect(studies[1].facts.join(' ')).toContain('569336560 lamports')
    expect(studies[1].limits.join(' ')).toContain('promised ETH output')
  })

  test('does not turn RPC failure into a protection claim', async () => {
    const fetcher = (async () => new Response('{}', { status: 503 })) as typeof fetch
    const studies = await getClearSignProtectionCaseStudies({ fetcher })
    expect(studies.every(study => study.status === 'unavailable')).toBe(true)
    expect(studies.every(study => study.protections.length === 0)).toBe(true)
  })
})
