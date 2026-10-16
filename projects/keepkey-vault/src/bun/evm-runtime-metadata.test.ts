import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { deviceFingerprint, resolveNamedRuntimeEvmMetadata, resolveRuntimeEvmMetadata, resolveRuntimeEvmSigner, runtimeProviderWillBeAsked, supportsRuntimeEvmMetadata, trustRuntimeSigner } from './evm-runtime-metadata'

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
      signer: { keyId: 2, alias: 'Test Signer', publicKeyHex, fingerprint, deviceFingerprint: deviceFingerprint(publicKeyHex) },
    })
  })

  test('the device fingerprint is the 16-hex form 7.16 shows (emulator transcript)', () => {
    // studio-audit/proof/run1: "Trust 'Acme Labs' (656B0D303F6BBDBD) for this session…"
    expect(deviceFingerprint('0246bda74e01a6587ece226943fbff7a10a55cc6971ea2113b0fc6fc90550ba139')).toBe('656B0D303F6BBDBD')
  })
})

/** A real provider on localhost (no fetch mock). Connections are not kept
 * alive, so a pooled socket to a stopped server never leaks into a later test. */
function provider(signer: () => Response | Promise<Response>, sign: () => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const res = await (new URL(req.url).pathname === '/signer' ? signer() : sign())
      res.headers.set('connection', 'close')
      return res
    },
  })
  process.env.CLEARSIGN_RUNTIME_URL = `http://127.0.0.1:${server.port}`
  return server
}
const KEY = `02${'11'.repeat(32)}`
const goodSigner = () => Response.json({ publicKeyHex: KEY, fingerprint: deviceFingerprint(KEY).slice(0, 8).toLowerCase(), keyId: 2, alias: 'Acme Labs' })

