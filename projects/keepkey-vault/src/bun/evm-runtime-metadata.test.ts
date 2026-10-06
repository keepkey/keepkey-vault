import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolveRuntimeEvmMetadata, supportsRuntimeEvmMetadata } from './evm-runtime-metadata'

const originalFetch = globalThis.fetch
const originalUrl = process.env.CLEARSIGN_RUNTIME_URL

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalUrl === undefined) delete process.env.CLEARSIGN_RUNTIME_URL
  else process.env.CLEARSIGN_RUNTIME_URL = originalUrl
})

describe('7.15 runtime EVM metadata', () => {
  test('remains an explicit fallback on certified-capable alpha firmware', () => {
    expect(supportsRuntimeEvmMetadata('7.14.1', true)).toBe(false)
    expect(supportsRuntimeEvmMetadata('7.15.0', false)).toBe(false)
    expect(supportsRuntimeEvmMetadata('7.15.0', true)).toBe(true)
    expect(supportsRuntimeEvmMetadata('7.16.0', true)).toBe(true)
  })
  test('is disabled unless a provider is explicitly configured', async () => {
    delete process.env.CLEARSIGN_RUNTIME_URL
    globalThis.fetch = (async () => { throw new Error('must not fetch') }) as unknown as typeof fetch
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 })).toBeUndefined()
  })

  test('sends every signed transaction field and validates signer identity', async () => {
    process.env.CLEARSIGN_RUNTIME_URL = 'http://127.0.0.1:1647/'
    const publicKeyHex = `02${'11'.repeat(32)}`
    const fingerprint = createHash('sha256').update(Uint8Array.from(Buffer.from(publicKeyHex, 'hex'))).digest('hex').slice(0, 8)
    let posted: any
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith('/signer')) {
        return Response.json({ publicKeyHex, fingerprint, keyId: 2, alias: 'Test Signer' })
      }
      posted = JSON.parse(String(init?.body))
      return Response.json({ keyId: 2, signedPayload: `0x${'ab'.repeat(80)}` })
    }) as typeof fetch

    const tx = {
      chainId: 1, nonce: '0x2', gasLimit: '0x5208', to: `0x${'22'.repeat(20)}`,
      value: '0x3', data: '0x1234', maxFeePerGas: '0x4', maxPriorityFeePerGas: '0x5',
    }
    const result = await resolveRuntimeEvmMetadata(tx)
    expect(posted).toEqual(tx)
    expect(result).toEqual({
      signedPayload: `0x${'ab'.repeat(80)}`,
      keyId: 2,
      signer: { keyId: 2, alias: 'Test Signer', publicKeyHex, fingerprint },
    })
  })

  test('rejects a signer whose advertised fingerprint does not match', async () => {
    process.env.CLEARSIGN_RUNTIME_URL = 'http://provider.test'
    globalThis.fetch = (async (input) => String(input).endsWith('/signer')
      ? Response.json({ publicKeyHex: `03${'22'.repeat(32)}`, fingerprint: 'deadbeef', keyId: 1 })
      : Response.json({ keyId: 1, signedPayload: `0x${'cd'.repeat(80)}` })) as typeof fetch
    expect(resolveRuntimeEvmMetadata({ chainId: 1 })).rejects.toThrow('signer identity is malformed')
  })

  test('fails closed when a configured provider refuses an opaque transaction', async () => {
    process.env.CLEARSIGN_RUNTIME_URL = 'http://provider.test'
    globalThis.fetch = (async (input) => String(input).endsWith('/signer')
      ? Response.json({ publicKeyHex: `03${'22'.repeat(32)}`, fingerprint: 'unused', keyId: 1 })
      : Response.json({ classification: 'OPAQUE', error: 'unknown contract identity' }, { status: 422 })) as typeof fetch
    expect(resolveRuntimeEvmMetadata({ chainId: 1 })).rejects.toThrow(
      'ClearSign provider refused transaction: unknown contract identity',
    )
  })
})
