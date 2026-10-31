/**
 * Typed-data orders and NFT marketplace approvals, from REAL requests:
 *   cow-order-swapspro-usdc-eth.json      swaps.pro CoW order, 25,000 USDC to ETH (2026-10-29 capture)
 *   seaport-opensea-listing-mainnet.json  an OpenSea listing sold on Ethereum; the OrderComponents
 *                                         hash matches the OrderFulfilled event and the signature
 *                                         recovers the seller (see its _source)
 *   seaport-opensea-listing-creator-fee-mainnet.json  the same, for a collection with a creator fee,
 *                                         with the collection's ERC-2981 royaltyInfo answer
 *   safetx-multisend-mainnet.json         an executed Safe MultiSend (python-keepkey eip712 corpus)
 *   setapprovalforall-opensea-conduit-pudgy.json  a mainnet setApprovalForAll to the OpenSea conduit
 * Each normal request reads named and calm; each mutant of it that a normal
 * dapp would not send stays loud.
 */
import { describe, expect, test } from 'bun:test'
import { decodeEIP712 } from '../src/bun/eip712-decoder'
import { buildTypedDataReport } from '../src/bun/evm-presign-report'
import { addSeaportCreatorFee } from '../src/bun/seaport-creator-fee'
import { addSeaportItemContracts, pioneerDecimals } from '../src/bun/seaport-item-contracts'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import { typedDataRows } from '../src/shared/typedDataRows'
import type { SigningRequestInfo } from '../src/shared/types'
import cow from './fixtures/typed-data/cow-order-swapspro-usdc-eth.json'
import seaport from './fixtures/typed-data/seaport-opensea-listing-mainnet.json'
import creatorFee from './fixtures/typed-data/seaport-opensea-listing-creator-fee-mainnet.json'
import safeMultiSend from './fixtures/typed-data/safetx-multisend-mainnet.json'
import nftApproval from './fixtures/nft/setapprovalforall-opensea-conduit-pudgy.json'
import pioneerAnswers from './fixtures/pioneer/token-decimals-20261031.json'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const OTHER = '0x1111111111111111111111111111111111111111'

function typedRequest(typedData: any, from: string, firmwareVersion = '7.16.0'): SigningRequestInfo {
  return {
    id: 't', method: '/eth/sign-typed-data', appName: 'test', chain: 'eth', from, firmwareVersion,
    chainId: Number(typedData.domain.chainId), typedDataDecoded: decodeEIP712(typedData, from),
  }
}
const texts = (req: SigningRequestInfo) => assessSigningRisk(req)!.reasons.map((r) => r.text).join('\n')

describe('CoW Protocol GPv2 order (swaps.pro capture)', () => {
  const { address, typedData } = cow.body

  test('the pinned settlement decodes in units, native ETH and this wallet', () => {
    const d = decodeEIP712(typedData, address)
    expect(d.isKnownType).toBe(true)
    expect(d.operationName).toBe('CoW Protocol Order')
    const v = (l: string) => d.fields.find((f) => f.label === l)?.value
    expect(v('Sell')).toBe('25,000 USDC')
    expect(v('Receive at least')).toBe('9.487278979799916817 ETH')
    expect(v('Buy Token')).toBe('ETH (native coin)')
    expect(v('Receiver')).toBe('This wallet')
    expect(v('Valid Until')).toBe('2026-10-29 21:15:00 UTC')
    expect(v('Order Kind')).toBe('sell')
    expect(v('Partially Fillable')).toBe('false')
    // The card keeps the signed value beside each reading.
    const rows = typedDataRows(d)
    expect(rows.find((r) => r.label === 'Sell')?.value).toBe('25,000 USDC (25000000000)')
    expect(rows.find((r) => r.label === 'Receiver')?.value).toBe('This wallet (0x9858EfFD232B4033E47d90003D41EC34EcaEda94)')
  })

  test('reads calm and named: green on 7.16, known on 7.14.2', () => {
    const risk = assessSigningRisk(typedRequest(typedData, address))!
    expect(risk.level).toBe('medium')
    expect(risk.tier).toBe('green')
    expect(texts(typedRequest(typedData, address))).toContain(
      'CoW Protocol swap order: sells 25,000 USDC for at least 9.487278979799916817 ETH, paid to this wallet, valid until 2026-10-29 21:15:00 UTC.')
    expect(assessSigningRisk(typedRequest(typedData, address, '7.14.2'))!.tier).toBe('yellow')
  })

  test('a zero receiver is the order owner', () => {
    const td = clone(typedData)
    td.message.receiver = '0x0000000000000000000000000000000000000000'
    expect(assessSigningRisk(typedRequest(td, address))!.tier).toBe('green')
  })

  test('mutant: the bought tokens go to another address', () => {
    const td = clone(typedData)
    td.message.receiver = OTHER
    const req = typedRequest(td, address)
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain(`The tokens bought go to ${OTHER}, which is NOT the account signing this`)
  })

  test('mutant: another verifying contract or an undeployed chain is not CoW', () => {
    const wrongContract = clone(typedData)
    wrongContract.domain.verifyingContract = OTHER
    const wrongChain = clone(typedData)
    wrongChain.domain.chainId = 324
    for (const td of [wrongContract, wrongChain]) {
      const d = decodeEIP712(td, address)
      expect(d.isKnownType).toBe(false)
      expect(texts(typedRequest(td, address))).not.toContain('CoW Protocol')
    }
  })
})

