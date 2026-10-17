import { afterEach, describe, expect, test } from 'bun:test'
import type { SigningRequestInfo } from '../shared/types'
import { applyEvmTxPreview, evmPriorityFee, normalizeEvmChainId, typedDataNativelyReviewed } from './evm-signing-preview'
import { approveSpender, findCertifiedEvmSchema, resolveEvmSchema } from './evm-schema-registry'
import { certifiedBodyRefused } from '../shared/certified-evm-envelope'
import { findCertifiedEvmEnvelope } from './evm-certified-registry'
import { SolanaSignMessageRequest } from './schemas'
import { solanaSignerChangedError } from './solana-message-preview'
import { evmCallRequiresAdvancedMode } from './evm-signing-policy'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { prepareEvmTxSigningInfo } from './evm-presign-report'
import { runtimeEvmSighash } from './uniswap-runtime-envelope'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const RECIPIENT = '1111111111111111111111111111111111111111'
const word = (hex: string) => hex.padStart(64, '0')
const transfer = '0xa9059cbb' + word(RECIPIENT) + word('f4240')
const approve = (spender: string) => '0x095ea7b3' + word(spender.replace(/^0x/, '')) + word('f4240')
// The envelope's certificate names chain 8453 at bytes 3..6 (schema registry checks it).
const PAYLOAD = `0x03${'ab'.repeat(2)}00002105${'ab'.repeat(194)}`

const info = (): SigningRequestInfo => ({ id: 't', method: '/eth/sign-transaction', appName: 'test' })

/** A VERIFIED worker reply for a Base USDC call; records what was asked. */
function service(method: 'transfer' | 'approve', entry: string, seen: any[] = []) {
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    seen.push(body)
    return new Response(JSON.stringify({
      classification: 'VERIFIED', keyId: 0x80, chainId: 8453, contract: USDC_BASE,
      selector: body.selector, method, expectedCalldataLength: 68, signedPayload: PAYLOAD, entry,
      ...(body.spender === PERMIT2 ? { spender: PERMIT2 } : {}),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return seen
}

describe('normalizeEvmChainId', () => {
  test('hex from the browser extension, decimal strings and numbers', () => {
    expect(normalizeEvmChainId('0x2105')).toBe(8453)
    expect(normalizeEvmChainId('8453')).toBe(8453)
    expect(normalizeEvmChainId(42161)).toBe(42161)
    expect(normalizeEvmChainId('0x')).toBeUndefined()
    expect(normalizeEvmChainId('1abc')).toBeUndefined()
    expect(normalizeEvmChainId(0)).toBeUndefined()
    expect(normalizeEvmChainId(undefined)).toBeUndefined()
  })
})

describe('applyEvmTxPreview = needsAdvancedMode = !(native || (fw >= 7.16 && certified))', () => {
  test('firmware-native token transfer: no AdvancedMode, no service call', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; throw new Error('no') }) as unknown as typeof fetch
    const s = info()
    await applyEvmTxPreview(s, USDC_ETH, transfer, 1, '7.16.0')
    expect(s.deviceClearSigns).toBe(true)
    expect(s.needsBlindSigning).toBe(false)
    expect(called).toBe(false)
  })

  test('a token in the 7.15 table but not 7.16.0: native on 7.15, certified lookup on 7.16', async () => {
    const LEO = '0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3'
    let called = false
    globalThis.fetch = (async () => { called = true; throw new Error('no') }) as unknown as typeof fetch
    const s715 = info()
    await applyEvmTxPreview(s715, LEO, transfer, 1, '7.15.0')
    expect(s715.deviceClearSigns).toBe(true)
    expect(s715.needsBlindSigning).toBe(false)
    expect(called).toBe(false)
    const s716 = info()
    await applyEvmTxPreview(s716, LEO, transfer, 1, '7.16.0')
    expect(s716.deviceClearSigns).toBe(false)
    expect(called).toBe(true) // the certified schema path ran
    expect(s716.needsBlindSigning).toBe(true) // service down here → AdvancedMode
  })

  test('7.16 + certified schema attaches the blob; the sign handler round-trips it to txMetadata', async () => {
    const seen = service('transfer', `eip155:8453:${USDC_BASE}:0xa9059cbb`)
    const s = info()
    await applyEvmTxPreview(s, USDC_BASE, transfer, 8453, '7.16.0')
    expect(s.deviceClearSigns).toBe(false)
    expect(s.needsBlindSigning).toBe(false)
    expect(s.calldataDecoded?.insightKeyId).toBe(0x80)
    // rest-api.ts "EVM Clear-Signing: attach signed metadata blob" decodes base64 → bytes.
    const bytes = new Uint8Array(Buffer.from(s.calldataDecoded!.signedInsightBlob!, 'base64'))
    expect(Buffer.from(bytes).toString('hex')).toBe(PAYLOAD.slice(2))
    expect(seen[0].spender).toBeUndefined() // a transfer sends no argument off the host
  })

  test('7.15: no certified lookup, AdvancedMode required', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; throw new Error('no') }) as unknown as typeof fetch
    const s = info()
    await applyEvmTxPreview(s, USDC_BASE, transfer, 8453, '7.15.0')
    expect(s.needsBlindSigning).toBe(true)
    expect(called).toBe(false)
  })

  test('service down → falls back to AdvancedMode, never throws', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const s = info()
    await applyEvmTxPreview(s, USDC_BASE, transfer, 8453, '7.16.0')
    expect(s.needsBlindSigning).toBe(true)
    expect(s.calldataDecoded?.signedInsightBlob).toBeUndefined()
  })

  test('a declined certified lookup leaves the Relay deposit blind (no local stand-in)', async () => {
    const TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
    const DATA = '0x49290c1c' + word('909ef6b32dfdc12ca86aa710b54c991af3c5f82e') + '8a2c121197efc95c42f53142ab409735ee353287f877ed4d351f63094d5bfcb1'
    globalThis.fetch = (async () => new Response(JSON.stringify({ classification: 'OPAQUE' }), { status: 422 })) as typeof fetch
    const s = info()
    await applyEvmTxPreview(s, TO, DATA, 1, '7.16.0')
    expect(s.needsBlindSigning).toBe(true)
    expect(s.calldataDecoded?.signedInsightBlob).toBeUndefined()
  })

  test('caller-provided runtime-signer blob keeps its REST priority, not a relaxed gate', async () => {
    const s = info()
    await applyEvmTxPreview(s, USDC_BASE, transfer, 8453, '7.15.0', { signedPayload: 'AAEC', keyId: 3 })
    expect(s.needsBlindSigning).toBe(true)
    expect(s.calldataDecoded?.signedInsightBlob).toBe('AAEC')
    expect(s.calldataDecoded?.insightKeyId).toBe(3)
  })
})

