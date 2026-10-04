/**
 * Across depositV3, from a real Uniswap cross-chain swap (Base → Ethereum,
 * second tx of the flow, 2026-10-04). The trailing 1dc0de… bytes are Across's
 * integrator tag, appended by Uniswap after the ABI encoding.
 */
import { describe, expect, test } from 'bun:test'
import { decodeCalldata, firmwareClearSigns } from '../bun/calldata-decoder'
import { assessSigningRisk } from './clearsign-risk'
import { acrossLocalTime, decodeAcrossDepositV3, findReviewedAcrossSpokePool } from './acrossDeposit'
import type { SigningRequestInfo } from './types'

const POOL = '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64'
const SIGNER = '0x909ef6b32dfdc12ca86aa710b54c991af3c5f82e'
const VALUE = '0x189e6105b7a8de7'
const DATA = '0x7b939232000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e0000000000000000000000004200000000000000000000000000000000000006000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000000000000000000000000000000000000000000000000189e6105b7a8de70000000000000000000000000000000000000000000000000189bfc0793fe6f50000000000000000000000000000000000000000000000000000000000000001000000000000000000000000394311a6aaa0d8e3411d8b62de4578d41322d1bd000000000000000000000000000000000000000000000000000000006ac2c7bb000000000000000000000000000000000000000000000000000000006ac2e3db000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000001dc0de00410000000c'
const TAG = '1dc0de00410000000c'
const ABI_ONLY = DATA.slice(0, -TAG.length)

const req = (over: Partial<SigningRequestInfo> = {}): SigningRequestInfo => ({
  id: 'x', method: '/eth/sign-transaction', appName: 'app.uniswap.org',
  from: SIGNER, to: POOL, value: VALUE, data: DATA, chainId: 8453,
  needsBlindSigning: true, deviceClearSigns: false, ...over,
} as SigningRequestInfo)
const texts = (r: SigningRequestInfo) => assessSigningRisk(r)!.reasons.map((x) => x.text)

describe('decodeAcrossDepositV3 — real Base → Ethereum deposit', () => {
  test('decodes every argument and the integrator tag', () => {
    const d = decodeAcrossDepositV3(POOL, DATA, 8453)!
    expect(d.pool.chain).toBe('Base')
    expect(d.depositor).toBe(SIGNER)
    expect(d.recipient).toBe(SIGNER)
    expect(d.inputToken).toBe('0x4200000000000000000000000000000000000006')
    expect(d.outputToken).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
    expect(d.inputAmount).toBe(BigInt(VALUE))
    expect(d.outputAmount).toBe(110830499236144885n)
    expect(d.destinationChainId).toBe(1n)
    expect(d.exclusiveRelayer).toBe('0x394311a6aaa0d8e3411d8b62de4578d41322d1bd')
    expect(d.quoteTimestamp).toBe(0x6ac2c7bb)
    expect(d.fillDeadline).toBe(0x6ac2e3db)
    expect(d.exclusivityParameter).toBe(12)
    expect(d.message).toBe('0x')
    expect(d.trailing).toBe(`0x${TAG}`)
  })

  test('the plain ABI encoding (no tag) decodes too', () => {
    expect(decodeAcrossDepositV3(POOL, ABI_ONLY, 8453)?.trailing).toBe('0x')
  })

  test('overlay fields name amounts, chains, fee, deadline', async () => {
    const decoded = (await decodeCalldata(POOL, DATA, 8453))!
    expect(decoded.dappName).toBe('Across')
    expect(decoded.source).toBe('local')
    const f = Object.fromEntries(decoded.fields.map((x) => [x.name, x.value]))
    expect(f['Action']).toBe('Across bridge deposit: Base → Ethereum (chain id 1)')
    expect(f['You send']).toBe('0.110872623775911399 WETH on Base')
    expect(f['Recipient gets']).toBe('0.110830499236144885 WETH on Ethereum (chain id 1)')
    expect(f['Recipient']).toBe(SIGNER)
    expect(f['Bridge fee']).toBe('0.000042124539766514 WETH (0.03%)')
    expect(f['Fill deadline']).toBe(acrossLocalTime(0x6ac2e3db))
    expect(f['Exclusive relayer']).toContain('only it may fill for 12 s')
    expect(f['Message to recipient']).toBe('None')
    expect(f['Trailing bytes']).toContain('Across integrator tag')
  })

  test('risk replaces the generic blind line but stays honest and high', () => {
    const r = assessSigningRisk(req())!
    expect(r.level).toBe('high')
    const all = r.reasons.map((x) => x.text).join('\n')
    expect(all).toContain('Across bridge deposit to the Across SpokePool on Base')
    expect(all).toContain('signing blind')
    expect(all).not.toContain('can use any token permission you already gave')
    expect(all).not.toContain('NOT the account signing')
    expect(all).toContain('Bridge fee: 0.000042124539766514 WETH (0.03%)')
  })

  test('the device gate is unchanged: firmware does not clear-sign it', () => {
    expect(firmwareClearSigns(POOL, DATA, 8453)).toBe(false)
  })
})

