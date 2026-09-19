import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'

import {
  buildRestSolanaSignRequest,
  DEFAULT_CLEARSIGN_SERVICE_URL,
  findCertifiedSolanaProof,
  type CertifiedSolanaProof,
} from './solana-certified-registry'
import { signSolanaWireTransaction } from './solana-signing'
import { solanaSignTx } from '@keepkey/hdwallet-keepkey/dist/solana'
import joinFixture from '../../__tests__/fixtures/solana/soltoshidice-blackjack-join.json'

const originalFetch = globalThis.fetch
const originalServiceUrl = process.env.CLEARSIGN_SERVICE_URL

function verifiedResponse(lutProof?: unknown): Response {
  return new Response(JSON.stringify({
    classification: 'VERIFIED',
    ...(lutProof === undefined ? {} : { lutProof }),
    schema: {
      payload: '0x4b4b534f4c534331',
      signature: `0x${'22'.repeat(64)}`,
      signerKeyId: 0x80,
    },
    certificate: `0x${'33'.repeat(139)}`,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalServiceUrl === undefined) delete process.env.CLEARSIGN_SERVICE_URL
  else process.env.CLEARSIGN_SERVICE_URL = originalServiceUrl
})

describe('findCertifiedSolanaProof', () => {
  test('uses the signer by default without an enable flag', async () => {
    delete process.env.CLEARSIGN_SERVICE_URL
    let requestedUrl = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return verifiedResponse()
    }) as typeof fetch

    const result = await findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative')
    expect(requestedUrl).toBe(`${DEFAULT_CLEARSIGN_SERVICE_URL}/v1/solana/certify`)
    expect(result?.schema.signerKeyId).toBe(0x80)
  })

  test('accepts a schema-only certified response for a self-contained transaction', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647/'
    globalThis.fetch = (async () => verifiedResponse()) as typeof fetch

    const result = await findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative')
    expect(result?.lutProof).toBeUndefined()
    expect(result?.schema.signerKeyId).toBe(0x80)
    expect(result?.schema.payload).toBe('4b4b534f4c534331')
    expect(result?.certificate).toHaveLength(139 * 2)
  })

  test('preserves a nonempty LUT proof for an ALT-backed transaction', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    globalThis.fetch = (async () => verifiedResponse({
      accounts: [Buffer.alloc(32, 0x11).toString('base64')],
      signature: `0x${'44'.repeat(64)}`,
      signerKeyId: 0x80,
    })) as typeof fetch

    const result = await findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative')
    expect(result?.lutProof?.accounts).toHaveLength(1)
    expect(result?.lutProof?.signature).toBe('44'.repeat(64))
  })

  test('rejects an empty or partial LUT proof instead of treating it as schema-only', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    globalThis.fetch = (async () => verifiedResponse({
      accounts: [],
      signature: `0x${'44'.repeat(64)}`,
      signerKeyId: 0x80,
    })) as typeof fetch

    await expect(findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative'))
      .rejects.toThrow(/partial LUT proof/)
  })

  test('rejects malformed service material before it reaches hdwallet', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    globalThis.fetch = (async () => {
      const response = verifiedResponse()
      const body = await response.json() as any
      body.schema.signerKeyId = 3
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    await expect(findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative'))
      .rejects.toThrow(/non-certified signer id/)

    globalThis.fetch = (async () => verifiedResponse({
      accounts: [Buffer.alloc(31).toString('base64')],
      signature: `0x${'44'.repeat(64)}`,
      signerKeyId: 0x80,
    })) as typeof fetch
    await expect(findCertifiedSolanaProof('unsigned-fixture', 'relayDepositNative'))
      .rejects.toThrow(/invalid LUT account/)
  })
})

