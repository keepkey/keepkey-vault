import { afterEach, describe, expect, test } from 'bun:test'
import type { SigningRequestInfo } from '../shared/types'
import { applyEvmTxPreview, evmPriorityFee, normalizeEvmChainId, typedDataNativelyReviewed } from './evm-signing-preview'
import { approveSpender, findCertifiedEvmSchema } from './evm-schema-registry'
import { findCertifiedEvmEnvelope } from './evm-certified-registry'
import { findEvmSchema } from './evm-schema-registry'
import { SolanaSignMessageRequest } from './schemas'
import { solanaSignerChangedError } from './solana-message-preview'

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

  test('never substitutes the local CI-key schema', async () => {
    const TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
    const DATA = '0x49290c1c' + word('909ef6b32dfdc12ca86aa710b54c991af3c5f82e') + '8a2c121197efc95c42f53142ab409735ee353287f877ed4d351f63094d5bfcb1'
    expect(findEvmSchema(1, TO, DATA)).toBeDefined()
    globalThis.fetch = (async () => new Response(JSON.stringify({ classification: 'OPAQUE' }), { status: 422 })) as typeof fetch
    const s = info()
    await applyEvmTxPreview(s, TO, DATA, 1, '7.16.0')
    expect(s.needsBlindSigning).toBe(true)
    expect(s.calldataDecoded?.signedInsightBlob).toBeUndefined()
  })

  test('caller-provided runtime-signer blob keeps its REST priority', async () => {
    const s = info()
    await applyEvmTxPreview(s, USDC_BASE, transfer, 8453, '7.15.0', { signedPayload: 'AAEC', keyId: 3 })
    expect(s.needsBlindSigning).toBe(false)
    expect(s.calldataDecoded?.signedInsightBlob).toBe('AAEC')
    expect(s.calldataDecoded?.insightKeyId).toBe(3)
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
