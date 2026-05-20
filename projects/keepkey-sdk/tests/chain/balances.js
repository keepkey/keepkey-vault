/**
 * Test: chain.getPortfolioBalances + chain.getBalance
 *
 * Requires device connected — derives a BTC xpub to query balances.
 */
const { run, ETH_PATH } = require('../_helpers')

const BTC_CAIP = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const ETH_CAIP = 'eip155:1/slip44:60'
const ETH_NETWORK = 'eip155:1'

run('Chain — Balances', async (getSdk, assert) => {
  const sdk = await getSdk()

  // Derive an ETH address for balance check
  const { address: ethAddr } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  assert('Got ETH address', ethAddr && ethAddr.startsWith('0x'))

  // ── getPortfolioBalances ────────────────────────────────────────
  const balResp = await sdk.chain.getPortfolioBalances({
    pubkeys: [{ caip: ETH_CAIP, pubkey: ethAddr }],
  })
  assert('getPortfolioBalances returns data', balResp?.data !== undefined)

  // ── getBalance (single address) ────────────────────────────────
  const bal = await sdk.chain.getBalance({
    networkId: ETH_NETWORK,
    address: ethAddr,
  })
  assert('getBalance returns data', bal?.data !== undefined)
})
