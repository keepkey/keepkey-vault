import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { deviceFingerprint, providerCanDescribe, resolveRuntimeEvmMetadata, resolveRuntimeEvmSigner, runtimeProviderWillBeAsked, supportsRuntimeEvmMetadata, trustRuntimeSigner } from './evm-runtime-metadata'

const originalFetch = globalThis.fetch
let providerUrl = ''

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('7.15 runtime EVM metadata', () => {
  test('remains an explicit fallback on certified-capable alpha firmware', () => {
    expect(supportsRuntimeEvmMetadata('7.14.1', true)).toBe(false)
    expect(supportsRuntimeEvmMetadata('7.15.0', false)).toBe(false)
    expect(supportsRuntimeEvmMetadata('7.15.0', true)).toBe(true)
    expect(supportsRuntimeEvmMetadata('7.16.0', true)).toBe(true)
  })
  test('contacts nothing without a provider URL', async () => {
    globalThis.fetch = (async () => { throw new Error('must not fetch') }) as unknown as typeof fetch
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 }, '')).toBeUndefined()
  })

  test('sends every signed transaction field and validates signer identity', async () => {
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
    const result = await resolveRuntimeEvmMetadata(tx, 'http://127.0.0.1:1647/')
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
  providerUrl = `http://127.0.0.1:${server.port}`
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
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 }, providerUrl)).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`127.0.0.1:${server.port}`)
    expect(warnings[0]).toContain('declined (unknown contract identity)')
  })

  test('503 → undefined', async () => {
    server = provider(goodSigner, () => new Response('down', { status: 503 }))
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 }, providerUrl)).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('unavailable (503)')])
  })

  test('connection refused → undefined', async () => {
    server = provider(goodSigner, goodSigner)
    server.stop(true)
    server = undefined
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 }, providerUrl)).toBeUndefined()
    expect(warnings).toEqual([expect.stringContaining('unreachable')])
  })

  test('a provider that never answers → undefined after the timeout', async () => {
    server = provider(goodSigner, () => new Promise<Response>(() => {}))
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 }, providerUrl, { timeoutMs: 200 })).toBeUndefined()
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
      expect(await resolveRuntimeEvmMetadata({ chainId: 1 }, providerUrl)).toBeUndefined()
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
    const result = await resolveRuntimeEvmMetadata({ chainId: 1 }, providerUrl)
    expect(result?.signer).toMatchObject({ alias: 'Acme Labs', deviceFingerprint: deviceFingerprint(KEY) })
    expect(warnings).toHaveLength(0)
  })

  test('the approval card names the signer before approval: /signer only, 16-hex as the device shows it', async () => {
    let signed = false
    server = provider(goodSigner, () => { signed = true; return new Response('no', { status: 500 }) })
    expect(await resolveRuntimeEvmSigner(providerUrl)).toMatchObject({ alias: 'Acme Labs', publicKeyHex: KEY, deviceFingerprint: deviceFingerprint(KEY) })
    expect(signed).toBe(false)
    server.stop(true)
    server = provider(() => new Response('down', { status: 503 }), goodSigner)
    expect(await resolveRuntimeEvmSigner(providerUrl)).toBeUndefined()
  })

  test('the provider is asked only with no other description, on 7.15+ with AdvancedMode', () => {
    const base = { id: 'x', method: '/eth/sign-transaction', appName: 'a', firmwareVersion: '7.16.0', advancedModeEnabled: true, chainId: 1, to: `0x${'aa'.repeat(20)}`, data: '0xdeadbeef' }
    expect(runtimeProviderWillBeAsked(base, undefined)).toBe(true)
    expect(runtimeProviderWillBeAsked({ ...base, advancedModeEnabled: false }, undefined)).toBe(false)
    expect(runtimeProviderWillBeAsked({ ...base, firmwareVersion: '7.14.1' }, undefined)).toBe(false)
    expect(runtimeProviderWillBeAsked(base, { signedPayload: '00' })).toBe(false)
    expect(runtimeProviderWillBeAsked({ ...base, calldataDecoded: { dappName: 'x', contractName: 'x', method: 'x', selector: '0x', fields: [], source: 'none', signedInsightBlob: 'AA==' } }, undefined)).toBe(false)
    expect(runtimeProviderWillBeAsked({ ...base, certifiedEvmSchema: { method: 'm' } as any }, undefined)).toBe(false)
  })

  test('calls the firmware shows on its own never ask a provider (card or handler)', () => {
    const base = { id: 'x', method: '/eth/sign-transaction', appName: 'a', firmwareVersion: '7.16.0', advancedModeEnabled: true, chainId: 1 }
    // A plain ETH send: no calldata.
    expect(runtimeProviderWillBeAsked({ ...base, to: `0x${'aa'.repeat(20)}`, data: '0x', value: '0x1' }, undefined)).toBe(false)
    expect(runtimeProviderWillBeAsked({ ...base, to: `0x${'aa'.repeat(20)}` }, undefined)).toBe(false)
    // ERC-20 transfer of USDT on Ethereum: the firmware's token table shows it.
    const usdtTransfer = `0xa9059cbb${'0'.repeat(24)}${'bb'.repeat(20)}${'0'.repeat(62)}64`
    expect(runtimeProviderWillBeAsked({ ...base, to: '0xdac17f958d2ee523a2206206994597c13d831ec7', data: usdtTransfer, value: '0x0' }, undefined)).toBe(false)
    expect(providerCanDescribe({ chainId: '0x1', to: '0xdAC17F958D2ee523a2206206994597C13D831ec7', data: usdtTransfer }, '7.16.0')).toBe(false)
    // Already judged native by the preview.
    expect(runtimeProviderWillBeAsked({ ...base, to: `0x${'aa'.repeat(20)}`, data: '0xdeadbeef', deviceClearSigns: true }, undefined)).toBe(false)
    // An unknown call is still asked.
    expect(providerCanDescribe({ chainId: 1, to: `0x${'aa'.repeat(20)}`, data: '0xdeadbeef' }, '7.16.0')).toBe(true)
  })

  test('the signer is checked before the transaction is sent: another key gets no POST', async () => {
    const hits: string[] = []
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        hits.push(`${req.method} ${new URL(req.url).pathname}`)
        const res = new URL(req.url).pathname === '/signer' ? goodSigner() : Response.json({ keyId: 2, signedPayload: `0x${'ab'.repeat(80)}` })
        res.headers.set('connection', 'close')
        return res
      },
    })
    const url = `http://127.0.0.1:${server.port}`
    const other = `03${'22'.repeat(32)}`
    expect(await resolveRuntimeEvmMetadata({ chainId: 1 }, url, { expectedPublicKeyHex: other })).toBeUndefined()
    expect(hits).toEqual(['GET /signer'])
    expect(warnings).toEqual([expect.stringContaining('not the one you added')])
    expect((await resolveRuntimeEvmMetadata({ chainId: 1 }, url, { expectedPublicKeyHex: KEY }))?.keyId).toBe(2)
    expect(hits).toEqual(['GET /signer', 'GET /signer', 'POST /sign'])
  })

  test('a refused device trust screen → not trusted, so the caller drops the metadata', async () => {
    const signer = { keyId: 2, alias: 'Acme Labs', publicKeyHex: KEY, fingerprint: 'x', deviceFingerprint: deviceFingerprint(KEY) }
    expect(await trustRuntimeSigner(signer, async () => { throw new Error('Action cancelled by user') }, '[test]')).toBe(false)
    expect(warnings).toEqual([expect.stringContaining(`Acme Labs (${deviceFingerprint(KEY)}) not trusted`)])
    expect(await trustRuntimeSigner(signer, async () => ({}), '[test]')).toBe(true)
  })
})