describe('findCertifiedSolanaProof token identities', () => {
  const SDICE = '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump'
  const token = (overrides: Record<string, unknown> = {}) => ({
    mint: SDICE, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', symbol: 'SDICE', decimals: 6,
    signature: '55'.repeat(64), signerKeyId: 0x80, ...overrides,
  })
  const withTokens = (tokenInfo: unknown) => (async () => {
    const body = await verifiedResponse().json() as any
    return new Response(JSON.stringify({ ...body, tokenInfo }), { status: 200 })
  }) as unknown as typeof fetch

  test('omits catalogKey so the service matches the whole catalog', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    let sent: any
    globalThis.fetch = (async (_input: any, init: any) => {
      sent = JSON.parse(init.body)
      return verifiedResponse()
    }) as typeof fetch
    await findCertifiedSolanaProof('unsigned-fixture')
    expect(sent).toEqual({ rawTx: 'unsigned-fixture' })
  })

  test('forwards validated token identities without the service-only token program', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    globalThis.fetch = withTokens([token()])
    const result = await findCertifiedSolanaProof('unsigned-fixture')
    expect(result?.tokenInfo).toEqual([{ mint: SDICE, symbol: 'SDICE', decimals: 6, signature: '55'.repeat(64), signerKeyId: 0x80 }])
  })

  test('rejects token identities firmware could not use or a dapp could have written', async () => {
    process.env.CLEARSIGN_SERVICE_URL = 'http://127.0.0.1:1647'
    for (const tokenInfo of [
      [], 'SDICE', Array.from({ length: 5 }, () => token()),
      [token({ symbol: 'USD\nAPPROVED' })], [token({ symbol: '' })], [token({ decimals: 10 })],
      [token({ signerKeyId: 1 })], [token({ mint: 'not-a-mint' })], [token({ signature: '55'.repeat(63) })],
    ]) {
      globalThis.fetch = withTokens(tokenInfo)
      await expect(findCertifiedSolanaProof('unsigned-fixture')).rejects.toThrow(/token/)
    }
  })
})

describe('REST /solana/sign-transaction wiring', () => {
  test('REST records the certified route before approval and builds the device request from it', () => {
    const rest = readFileSync(new URL('./rest-api.ts', import.meta.url), 'utf8')
    const previewStart = rest.indexOf("} else if (path === '/solana/sign-transaction') {")
    const preview = rest.slice(previewStart, rest.indexOf('} else if (', previewStart + 10))
    expect(preview).toContain('routeExternalSolanaTransaction(')
    expect(preview).toContain('signingInfo.requiresBlindSigningConsent = route.requiresBlindSigningConsent')
    expect(preview).toContain('activeSolanaCertified = { rawTx: preview.raw_tx, proof: route.certifiedProof }')
    expect(preview).toContain('signingInfo.deviceClearSigns = true')
    // AdvancedMode is demanded only on the opaque (consent) path.
    const consentBlock = preview.indexOf('if (signingInfo.requiresBlindSigningConsent) {')
    expect(preview.split('requiresAdvancedMode = true')).toHaveLength(2)
    expect(preview.indexOf('requiresAdvancedMode = true')).toBeGreaterThan(consentBlock)
    expect(rest.indexOf('routeExternalSolanaTransaction(')).toBeLessThan(rest.indexOf('callbacks.onSigningRequest(signingInfo)'))

    const handlerStart = rest.indexOf("if (path === '/solana/sign-transaction' && method === 'POST') {")
    const handler = rest.slice(handlerStart, rest.indexOf('// ── SOLANA MESSAGE SIGNING', handlerStart))
    expect(handler).toContain('buildRestSolanaSignRequest(body, addressNList, {')
    expect(handler).toContain('certified: activeSolanaCertified,')
    expect(handler).toContain('routedCertified: activeSigningInfo?.deviceClearSigns === true,')
    expect(handler).toContain('allowBlindSigning: activeAllowBlindSigning,')
    expect(handler).toContain('signSolanaWireTransaction(\n              signRequest,')
  })
})