describe('Seaport 1.6 listing (OpenSea, mainnet)', () => {
  const { address, typedData } = seaport.body

  test('a normal listing reads named and calm, with the price', () => {
    const d = decodeEIP712(typedData, address)
    expect(d.operationName).toBe('Seaport 1.6 Order')
    expect(d.seaportListing?.total).toBe('0.55899781 ETH')
    const req = typedRequest(typedData, address)
    const risk = assessSigningRisk(req)!
    expect(risk.level).toBe('medium')
    expect(risk.tier).toBe('green')
    expect(texts(req)).toContain('Seaport listing: sells ERC-721 #5318 of collection 0x387C41B0B2F1128dE44dB1Bcf8baad085f26392C for 0.55899781 ETH. You receive 0.5534078319 ETH, and 0.0055899781 ETH goes to OpenSea\'s fee address.')
    expect(assessSigningRisk(typedRequest(typedData, address, '7.14.2'))!.tier).toBe('yellow')
  })

  test('mutant: the sale proceeds are paid to another address', () => {
    const td = clone(typedData)
    td.message.consideration[0].recipient = OTHER
    const req = typedRequest(td, address)
    expect(assessSigningRisk(req)!.level).toBe('critical')
    expect(texts(req)).toContain(`Pays 0.5534078319 ETH to ${OTHER}, which is neither the seller nor a marketplace fee address`)
  })

  test('mutant: the account signing is not the seller', () => {
    expect(assessSigningRisk(typedRequest(typedData, OTHER))!.level).toBe('critical')
  })

  // A phishing listing pays the seller nothing, or nothing anyone can value.
  const seller = (startAmount: string) => ({
    itemType: 0, token: '0x0000000000000000000000000000000000000000', identifierOrCriteria: '0', startAmount, endAmount: startAmount, recipient: address,
  })

  test('mutant: the seller is paid 1 wei', () => {
    const td = clone(typedData)
    td.message.consideration = [seller('1')]
    const req = typedRequest(td, address)
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain('Pays you only 0.000000000000000001 ETH for ERC-721 #5318')
  })

  test('mutant: the seller is paid 0', () => {
    const td = clone(typedData)
    td.message.consideration = [seller('0')]
    const req = typedRequest(td, address)
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain('Pays you nothing for ERC-721 #5318')
  })

  test('mutant: the seller\'s payment is 0 and only the OpenSea fee is left', () => {
    const td = clone(typedData)
    td.message.consideration[0].startAmount = td.message.consideration[0].endAmount = '0'
    const req = typedRequest(td, address)
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain('Pays you nothing for ERC-721 #5318')
  })

  test('mutant: paid in a token this computer cannot name', () => {
    const td = clone(typedData)
    for (const c of td.message.consideration) { c.itemType = 1; c.token = '0x3333333333333333333333333333333333333333' }
    const req = typedRequest(td, address)
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain('Paid in a token this computer cannot name (558997810000000000 base units of token 0x3333333333333333333333333333333333333333)')
  })

  test('mutant: not the pinned Seaport 1.6 deployment', () => {
    const td = clone(typedData)
    td.domain.verifyingContract = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC' // Seaport 1.5
    expect(decodeEIP712(td, address).isKnownType).toBe(false)
    expect(assessSigningRisk(typedRequest(td, address))!.level).toBe('critical')
  })
})