describe('a caller blob never relaxes the gate unless it is a certified envelope the device shows', () => {
  const TO = `0x${'42'.repeat(20)}`
  const CALL = '0xdeadbeef' + word('1')
  /** 0x03 + a 139-byte certificate + body (version, chain id, contract, selector). */
  const envelope = (version = 0x02, chainId = 1, to = TO, selector = 'deadbeef') =>
    `03${'cc'.repeat(139)}${version.toString(16).padStart(2, '0')}${chainId.toString(16).padStart(8, '0')}${to.slice(2)}${selector}`
  const preview = async (fw: string, meta: { signedPayload: string; keyId?: number }) => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const s = info()
    await applyEvmTxPreview(s, TO, CALL, 1, fw, meta)
    return s
  }

  test('a runtime-signer blob (keyId 1) on 7.16.0 annotates only: still blind, still AdvancedMode', async () => {
    const meta = { signedPayload: '00112233', keyId: 1 }
    const s = await preview('7.16.0', meta)
    expect(s.needsBlindSigning).toBe(true)
    expect(s.calldataDecoded?.insightSource).toBe('caller')
    expect(s.calldataDecoded?.insightKeyId).toBe(1)
    expect(assessSigningRisk({ ...s, to: TO, data: CALL, chainId: 1, firmwareVersion: '7.16.0' })!.tier).not.toBe('green')
    expect(evmCallRequiresAdvancedMode(TO, CALL, 1, false, meta, undefined, '7.16.0')).toBe(true)
  })

  test('a certified 0x03 envelope for this exact call on 7.16.0 is shown, so no AdvancedMode', async () => {
    const meta = { signedPayload: `0x${envelope()}`, keyId: 0x80 }
    expect((await preview('7.16.0', meta)).needsBlindSigning).toBe(false)
    expect(evmCallRequiresAdvancedMode(TO, CALL, 1, false, meta, undefined, '7.16.0')).toBe(false)
  })

  test('the certified shape is not enough: old firmware, wrong key, body, chain, contract or selector', async () => {
    for (const [fw, meta] of [
      ['7.15.0', { signedPayload: envelope(), keyId: 0x80 }],
      ['7.16.0', { signedPayload: envelope(), keyId: 1 }],
      ['7.16.0', { signedPayload: envelope(0x04), keyId: 0x80 }],
      ['7.16.0', { signedPayload: envelope(0x06), keyId: 0x80 }],
      ['7.16.0', { signedPayload: envelope(0x02, 8453), keyId: 0x80 }],
      ['7.16.0', { signedPayload: envelope(0x02, 1, `0x${'43'.repeat(20)}`), keyId: 0x80 }],
      ['7.16.0', { signedPayload: envelope(0x02, 1, TO, 'a9059cbb'), keyId: 0x80 }],
      ['7.16.0', { signedPayload: envelope().slice(0, 300), keyId: 0x80 }],
    ] as const) {
      expect((await preview(fw, meta)).needsBlindSigning).toBe(true)
      expect(evmCallRequiresAdvancedMode(TO, CALL, 1, false, meta, undefined, fw)).toBe(true)
    }
  })
})

