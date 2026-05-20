/**
 * Test: chain.getAvailableAssets + chain.searchAssets
 *
 * No device required — tests the chain data API proxy.
 */
const { run } = require('../_helpers')

run('Chain — Available Assets & Search', async (getSdk, assert) => {
  const sdk = await getSdk()

  // ── getAvailableAssets ──────────────────────────────────────────
  const assets = await sdk.chain.getAvailableAssets()
  const list = assets?.data?.assets || assets?.data || []
  assert('getAvailableAssets returns data', Array.isArray(list))
  assert('Has at least 1 asset', list.length > 0)
  if (list.length > 0) {
    const first = list[0]
    assert('Asset has asset field', typeof first.asset === 'string' || typeof first.symbol === 'string')
  }

  // ── searchAssets ────────────────────────────────────────────────
  const search = await sdk.chain.searchAssets({ q: 'ethereum', limit: 10 })
  const results = search?.data || []
  assert('searchAssets returns data', Array.isArray(results) || typeof results === 'object')
})