describe('Seaport 1.6 listing with a creator fee (OpenSea, mainnet)', () => {
  const { address, typedData } = creatorFee.body
  const { royaltyInfo } = creatorFee
  const CREATOR = royaltyInfo.decoded.receiver
  // The collection's recorded answer, only for the exact call it was read with.
  const chain = async (chainId: number, to: string, data: string) => {
    expect(chainId).toBe(1)
    expect(to).toBe(royaltyInfo._source.to)
    expect(data).toBe(royaltyInfo.data)
    return royaltyInfo.result
  }
  const looked = async (td: any, call = chain) => {
    const req = typedRequest(td, address)
    await addSeaportCreatorFee(req, call)
    return req
  }

  test('unchecked, the creator payee is unknown', () => {
    const req = typedRequest(typedData, address)
    expect(assessSigningRisk(req)!.level).toBe('critical')
    expect(texts(req)).toContain(`Pays 0.00105 ETH to ${CREATOR}, which is neither the seller nor a marketplace fee address`)
  })

  test('the collection\'s own royaltyInfo names it: calm, with the creator fee', async () => {
    const req = await looked(typedData)
    const risk = assessSigningRisk(req)!
    expect(risk.level).toBe('medium')
    expect(risk.tier).toBe('green')
    expect(texts(req)).toContain(`You receive 0.01974 ETH, and 0.00021 ETH goes to OpenSea's fee address, and 0.00105 ETH goes to the creator fee address the collection names on chain (${CREATOR}).`)
  })

  test('mutant: the "royalty" goes to another address', async () => {
    const td = clone(typedData)
    td.message.consideration[2].recipient = OTHER
    const req = await looked(td)
    expect(assessSigningRisk(req)!.level).toBe('critical')
    expect(texts(req)).toContain(`Pays 0.00105 ETH to ${OTHER}, which is neither`)
  })

  test('mutant: more than the collection\'s royalty goes to its creator (same price)', async () => {
    const td = clone(typedData)
    const [own, , creator] = td.message.consideration
    own.startAmount = own.endAmount = (BigInt(own.startAmount) - 10n ** 15n).toString()
    creator.startAmount = creator.endAmount = (BigInt(creator.startAmount) + 10n ** 15n).toString()
    const req = await looked(td)
    expect(assessSigningRisk(req)!.level).toBe('critical')
  })

  test('no answer from the collection: the payee stays unknown', async () => {
    const req = await looked(typedData, async () => { throw new Error('execution reverted') })
    expect(assessSigningRisk(req)!.level).toBe('critical')
  })

  // What Desktop met on the 2026-10-30 emulator leg: the default endpoint is
  // Pioneer, which serves no eth_call, so royaltyInfo could not be asked.
  const PIONEER_NO_ETH_CALL = async () => { throw new Error('Pioneer does not expose eth_call (server has no EvmReadRpc)') }

  test('royaltyInfo could not be asked: not danger, and the card says the payee was not checked', async () => {
    const req = await looked(typedData, PIONEER_NO_ETH_CALL)
    expect(req.typedDataDecoded?.seaportListing?.creatorFeeUnchecked).toBe(true)
    expect(req.typedDataDecoded?.seaportListing?.payments.map((p) => p.role)).toEqual(['offerer', 'opensea-fee', 'other'])
    const risk = assessSigningRisk(req)!
    expect(risk.level).toBe('medium')
    // Not green: this computer did not check who that payee is.
    expect(risk.tier).toBe('yellow')
    expect(risk.headline).toBe('Shown on your KeepKey, but this computer could not check one payee')
    expect(texts(req)).toContain('You receive 0.01974 ETH, and 0.00021 ETH goes to OpenSea\'s fee address.')
    expect(texts(req)).toContain(`Also pays 0.00105 ETH to ${CREATOR}. This computer could not ask the collection for its creator fee (ERC-2981 royaltyInfo), so it could not check that this is the creator fee address.`)
    expect(texts(req)).not.toContain('creator fee address the collection names on chain')
    expect(texts(req)).not.toContain('which is neither the seller nor a marketplace fee address')
  })

  test('CONTROL: royaltyInfo not asked, and the listing is not otherwise normal: still red', async () => {
    // Two different unknown payees: at most one can be the creator fee.
    const two = clone(typedData)
    two.message.consideration.push({ ...two.message.consideration[2], recipient: OTHER })
    two.message.totalOriginalConsiderationItems = String(two.message.consideration.length)
    const twoReq = await looked(two, PIONEER_NO_ETH_CALL)
    expect(twoReq.typedDataDecoded?.seaportListing?.creatorFeeUnchecked).toBe(true)
    expect(twoReq.typedDataDecoded?.seaportListing?.payments.filter((p) => p.role === 'other').length).toBe(2)
    expect(assessSigningRisk(twoReq)!.level).toBe('critical')
    // The seller is paid dust and the unknown payee takes the rest.
    const dust = clone(typedData)
    const [own, , creator] = dust.message.consideration
    creator.startAmount = creator.endAmount = (BigInt(creator.startAmount) + BigInt(own.startAmount) - 1n).toString()
    own.startAmount = own.endAmount = '1'
    const dustReq = await looked(dust, PIONEER_NO_ETH_CALL)
    expect(dustReq.typedDataDecoded?.seaportListing?.creatorFeeUnchecked).toBe(true)
    expect(assessSigningRisk(dustReq)!.level).toBe('critical')
    // The unknown payee takes as much as the seller gets: not a fee, stays high.
    const half = clone(typedData)
    const [own2, , creator2] = half.message.consideration
    const total = BigInt(own2.startAmount) + BigInt(creator2.startAmount)
    own2.startAmount = own2.endAmount = (total / 2n).toString()
    creator2.startAmount = creator2.endAmount = (total - total / 2n).toString()
    const halfReq = await looked(half, PIONEER_NO_ETH_CALL)
    expect(halfReq.typedDataDecoded?.seaportListing?.creatorFeeUnchecked).toBe(true)
    expect(assessSigningRisk(halfReq)!.level).toBe('critical')
    expect(assessSigningRisk(halfReq)!.tier).toBe('red')
  })

  // The unchecked payee takes `pct`% of the price, out of what the seller gets.
  const split = (pct: bigint) => {
    const td = clone(typedData)
    const [own, , creator] = td.message.consideration
    const total = td.message.consideration.reduce((sum: bigint, c: any) => sum + BigInt(c.startAmount), 0n)
    const take = total * pct / 100n
    own.startAmount = own.endAmount = (BigInt(own.startAmount) + BigInt(creator.startAmount) - take).toString()
    creator.startAmount = creator.endAmount = take.toString()
    return td
  }

  test('royaltyInfo not asked, on 7.14.2: yellow, not red', async () => {
    const req = typedRequest(typedData, address, '7.14.2')
    await addSeaportCreatorFee(req, PIONEER_NO_ETH_CALL)
    const risk = assessSigningRisk(req)!
    expect(risk.level).toBe('medium')
    expect(risk.tier).toBe('yellow')
    expect(risk.headline).toBe('Known, but your KeepKey cannot show it yet')
  })

  test('royaltyInfo not asked: up to 10% of the price, the most OpenSea lets a creator set, reads as an unchecked fee', async () => {
    const req = await looked(split(10n), PIONEER_NO_ETH_CALL)
    const risk = assessSigningRisk(req)!
    expect(risk.level).toBe('medium')
    expect(risk.tier).toBe('yellow')
    expect(texts(req)).toContain('This computer could not ask the collection for its creator fee')
  })

  test('mutant: royaltyInfo not asked, and the unchecked payee takes more than a creator fee can', async () => {
    for (const pct of [11n, 30n, 45n, 49n]) {
      const req = await looked(split(pct), PIONEER_NO_ETH_CALL)
      expect(req.typedDataDecoded?.seaportListing?.creatorFeeUnchecked).toBe(true)
      const risk = assessSigningRisk(req)!
      expect([pct, risk.level, risk.tier]).toEqual([pct, 'critical', 'red'])
      expect(texts(req)).toContain(`to ${CREATOR}, which is neither the seller nor a marketplace fee address`)
    }
  })
})

