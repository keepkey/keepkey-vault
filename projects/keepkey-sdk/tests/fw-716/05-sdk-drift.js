#!/usr/bin/env node
/**
 * fw-716/05 — Binance retired on 7.16, plus SDK surface drift against this
 * Desktop. No presses, no signing: /bnb/* is not in SIGNING_ROUTES, so no card.
 *
 * 1) POST /addresses/bnb and POST /bnb/sign-transaction (empty body) answer 404.
 * 2) The SDK no longer exposes address.bnbGetAddress,
 *    binance.binanceSignTransaction, system.info.getSupportedAssets or
 *    chain.getInboundAddresses (no Desktop routes behind them).
 * 3) chain.getSwapQuote in the CAIP shape (Base ETH -> Base USDC, quote only,
 *    nothing is signed or broadcast) answers 2xx with a quote and no error.
 *
 * Only step 3 can SKIP: when Desktop is in offline mode or the Pioneer server
 * it uses cannot be reached. /api/health has no Pioneer field, so the suite
 * probes the Pioneer base from /api/pioneer/status itself. Any other quote
 * error is a FAIL. A red result means an SDK fix is missing (run this only
 * after the sdkMethods changes are built into lib/).
 */
const { run, ETH_PATH, skip } = require('../_helpers')
const F = require('./_fw716')

const BASE_URL = (process.env.KEEPKEY_URL || 'http://localhost:1646').replace(/\/+$/, '')

/** Raw POST, no SDK wrapper: returns the HTTP status. */
async function rawPost(apiKey, path, body) {
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  await resp.text()
  return resp.status
}

run('fw-716/05 Binance retired, SDK surface drift', async (getSdk, assert) => {
  const sdk = await getSdk()

  // ── 1) retired Binance routes ───────────────────────────────────────
  for (const path of ['/addresses/bnb', '/bnb/sign-transaction']) {
    const status = await rawPost(sdk.apiKey, path, {})
    console.log(`  POST ${path} -> ${status}`)
    assert(`POST ${path} answers 404`, status === 404)
  }

  // ── 2) drifted SDK methods are gone ─────────────────────────────────
  const drifted = {
    'address.bnbGetAddress': sdk.address?.bnbGetAddress,
    'binance.binanceSignTransaction': sdk.binance?.binanceSignTransaction,
    'system.info.getSupportedAssets': sdk.system?.info?.getSupportedAssets,
    'chain.getInboundAddresses': sdk.chain?.getInboundAddresses,
  }
  for (const [name, fn] of Object.entries(drifted)) {
    assert(`sdk.${name} is not exposed`, typeof fn === 'undefined')
  }

  // ── 3) swap quote, CAIP shape ───────────────────────────────────────
  const health = await sdk.system.info.getHealth()
  console.log(`  health: ready=${health.ready} device_connected=${health.device_connected} version=${health.version}`)
  const pioneer = await sdk.getClient().get('/api/pioneer/status')
  console.log(`  pioneer base: ${pioneer.url}`)
  if (/^https?:\/\//.test(pioneer.url || '')) {
    // Any HTTP answer proves the network path; only a transport failure skips.
    const reachable = await fetch(pioneer.url, { signal: AbortSignal.timeout(10_000) }).then(() => true, () => false)
    if (!reachable) skip(`step 3: Pioneer ${pioneer.url} is unreachable (no network?)`)
  }

  const { address: device } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  console.log(`  device: ${device}`)

  const params = {
    fromCaip: 'eip155:8453/slip44:60',
    toCaip: `eip155:8453/erc20:${F.USDC_BASE}`,
    amount: '0.0001',
    fromAddress: device,
    toAddress: device,
  }
  let quote
  try {
    quote = await sdk.chain.getSwapQuote(params)
  } catch (e) {
    // Only Desktop's offline mode becomes a SKIP; every other error is a FAIL.
    if (e?.status === 503 && /OFFLINE/.test(String(e.message))) skip('step 3: Desktop is in offline mode')
    throw e
  }
  const data = quote?.data
  const quotes = Array.isArray(data) ? data : data ? [data] : []
  console.log(`  quote: ${JSON.stringify(data).slice(0, 200)}`)
  assert('getSwapQuote answers at least one quote', quotes.length >= 1)
  assert('quote has an expectedOutput above 0', quotes.length >= 1 && Number(quotes[0].expectedOutput) > 0)
  assert('quote has no error field', !quote?.error && quotes.every((q) => !q?.error))
})
