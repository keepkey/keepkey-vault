import { describe, expect, test } from 'bun:test'
import { signSolanaWireTransaction } from '../src/bun/solana-signing'
import { SolanaSignRequest } from '../src/bun/schemas'

function wireTransaction(message: number[]): string {
  return Buffer.concat([
    Buffer.from([1]),       // one signature
    Buffer.alloc(64, 0),    // empty signature slot
    Buffer.from(message),
  ]).toString('base64')
}

describe('Solana transaction signing route', () => {
  test('REST schema preserves a complete descriptor and one-shot consent', () => {
    const swapMetadata = {
      payload: Buffer.from('KKSOLSW1-test').toString('base64'),
      signature: Buffer.alloc(64, 1).toString('base64'),
      signerKeyId: 3,
    }
    const parsed = SolanaSignRequest.parse({
      raw_tx: wireTransaction([0x80, 1, 0, 0]),
      addressNList: [0x8000002c, 0x800001f5, 0x80000000, 0x80000000],
      swapMetadata,
      allowBlindSigning: true,
    })
    expect(parsed.swapMetadata).toEqual(swapMetadata)
    expect(parsed.allowBlindSigning).toBe(true)
  })

  test('REST schema rejects partial or out-of-range descriptors', () => {
    expect(() => SolanaSignRequest.parse({
      raw_tx: wireTransaction([0x80, 1, 0, 0]),
      swapMetadata: { payload: 'S0tTT0xTVzE=', signerKeyId: 3 },
    })).toThrow()
    expect(() => SolanaSignRequest.parse({
      raw_tx: wireTransaction([0x80, 1, 0, 0]),
      swapMetadata: { payload: 'S0tTT0xTVzE=', signature: 'AA==', signerKeyId: 4 },
    })).toThrow()
  })

  test('routes v0 through SolanaSignTx and preserves one-shot/metadata parameters', async () => {
    let deviceRequest: any
    let messageCalls = 0
    const signature = Uint8Array.from({ length: 64 }, (_, i) => i)
    const wallet = {
      solanaSignTx: async (request: any) => {
        deviceRequest = request
        return { signature }
      },
      solanaSignMessage: async () => {
        messageCalls++
        throw new Error('v0 transaction must not use message signing')
      },
    }
    const swapMetadata = {
      payload: Buffer.from('KKSOLSW1-test').toString('base64'),
      signature: Buffer.alloc(64, 1).toString('base64'),
      signerKeyId: 1,
    }
    const unsignedTx = {
      addressNList: [0x8000002c, 0x800001f5, 0x80000000, 0x80000000],
      rawTx: wireTransaction([0x80, 1, 0, 0]),
      allowBlindSigning: true,
      swapMetadata,
    }
    const result = await signSolanaWireTransaction(
      unsignedTx,
      (request) => wallet.solanaSignTx(request),
    )

    expect(messageCalls).toBe(0)
    expect(Buffer.from(deviceRequest.rawTx, 'base64')).toEqual(Buffer.from([0x80, 1, 0, 0]))
    expect(deviceRequest.allowBlindSigning).toBe(true)
    expect(deviceRequest.swapMetadata).toEqual(swapMetadata)
    expect(Buffer.from(result.signature)).toEqual(Buffer.from(signature))
    expect(Buffer.from(result.serializedTx, 'base64').subarray(1, 65)).toEqual(Buffer.from(signature))
  })

  test('routes legacy transactions through the same transaction API', async () => {
    let deviceRequest: any
    const wallet = {
      solanaSignTx: async (request: any) => {
        deviceRequest = request
        return { signature: Buffer.alloc(64, 0x7f) }
      },
    }
    await signSolanaWireTransaction({
      addressNList: [0x8000002c, 0x800001f5, 0x80000000, 0x80000000],
      rawTx: wireTransaction([1, 0, 0, 0]),
    }, (request) => wallet.solanaSignTx(request))
    expect(Buffer.from(deviceRequest.rawTx, 'base64')).toEqual(Buffer.from([1, 0, 0, 0]))
  })
})
