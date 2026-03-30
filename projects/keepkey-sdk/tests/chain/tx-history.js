/**
 * Test: chain.getTransactionHistory
 *
 * Requires device connected — derives ETH address to query tx history.
 */
const { run, ETH_PATH } = require('../_helpers')

const ETH_CAIP = 'eip155:1'

run('Chain — Transaction History', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address: ethAddr } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  assert('Got ETH address', ethAddr && ethAddr.startsWith('0x'))

  const resp = await sdk.chain.getTransactionHistory({
    queries: [{ pubkey: ethAddr, caip: ETH_CAIP }],
  })
  const data = resp?.data || resp
  assert('getTransactionHistory returns data', data !== undefined)
})