describe('buildRestSolanaSignRequest (device SolanaSignTx parameters)', () => {
  const rawTx = joinFixture.rawTxBase64
  const addressNList = [0x8000002c, 0x800001f5, 0x80000000, 0x80000000]
  const proof: CertifiedSolanaProof = {
    schema: { payload: 'aa', signature: '22'.repeat(64), signerKeyId: 0x80 },
    certificate: '33'.repeat(139),
    lutProof: { accounts: [Buffer.alloc(32, 0x11).toString('base64')], signature: '44'.repeat(64), signerKeyId: 0x80 },
    tokenInfo: [{ mint: joinFixture.expected.mint, symbol: 'SDICE', decimals: 6, signature: '55'.repeat(64), signerKeyId: 0x80 }],
  }
  const opaque = { routedCertified: false, allowBlindSigning: true }
  const certifiedRoute = { routedCertified: true, allowBlindSigning: false }

  test('forwards the preview certified proof when raw_tx matches', () => {
    const request = buildRestSolanaSignRequest({ raw_tx: rawTx }, addressNList, { ...certifiedRoute, certified: { rawTx, proof } })
    expect(request).toEqual({
      addressNList, rawTx, schema: proof.schema, certificate: proof.certificate, lutProof: proof.lutProof,
      tokenInfo: proof.tokenInfo, x402: undefined, allowBlindSigning: false,
    })
  })

  test('forwards nothing certified on a raw_tx mismatch', () => {
    const request = buildRestSolanaSignRequest({ raw_tx: rawTx }, addressNList, { ...opaque, certified: { rawTx: 'other', proof } })
    expect(request.schema).toBeUndefined()
    expect(request.certificate).toBeUndefined()
    expect(request.lutProof).toBeUndefined()
    expect('tokenInfo' in request).toBe(false)
    expect(request.allowBlindSigning).toBe(true)
  })

  test('caller-supplied material wins over the preview proof', () => {
    const callerSchema = { payload: 'bb', signature: '66'.repeat(64), signerKeyId: 0x80 }
    const request = buildRestSolanaSignRequest(
      { raw_tx: rawTx, schema: callerSchema, certificate: '77'.repeat(139) },
      addressNList,
      { ...certifiedRoute, certified: { rawTx, proof } },
    )
    expect(request.schema).toEqual(callerSchema)
    expect(request.certificate).toBe('77'.repeat(139))
    expect(request.lutProof).toBeUndefined()
    expect('tokenInfo' in request).toBe(false)
  })

  test('refuses when the preview routed certified but no certified material is present at sign time', () => {
    for (const certified of [undefined, { rawTx: 'other', proof }]) {
      expect(() => buildRestSolanaSignRequest({ raw_tx: rawTx }, addressNList, { ...certifiedRoute, certified }))
        .toThrow(/refusing to sign an opaque transaction without consent/)
    }
    let status: number | undefined
    try {
      buildRestSolanaSignRequest({ raw_tx: rawTx }, addressNList, certifiedRoute)
    } catch (error: any) {
      status = error.status
    }
    expect(status).toBe(409)
    // The opaque path is unaffected: no certified route, nothing to forward.
    expect(buildRestSolanaSignRequest({ raw_tx: rawTx }, addressNList, opaque).schema).toBeUndefined()
  })
})

describe('certified envelope reaches the device request', () => {
  test('the real join carries schema, certificate, and token identity to SolanaSignTx', async () => {
    const full = Buffer.from(joinFixture.rawTxBase64, 'base64')
    const schema = { payload: '4b4b534f4c534331', signature: '22'.repeat(64), signerKeyId: 0x80 }
    const tokenInfo = [{ mint: joinFixture.expected.mint, symbol: 'SDICE', decimals: 6, signature: '55'.repeat(64), signerKeyId: 0x80 }]
    let deviceRequest: any
    const result = await signSolanaWireTransaction({
      addressNList: [0x8000002c, 0x800001f5, 0x80000000, 0x80000000],
      rawTx: joinFixture.rawTxBase64,
      schema,
      certificate: '33'.repeat(139),
      tokenInfo,
    }, async (request) => {
      deviceRequest = request
      return { signature: Buffer.alloc(64, 0x7f) }
    }, async () => joinFixture.expected.instructionAccounts[0])
    // The device gets the exact message bytes (no signature wrapper).
    expect(Buffer.from(deviceRequest.rawTx, 'base64')).toEqual(full.subarray(65))
    expect(deviceRequest.schema).toEqual(schema)
    expect(deviceRequest.certificate).toBe('33'.repeat(139))
    expect(deviceRequest.tokenInfo).toEqual(tokenInfo)
    expect(deviceRequest.lutProof).toBeUndefined()
    expect(Buffer.from(result.serializedTx, 'base64').subarray(1, 65)).toEqual(Buffer.alloc(64, 0x7f))

    // The installed hdwallet build encodes it as SolanaSignTx.token_info (4)
    // with mint (1), symbol (2), decimals (3), signature (4), signer id (5).
    let wire: Buffer | undefined
    const transport: any = {
      lockDuring: (fn: () => unknown) => fn(),
      call: async (_type: number, message: any) => {
        wire = Buffer.from(message.serializeBinary())
        return { message_enum: 753, proto: { getSignature_asU8: () => new Uint8Array(64) } }
      },
    }
    await solanaSignTx(transport, deviceRequest)
    const tokenField = '2270' + '0a20' + Buffer.from(bs58.decode(joinFixture.expected.mint)).toString('hex')
      + '1205' + Buffer.from('SDICE').toString('hex') + '1806' + '2240' + '55'.repeat(64) + '288001'
    expect(wire!.toString('hex')).toContain(tokenField)
    expect(wire!.toString('hex')).toContain('6a8b01' + '33'.repeat(139))
  })
})