describe('one rule for certified 0x04 dynamic schemas (REST gate = swap gate)', () => {
  const PORTALS = '0xbf5a7f3629fb325e2a8453d595ab103465f75e62'
  const DATA = '0xa2e42c65' + '00'.repeat(448)
  /** 0x03 | certificate (chain id at bytes 3..6) | 0x04 body | signature. */
  const dynamicEnvelope = () => `0x03${'cc'.repeat(2)}00000001${'cc'.repeat(133)}04${'00000001'}${PORTALS.slice(2)}a2e42c65${'00'.repeat(8)}${'ab'.repeat(65)}`
  const service = () => {
    globalThis.fetch = (async () => Response.json({
      classification: 'VERIFIED', chainId: 1, contract: PORTALS, selector: '0xa2e42c65', method: 'Portals swap',
      keyId: 0x80, signedPayload: dynamicEnvelope(),
    })) as unknown as typeof fetch
  }

  test('7.16.0 refuses 0x04 inside the certified envelope: never resolved, attached or relied on', async () => {
    expect(certifiedBodyRefused(dynamicEnvelope(), '7.16.0')).toBe(true)
    expect(certifiedBodyRefused(dynamicEnvelope(), undefined)).toBe(true)
    expect(certifiedBodyRefused(dynamicEnvelope(), '7.17.0')).toBe(false)
    service()
    expect(await resolveEvmSchema(1, PORTALS, DATA, true, '7.16.0')).toBeUndefined()
    const s = info()
    await applyEvmTxPreview(s, PORTALS, DATA, 1, '7.16.0')
    expect(s.needsBlindSigning).toBe(true)
    expect(s.calldataDecoded?.signedInsightBlob).toBeUndefined()
    // The swap gate agrees: a 0x04 envelope does not lift AdvancedMode on 7.16.0.
    expect(evmCallRequiresAdvancedMode(PORTALS, DATA, 1, false, { signedPayload: dynamicEnvelope(), keyId: 0x80 }, undefined, '7.16.0')).toBe(true)
  })

  test('firmware that shows 0x04 gets it on both gates', async () => {
    service()
    expect((await resolveEvmSchema(1, PORTALS, DATA, true, '7.17.0'))?.method).toBe('Portals swap')
    service()
    const s = info()
    await applyEvmTxPreview(s, PORTALS, DATA, 1, '7.17.0')
    expect(s.needsBlindSigning).toBe(false)
    expect(evmCallRequiresAdvancedMode(PORTALS, DATA, 1, false, { signedPayload: dynamicEnvelope(), keyId: 0x80 }, undefined, '7.17.0')).toBe(false)
  })
})

