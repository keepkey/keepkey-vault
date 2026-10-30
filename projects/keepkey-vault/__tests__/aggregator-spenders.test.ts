/**
 * Swap and bridge spenders Desktop names (src/shared/evm-known-spenders.ts),
 * driven by REAL requests:
 *   - the three USDC approvals swaps.pro sent on 2026-10-29 (CoW, 0x, LI.FI
 *     routes), docs/clearsign-case-studies/swapspro-20261029/requests;
 *   - an on-chain USDC EIP-2612 permit to the CoW Vault Relayer and an
 *     on-chain Permit2 PermitSingle to the 1inch v6 router
 *     (fixtures/spenders, each with its _source; the signatures are checked
 *     below so the documents are exactly what was signed).
 * Owner rule (2026-10-11): danger only when a request is not normal. A
 * bounded grant to a spender Desktop recognises reads "check before you
 * sign"; an unlimited grant to one it does not recognise reads danger.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ethers } from 'ethers'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import { erc20Preview } from '../src/shared/erc20Preview'
import { knownSpenderName } from '../src/shared/evm-known-spenders'
import { recognizedSpender, recognizedTypedDataSpender } from '../src/bun/evm-signing-preview'
import { decodeEIP712 } from '../src/bun/eip712-decoder'
import type { SigningRequestInfo } from '../src/shared/types'
import cowPermit from './fixtures/spenders/usdc-permit-cow-vaultrelayer.json'
import oneInchPermit2 from './fixtures/spenders/permit2-1inch-v6-unlimited.json'
import zeroExQuote from '../src/bun/erc7730-typed-data.fixtures.json'

const REQUESTS = join(import.meta.dir, '../../../docs/clearsign-case-studies/swapspro-20261029/requests')
const swapsPro = (name: string) => JSON.parse(readFileSync(join(REQUESTS, `${name}.json`), 'utf8'))
const STRANGER = '0x9999999999999999999999999999999999999999'
const MAX = (1n << 256n) - 1n
const word = (n: bigint) => n.toString(16).padStart(64, '0')
const withSpender = (data: string, spender: string) => data.slice(0, 10) + spender.slice(2).toLowerCase().padStart(64, '0') + data.slice(74)
const withAmount = (data: string, amount: bigint) => data.slice(0, 74) + word(amount)

/** The request as the REST/WalletConnect sign path builds it (offline: no service lookups). */
async function preview(body: any, data = body.data, fw = '7.16.0'): Promise<SigningRequestInfo> {
  const { prepareEvmTxSigningInfo } = await import('../src/bun/evm-presign-report')
  const chainId = Number(body.chainId)
  const original = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  try {
    const s = { id: 't', method: '/eth/sign-transaction', appName: 'swaps.pro', from: body.from, to: body.to, value: body.value, chainId, data, firmwareVersion: fw } as SigningRequestInfo
    await prepareEvmTxSigningInfo(s, { chainId, from: body.from, to: body.to, value: body.value, data }, fw)
    return s
  } finally { globalThis.fetch = original }
}