describe('setApprovalForAll to a marketplace operator', () => {
  const tx = nftApproval.body
  const request = (data: string): SigningRequestInfo => ({
    id: 't', method: '/eth/sign-transaction', appName: 'test', chain: 'eth',
    from: tx.from, to: tx.to, value: tx.value, data, chainId: 1, firmwareVersion: '7.16.0',
  })

  test('the OpenSea conduit is named, not danger', () => {
    const risk = assessSigningRisk(request(tx.data))!
    expect(risk.level).toBe('medium')
    expect(risk.tier).toBe('yellow')
    expect(risk.reasons[0].text).toContain('Standard marketplace setup: lets the OpenSea conduit (0x1e0049783f008a0085193e00003d00cd54003c71) move ALL of your NFTs')
  })

  test('the Blur ExecutionDelegate is named (same captured call, Blur operator)', () => {
    const blur = tx.data.replace('1e0049783f008a0085193e00003d00cd54003c71', '00000000000111abe46ff893f3b2fdf1f759a8a8')
    expect(assessSigningRisk(request(blur))!.reasons[0].text).toContain('lets the Blur ExecutionDelegate')
  })

  test('mutant: an operator this computer does not know stays danger', () => {
    const risk = assessSigningRisk(request(tx.data.replace('1e0049783f008a0085193e00003d00cd54003c71', OTHER.slice(2))))!
    expect(risk.level).toBe('critical')
    expect(risk.tier).toBe('red')
  })
})

