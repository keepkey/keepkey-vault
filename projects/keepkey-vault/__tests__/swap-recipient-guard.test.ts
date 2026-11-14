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
let relay: { requestId?: string; recipient?: string; data?: string; integration?: string; totalBps?: number } = {}
const pioneer = {
  GetAvailableAssets: async () => ({ data: [] }),
  // The shape api.keepkey.info returns for a Relay route (raw = Relay's own /quote body).
  Quote: async (params: any) => {
    quotes++
    return [{ integration: relay.integration ?? 'relay', quote: {
      source: 'relay', swapper: 'relay', amountOut: 0.0099, amountOutMin: 0.0098, buyAmount: 0.0099,
      txs: [{ type: 'EVM', chain: 'eip155:8453', txParams: {
        to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: relay.data ?? depositNative(), value: '10000000000000000',
        gasLimit: '32713', chainId: 8453, recipientAddress: '0x4cd00e387622c35bddb9b4c962c136462338bc31', senderAddress: params.senderAddress, amount: params.sellAmount,
      } }],
      relayRequestId: relay.requestId,
      ...(relay.totalBps === undefined ? {} : { fees: { total_bps: relay.totalBps } }),
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

test('a ShapeShift route that Relay fills is not held to a Relay /quote body it does not carry', async () => {
  // ShapeShift's Relay sub-route has no Relay /quote body in raw, so there is no
  // order to check. Refusing it broke every ShapeShift-via-Relay swap.
  relay = { integration: 'shapeshiftSwap' }
  const result = await quote(RECIPIENT)
  expect(result.relayOrder).toBeUndefined()
  expect(result.relayTx?.data).toBe(depositNative())
})

test('a recipient that is not a valid address for the destination network is refused before Pioneer is asked (V3)', async () => {
  quotes = 0
  relay = { requestId: REQUEST_ID, recipient: RECIPIENT }
  // EIP-55 checksum mismatch (one mistyped case), a .eth name, and a BTC address for an EVM output.
  for (const bad of ['0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'vitalik.eth', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4']) {
    await expect(quote(bad)).rejects.toThrow(/not a valid address/i)
  }
  expect(quotes).toBe(0)
  // All-lowercase EVM addresses carry no checksum and stay valid.
  await expect(quote(RECIPIENT)).resolves.toBeDefined()
})

test('executeSwap refuses an invalid recipient override too (V3)', async () => {
  const run = executeSwap({
    fromChainId: 'base', toChainId: 'arbitrum', fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:42161/slip44:60',
    amount: '0.01', memo: '', inboundAddress: '', expectedOutput: '0.0099',
    fromAddressOverride: SENDER, toAddressOverride: '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  } as any, {
    wallet: {}, getAllChains: () => CHAINS, getEvmRpcSource: () => undefined,
    getBtcXpub: () => undefined, getAllBtcXpubs: () => [], wrapSign: (sign: any) => sign(), pushSubStage: () => {},
  } as any)
  await expect(run).rejects.toThrow(/not a valid address/i)
})

test('a THOR/Maya memo that pays someone other than the recipient is refused, from any source family', async () => {
  const run = (memo: string) => executeSwap({
    fromChainId: 'base', toChainId: 'ethereum', fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:1/slip44:60',
    amount: '0.01', memo, inboundAddress: '0x3333333333333333333333333333333333333333', router: '0x4444444444444444444444444444444444444444',
    expectedOutput: '0.0099', integration: 'thorchain', fromAddressOverride: SENDER, toAddressOverride: RECIPIENT,
  } as any, {
    wallet: {}, getAllChains: () => CHAINS, getEvmRpcSource: () => { throw new Error('fixture: past the memo check') },
    getBtcXpub: () => undefined, getAllBtcXpubs: () => [], wrapSign: (sign: any) => sign(), pushSubStage: () => {},
  } as any)
  await expect(run('=:ETH.ETH:0x2222222222222222222222222222222222222222:0/1/0:kk:30')).rejects.toThrow(/memo pays out to 0x2222/)
  // The entered recipient (any case) passes the memo check and goes on to build.
  await expect(run(`=:ETH.ETH:${RECIPIENT.toUpperCase().replace('0X', '0x')}:0/1/0:kk:30`)).rejects.not.toThrow(/memo pays out/)
})

test('the fee-gate refusal names the pair and route it was quoted for (V14)', async () => {
  // Switching the output re-quotes; an identical message would read as the old error.
  relay = { requestId: REQUEST_ID, recipient: RECIPIENT, totalBps: 2079 }
  await expect(quote(RECIPIENT)).rejects.toThrow(/^Swap amount too low: quoted fees for ETH → ETH via relay \(20\.79%\)/)
  relay = { requestId: REQUEST_ID, recipient: RECIPIENT }
})
