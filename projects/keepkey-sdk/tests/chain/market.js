/**
 * Test: chain.getMarketInfo
 *
 * No device required — queries market price data.
 */
const { run } = require('../_helpers')

const BTC_CAIP = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const ETH_CAIP = 'eip155:1/slip44:60'

run('Chain — Market Info', async (getSdk, assert) => {
  const sdk = await getSdk()

  const resp = await sdk.chain.getMarketInfo({ caips: [BTC_CAIP, ETH_CAIP] })
  const data = resp?.data || resp
  assert('getMarketInfo returns data', data !== undefined)

  // Should return price info — the shape varies but should be an array or object
  const arr = Array.isArray(data) ? data : data?.data || []
  if (Array.isArray(arr) && arr.length > 0) {
    const first = arr[0]
    const hasPrice = first?.price !== undefined || first?.priceUsd !== undefined
    assert('First entry has price', hasPrice)
  } else {
    assert('Response has content', Object.keys(data).length > 0)
  }
})
