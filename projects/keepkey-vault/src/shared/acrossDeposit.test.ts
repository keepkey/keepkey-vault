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

  test('a known protocol: yellow, says the firmware cannot show it yet', () => {
    const r = assessSigningRisk(req())!
    expect(r.level).toBe('medium')
    const all = r.reasons.map((x) => x.text).join('\n')
    expect(all).toContain('Across bridge deposit to the Across SpokePool on Base, a contract KeepKey knows')
    expect(all).toContain('cannot show Across deposits on the device yet')
    expect(all).not.toContain('signing blind')
    expect(r.tier).toBe('yellow')
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
      expect(texts(req({ data })).some((x) => x.includes('You would be signing blind'))).toBe(true)
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

// ── Verdict regressions: the tier must match what the device shows ──
/** A canonical depositV3 (no message). */
function deposit(o: { recipient?: string; inputToken: string; outputToken: string; inputAmount: bigint; outputAmount: bigint; dest: bigint; relayer?: string; exclusivity?: number }): string {
  const w = (h: string) => h.replace(/^0x/, '').padStart(64, '0')
  const n = (v: bigint | number) => w(BigInt(v).toString(16))
  return '0x7b939232' + [
    w(SIGNER), w(o.recipient ?? SIGNER), w(o.inputToken), w(o.outputToken),
    n(o.inputAmount), n(o.outputAmount), n(o.dest), w(o.relayer ?? '0x0'),
    n(0x6ac2c7bb), n(0x6ac2e3db), n(o.exclusivity ?? 0), n(0x180), n(0),
  ].join('')
}
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const ETH_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ATTACKER = '0x1111111111111111111111111111111111111111'

describe('Across verdict regressions', () => {
  // evm-green:0
  test('a caller-supplied keyId 0x80 blob never makes an Across deposit green', async () => {
    const { applyEvmTxPreview } = await import('../bun/evm-signing-preview')
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    try {
      for (const fw of ['7.14.2', '7.15.0', '7.16.0']) {
        for (const signedPayload of ['01' + 'ab'.repeat(120), '03' + '00'.repeat(139) + '07' + 'ee'.repeat(100)]) {
          const s = req({ firmwareVersion: fw, needsBlindSigning: undefined, deviceClearSigns: undefined })
          await applyEvmTxPreview(s, POOL, DATA, 8453, fw, { signedPayload, keyId: 0x80 })
          const r = assessSigningRisk(s)!
          expect(r.tier).toBe('yellow')
          expect(r.headline).not.toBe('Shown on your KeepKey')
          expect(s.calldataDecoded?.insightSource).toBe('caller')
        }
      }
    } finally { globalThis.fetch = original }
  })

  // wiring:1
  test('a certified 0x04 decoder body is not shown by 7.16.0: Arbitrum Across stays yellow', () => {
    const { CERTIFIED_EVM_CATALOG, buildEvmSchemaBody } = require('../bun/evm-certified-schema')
    const ARB_POOL = '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a'
    const body: Buffer = buildEvmSchemaBody(CERTIFIED_EVM_CATALOG[`42161:${ARB_POOL}:0x7b939232`])
    expect(body[0]).toBe(0x04)
    const blob = Buffer.from('03' + '11'.repeat(139) + body.toString('hex') + '22'.repeat(65), 'hex').toString('base64')
    const data = deposit({ inputToken: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', outputToken: ETH_WETH, inputAmount: 10n ** 18n, outputAmount: 999n * 10n ** 15n, dest: 1n })
    const r = assessSigningRisk(req({
      to: ARB_POOL, chainId: 42161, value: '0x0', data, firmwareVersion: '7.16.0', needsBlindSigning: false,
      calldataDecoded: { dappName: 'Across', contractName: ARB_POOL, method: 'Across bridge', selector: '0x7b939232', fields: [], source: 'local', signedInsightBlob: blob, insightKeyId: 0x80 },
    }))!
    expect(r.tier).toBe('yellow')
    expect(r.reasons.map((x) => x.text).join('\n')).toContain('cannot show Across deposits on the device yet')
  })

  // evm-yellow:3
  test('an output token this computer cannot name, or an unknown destination, is red', () => {
    const base = { inputToken: BASE_USDC, inputAmount: 1000_000000n, relayer: ATTACKER }
    const junk = assessSigningRisk(req({ value: '0x0', data: deposit({ ...base, outputToken: '0x' + '22'.repeat(20), outputAmount: 1n, dest: 1n }) }))!
    expect(junk.tier).toBe('red')
    expect(junk.reasons[0].text).toContain('cannot name the token the recipient gets')
    const chain = assessSigningRisk(req({ value: '0x0', data: deposit({ ...base, outputToken: ETH_USDC, outputAmount: 999_000000n, dest: 31337n }) }))!
    expect(chain.tier).toBe('red')
    expect(chain.reasons.map((x) => x.text).join('\n')).toContain('does not recognize destination chain id 31337')
    // The normal route stays yellow, and both sides are named.
    const usdc = assessSigningRisk(req({ value: '0x0', data: deposit({ ...base, outputToken: ETH_USDC, outputAmount: 999_500000n, dest: 1n }) }))!
    expect(usdc.tier).toBe('yellow')
    expect(usdc.reasons.map((x) => x.text).join('\n')).toContain('Bridge fee: 0.5 USDC (0.05%)')
  })

  // Follow-up to evm-yellow:3: real stablecoin routes stay yellow and named.
  test('Base USDC to the USDC or USDT Across pays out on each pinned chain is yellow, with both sides named', async () => {
    const routes: [bigint, string, string][] = [
      [10n, '0x0b2c639c533813f4aa9d7837caf62653d097ff85', '999.5 USDC'],     // Optimism native USDC
      [137n, '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', '999.5 USDC'],    // Polygon native USDC
      [137n, '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', '999.5 USDC.e'],  // Polygon bridged USDC
      [43114n, '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', '999.5 USDC'],
      [59144n, '0xa219439258ca9da29e9cc4ce5596924745e12b93', '999.5 USDT'],
      [324n, '0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4', '999.5 USDC.e'],
    ]
    for (const [dest, outputToken, received] of routes) {
      const data = deposit({ inputToken: BASE_USDC, outputToken, inputAmount: 1000_000000n, outputAmount: 999_500000n, dest })
      const r = assessSigningRisk(req({ value: '0x0', data }))!
      expect(r.tier).toBe('yellow')
      expect(r.reasons.map((x) => x.text).join('\n')).toContain(`A relayer pays ${received} to`)
      expect((await decodeCalldata(POOL, data, 8453))?.fields.find((f) => f.name === 'Recipient gets')?.value).toStartWith(received)
    }
    // BNB Smart Chain USDC has 18 decimals.
    const bsc = deposit({ inputToken: BASE_USDC, outputToken: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', inputAmount: 1000_000000n, outputAmount: 999_5n * 10n ** 17n, dest: 56n })
    expect(assessSigningRisk(req({ value: '0x0', data: bsc }))!.tier).toBe('yellow')
    expect(texts(req({ value: '0x0', data: bsc })).join('\n')).toContain('A relayer pays 999.5 USDC to')
  })

  // evm-yellow:4
  test('a "bridge fee" that keeps 99% of the deposit is red and names the relayer that collects it', () => {
    const data = deposit({ inputToken: BASE_WETH, outputToken: ETH_WETH, inputAmount: 10n ** 18n, outputAmount: 10n ** 16n, dest: 1n, relayer: ATTACKER, exclusivity: 3600 })
    const r = assessSigningRisk(req({ value: '0xde0b6b3a7640000', data }))!
    expect(r.tier).toBe('red')
    expect(r.reasons[0].text).toBe(`Bridge fee: 0.99 WETH (99.00%). That is not a normal Across fee: the exclusive relayer ${ATTACKER} keeps it.`)
  })
})