describe('ClearSign report for typed data', () => {
  test('a level like a transaction, bound to the EIP-712 digest', () => {
    const { address, typedData } = seaport.body
    const shown = buildTypedDataReport(typedRequest(typedData, address))!
    expect(shown.protectionLevel).toBe('P4')
    expect(shown.descriptor.label).toBe('Seaport 1.6 Order')
    expect(shown.transactionFingerprint).toBe(seaport._source.checks.eip712Digest)
    // Older firmware: decoded here, not shown on the device.
    expect(buildTypedDataReport(typedRequest(typedData, address, '7.14.2'))!.protectionLevel).toBe('P2')
    const unknown = clone(cow.body.typedData)
    unknown.domain.verifyingContract = OTHER
    expect(buildTypedDataReport(typedRequest(unknown, cow.body.address, '7.14.2'))!.protectionLevel).toBe('P1')
  })

  test('a SafeTx whose call the device shows only as hex is not "ClearSign ready"', () => {
    const req = typedRequest(safeMultiSend.body.typedData, OTHER)
    expect(assessSigningRisk(req)!.tier).toBe('red')
    const report = buildTypedDataReport(req)!
    expect(report.protectionLevel).toBe('P1')
    expect(report.headline).not.toBe('KeepKey ClearSign ready')
  })
})