describe('swaps.pro approvals name the spender and read "check before you sign"', () => {
  const cases = [
    ['approve-cow-vaultrelayer', 'CoW', 'CoW Protocol Vault Relayer', '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110'],
    ['approve-0x-allowanceholder', '^0x', '0x AllowanceHolder', '0x0000000000001ff3684f28c67538d4d072c22734'],
    ['approve-lifi-diamond', '^LI.FI', 'LI.FI Diamond', '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'],
  ] as const
  for (const [file, route, name, spender] of cases) {
    test(`${file}: ${name}`, async () => {
      const req = swapsPro(file)
      // The capture's route label matches the spender it approved.
      expect(req.route).toBe(route)
      expect(`0x${req.body.data.slice(34, 74)}`).toBe(spender)
      const s = await preview(req.body)
      expect(s.recognizedSpender).toBe(name)
      const r = assessSigningRisk(s)!
      expect(r.level).toBe('medium')
      expect(r.reasons[0].text).toBe(`Lets ${name} (${spender}) spend up to 25,000 USDC, now and later, without asking you again.`)
      // The Spender row reads the same name, never "Unidentified address".
      expect(erc20Preview(s.to, s.chainId as number, s.data, s.recognizedSpender)?.counterpartyIdentity).toBe(name)
    })
  }

  test('a revoke (approve 0) to a recognised spender stays low', async () => {
    const req = swapsPro('approve-cow-vaultrelayer')
    expect(assessSigningRisk(await preview(req.body, withAmount(req.body.data, 0n)))!.level).toBe('low')
  })

  test('unlimited: high to a recognised spender, critical to one Desktop does not recognise', async () => {
    const req = swapsPro('approve-cow-vaultrelayer')
    const unlimited = withAmount(req.body.data, MAX)
    expect(assessSigningRisk(await preview(req.body, unlimited))!.level).toBe('high')
    const stranger = await preview(req.body, withSpender(unlimited, STRANGER))
    expect(stranger.recognizedSpender).toBeUndefined()
    expect(assessSigningRisk(stranger)!.level).toBe('critical')
    expect(erc20Preview(stranger.to, stranger.chainId as number, stranger.data, stranger.recognizedSpender)?.counterpartyIdentity).toBeUndefined()
  })

  test('the same spender on a chain it is not listed for is not recognised', async () => {
    const req = swapsPro('approve-cow-vaultrelayer')
    // Linea (59144) is not on CoW's deployment list.
    expect(recognizedSpender(59144, '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110')).toBeUndefined()
    // Odos uses a different router per chain: the Ethereum one is not Base's.
    expect(recognizedSpender(1, '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559')).toBe('Odos Router v2')
    expect(recognizedSpender(8453, '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559')).toBeUndefined()
    expect(req.body.chainId).toBe('0x1')
  })
})

describe('permits to recognised spenders use the same recognition', () => {
  const typed = (doc: any) => {
    const chainId = Number(doc.domain.chainId)
    const typedDataDecoded = decodeEIP712(doc)
    return {
      id: 't', method: '/eth/sign-typed-data', appName: 'dapp', chain: 'eth', from: doc.message.owner, chainId, firmwareVersion: '7.16.0',
      typedDataDecoded, recognizedSpender: recognizedTypedDataSpender(typedDataDecoded, chainId),
    } as SigningRequestInfo
  }
  const verify = (f: { typedData: any; signature: string }) => {
    const { EIP712Domain: _, ...types } = f.typedData.types
    return ethers.utils.verifyTypedData(f.typedData.domain, types, f.typedData.message, f.signature).toLowerCase()
  }

  test('fixtures are the documents that were signed on chain', () => {
    expect(verify(cowPermit)).toBe('0xa6601384d5053d7348801ee7675f7788071f8002')
    expect(verify(oneInchPermit2)).toBe('0x8fd7aa0ff1b2ceafcc31eb2c721141fb4d662b70')
  })

  test('USDC permit to the CoW Vault Relayer: named, bounded, medium', () => {
    const s = typed(cowPermit.typedData)
    expect(s.recognizedSpender).toBe('CoW Protocol Vault Relayer')
    const r = assessSigningRisk(s)!
    expect(r.level).toBe('medium')
    expect(r.reasons[0].text).toContain('Lets CoW Protocol Vault Relayer (0xc92e8bdf79f0507f65a392b0ab4667716bfe0110) spend up to ')
    // Control: the same permit to a spender Desktop does not recognise.
    const other = typed({ ...cowPermit.typedData, message: { ...cowPermit.typedData.message, spender: STRANGER } })
    expect(other.recognizedSpender).toBeUndefined()
    expect(assessSigningRisk(other)!.level).toBe('high')
  })

  test('unlimited Permit2 permit to the 1inch v6 router: named, high like an unlimited approve; to an unknown spender: danger', () => {
    const s = typed(oneInchPermit2.typedData)
    expect(s.recognizedSpender).toBe('1inch Aggregation Router v6')
    const r = assessSigningRisk(s)!
    expect(r.level).toBe('high')
    expect(r.reasons[0].text).toContain('Lets 1inch Aggregation Router v6 (0x111111125421ca6dc452d289314280a0f8842a65) spend ALL of ')
    const other = typed({ ...oneInchPermit2.typedData, message: { ...oneInchPermit2.typedData.message, spender: STRANGER } })
    expect(other.recognizedSpender).toBeUndefined()
    expect(assessSigningRisk(other)!.level).toBe('critical')
  })

  // A standing max Permit2 allowance is at least as strong as an unlimited
  // approve(): a Desktop-list name must not make it the quieter of the two.
  // Only certified name records (the Uniswap routers) get the Permit2 exemption.
  test('unlimited Permit2 to any Desktop-list spender reads high, never "check before you sign"', () => {
    const spenders: [string, string][] = [
      ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', 'LI.FI Diamond'],
      ['0xc92e8bdf79f0507f65a392b0ab4667716bfe0110', 'CoW Protocol Vault Relayer'],
      ['0x0000000000001ff3684f28c67538d4d072c22734', '0x AllowanceHolder'],
      ['0xdef1c0ded9bec7f1a1670819833240f027b25eff', '0x Exchange Proxy'],
      ['0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5', 'Across SpokePool'],
      ['0x6131b5fae19ea4f9d964eac0408e4408b66337b5', 'KyberSwap Meta Aggregation Router v2'],
      ['0x5567954cd026cebfe486062cb75848e0f1c12e58', 'Relay Approval Proxy'],
    ]
    for (const [spender, name] of spenders) {
      const s = typed({ ...oneInchPermit2.typedData, message: { ...oneInchPermit2.typedData.message, spender } })
      expect(s.recognizedSpender).toBe(name)
      const r = assessSigningRisk(s)!
      expect(`${name}: ${r.level}`).toBe(`${name}: high`)
      expect(r.reasons[0].text).toContain(`Lets ${name} (${spender}) spend ALL of `)
    }
  })

  test('a certified router keeps the Permit2 exemption: unlimited Permit2 to the Uniswap Universal Router reads medium', () => {
    const ur = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af'
    const s = typed({ ...oneInchPermit2.typedData, message: { ...oneInchPermit2.typedData.message, spender: ur } })
    expect(s.recognizedSpender).toMatch(/^Uniswap /)
    expect(assessSigningRisk(s)!.level).toBe('medium')
  })
})

