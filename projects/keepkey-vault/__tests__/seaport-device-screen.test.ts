/**
 * Review r3 (L2) on firmware PR #1035: with the KeepKey-certified Seaport
 * definition (batch 6-D) attached, a 7.17 KeepKey ends the review with its
 * own settlement screen, "Order summary" or WARNING. Desktop predicts it with
 * the firmware's rules (src/bun/seaport-settlement.ts) and the card says
 * "Your KeepKey will show WARNING: ..." above it, so it is never green over a
 * device WARNING.
 *
 * Real pieces: the OpenSea listing sold on mainnet
 * (seaport-opensea-listing-mainnet.json) and the 6-D TEST leaf; each mutant is
 * a phishing order or an order the device warns on. The expected lines are
 * the device's, from keepkey-firmware unittests/firmware/erc7730_settle.cpp
 * and python-keepkey tests/test_msg_ethereum_erc7730_settlement.py on the
 * emulator.
 */
import { describe, expect, test } from 'bun:test'
import { decodeEIP712 } from '../src/bun/eip712-decoder'
import { seaportDeviceScreen } from '../src/bun/seaport-settlement'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import type { SigningRequestInfo } from '../src/shared/types'
import seaport from './fixtures/typed-data/seaport-opensea-listing-mainnet.json'
import leaf from './fixtures/typed-data/seaport-6d-test-envelope.json'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const { address, typedData } = seaport.body
const NFT = typedData.message.offer[0].token
const ZERO = '0x0000000000000000000000000000000000000000'
const STRANGER = '0x00000000000000000000000000000000DeaDBeef'
const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
const LDO = '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const DCL_LAND = '0xF87E31492Faf9A91B02Ee0dEAAd50d51d56D5d4d'
const BIG_ID = '340282366920938463463374607431768211457' // 2^128 + 1
const catalog = { primaryDefinitionId: leaf.definition.definitionId, definitions: [leaf.definition] } as any

function request(td: any, attached = true): SigningRequestInfo {
  return {
    id: 't', method: '/eth/sign-typed-data', appName: 'test', chain: 'eth', from: address, firmwareVersion: '7.17.0',
    chainId: 1, typedDataDecoded: decodeEIP712(td, address), ...(attached ? { erc7730: catalog } : {}),
  }
}
const texts = (req: SigningRequestInfo) => assessSigningRisk(req)!.reasons.map((r) => r.text).join('\n')
const nft = (token: string, id: string, itemType = 2, amount = '1') => ({ itemType, token, identifierOrCriteria: id, startAmount: amount, endAmount: amount })
const paid = (startAmount: string, recipient = address, token = ZERO, itemType = 0) => ({ itemType, token, identifierOrCriteria: '0', startAmount, endAmount: startAmount, recipient })
function order(offer: any[], consideration: any[]) {
  const td = clone(typedData)
  td.message.offer = offer
  td.message.consideration = consideration
  return td
}

