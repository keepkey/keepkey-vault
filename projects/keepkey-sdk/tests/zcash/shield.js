/**
 * Zcash shielded (Orchard): status, balance, and the shape of a built spend.
 * Builds only: never calls send, shield, deshield, finalize or broadcast, and
 * nothing is signed.
 *
 * Device: reading the balance proves the cached view key belongs to the
 * connected device, which can ask to export the Zcash view key (1 press).
 *
 * Requires Zcash privacy enabled in Desktop (zcash_privacy_enabled) and
 * firmware with Zcash support. 403 or 503 from Desktop: SKIPPED.
 *
 * Run: make test-sdk filter=zcash/shield
 */
const { run, skip } = require('../_helpers')

/** GET/POST through the paired SDK client. 403/503 SKIP with the reason. */
async function call(sdk, method, path, body) {
  try {
    return method === 'GET' ? await sdk.getClient().get(path, 600000) : await sdk.getClient().post(path, body, 600000)
  } catch (e) {
    if (e.status === 403) skip(`Zcash privacy disabled (${path}: ${e.message})`)
    if (e.status === 503) skip(`${path} answered 503: ${e.message}`)
    throw e
  }
}

run('Zcash shielded — status, balance, build request structure (build only)', async (getSdk, assert) => {
  const sdk = await getSdk()

  console.log('\n  [1] Sidecar status')
  const status = await call(sdk, 'GET', '/api/zcash/shielded/status')
  assert('status has a boolean "ready"', typeof status.ready === 'boolean')
  if (!status.ready) skip(`sidecar not ready (${status.error ?? 'no error given'})`)

  console.log('\n  [2] Shielded balance')
  console.log('  OWNER: the device may ask to export the Zcash view key - confirm.')
  const balance = await call(sdk, 'GET', '/api/zcash/shielded/balance')
  assert('balance.confirmed is a number >= 0', typeof balance.confirmed === 'number' && balance.confirmed >= 0)
  const spendable = balance.spendable_confirmed ?? balance.confirmed
  assert('spendable_confirmed is a number >= 0', typeof spendable === 'number' && spendable >= 0)
  console.log(`     confirmed: ${balance.confirmed} zat, spendable: ${spendable} zat`)
  if (spendable < 20000) skip(`spendable shielded balance too low to build (${spendable} zat)`)

  console.log('\n  [3] Build a spend (not signed, not broadcast)')
  let build
  try {
    build = await sdk.getClient().post('/api/zcash/shielded/build', {
      recipient: 'u1' + 'a'.repeat(87), // not a valid address: the sidecar may refuse it
      amount: 10000,
      account: 0,
    }, 600000)
  } catch (e) {
    const msg = String(e.message || e).toLowerCase()
    const addressError = msg.includes('address') || msg.includes('recipient')
    assert(`build refuses the placeholder recipient with an address error (got ${e.status}: ${String(e.message).slice(0, 100)})`, addressError)
    return
  }

  const req = build.signing_request
  assert('build returns signing_request', !!req && typeof req === 'object')
  if (!req) return
  assert('signing_request.n_actions matches actions.length', Array.isArray(req.actions) && req.n_actions === req.actions.length)
  assert('signing_request.sighash is 64-char hex', /^[0-9a-f]{64}$/i.test(req.sighash || ''))
  assert('digests.orchard is 64-char hex', /^[0-9a-f]{64}$/i.test(req.digests?.orchard || ''))
  assert('bundle_meta.anchor is 64-char hex', /^[0-9a-f]{64}$/i.test(req.bundle_meta?.anchor || ''))
  console.log(`     pool ${req.pool}, ${req.n_actions} action(s)`)
})