describe('Relay Receiver is not a spender', () => {
  // Its only functions are forward() (native coin) and a solver-only
  // makeCalls(): no Relay flow approves it, so an allowance reads as unknown.
  test('a 25,000 USDC approve to the Relay Receiver is not named and reads high', async () => {
    const receiver = '0xa5f565650890fba1824ee0f21ebbbf660a179934'
    expect(knownSpenderName(1, receiver)).toBeUndefined()
    expect(knownSpenderName(143, '0xf17902d51fdff7bf50aacc78d6bb399baf88b479')).toBeUndefined()
    const req = swapsPro('approve-cow-vaultrelayer')
    const s = await preview(req.body, withSpender(req.body.data, receiver))
    expect(s.recognizedSpender).toBeUndefined()
    expect(assessSigningRisk(s)!.level).toBe('high')
    expect(erc20Preview(s.to, s.chainId as number, s.data, s.recognizedSpender)?.counterpartyIdentity).toBeUndefined()
  })
})

// The real 0x Swap API v2 permit2 quote on Base (0x-examples README, the
// fixture of the 2026-10-30 emulator leg "Generic EIP-712"): a one-time
// Permit2 PermitTransferFrom of 0.0001 WETH to 0x Settler deployment 9. It read
// red "Unknown or unusual" with the amount in raw units.
describe('0x Swap API permit2 quote', () => {
  const quote = zeroExQuote.typedData
  const typed = (doc: any, fw = '7.16.0') => {
    const chainId = Number(doc.domain.chainId)
    const typedDataDecoded = decodeEIP712(doc)
    return {
      id: 't', method: '/eth/sign-typed-data', appName: '0x', chain: 'eth', chainId, firmwareVersion: fw,
      typedDataDecoded, recognizedSpender: recognizedTypedDataSpender(typedDataDecoded, chainId),
    } as SigningRequestInfo
  }
  const with_ = (message: Record<string, unknown>) => ({ ...quote, message: { ...quote.message, ...message } })

  test('the fixture is the document 0x hashed', () => {
    const { EIP712Domain: _, ...types } = quote.types
    expect(ethers.utils._TypedDataEncoder.hash(quote.domain, types, quote.message)).toBe(zeroExQuote.zeroXPermit2Hash)
  })

  test('names the Settler and the WETH amount, and reads "check before you sign"', () => {
    const s = typed(quote)
    expect(s.recognizedSpender).toBe('0x Settler')
    const r = assessSigningRisk(s)!
    expect(r.level).toBe('medium')
    expect(r.tier).not.toBe('red')
    expect(r.reasons[0].text).toBe('Lets 0x Settler (0x6a57a0579e91a5b7ce9c2d08b93e1a9b995f974f) take up to 0.0001 WETH, once. This signature alone is enough; no transaction from you is needed.')
  })

  test('on 7.14.2, which cannot show it, the card is known (yellow) and still says the device cannot show it', () => {
    const r = assessSigningRisk(typed(quote, '7.14.2'))!
    expect(r.level).toBe('medium')
    expect(r.tier).toBe('yellow')
    expect(r.reasons.map((x) => x.text).join('\n')).toContain('KeepKey firmware 7.14.2 cannot show this Permit2 Signature Transfer on the device yet')
  })

  test('controls: a spender that is not a genuine Settler, and an unlimited one-time transfer, still read red', () => {
    const stranger = typed(with_({ spender: STRANGER }))
    expect(stranger.recognizedSpender).toBeUndefined()
    expect(assessSigningRisk(stranger)!.level).toBe('high')
    // The Settler of another chain is not this chain's Settler.
    expect(typed({ ...quote, domain: { ...quote.domain, chainId: 1 } }).recognizedSpender).toBeUndefined()
    // A Settler is never a spender for an allowance (0x: never approve Settler).
    expect(recognizedSpender(8453, quote.message.spender)).toBeUndefined()
    const all = typed(with_({ permitted: { ...quote.message.permitted, amount: MAX.toString() } }))
    expect(all.recognizedSpender).toBe('0x Settler')
    expect(assessSigningRisk(all)!.level).toBe('high')
  })
})