describe('the device settlement screen, predicted (firmware rules)', () => {
  test('a real listing: "Order summary", and the card stays green', () => {
    expect(seaportDeviceScreen(typedData, address)).toEqual({ warning: false, lines: [] })
    const req = request(typedData)
    expect(assessSigningRisk(req)!.tier).toBe('green')
    expect(texts(req)).not.toContain('Your KeepKey will show WARNING')
  })

  // Each row: the order, the device's warning lines (firmware unit test).
  const cases: Array<[string, any, string[]]> = [
    ['1 wei to this wallet (DustIsALineNotAPrice)', order([nft(NFT, '5318')], [paid('1')]),
      ['This wallet gets under 0.0001 ETH.']],
    // Desktop's own dust bar is a millionth of a coin; the device's is 0.0001.
    ['0.00005 ETH for the NFT: above Desktop\'s bar, under the device floor', order([nft(NFT, '5318')], [paid('50000000000000')]),
      ['This wallet gets under 0.0001 ETH.']],
    ['the payment redirected to a stranger', order([nft(NFT, '5318')], [paid('553407831900000000', STRANGER)]),
      ['Nothing in this order is paid to this wallet.']],
    ['three NFTs given (bundle)', order([nft(NFT, '1'), nft(NFT, '2'), nft(NFT, '3')], [paid('10000000000000000')]),
      ['This wallet gives more items than this screen lists.']],
    ['an ERC-721 naming stETH (never_nft), ID under 2^64', order([nft(STETH, '1000000000000000000')], [paid('10000000000000000')]),
      ['An NFT item names the token stETH: Seaport moves its ID as an amount of stETH.']],
    ['an ERC-721 naming WETH (table)', order([nft(WETH, '50000000000000000000')], [paid('10000000000000000')]),
      ['An NFT item names the token WETH: Seaport moves its ID as an amount of WETH.']],
    ['an ERC-721 ID of 2^64 or more on an unlisted contract', order([nft(LDO, BIG_ID)], [paid('10000000000000000')]),
      ['An NFT ID is 2^64 or more: if its contract is a token, Seaport moves that many units of it.']],
    ['an item given by criteria', order([nft(NFT, '0', 4)], [paid('10000000000000000')]),
      ['This wallet gives an item by criteria: the buyer picks its ID (on a token, the ID is an amount).']],
    ['an ERC-20 given that the table does not list', order([{ ...nft(LDO, '0', 1), startAmount: '5318', endAmount: '5318' }], [paid('10000000000000000')]),
      ['This wallet gives a token the device does not know: if it is an NFT collection, Seaport moves the NFT whose ID is the amount.']],
    ['an offer: WETH for an NFT', order([{ ...nft(WETH, '0', 1), startAmount: '500000000000000000', endAmount: '500000000000000000' }], [{ ...nft(NFT, '5318'), recipient: address }]),
      ['This wallet gets only unknown tokens or NFTs.']],
    ['2 WETH given, 2 ETH back (WETH nets as ETH)', order([nft(NFT, '5318'), { ...nft(WETH, '0', 1), startAmount: '2000000000000000000', endAmount: '2000000000000000000' }], [paid('2000000000000000000')]),
      ['This wallet gets back no more than it gives.']],
  ]
  for (const [name, td, lines] of cases) {
    test(`device WARNING: ${name}`, () => {
      expect(seaportDeviceScreen(td, address)).toEqual({ warning: true, lines })
      const req = request(td)
      expect(assessSigningRisk(req)!.tier).toBe('red')
      expect(texts(req)).toContain(`Your KeepKey will show WARNING: ${lines.join(' ')}`)
    })
  }

  test('the 0.00005 ETH listing: Desktop alone would read it as a normal listing', () => {
    const td = order([nft(NFT, '5318')], [paid('50000000000000')])
    expect(texts(request(td))).toContain('Seaport listing: sells')
    expect(assessSigningRisk(request(td, false))!.tier).toBe('green')
    // With the definition attached the device warns, so the card is red.
    expect(assessSigningRisk(request(td))!.tier).toBe('red')
  })

  test('hashed-ID collections are calm, as on the device: Decentraland LAND (2^128 + 1)', () => {
    const td = order([nft(DCL_LAND, BIG_ID)], [paid('10000000000000000')])
    expect(seaportDeviceScreen(td, address)).toEqual({ warning: false, lines: [] })
    // CONTROL: the same ID one contract over warns (row above).
  })

  test('the device floor by decimals: 0.01 USDC is at it, 0.009999 under it', () => {
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    expect(seaportDeviceScreen(order([nft(NFT, '5318')], [paid('10000', address, USDC, 1)]), address)).toEqual({ warning: false, lines: [] })
    expect(seaportDeviceScreen(order([nft(NFT, '5318')], [paid('9999', address, USDC, 1)]), address))
      .toEqual({ warning: true, lines: ['This wallet gets under 0.01 USDC.'] })
  })

  test('no definition attached: the device shows no settlement screen, so the card says nothing about one', () => {
    const td = order([nft(NFT, '5318')], [paid('1')])
    expect(texts(request(td, false))).not.toContain('Your KeepKey will show WARNING')
  })

  test('no prediction where the device refuses or the chain has no leaf', () => {
    expect(seaportDeviceScreen(order([nft(NFT, '5318', 6)], [paid('1')]), address)).toBeUndefined()
    const base = clone(typedData)
    base.domain.chainId = 8453
    expect(seaportDeviceScreen(base, address)).toBeUndefined()
  })
})
