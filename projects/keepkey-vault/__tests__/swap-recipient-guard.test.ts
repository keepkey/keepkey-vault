import { expect, mock, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'

// Audit v4 H1: the swap payout recipient is checked in Bun, not only in the
// dialog. A zero/burn recipient never reaches Pioneer or the signer, and a
// Relay order must say it pays the address the user entered.
const SENDER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const RECIPIENT = '0x1111111111111111111111111111111111111111'
const REQUEST_ID = '0x' + 'ab'.repeat(32)
const depositNative = (requestId = REQUEST_ID) => '0x49290c1c' + SENDER.slice(2).toLowerCase().padStart(64, '0') + requestId.slice(2)

let quotes = 0
let relay: { requestId?: string; recipient?: string; data?: string } = {}
const pioneer = {
  GetAvailableAssets: async () => ({ data: [] }),
  // The shape api.keepkey.info returns for a Relay route (raw = Relay's own /quote body).
  Quote: async (params: any) => {
    quotes++
    return [{ integration: 'relay', quote: {
      source: 'relay', swapper: 'relay', amountOut: 0.0099, amountOutMin: 0.0098, buyAmount: 0.0099,
      txs: [{ type: 'EVM', chain: 'eip155:8453', txParams: {
        to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: relay.data ?? depositNative(), value: '10000000000000000',
        gasLimit: '32713', chainId: 8453, recipientAddress: '0x4cd00e387622c35bddb9b4c962c136462338bc31', senderAddress: params.senderAddress, amount: params.sellAmount,
      } }],
      relayRequestId: relay.requestId,
      raw: { requestId: relay.requestId, details: { sender: params.senderAddress, ...(relay.recipient === undefined ? {} : { recipient: relay.recipient }) } },
    } }]
  },
}
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => pioneer, getPioneerApiBase: () => 'https://fixture.invalid', getQueryKey: () => 'fixture' }))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: '/private/tmp/vault-swap-recipient-test' } } }))
mock.module('../src/bun/txbuilder', () => ({
  normalizeBchAddress: (address: string) => address,
  buildTx: async () => { throw new Error('fixture builder reached') },
}))
const { getSwapQuote, executeSwap } = await import('../src/bun/swap')

const quote = (toAddress: string) => getSwapQuote({
  fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:42161/slip44:60', amount: '0.01', fromAddress: SENDER, toAddress,
})

test('zero and burn recipients are refused before Pioneer is asked', async () => {
  quotes = 0
  for (const burn of ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dEaD', '0xdead000000000000000042069420694206942069']) {
    await expect(quote(burn)).rejects.toThrow(/burn address/i)
  }
  expect(quotes).toBe(0)
})

test('a burn recipient cannot reach signing through executeSwap either', async () => {
  const run = executeSwap({
    fromChainId: 'base', toChainId: 'arbitrum', fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:42161/slip44:60',
    amount: '0.01', memo: '', inboundAddress: '', expectedOutput: '0.0099',
    fromAddressOverride: SENDER, toAddressOverride: '0x0000000000000000000000000000000000000000',
  } as any, {
    wallet: {}, getAllChains: () => CHAINS, getEvmRpcSource: () => undefined,
    getBtcXpub: () => undefined, getAllBtcXpubs: () => [], wrapSign: (sign: any) => sign(), pushSubStage: () => {},
  } as any)
  await expect(run).rejects.toThrow(/burn address/i)
})

test('a Relay order that pays the entered recipient is returned with that recipient', async () => {
  relay = { requestId: REQUEST_ID, recipient: RECIPIENT }
  const result = await quote(RECIPIENT)
  expect(result.relayOrderRecipient).toBe(RECIPIENT)
  // EVM addresses compare case-insensitively.
  relay = { requestId: REQUEST_ID, recipient: RECIPIENT.toUpperCase().replace('0X', '0x') }
  expect((await quote(RECIPIENT)).relayOrderRecipient).toBeDefined()
})

test('a Relay order that pays someone else, or does not say, is refused', async () => {
  relay = { requestId: REQUEST_ID, recipient: '0x2222222222222222222222222222222222222222' }
  await expect(quote(RECIPIENT)).rejects.toThrow(/Relay.*0x2222222222222222222222222222222222222222.*not the recipient you entered/)
  relay = { requestId: REQUEST_ID }
  await expect(quote(RECIPIENT)).rejects.toThrow(/Relay did not say who this order pays/)
})

test('the Relay order checked must be the order the deposit calldata funds', async () => {
  relay = { requestId: '0x' + 'cd'.repeat(32), recipient: RECIPIENT }
  await expect(quote(RECIPIENT)).rejects.toThrow(/different Relay order/)
  relay = { recipient: RECIPIENT }
  await expect(quote(RECIPIENT)).rejects.toThrow(/different Relay order/)
})