describe('a provider decline or outage means no description, never a failed signature', () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  let server: ReturnType<typeof Bun.serve> | undefined
  beforeEach(() => { warnings.length = 0; console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')) } })
  afterEach(() => { console.warn = originalWarn; server?.stop(true); server = undefined })

  test('422 decline → undefined, one warning naming the provider and the reason', async () => {
    server = provider(goodSigner, () => Response.json({ classification: 'OPAQUE', error: 'unknown contract identity' }, { status: 422 }))
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 })).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`127.0.0.1:${server.port}`)
    expect(warnings[0]).toContain('declined (unknown contract identity)')
  })

  test('503 → undefined', async () => {
    server = provider(goodSigner, () => new Response('down', { status: 503 }))
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 })).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('unavailable (200/503)')])
  })

  test('connection refused → undefined', async () => {
    server = provider(goodSigner, goodSigner)
    const url = process.env.CLEARSIGN_RUNTIME_URL
    server.stop(true)
    server = undefined
    process.env.CLEARSIGN_RUNTIME_URL = url
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 })).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('unreachable')])
  })

  test('a provider that never answers → undefined after the timeout', async () => {
    server = provider(goodSigner, () => new Promise<Response>(() => {}))
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 }, 200)).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('no answer in 200 ms')])
  })

  test('a malformed or mismatched identity → undefined; nothing reaches the device', async () => {
    for (const signer of [
      { publicKeyHex: `03${'22'.repeat(32)}`, fingerprint: 'deadbeef', keyId: 2 },
      { publicKeyHex: 'not-a-key', fingerprint: 'deadbeef', keyId: 2 },
      { publicKeyHex: KEY, fingerprint: deviceFingerprint(KEY).slice(0, 6), keyId: 2 },
      { publicKeyHex: KEY, fingerprint: deviceFingerprint(KEY), keyId: 1 },
    ]) {
      server = provider(() => Response.json(signer), () => Response.json({ keyId: 2, signedPayload: `0x${'ab'.repeat(80)}` }))
      expect(await resolveRuntimeEvmMetadata({ chainId: 1 })).toBeUndefined()
      server.stop(true)
    }
    server = undefined
    expect(warnings).toHaveLength(4)
  })

  test('accepts the 16-hex device fingerprint as well as the 8-hex wire form', async () => {
    server = provider(
      () => Response.json({ publicKeyHex: KEY, fingerprint: deviceFingerprint(KEY), keyId: 2, alias: 'Acme Labs' }),
      () => Response.json({ keyId: 2, signedPayload: `0x${'ab'.repeat(80)}` }),
    )
    const result = await resolveRuntimeEvmMetadata({ chainId: 1 })
    expect(result?.signer).toMatchObject({ alias: 'Acme Labs', deviceFingerprint: deviceFingerprint(KEY) })
    expect(warnings).toHaveLength(0)
  })

  test('the approval card names the signer before approval: /signer only, 16-hex as the device shows it', async () => {
    let signed = false
    server = provider(goodSigner, () => { signed = true; return new Response('no', { status: 500 }) })
    expect(await resolveRuntimeEvmSigner()).toMatchObject({ alias: 'Acme Labs', publicKeyHex: KEY, deviceFingerprint: deviceFingerprint(KEY) })
    expect(signed).toBe(false)
    server.stop(true)
    server = provider(() => new Response('down', { status: 503 }), goodSigner)
    expect(await resolveRuntimeEvmSigner()).toBeUndefined()
  })

  test('the sign handler attaches only from the key the card named', async () => {
    server = provider(goodSigner, () => Response.json({ keyId: 2, signedPayload: `0x${'ab'.repeat(80)}` }))
    const named = { publicKeyHex: KEY, fingerprint: deviceFingerprint(KEY) }
    expect((await resolveNamedRuntimeEvmMetadata({ chainId: 1 }, named))?.signer.publicKeyHex).toBe(KEY)
    expect(await resolveNamedRuntimeEvmMetadata({ chainId: 1 }, undefined)).toBeUndefined()
    const other = `03${'22'.repeat(32)}`
    expect(await resolveNamedRuntimeEvmMetadata({ chainId: 1 }, { publicKeyHex: other, fingerprint: deviceFingerprint(other) })).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('signer changed since approval')])
  })

  test('the provider is asked only with no other description, on 7.15+ with AdvancedMode', () => {
    const base = { id: 'x', method: '/eth/sign-transaction', appName: 'a', firmwareVersion: '7.16.0', advancedModeEnabled: true }
    expect(runtimeProviderWillBeAsked(base, undefined)).toBe(true)
    expect(runtimeProviderWillBeAsked({ ...base, advancedModeEnabled: false }, undefined)).toBe(false)
    expect(runtimeProviderWillBeAsked({ ...base, firmwareVersion: '7.14.1' }, undefined)).toBe(false)
    expect(runtimeProviderWillBeAsked(base, { signedPayload: '00' })).toBe(false)
    expect(runtimeProviderWillBeAsked({ ...base, calldataDecoded: { dappName: 'x', contractName: 'x', method: 'x', selector: '0x', fields: [], source: 'none', signedInsightBlob: 'AA==' } }, undefined)).toBe(false)
    expect(runtimeProviderWillBeAsked({ ...base, certifiedEvmSchema: { method: 'm' } as any }, undefined)).toBe(false)
  })

  test('a refused device trust screen → not trusted, so the caller drops the metadata', async () => {
    const signer = { keyId: 2, alias: 'Acme Labs', publicKeyHex: KEY, fingerprint: 'x', deviceFingerprint: deviceFingerprint(KEY) }
    expect(await trustRuntimeSigner(signer, async () => { throw new Error('Action cancelled by user') }, '[test]')).toBe(false)
    expect(warnings).toEqual([expect.stringContaining(`Acme Labs (${deviceFingerprint(KEY)}) not trusted`)])
    expect(await trustRuntimeSigner(signer, async () => ({}), '[test]')).toBe(true)
  })
})