describe('a transaction-bound certified answer follows the same rule (REST gate = swap gate)', () => {
  const UR = '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
  const DATA = '0x3593564c' + '00'.repeat(4000)
  const FROM = '0x' + '11'.repeat(20)
  const preview = { from: FROM, to: UR, data: DATA, value: '0x0', nonce: '0x5', gas: '0x40000', maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x1' }
  const certTx = { chainId: 42161, from: FROM, to: UR, data: DATA, value: '0x0', nonce: '0x5', gasLimit: '0x40000', maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x1' }
  const envelope = (bodyVersion: number) => '0x' + Buffer.concat([
    Buffer.from([0x03]), Buffer.alloc(139, 7),
    Buffer.from([bodyVersion]), Buffer.from('0000a4b1', 'hex'), Buffer.from(UR.slice(2), 'hex'), Buffer.from('3593564c', 'hex'), Buffer.alloc(40),
    Buffer.alloc(65, 9),
  ]).toString('hex')
  const service = (payload: string) => {
    const txHash = '0x' + runtimeEvmSighash(certTx).toString('hex')
    globalThis.fetch = (async (url: any) => String(url).endsWith('/v1/evm/transaction')
      ? Response.json({ signedPayload: payload, keyId: 0x80, classification: 'VERIFIED', chainId: 42161, contract: UR, selector: '0x3593564c', txHash, method: 'execute' })
      : new Response('{}', { status: 422 })) as unknown as typeof fetch
  }
  const rest = async (fw: string) => {
    const s: any = { ...info(), chainId: 42161, to: UR, data: DATA, value: '0x0', from: FROM, firmwareVersion: fw }
    await prepareEvmTxSigningInfo(s, preview, fw)
    return s
  }

  for (const body of [0x01, 0x04]) {
    test(`body 0x0${body} on 7.16.0: REST stays blind and attaches nothing, as the swap gate does`, async () => {
      service(envelope(body))
      const s = await rest('7.16.0')
      expect(s.certifiedEvmSchema).toBeUndefined()
      expect(s.needsBlindSigning).toBe(true)
      expect(evmCallRequiresAdvancedMode(UR, DATA, 42161, false, { signedPayload: envelope(body), keyId: 0x80 }, undefined, '7.16.0', '0x0')).toBe(true)
    })
  }

  test('a body the firmware shows relaxes both gates', async () => {
    service(envelope(0x04))
    const s = await rest('7.17.0')
    expect(s.certifiedEvmSchema?.method).toBe('execute')
    expect(s.needsBlindSigning).toBe(false)
    expect(evmCallRequiresAdvancedMode(UR, DATA, 42161, false, { signedPayload: envelope(0x04), keyId: 0x80 }, undefined, '7.17.0', '0x0')).toBe(false)
  })
})

describe('the device does not show it → never green (firmware mirror)', () => {
  const ZX = '0xdef1c0ded9bec7f1a1670819833240f027b25eff'
  const UNIV2 = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
  const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7'
  const UNKNOWN_A = '4444444444444444444444444444444444444444'
  const UNKNOWN_B = '5555555555555555555555555555555555555555'
  const TENTH_ETH = '0x16345785d8a0000'
  const w = (hex: string) => word(hex.replace(/^0x/, ''))
  const sell = (a: string, b: string, offset = '80') =>
    '0xd9627aa4' + w(offset) + w('de0b6b3a7640000') + w('1') + w('0') + w('2') + w(a) + w(b)
  const liquidity = (selector: string, tokenWord: string) =>
    selector + tokenWord + w('1') + w('1') + w('1') + w(RECIPIENT) + w('ffffffff')

  async function verdict(to: string, data: string, chainId: number, fw: string, value = '0x0') {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const s: SigningRequestInfo = { ...info(), chain: 'eth', from: `0x${RECIPIENT}`, to, value, data, chainId, firmwareVersion: fw }
    await applyEvmTxPreview(s, to, data, chainId, fw)
    return { s, tier: assessSigningRisk(s)!.tier }
  }

  test('evm-yellow:0 — a token transfer or approve that also sends ETH is not shown on 7.15 or 7.16', async () => {
    for (const fw of ['7.15.0', '7.16.0']) {
      for (const data of [transfer, approve(PERMIT2)]) {
        const withValue = await verdict(USDC_ETH, data, 1, fw, TENTH_ETH)
        expect(withValue.s.deviceClearSigns).toBe(false)
        expect(withValue.s.needsBlindSigning).toBe(true)
        expect(withValue.tier).not.toBe('green')
        expect((await verdict(USDC_ETH, data, 1, fw)).tier).toBe('green')
      }
    }
  })

  test('a token transfer, approve or increaseAllowance that also sends ETH is red; without ETH it is unchanged', async () => {
    const increase = '0x39509351' + word(PERMIT2.slice(2)) + word('f4240')
    for (const data of [transfer, approve(PERMIT2), increase]) {
      const withValue = await verdict(USDC_ETH, data, 1, '7.16.0', TENTH_ETH)
      expect(withValue.tier).toBe('red')
      expect(assessSigningRisk(withValue.s)!.reasons.map((r) => r.text))
        .toContain('Also sends 0.1 ETH to the token contract, which a token transfer or approval does not do.')
    }
    const plain = await verdict(USDC_ETH, transfer, 1, '7.16.0')
    expect(plain.tier).toBe('green')
    expect(assessSigningRisk(plain.s)!.reasons.some((r) => r.text.startsWith('Also sends'))).toBe(false)
  })

  test('evm-green:4 — the host gates ETH on a token call before the device says "Blocked"', async () => {
    for (const data of [transfer, approve(PERMIT2)]) {
      expect(evmCallRequiresAdvancedMode(USDC_ETH, data, 1, false, undefined, undefined, '7.16.0', TENTH_ETH)).toBe(true)
      expect(evmCallRequiresAdvancedMode(USDC_ETH, data, 1, false, undefined, undefined, '7.16.0', '0x0')).toBe(false)
      expect(evmCallRequiresAdvancedMode(USDC_ETH, data, 1, false, undefined, undefined, '7.16.0')).toBe(false)
      expect((await verdict(USDC_ETH, data, 1, '7.16.0', TENTH_ETH)).tier).not.toBe('green')
    }
  })

  test('evm-green:2 — 0x sellToUniswap is red unless the device can name every token', async () => {
    for (const [data, chainId] of [
      [sell(UNKNOWN_A, UNKNOWN_B), 1],               // tokens outside the 7.16 table
      [sell(USDC_ETH, USDT_ETH, 'a0'), 1],           // non-canonical array offset
      [sell(USDC_ETH, USDC_BASE), 8453],             // Base has no table entries
    ] as const) {
      const r = await verdict(ZX, data, chainId, '7.16.0')
      expect(r.s.deviceClearSigns).toBe(false)
      expect(r.s.needsBlindSigning).toBe(true)
      expect(r.tier).toBe('red')
    }
    expect((await verdict(ZX, sell(USDC_ETH, USDT_ETH), 1, '7.16.0')).tier).toBe('green')
  })

  test('evm-green:3 — Uniswap V2 liquidity is red when the firmware would refuse it', async () => {
    const add = '0xf305d719', remove = '0x02751cec'
    for (const [data, value] of [
      [liquidity(add, w(UNKNOWN_A)), '0xde0b6b3a7640000'],                          // token outside the table
      [liquidity(remove, w(USDC_ETH)), '0x1'],                                      // ETH on removeLiquidityETH
      [liquidity(add, 'ff'.repeat(12) + USDC_ETH.slice(2)), '0xde0b6b3a7640000'],   // dirty address word
    ] as const) {
      const r = await verdict(UNIV2, data, 1, '7.16.0', value)
      expect(r.s.deviceClearSigns).toBe(false)
      expect(r.s.needsBlindSigning).toBe(true)
      expect(r.tier).toBe('red')
    }
    expect((await verdict(UNIV2, liquidity(add, w(USDC_ETH)), 1, '7.16.0', '0xde0b6b3a7640000')).tier).toBe('green')
  })
})

describe('approve spender selects the certified entry', () => {
  test('approveSpender reads only a clean 68-byte approve', () => {
    expect(approveSpender(approve(PERMIT2))).toBe(PERMIT2)
    expect(approveSpender(transfer)).toBeUndefined()
    expect(approveSpender('0x095ea7b3' + 'ff'.repeat(12) + PERMIT2.slice(2) + word('1'))).toBeUndefined()
    expect(approveSpender(approve(PERMIT2) + '00')).toBeUndefined()
  })

  test('schema registry sends the Permit2 spender and checks the pinned entry', async () => {
    const seen = service('approve', `eip155:8453:${USDC_BASE}:0x095ea7b3:permit2`)
    expect((await findCertifiedEvmSchema(8453, USDC_BASE, approve(PERMIT2)))?.keyId).toBe(0x80)
    expect(seen[0].spender).toBe(PERMIT2)
    // Generic entry back for a Permit2 approve → refused, not silently used.
    service('approve', `eip155:8453:${USDC_BASE}:0x095ea7b3`)
    await expect(findCertifiedEvmSchema(8453, USDC_BASE, approve(PERMIT2))).rejects.toThrow(/does not match/)
  })

  test('envelope registry sends the spender for approve, not for transfer', async () => {
    const seen = service('approve', `eip155:8453:${USDC_BASE}:0x095ea7b3:permit2`)
    expect((await findCertifiedEvmEnvelope(8453, USDC_BASE, approve(PERMIT2)))?.keyId).toBe(0x80)
    expect(seen[0].spender).toBe(PERMIT2)
    const seen2 = service('transfer', `eip155:8453:${USDC_BASE}:0xa9059cbb`)
    await findCertifiedEvmEnvelope(8453, USDC_BASE, transfer)
    expect('spender' in seen2[0]).toBe(false)
    service('approve', `eip155:8453:${USDC_BASE}:0x095ea7b3`)
    await expect(findCertifiedEvmEnvelope(8453, USDC_BASE, approve(PERMIT2))).rejects.toThrow(/invalid certified/)
  })
})

describe('evmPriorityFee (canonical RLP, shared by REST and WalletConnect)', () => {
  test('zero or absent → empty string', () => {
    expect(evmPriorityFee(undefined)).toBe('0x')
    expect(evmPriorityFee('0x0')).toBe('0x')
    expect(evmPriorityFee('0x00')).toBe('0x')
    expect(evmPriorityFee('0x59682f00')).toBe('0x59682f00')
  })
})

describe('typedDataNativelyReviewed', () => {
  const permit = () => ({
    primaryType: 'PermitSingle',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
    },
    message: {},
  })
  test('canonical Permit2 PermitSingle on 7.16+ only', () => {
    expect(typedDataNativelyReviewed(permit(), '7.16.0')).toBe(true)
    expect(typedDataNativelyReviewed(permit(), '7.15.2')).toBe(false)
    expect(typedDataNativelyReviewed(permit(), undefined)).toBe(false)
  })
  test('anything off-canonical stays AdvancedMode-gated', () => {
    const wrongContract = permit(); wrongContract.domain.verifyingContract = '0x1111111111111111111111111111111111111111'
    const extraDomain: any = permit(); extraDomain.domain.version = '1'
    const wrongName = permit(); wrongName.domain.name = 'Permit3'
    const batch = permit(); batch.primaryType = 'PermitBatch'
    const wrongWidth = permit(); wrongWidth.types.PermitDetails[1].type = 'uint256'
    for (const doc of [wrongContract, extraDomain, wrongName, batch, wrongWidth]) {
      expect(typedDataNativelyReviewed(doc, '7.16.0')).toBe(false)
    }
  })
})

describe('Solana sign-message signer check', () => {
  test('schema keeps the claimed signer (zod .strip() would drop unknown keys)', () => {
    const parsed = SolanaSignMessageRequest.parse({ message: 'aGk=', pubkey: 'A', address: 'B', junk: 1 })
    expect(parsed.pubkey).toBe('A')
    expect(parsed.address).toBe('B')
    expect((parsed as any).junk).toBeUndefined()
  })
  test('a different derived account is a clear "reconnect" error', () => {
    expect(solanaSignerChangedError(undefined, 'X')).toBeUndefined()
    expect(solanaSignerChangedError('X', 'X')).toBeUndefined()
    expect(solanaSignerChangedError('Old', 'New')).toMatch(/account changed — reconnect the dapp/)
  })
})

describe('certified Uniswap swap (0x07) attach', () => {
  const header = require('node:fs').readFileSync(new URL('../../__tests__/fixtures/uniswap/uniswap_ur_vectors.h', import.meta.url), 'utf8') as string
  const vectors = [...header.matchAll(/\{"(0x[0-9a-f]{64})", "([0-9a-f]{40})", "([0-9a-f]{64})", "([0-9a-f]+)", \{(.*?)\}\},?\n/g)]
    .map((m) => ({ tx: m[1], router: `0x${m[2]}`, value: BigInt(`0x${m[3]}`), data: `0x${m[4]}`, steps: m[5] }))
  const { urPrecheck } = require('./uniswap-ur')
  const { buildEvmDecoderBody, reviewedSwapTokens, REVIEWED_EVM_TOKENS } = require('./evm-certified-schema')
  const appShaped = (v: any) => v.steps.includes('PERMIT2_PERMIT') || v.steps.includes('WRAP_ETH')
  const reviewed = (v: any) => {
    const pre = urPrecheck(v.router, v.data, v.value)
    return pre && pre.tokens.every((t: string) => REVIEWED_EVM_TOKENS[`8453:${t}`]) ? pre : null
  }
  // Searched at test time; never hard-coded to one sample.
  const fullyReviewed = vectors.filter((v) => appShaped(v) && reviewed(v))
  const appSwap = fullyReviewed[0]
  const ethSwap = fullyReviewed.find((v) => v.steps.includes('WRAP_ETH'))
  const unreviewedToken = vectors.find((v) => appShaped(v) && urPrecheck(v.router, v.data, v.value) && !reviewed(v))!
  const CERT = 'cc'.repeat(139)

  /** A worker that signs nothing: it returns the body Desktop expects (or a tampered one). */
  function swapService(seen: any[], tamper?: (tokens: any[]) => any[]) {
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      // Published-review lookup for an unknown call: none exists here.
      if (String(url).endsWith('/v1/evm/schema')) {
        return new Response(JSON.stringify({ classification: 'OPAQUE' }), { status: 422 })
      }
      seen.push({ url: String(url), body })
      let tokens = reviewedSwapTokens(body.chainId, body.tokens)
      if (tamper) tokens = tamper(tokens)
      const inner = buildEvmDecoderBody(body.chainId, body.contract, body.selector, tokens).toString('hex')
      return new Response(JSON.stringify({
        success: true, classification: 'VERIFIED', version: 7, keyId: 0x80, chainId: body.chainId,
        entry: `eip155:${body.chainId}:${body.contract}:uniswap-ur`, contract: body.contract, selector: body.selector,
        method: 'execute', signedPayload: `0x03${CERT}${inner}${'ee'.repeat(65)}`, tokens,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return seen
  }
  const swapInfo = (value: bigint): SigningRequestInfo => ({ ...info(), value: `0x${value.toString(16)}` })

  test('fixtures: the real Base sample holds an app-shaped swap whose tokens are all reviewed', () => {
    if (!appSwap) {
      throw new Error('uniswap_ur_vectors.h has no app-shaped (PERMIT2_PERMIT/WRAP_ETH) swap whose tokens are all in REVIEWED_EVM_TOKENS for 8453; pin one in scripts/uniswap/gen_ur_vectors.py ALWAYS')
    }
    expect(unreviewedToken).toBeDefined()
  })

  test('7.16 + reviewed router + reviewed tokens: attaches 0x03 envelope, no AdvancedMode, sends only addresses', async () => {
    const seen = swapService([])
    const s = swapInfo(appSwap.value)
    await applyEvmTxPreview(s, appSwap.router, appSwap.data, 8453, '7.16.0')
    expect(s.needsBlindSigning).toBe(false)
    expect(s.calldataDecoded?.insightKeyId).toBe(0x80)
    const blob = Buffer.from(s.calldataDecoded!.signedInsightBlob!, 'base64')
    expect(blob[0]).toBe(0x03)
    expect(blob[140]).toBe(0x07)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toEndWith('/v1/evm/swap')
    expect(Object.keys(seen[0].body).sort()).toEqual(['chainId', 'contract', 'selector', 'tokens'])
    expect(seen[0].body.selector).toBe('0x3593564c')
    expect(seen[0].body.tokens).toEqual(urPrecheck(appSwap.router, appSwap.data, 0n).tokens)
  })

  // Runs only when the sample holds a reviewed ETH-in swap; msg.value handling
  // is otherwise covered by uniswap-ur.test.ts and the ETH-beside-token case below.
  test.if(!!ethSwap)('ETH-in swap: msg.value is read from the request; a different value attaches nothing', async () => {
    const seen = swapService([])
    const s = swapInfo(ethSwap.value)
    await applyEvmTxPreview(s, ethSwap.router, ethSwap.data, 8453, '7.16.0')
    expect(s.needsBlindSigning).toBe(false)
    const s2 = swapInfo(ethSwap.value + 1n)
    await applyEvmTxPreview(s2, ethSwap.router, ethSwap.data, 8453, '7.16.0')
    expect(s2.needsBlindSigning).toBe(true)
    expect(seen).toHaveLength(1)
  })

  test('no request, AdvancedMode: 7.15, unreviewed token, unreviewed router, V4 shape, ETH beside a token swap', async () => {
    const seen = swapService([])
    const v4 = header.slice(header.indexOf('v4_rejected()')).match(/"(3593564c[0-9a-f]+)"/)![1]
    const cases: [string, string, bigint, string][] = [
      [appSwap.router, appSwap.data, 0n, '7.15.0'],
      [unreviewedToken.router, unreviewedToken.data, 0n, '7.16.0'],
      ['0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', appSwap.data, 0n, '7.16.0'],
      [appSwap.router, `0x${v4}`, 0n, '7.16.0'],
      [appSwap.router, appSwap.data, 5n, '7.16.0'],
    ]
    for (const [to, data, value, fw] of cases) {
      const s = swapInfo(value)
      await applyEvmTxPreview(s, to, data, 8453, fw)
      expect(s.needsBlindSigning).toBe(true)
      expect(s.calldataDecoded?.signedInsightBlob).toBeUndefined()
    }
    expect(seen).toHaveLength(0)
  })

  test('a service body naming other token identities is refused, never attached', async () => {
    swapService([], (tokens) => [...tokens].reverse())
    const s = swapInfo(0n)
    await applyEvmTxPreview(s, appSwap.router, appSwap.data, 8453, '7.16.0')
    expect(s.needsBlindSigning).toBe(true)
    expect(s.calldataDecoded?.signedInsightBlob).toBeUndefined()
  })

  test('service 503 / down: AdvancedMode, never throws', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ classification: 'UNAVAILABLE' }), { status: 503 })) as unknown as typeof fetch
    const s = swapInfo(0n)
    await applyEvmTxPreview(s, appSwap.router, appSwap.data, 8453, '7.16.0')
    expect(s.needsBlindSigning).toBe(true)
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const s2 = swapInfo(0n)
    await applyEvmTxPreview(s2, appSwap.router, appSwap.data, 8453, '7.16.0')
    expect(s2.needsBlindSigning).toBe(true)
  })
})

