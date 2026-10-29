/**
 * Typed-data orders and NFT marketplace approvals, from REAL requests:
 *   cow-order-swapspro-usdc-eth.json      swaps.pro CoW order, 25,000 USDC to ETH (2026-10-29 capture)
 *   seaport-opensea-listing-mainnet.json  an OpenSea listing sold on Ethereum; the OrderComponents
 *                                         hash matches the OrderFulfilled event and the signature
 *                                         recovers the seller (see its _source)
 *   setapprovalforall-opensea-conduit-pudgy.json  a mainnet setApprovalForAll to the OpenSea conduit
 * Each normal request reads named and calm; each mutant of it that a normal
 * dapp would not send stays loud.
 */
import { describe, expect, test } from 'bun:test'
import { decodeEIP712 } from '../src/bun/eip712-decoder'
import { buildTypedDataReport } from '../src/bun/evm-presign-report'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import { typedDataRows } from '../src/shared/typedDataRows'
import type { SigningRequestInfo } from '../src/shared/types'
import cow from './fixtures/typed-data/cow-order-swapspro-usdc-eth.json'
import seaport from './fixtures/typed-data/seaport-opensea-listing-mainnet.json'
import nftApproval from './fixtures/nft/setapprovalforall-opensea-conduit-pudgy.json'

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

  test('mutant: not the pinned Seaport 1.6 deployment', () => {
    const td = clone(typedData)
    td.domain.verifyingContract = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC' // Seaport 1.5
    expect(decodeEIP712(td, address).isKnownType).toBe(false)
    expect(assessSigningRisk(typedRequest(td, address))!.level).toBe('critical')
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
})