describe('decodeAcrossDepositV3 — flags and refusals', () => {
  test('recipient other than the signer is flagged', () => {
    const other = '1111111111111111111111111111111111111111'
    const data = DATA.replace(`000000000000000000000000${SIGNER.slice(2)}0000000000000000000000004200`, `000000000000000000000000${other}0000000000000000000000004200`)
    expect(decodeAcrossDepositV3(POOL, data, 8453)!.recipient).toBe(`0x${other}`)
    const t = texts(req({ data }))
    expect(t.some((x) => x.includes(`go to 0x${other}, which is NOT the account signing this`))).toBe(true)
  })

  test('value that does not fund the deposit is flagged', () => {
    expect(texts(req({ value: '0x1' })).some((x) => x.includes('does not match the deposit'))).toBe(true)
  })

  test('a token-funded deposit says it uses the existing permission', () => {
    expect(texts(req({ value: '0x0' })).some((x) => x.includes('using the token permission you gave this SpokePool'))).toBe(true)
  })

  test('truncated, malformed or oversized calldata falls back to the generic path', async () => {
    const bad = [
      DATA.slice(0, 10 + 64 * 12),                                 // no length word
      ABI_ONLY.slice(0, -2),                                       // odd/short
      DATA.replace('0000000000000000000000000000000000000000000000000000000000000180', '00000000000000000000000000000000000000000000000000000000000001a0'), // bad offset
      DATA.replace('000000000000000000000000909ef6b3', '000000000000000000000001909ef6b3'), // dirty address word
      DATA.replace('000000000000000000000000000000000000000000000000000000006ac2e3db', '000000000000000000000000000000000000000000000000000000016ac2e3db'), // uint32 overflow
      ABI_ONLY + '00'.repeat(65),                                  // too much trailing data
      ABI_ONLY.replace(/0{64}$/, '0'.repeat(62) + '40'),           // message length past the end
    ]
    for (const data of bad) {
      expect(decodeAcrossDepositV3(POOL, data, 8453)).toBeNull()
      expect((await decodeCalldata(POOL, data, 8453))?.dappName).not.toBe('Across')
      expect(texts(req({ data })).some((x) => x.includes('It can use any token permission you already gave that contract'))).toBe(true)
    }
  })

  test('unknown chain or address is not treated as Across', () => {
    expect(findReviewedAcrossSpokePool(8453, POOL)).toBeDefined()
    expect(decodeAcrossDepositV3(POOL, DATA, 1)).toBeNull()        // Base's pool address on Ethereum
    expect(decodeAcrossDepositV3(POOL, DATA, undefined)).toBeNull()
    expect(decodeAcrossDepositV3('0x' + '22'.repeat(20), DATA, 8453)).toBeNull()
    expect(texts(req({ chainId: 1 })).some((x) => x.includes('Across'))).toBe(false)
  })
})
