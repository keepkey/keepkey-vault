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
import { HASHED_ID, seaportDeviceScreen } from '../src/bun/seaport-settlement'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import type { SigningRequestInfo } from '../src/shared/types'
import seaport from './fixtures/typed-data/seaport-opensea-listing-mainnet.json'
import leaf from './fixtures/typed-data/seaport-6d-test-envelope.json'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const { address, typedData } = seaport.body
const NFT = typedData.message.offer[0].token
const ZERO = '0x0000000000000000000000000000000000000000'
const STRANGER = '0x00000000000000000000000000000000DeaDBeef'
const OPENSEA_FEE = '0x0000a26b00c1f0df003000390027140000faa719'
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

  // Review r4 (MEDIUM): the r3 list was hand-picked. These eight are the
  // chain-1 ERC-721s with the most Seaport 1.6 listings moving IDs of 2^64 or
  // more over blocks 26263701-26313700 (keepkey-firmware
  // ReviewR4HashedIdCollectionsFromRealFills); each ID is one a real listing
  // sold. Each row's CONTROL: the same order without the entry in HASHED_ID
  // gets the 2^64 line.
  const REAL_FILLS: Array<[string, string, string]> = [
    ['ENS Commemorative', '0x20262e3433306a4FF250a64d20a8E0F09B2C7F68', '48003397463042151135054429093830131708341549242837490818085529917933067218499'],
    ['Unetwork Operator Software License', '0x0bfa9AFF76FD91756F837Ab47e11BD99e04C15bD', '45765913844595258193548228240877806238768789230531599317817665566485529869688'],
    ['Gucci', '0x572E33FFa523865791aB1C26B42a86aC244Df784', '340282366920938542673693659940582850561'],
    ['Zer0 Name Service (0x51bd)', '0x51bd5948CF84a1041d2720F56DEd5e173396FC95', '79568353643888327899854263340736167261659053454504344533191743950653442050388'],
    ['Zer0 Name Service (0x05f8)', '0x05F81F870cBca79E9171f22886b58b5597A603AA', '18892894410978774248890299786202284410728464348118729900929399131199752586985'],
    ['OKX AI NFT', '0x741512954Cb6f8e5d3cD9321c07462b05B7cC8D5', '48946210978007337916061731105535069646541815001795534346996811128657017831425'],
    ['Zero Name Service (0xc2e9)', '0xc2e9678A71e50E5AEd036e00e9c5caeb1aC5987D', '58041909196144185922593705252084154663034532091665909167609340436044583769244'],
    ['Rarible (0xc915)', '0xc9154424B823b10579895cCBE442d41b9Abd96Ed', '2826039867819840215306711511831437299585336968281979299548049622915281322105'],
  ]
  for (const [name, token, id] of REAL_FILLS) {
    test(`hashed-ID collection from real fills is calm: ${name}`, () => {
      const td = order([nft(token, id)], [paid('50000000000000000'), paid('1250000000000000', OPENSEA_FEE)])
      expect(seaportDeviceScreen(td, address)).toEqual({ warning: false, lines: [] })
      const key = `1:${token.toLowerCase()}`
      expect(HASHED_ID.has(key)).toBe(true)
      HASHED_ID.delete(key)
      try {
        expect(seaportDeviceScreen(td, address)!.lines)
          .toEqual(['An NFT ID is 2^64 or more: if its contract is a token, Seaport moves that many units of it.'])
      } finally { HASHED_ID.add(key) }
    })
  }

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

  // Review r4 (LOW): the firmware's table answers 0xEeee as ETH on chain 1, so
  // its 2^64 line skips it like any coin; only the placeholder line shows
  // (keepkey-firmware ReviewAnNftItemNamingThePlaceholderSaysWhatItIs).
  test('an ERC-721 naming 0xEeee with an ID of 2^64 or more: the placeholder line only, as on the device', () => {
    const EEEE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
    const td = order([nft(EEEE, BIG_ID)], [paid('10000000000000000')])
    expect(seaportDeviceScreen(td, address)).toEqual({ warning: true, lines: [
      "An NFT item names 0xEeee...EEeE, the native coin's placeholder: it is not an NFT contract."] })
    expect(assessSigningRisk(request(td))!.tier).toBe('red')
    // CONTROL: the same ID on an unlisted contract gets the 2^64 line.
    expect(seaportDeviceScreen(order([nft(LDO, BIG_ID)], [paid('10000000000000000')]), address)!.lines)
      .toEqual(['An NFT ID is 2^64 or more: if its contract is a token, Seaport moves that many units of it.'])
  })

  // Review r4 (LOW): off chain 1 the card said nothing about the device's last
  // screen; it now says it does not predict it.
  test('another chain: the card says plainly it does not predict the device screen', () => {
    const NOT_PREDICTED = 'This computer does not predict your KeepKey\'s last screen for this order ("Order summary" or WARNING) on chain 8453: it predicts it only on Ethereum (chain 1).'
    const td = clone(typedData)
    td.domain.chainId = 8453
    expect(seaportDeviceScreen(td, address)).toBeUndefined()
    const req = { ...request(td), chainId: 8453, chain: 'base' }
    expect(texts(req)).toContain(NOT_PREDICTED)
    // CONTROL: on chain 1 it is predicted, and the line is not there.
    expect(texts(request(typedData))).not.toContain('does not predict your KeepKey')
  })

  test('no prediction where the device refuses or the chain has no leaf', () => {
    expect(seaportDeviceScreen(order([nft(NFT, '5318', 6)], [paid('1')]), address)).toBeUndefined()
    const base = clone(typedData)
    base.domain.chainId = 8453
    expect(seaportDeviceScreen(base, address)).toBeUndefined()
  })
})