// What each Seaport item's token contract says it is, asked before approval
// (ERC-165 supportsInterface, ERC-20 decimals). Seaport moves an item by its
// type whatever the contract is: an ERC-721 item naming an ERC-20 moves "ID"
// units of it (review r1 on firmware PR #1035: USDe on mainnet, USDC on Base,
// below the device's 2^64 ID warning), and an ERC-20 item naming an NFT
// collection moves the NFT whose ID is the amount.
describe('Seaport item contracts (supportsInterface, decimals)', () => {
  const { address, typedData } = seaport.body
  const NFT = typedData.message.offer[0].token
  const USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3'
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const EOA = '0x2222222222222222222222222222222222222222'
  const SUPPORTS_721 = '0x01ffc9a780ac58cd00000000000000000000000000000000000000000000000000000000'
  const SUPPORTS_1155 = '0x01ffc9a7d9b67a2600000000000000000000000000000000000000000000000000000000'
  const DECIMALS = '0x313ce567'
  const word = (n: number) => '0x' + n.toString(16).padStart(64, '0')
  // Each contract's answers, as the chain gives them: an NFT collection says
  // ERC-721 and has no decimals(); an ERC-20 has no supportsInterface (revert)
  // and answers decimals(); an address with no code answers "0x".
  const contracts: Record<string, Record<string, string | Error>> = {
    [NFT.toLowerCase()]: { [SUPPORTS_721]: word(1), [SUPPORTS_1155]: word(0), [DECIMALS]: new Error('execution reverted') },
    [USDE.toLowerCase()]: { [SUPPORTS_721]: new Error('execution reverted'), [SUPPORTS_1155]: new Error('execution reverted'), [DECIMALS]: word(18) },
    [BASE_USDC.toLowerCase()]: { [SUPPORTS_721]: new Error('execution reverted'), [SUPPORTS_1155]: new Error('execution reverted'), [DECIMALS]: word(6) },
    [EOA.toLowerCase()]: { [SUPPORTS_721]: '0x', [SUPPORTS_1155]: '0x', [DECIMALS]: '0x' },
  }
  const calls: string[] = []
  const chain = async (_chainId: number, to: string, data: string) => {
    calls.push(`${to.toLowerCase()} ${data}`)
    const answer = contracts[to.toLowerCase()]?.[data]
    if (answer === undefined) throw new Error(`unexpected call ${to} ${data}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  // No decimals fallback unless a test passes one.
  const noFallback = async () => { throw new Error('no fallback in this test') }
  const asked = async (td: any, call = chain, decimals: (c: number, t: string) => Promise<number | null> = noFallback) => {
    const req = typedRequest(td, address, '7.17.0')
    await addSeaportItemContracts(req, call, decimals)
    return req
  }
  const withOffer = (item: any, chainId = 1) => {
    const td = clone(typedData)
    td.domain.chainId = chainId
    td.message.offer = [{ ...td.message.offer[0], ...item }]
    return td
  }

  test('a normal listing: its NFT says ERC-721, the card stays calm', async () => {
    calls.length = 0
    const req = await asked(typedData)
    expect(calls.sort()).toEqual([DECIMALS, SUPPORTS_1155, SUPPORTS_721].map((d) => `${NFT.toLowerCase()} ${d}`).sort())
    expect(req.typedDataDecoded?.seaportItems?.[0]).toMatchObject({ side: 'offer', itemType: 2, erc721: true, erc1155: false })
    const risk = assessSigningRisk(req)!
    expect(risk.tier).toBe('green')
    expect(texts(req)).not.toContain('answers like an ERC-20')
    expect(texts(req)).not.toContain('could not ask the contracts')
  })

  test('review r1: an ERC-721 item naming USDe (10,000 USDe as ID 10^22) is red', async () => {
    const req = await asked(withOffer({ token: USDE, identifierOrCriteria: '10000000000000000000000' }))
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain(`Offer 1 is an ERC-721 NFT item, but ${USDE} answers like an ERC-20 token (decimals 18): Seaport would move the NFT ID as that many token units.`)
    // Never also read as a normal listing.
    expect(texts(req)).not.toContain('Seaport listing: sells')
    expect(texts(req)).toContain('This is a marketplace order.')
  })

  test('review r1: an ERC-721 item naming USDC on Base (ID 10^10, under 2^64) is red', async () => {
    const req = await asked(withOffer({ token: BASE_USDC, identifierOrCriteria: '10000000000' }, 8453))
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain(`Offer 1 is an ERC-721 NFT item, but ${BASE_USDC} answers like an ERC-20 token (decimals 6)`)
  })

  test('an NFT item naming an address with no contract is red', async () => {
    const req = await asked(withOffer({ token: EOA }))
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain(`Offer 1 is an ERC-721 NFT item, but ${EOA} does not say it is an ERC-721 contract.`)
  })

  test('an ERC-1155 item naming an ERC-721 collection is red', async () => {
    const req = await asked(withOffer({ itemType: 3, amount: undefined }))
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain(`Offer 1 is an ERC-1155 NFT item, but ${NFT} does not say it is an ERC-1155 contract.`)
  })

  test('an ERC-20 item naming an NFT collection is red (moves the NFT whose ID is the amount)', async () => {
    const req = await asked(withOffer({ itemType: 1, identifierOrCriteria: '0', startAmount: '5318', endAmount: '5318' }))
    expect(assessSigningRisk(req)!.level).toBe('critical')
    expect(texts(req)).toContain(`Offer 1 is an ERC-20 token item, but ${NFT} is an NFT collection: Seaport would move the NFT whose ID is the amount.`)
  })

  test('the contracts could not be asked: the card says so and invents nothing', async () => {
    const req = await asked(typedData, async () => { throw new Error('Pioneer does not expose eth_call (server has no EvmReadRpc)') })
    expect(req.typedDataDecoded?.seaportItems?.[0]).toMatchObject({ unchecked: true })
    expect(req.typedDataDecoded?.seaportItems?.[0].erc721).toBeUndefined()
    expect(texts(req)).toContain('This computer could not ask the contracts in this order whether they are NFTs or tokens, so it could not check them.')
    // The same attack, unasked: no red line for it either way (only what is known).
    const attack = await asked(withOffer({ token: USDE }), async () => { throw new Error('timeout') })
    expect(texts(attack)).not.toContain('answers like an ERC-20')
  })

  test('review r2: not asked at all (no read made) is not checked either, and the card says so', () => {
    const req = typedRequest(withOffer({ token: USDE }), address, '7.17.0')
    expect(texts(req)).toContain('This computer could not ask the contracts in this order whether they are NFTs or tokens, so it could not check them.')
    // Nothing is invented about the contract.
    expect(texts(req)).not.toContain('answers like an ERC-20')
  })

  test('review r2: an ERC-721 item naming a hybrid (ERC-404: ERC-721 and decimals 18) is red', async () => {
    const HYBRID = '0x9E9FbDE7C7a83c43913BddC8779158F1368F0413' // Pandora (ERC-404) on mainnet
    contracts[HYBRID.toLowerCase()] = { [SUPPORTS_721]: word(1), [SUPPORTS_1155]: word(0), [DECIMALS]: word(18) }
    const req = await asked(withOffer({ token: HYBRID, identifierOrCriteria: '1000000000000000000' }))
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain(`Offer 1 is an ERC-721 NFT item, but ${HYBRID} also answers like an ERC-20 token (decimals 18): Seaport could move the NFT ID as that many token units.`)
    expect(texts(req)).not.toContain('Seaport listing: sells')
    // CONTROL: an NFT contract with decimals() 0 (some answer it) is not a token.
    contracts[HYBRID.toLowerCase()][DECIMALS] = word(0)
    const zero = await asked(withOffer({ token: HYBRID, identifierOrCriteria: '7' }))
    expect(texts(zero)).not.toContain('also answers like an ERC-20')
  })

  test('LIMIT: a contract older than final ERC-721 (CryptoKitties says only its draft 0x9a20483d) reads red', async () => {
    // A stated limit: the line is true (it does not say ERC-721), and red is the safe side.
    const KITTIES = '0x06012c8cf97BEaD5deAe237070F9587f8E7A266d'
    contracts[KITTIES.toLowerCase()] = { [SUPPORTS_721]: word(0), [SUPPORTS_1155]: word(0), [DECIMALS]: new Error('execution reverted') }
    const req = await asked(withOffer({ token: KITTIES, identifierOrCriteria: '1' }))
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain(`Offer 1 is an ERC-721 NFT item, but ${KITTIES} does not say it is an ERC-721 contract.`)
  })

  // Review r3 (M1): production Pioneer (api.keepkey.info) has no EvmReadRpc,
  // so supportsInterface throws there and every item read "unchecked" on the
  // default path. Pioneer's GetTokenDecimals works live: an NFT item whose
  // contract answers decimals() > 0 is red. Real answers
  // (fixtures/pioneer/token-decimals-20261031.json), replayed in
  // pioneer-client's shape (a non-2xx answer throws with .status and
  // .response.body).
  const noEvmReadRpc = async () => { throw new Error('PIONEER_UNSUPPORTED eth_call (server has no EvmReadRpc)') }
  const livePioneer = {
    GetTokenDecimals: async ({ networkId, contractAddress }: { networkId: string; contractAddress: string }) => {
      const answer = pioneerAnswers.answers.find((a) => a.networkId === networkId && a.contractAddress === contractAddress)
      if (!answer) throw new Error(`no recorded answer for ${networkId} ${contractAddress}`)
      if (answer.status === 200) return { data: answer.body }
      throw Object.assign(new Error('Not Found'), { status: answer.status, statusCode: answer.status, response: { body: answer.body } })
    },
  }
  const production = pioneerDecimals(livePioneer)

  test('review r3: on production Pioneer a normal listing is checked by decimals and stays green', async () => {
    const req = await asked(typedData, noEvmReadRpc, production)
    expect(req.typedDataDecoded?.seaportItems?.[0]).toMatchObject({ itemType: 2, decimalsOnly: true })
    expect(req.typedDataDecoded?.seaportItems?.[0].decimals).toBeUndefined()
    expect(assessSigningRisk(req)!.tier).toBe('green')
    expect(texts(req)).not.toContain('could not ask the contracts')
    expect(texts(req)).toContain('This computer asked the contracts in this order only for ERC-20 decimals(), not which NFT standard they follow.')
  })

  test('review r3: on production Pioneer an ERC-721 item naming USDe or stETH is red', async () => {
    for (const [token, decimals] of [[USDE, 18], ['0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', 18]] as const) {
      const req = await asked(withOffer({ token, identifierOrCriteria: '10000000000000000000' }), noEvmReadRpc, production)
      expect(assessSigningRisk(req)!.tier).toBe('red')
      expect(texts(req)).toContain(`Offer 1 is an ERC-721 NFT item, but ${token} answers like an ERC-20 token (decimals ${decimals}): Seaport would move the NFT ID as that many token units.`)
      expect(texts(req)).not.toContain('Seaport listing: sells')
    }
    // ERC-1155, and USDC on Base (ID 10^10, under the device's 2^64).
    const erc1155 = await asked(withOffer({ itemType: 3, token: USDE }), noEvmReadRpc, production)
    expect(texts(erc1155)).toContain(`Offer 1 is an ERC-1155 NFT item, but ${USDE} answers like an ERC-20 token (decimals 18).`)
    const base = await asked(withOffer({ token: BASE_USDC, identifierOrCriteria: '10000000000' }, 8453), noEvmReadRpc, production)
    expect(texts(base)).toContain(`Offer 1 is an ERC-721 NFT item, but ${BASE_USDC} answers like an ERC-20 token (decimals 6)`)
  })

  test('review r3: CONTROLS on production Pioneer: decimals 0 (Decentraland LAND) and none (BAYC) are not tokens', async () => {
    for (const token of ['0xF87E31492Faf9A91B02Ee0dEAAd50d51d56D5d4d', '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D']) {
      const req = await asked(withOffer({ token }), noEvmReadRpc, production)
      expect(texts(req)).not.toContain('answers like an ERC-20')
      expect(texts(req)).not.toContain('could not ask the contracts')
    }
  })

  test('review r3: decimals alone cannot clear an ERC-20 item: one naming BAYC is not checked, and says so', async () => {
    const req = await asked(withOffer({ itemType: 1, token: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', identifierOrCriteria: '0', startAmount: '5318', endAmount: '5318' }), noEvmReadRpc, production)
    expect(texts(req)).toContain('This computer could not ask the contracts in this order whether they are NFTs or tokens, so it could not check them.')
    expect(texts(req)).not.toContain('is an NFT collection')
  })

  test('review r3: neither read works (Pioneer errors too): could not be checked, nothing invented', async () => {
    const down = pioneerDecimals({ GetTokenDecimals: async () => { throw Object.assign(new Error('Internal Server Error'), { status: 500, response: { body: { success: false } } }) } })
    const req = await asked(withOffer({ token: USDE }), noEvmReadRpc, down)
    expect(req.typedDataDecoded?.seaportItems?.[0]).toMatchObject({ unchecked: true })
    expect(texts(req)).toContain('This computer could not ask the contracts in this order whether they are NFTs or tokens, so it could not check them.')
    expect(texts(req)).not.toContain('answers like an ERC-20')
    // A 404 that is not Pioneer's CONTRACT_NOT_FOUND is no answer either.
    const lost = pioneerDecimals({ GetTokenDecimals: async () => { throw Object.assign(new Error('Not Found'), { status: 404, response: { body: 'no route' } }) } })
    expect((await asked(withOffer({ token: USDE }), noEvmReadRpc, lost)).typedDataDecoded?.seaportItems?.[0]).toMatchObject({ unchecked: true })
  })

  test('a Seaport BulkOrder is red, with a plain reason', () => {
    const td = clone(typedData)
    td.types.BulkOrder = [{ name: 'tree', type: 'OrderComponents[2]' }]
    td.primaryType = 'BulkOrder'
    td.message = { tree: [typedData.message, typedData.message] }
    const req = typedRequest(td, address, '7.17.0')
    expect(assessSigningRisk(req)!.tier).toBe('red')
    expect(texts(req)).toContain('This is a Seaport bulk order: one signature for a whole tree of orders. Your KeepKey does not check who is paid in a bulk order')
    // CONTROL: the plain order has no such line.
    expect(texts(typedRequest(typedData, address, '7.17.0'))).not.toContain('bulk order')
  })
})