// Real Base swap from the Uniswap app (fixture header names the tx). Its card
// showed "Deadline: 160" (the inputs offset word) and "ERC-20" as the app.
describe('Uniswap Universal Router card rows — real Base swap', () => {
  const swap = require('../../__tests__/fixtures/uniswap/base-ur-usdc-to-eth-swap.json')
  const { decodeCalldata, formatDeadline } = require('./calldata-decoder')
  const DEADLINE = 1791151531

  test('Deadline is the third head word, as local time; app is Uniswap', async () => {
    const d = await decodeCalldata(swap.to, swap.data, swap.chainId)
    expect(d.dappName).toBe('Uniswap')
    const deadline = d.fields.find((f: any) => f.name === 'Deadline').value
    expect(deadline).not.toBe('160')
    expect(deadline).toBe(formatDeadline(String(DEADLINE)))
  })

  test('formatDeadline: local HH:MM and how far off', () => {
    const at = (minutes: number) => (DEADLINE - minutes * 60) * 1000
    expect(formatDeadline(String(DEADLINE), at(20))).toMatch(/^\d{2}:\d{2}, in 20 min$/)
    expect(formatDeadline(String(DEADLINE), at(-5))).toMatch(/^\d{2}:\d{2}, EXPIRED 5 min ago$/)
    expect(formatDeadline(String(DEADLINE), at(3 * 1440))).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}, in 3 d$/)
    expect(formatDeadline('160')).toBe('160')
  })

  test('the decoded swap is on the card: amounts, tokens, recipient', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const s: SigningRequestInfo = { ...info(), from: swap.from, to: swap.to, value: swap.value, data: swap.data, chainId: swap.chainId }
    await applyEvmTxPreview(s, swap.to, swap.data, swap.chainId, '7.15.0')
    const row = (n: string) => s.calldataDecoded?.fields.find((f) => f.name === n)?.value
    // The swap's own floor is 0; UNWRAP_WETH carries the real one.
    expect(row('Action')).toBe('Swap 300 USDC for at least 0.108123518386717195 ETH')
    expect(row('You pay')).toBe('300 USDC')
    expect(row('Minimum output')).toBe('0.108123518386717195 ETH')
    expect(row('Recipient')).toBe(`${swap.from} (the signing account)`)
    expect(row('Token warning')).toBeUndefined()
    // Display only: the gate is unchanged.
    expect(s.needsBlindSigning).toBe(true)
  })

  test('same calldata to an unreviewed contract gets no swap rows', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const other = '0x1111111111111111111111111111111111111111'
    const s: SigningRequestInfo = { ...info(), from: swap.from, to: other, value: swap.value, data: swap.data, chainId: swap.chainId }
    await applyEvmTxPreview(s, other, swap.data, swap.chainId, '7.16.0')
    expect(s.calldataDecoded?.fields.find((f) => f.name === 'Action')).toBeUndefined()
    expect(s.needsBlindSigning).toBe(true)
  })
})