describe('Desktop spender list', () => {
  test('names each requested spender on Ethereum and Base', () => {
    const both: [string, string][] = [
      ['0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', 'CoW Protocol Vault Relayer'],
      ['0x0000000000001fF3684f28c67538d4D072C22734', '0x AllowanceHolder'],
      ['0xDef1C0ded9bec7F1a1670819833240f027b25EfF', '0x Exchange Proxy'],
      ['0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', 'LI.FI Diamond'],
      ['0x111111125421cA6dc452d289314280a0f8842A65', '1inch Aggregation Router v6'],
      ['0x6A000F20005980200259B80c5102003040001068', 'ParaSwap Augustus v6.2'],
      ['0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', 'KyberSwap Meta Aggregation Router v2'],
      ['0x5567954cd026cebfe486062cb75848e0f1c12e58', 'Relay Approval Proxy'],
      ['0xccc88a9d1b4ed6b0eaba998850414b24f1c315be', 'Relay Approval Proxy'],
    ]
    for (const chainId of [1, 8453]) for (const [a, name] of both) expect(knownSpenderName(chainId, a)).toBe(name)
    expect(knownSpenderName(8453, '0x19cEeAd7105607Cd444F5ad10dd51356436095a1')).toBe('Odos Router v2')
    expect(knownSpenderName(8453, '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64')).toBe('Across SpokePool')
    expect(knownSpenderName(1, '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5')).toBe('Across SpokePool')
  })

  test('GPv2Settlement is not a spender, and SwapDialog no longer calls it the Vault Relayer', () => {
    expect(knownSpenderName(1, '0x9008D19f58AAbD9eD0D60971565AA8510560ab41')).toBeUndefined()
    const src = readFileSync(join(import.meta.dir, '../src/mainview/components/SwapDialog.tsx'), 'utf8')
    expect(src).not.toMatch(/9008d19f58aabd9ed0d60971565aa8510560ab41[^\n]*Vault Relayer/i)
  })
})
