import { describe, expect, test } from 'bun:test'
import { parseQuoteResponse, assertRelayOrderRecipient } from '../src/bun/swap-parsing'
import { CHAINS } from '../src/shared/chains'
import { validateAddress } from '../src/shared/address-validation'

const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const router = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const requestId = '0x' + 'ab'.repeat(32)
const depositId = 'cd'.repeat(32)
const data = '0x49290c1c' + sender.slice(2).padStart(64, '0') + depositId
const params = { fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:1/slip44:60', slippageBps: 300 }
function response() {
  const tx = { to: router, data, value: '6315000000000000', chainId: 8453 }
  return { integration: 'relay', quote: {
    source: 'relay', swapper: 'Relay', amountOut: '0.0062', amountOutMin: '0.006',
    relayRequestId: requestId,
    txs: [{ type: 'EVM', chain: 'eip155:8453', txParams: { ...tx, gasLimit: '32713', senderAddress: sender, recipientAddress: router } }],
    raw: { requestId, details: { recipient }, steps: [{ id: 'deposit', requestId, items: [{
      data: { ...tx, from: sender }, check: { endpoint: '/intents/status?requestId=' + requestId },
    }] }] },
  } }
}
const parse = (r = response()) => parseQuoteResponse([r], params)

describe('Relay tracking id and deposit id are separate', () => {
  test('accepts the observed live quote shape while binding its source transaction and recipient', () => {
    const quote = parse()
    expect(assertRelayOrderRecipient(quote, recipient)).toBe(recipient)
    expect(quote.relayOrder?.requestId).toBe(requestId)
    expect(quote.relayOrder?.deposit?.data.slice(-64)).toBe(depositId)
  })
  test.each(['to', 'data', 'value', 'chainId'] as const)('refuses changed normalized %s even with the correct payout address', field => {
    const r = response()
    Object.assign(r.quote.txs[0].txParams, { [field]: {
      to: recipient, data: data.slice(0,-64) + 'ef'.repeat(32), value: '6315000000000001', chainId: 1,
    }[field] })
    expect(() => assertRelayOrderRecipient(parse(r), recipient)).toThrow(/different Relay order/)
  })
  test('still refuses a different payout recipient', () => {
    const quote = parse()
    expect(() => assertRelayOrderRecipient(quote, sender)).toThrow(/not the recipient/)
  })
  test('a checksummed bech32 spelling cannot hide a different Solana payout key', () => {
    const address = 'maya1quvzjwjtt3kharaqk8pd8e84qctjsw22wqttrm'
    const solana = CHAINS.find(chain => chain.id === 'solana')!
    expect(validateAddress(address, solana).valid).toBe(true)
    expect(validateAddress(address.toUpperCase(), solana).valid).toBe(true)
    const r = response()
    r.quote.raw.details.recipient = address.toUpperCase()
    const quote = parseQuoteResponse([r], { ...params, toCaip: solana.caip })
    expect(() => assertRelayOrderRecipient(quote, address, solana)).toThrow(/not the recipient/)
    expect(() => assertRelayOrderRecipient(quote, address)).toThrow(/not the recipient/)
    expect(assertRelayOrderRecipient(quote, address.toUpperCase(), solana)).toBe(address.toUpperCase())
  })
  test('known Bitcoin destinations retain valid uppercase bech32 equivalence', () => {
    const address = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
    const bitcoin = CHAINS.find(chain => chain.id === 'bitcoin')!
    const r = response()
    r.quote.raw.details.recipient = address.toUpperCase()
    const quote = parseQuoteResponse([r], { ...params, toCaip: bitcoin.caip })
    expect(assertRelayOrderRecipient(quote, address, bitcoin)).toBe(address.toUpperCase())
    expect(() => assertRelayOrderRecipient(quote, address)).toThrow(/not the recipient/)
  })
  test('still refuses missing payout details', () => {
    const r = response()
    delete (r.quote.raw.details as any).recipient
    expect(() => assertRelayOrderRecipient(parse(r), recipient)).toThrow(/did not say who/)
  })
  test('ambiguous or missing raw transactions fail closed', () => {
    for (const count of [0, 2]) {
      const r = response()
      r.quote.raw.steps[0].items = Array.from({ length: count }, () => r.quote.raw.steps[0].items[0])
      expect(() => assertRelayOrderRecipient(parse(r), recipient)).toThrow(/different Relay order/)
    }
  })
  test('an approval step does not change the bound deposit', () => {
    const r = response()
    r.quote.raw.steps.unshift({ ...structuredClone(r.quote.raw.steps[0]), id: 'approve' })
    expect(assertRelayOrderRecipient(parse(r), recipient)).toBe(recipient)
  })
  test('raw chain and amount must be explicit, not guessed', () => {
    for (const field of ['value', 'chainId']) {
      const r = response()
      delete (r.quote.raw.steps[0].items[0].data as any)[field]
      expect(() => assertRelayOrderRecipient(parse(r), recipient)).toThrow(/different Relay order/)
    }
  })
})

describe('Relay from non-EVM sources (audit v8 N3)', () => {
  test('a Solana-source order has no calldata to bind and is checked by recipient only', () => {
    const r: any = response()
    r.quote.txs = [{ type: 'SOLANA', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', txParams: { serializedTx: 'AQID', recipientAddress: 'SoLRelayDeposit1111111111111111111111111111' } }]
    r.quote.raw.steps = [{ id: 'deposit', requestId, items: [{ data: { instructions: [] } }] }]
    const quote = parseQuoteResponse([r], { ...params, fromCaip: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501' })
    expect(assertRelayOrderRecipient(quote, recipient)).toBe(recipient)
  })
  test('a string chainId from the provider still binds an EVM deposit', () => {
    const r: any = response()
    r.quote.raw.steps[0].items[0].data.chainId = '8453'
    expect(assertRelayOrderRecipient(parse(r), recipient)).toBe(recipient)
  })
})
