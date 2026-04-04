/**
 * Test: chain.getFeeRate + chain.getGasPrice + chain.getNonce
 *
 * No device required — queries network fee/gas/nonce data.
 */
const { run, ETH_PATH } = require('../_helpers')

const BTC_NETWORK = 'bip122:000000000019d6689c085ae165831e93'
const ETH_NETWORK = 'eip155:1'

run('Chain — Network Info', async (getSdk, assert) => {
  const sdk = await getSdk()

  // ── getFeeRate (BTC) ───────────────────────────────────────────
  const feeResp = await sdk.chain.getFeeRate({ networkId: BTC_NETWORK })
  const feeData = feeResp?.data || feeResp
  assert('getFeeRate returns data', feeData !== undefined)
  // Should have slow/average/fast
  const hasFees = feeData?.slow !== undefined || feeData?.average !== undefined || feeData?.fast !== undefined
  assert('Fee data has rate tiers', hasFees)

  // ── getGasPrice (ETH) ──────────────────────────────────────────
  const gasResp = await sdk.chain.getGasPrice({ networkId: ETH_NETWORK })
  const gasData = gasResp?.data || gasResp
  assert('getGasPrice returns data', gasData !== undefined)

  // ── getNonce (ETH — use a known address) ───────────────────────
  const { address: ethAddr } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  const nonceResp = await sdk.chain.getNonce({ networkId: ETH_NETWORK, address: ethAddr })
  const nonceData = nonceResp?.data || nonceResp
  assert('getNonce returns data', nonceData !== undefined)
  assert('Nonce is a number', typeof nonceData?.nonce === 'number' || typeof nonceData === 'number')
})
