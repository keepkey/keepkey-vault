/**
 * Test: chain.getSwapQuote (POST /api/v2/swap/quote, CAIP shape).
 *
 * Quote only: nothing is signed or broadcast. Derives the device's ETH and BTC
 * addresses (no display) for the quote. Needs the network and Pioneer.
 */
const { run, ETH_PATH } = require('../_helpers')

run('Chain — Swap quote (ETH -> BTC)', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address: ethAddr } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  const btcPath = [0x80000000 + 84, 0x80000000, 0x80000000, 0, 0] // m/84'/0'/0'/0/0
  const { address: btcAddr } = await sdk.address.utxoGetAddress({
    address_n: btcPath,
    coin: 'Bitcoin',
    script_type: 'p2wpkh',
    show_display: false,
  })
  assert('Got BTC address', btcAddr && btcAddr.startsWith('bc1'))

  // An error here is a failure: a quote that cannot be fetched is not a pass.
  const quote = await sdk.chain.getSwapQuote({
    fromCaip: 'eip155:1/slip44:60', // ETH
    toCaip: 'bip122:000000000019d6689c085ae165831e93/slip44:0', // BTC
    amount: '0.01',
    fromAddress: ethAddr,
    toAddress: btcAddr,
    slippageBps: 300,
  })
  assert('getSwapQuote answers { data }', !!quote && quote.data !== undefined && quote.data !== null)
  assert('quote has no error field', !quote?.error && !quote?.data?.error)
  console.log(`    quote: ${JSON.stringify(quote?.data).slice(0, 160)}`)
})