// Real Base UR 2.1.2 V4 calls from the firmware's D-021 sample, with the
// firmware's own review (ur-firmware-parity.json.gz). Searched at test time.
describe('Uniswap V4 through UR 2.1.2 — preview rows and certified attach', () => {
  const { readFileSync } = require('node:fs')
  const { urPrecheck } = require('./uniswap-ur')
  const { buildEvmDecoderBody, reviewedSwapTokens, REVIEWED_EVM_TOKENS } = require('./evm-certified-schema')
  const { uniswapSwapFields } = require('./evm-signing-preview')
  const UR212 = '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40'
  const fixture = JSON.parse(Buffer.from(Bun.gunzipSync(readFileSync(new URL('../../__tests__/fixtures/uniswap/ur-firmware-parity.json.gz', import.meta.url)))).toString())
  const v4 = (Object.entries(fixture.calls) as [string, [string, string, string]][])
    .filter(([key]) => key.startsWith('0x'))
    .map(([tx, [, value, cd]]) => ({ tx, value: BigInt(`0x${value}`), data: `0x${cd}`, pre: urPrecheck(UR212, cd, BigInt(`0x${value}`)) }))
    .filter((c) => c.pre?.plan.steps.some((s: any) => s.kind.startsWith('V4_SWAP')))
  const allReviewed = (c: any) => c.pre.tokens.every((t: string) => REVIEWED_EVM_TOKENS[`8453:${t}`])
  const ethIn = v4.find((c) => c.pre.summary.inIsEth && c.pre.plan.steps.length === 1 && allReviewed(c))!
  const ethOut = v4.find((c) => c.pre.summary.outIsEth && allReviewed(c))!
  const hooked = v4.find((c) => c.pre.summary.hooks.length > 0)!
  const rows = (c: any, chainId = 8453, router = UR212) =>
    Object.fromEntries(uniswapSwapFields(chainId, router, c.data, `0x${c.value.toString(16)}`).map((f: any) => [f.name, f.value]))

  test('fixtures: the sample holds ETH-in, ETH-out and hooked V4 swaps', () => {
    expect(ethIn && ethOut && hooked).toBeTruthy()
  })

  test('native ETH paid by msg.value: shown as ETH, never named in the entry', () => {
    const r = rows(ethIn)
    const s = ethIn.pre.summary
    expect(r['You pay']).toMatch(/ ETH$/)
    expect(r['Minimum output']).toEndWith(` ${REVIEWED_EVM_TOKENS[`8453:${s.tokenOut}`].symbol}`)
    expect(r.Action).toStartWith(`Swap ${r['You pay']} for at least ${r['Minimum output']}`)
    expect(r.Preview).toBe('Checked on this computer. Your KeepKey screen is the final word.')
    expect(ethIn.pre.tokens).toEqual([s.tokenOut])
  })

  test('ETH delivered: the minimum is in ETH and only the paid token is named', () => {
    expect(rows(ethOut)['Minimum output']).toMatch(/ ETH$/)
    expect(ethOut.pre.tokens).toEqual([ethOut.pre.summary.tokenIn])
  })

  test('every pool hook is a row, as on the device', () => {
    const r = rows(hooked)
    const hooks = hooked.pre.summary.hooks as string[]
    const shown = Object.entries(r).filter(([k]) => k.startsWith('Pool hook')).map(([, v]) => v)
    expect(shown).toEqual(hooks.map((h) => `The swap runs this hook contract ${h}`))
  })

  test('fails closed off UR 2.1.2 on Base: no rows through UR 2.0, or on another chain', () => {
    expect(rows(ethIn, 8453, '0x6ff5693b99212da76ad316178a184ab56d299b43')).toEqual({})
    expect(rows(ethIn, 1)).toEqual({})
  })

  test('7.16 attach: the request names the delivered token only (no native ETH, no intermediates)', async () => {
    const seen: any[] = []
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (!String(url).endsWith('/v1/evm/swap')) return new Response(JSON.stringify({ classification: 'OPAQUE' }), { status: 422 })
      seen.push(body)
      const tokens = reviewedSwapTokens(body.chainId, body.tokens)
      const inner = buildEvmDecoderBody(body.chainId, body.contract, body.selector, tokens).toString('hex')
      return new Response(JSON.stringify({
        success: true, classification: 'VERIFIED', version: 7, keyId: 0x80, chainId: body.chainId,
        entry: `eip155:${body.chainId}:${body.contract}:uniswap-ur`, contract: body.contract, selector: body.selector,
        method: 'execute', signedPayload: `0x03${'cc'.repeat(139)}${inner}${'ee'.repeat(65)}`, tokens,
      }), { status: 200 })
    }) as typeof fetch
    const s: SigningRequestInfo = { ...info(), value: `0x${ethIn.value.toString(16)}` }
    await applyEvmTxPreview(s, UR212, ethIn.data, 8453, '7.16.0')
    expect(s.needsBlindSigning).toBe(false)
    expect(seen).toEqual([{ chainId: 8453, contract: UR212, selector: ethIn.data.slice(0, 10), tokens: [ethIn.pre.summary.tokenOut] }])
  })
})

test('recognizedSpender: canonical Permit2 and certified name records only', async () => {
  const { recognizedSpender } = await import('./evm-signing-preview')
  expect(recognizedSpender(1, '0x000000000022D473030F116dDEE9F6B43aC78BA3')).toBe('Uniswap Permit2')
  expect(recognizedSpender(1, '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD')).toBe('Uniswap Universal Router')
  // A token is not a reviewed spender, and neither is a random or malformed address.
  expect(recognizedSpender(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBeUndefined()
  expect(recognizedSpender(1, '0x1111111254eeb25477b68fb85ed929f73a960582')).toBeUndefined()
  expect(recognizedSpender(1, 'not-an-address')).toBeUndefined()
  expect(recognizedSpender(undefined, '0x000000000022D473030F116dDEE9F6B43aC78BA3')).toBeUndefined()
})
