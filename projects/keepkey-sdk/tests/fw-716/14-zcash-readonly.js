#!/usr/bin/env node
/**
 * fw-716/14 — Zcash on 7.16 within the sign-only rule: the shielded service
 * status, and proof that the view key Desktop has cached belongs to this
 * device. Nothing is signed. Never calls send, shield, deshield, build,
 * finalize or broadcast.
 *
 * Presses: at most 1 (the device asks to export the Zcash view key). Desktop
 * reuses a view key it already read from this device (keyed by the device's
 * own ETH address), so there may be no prompt at all. No Desktop card.
 * KK716_ZCASH_DISPLAY=1 adds 1 press: the device shows its unified address.
 *
 * SKIPs: 403 (zcash_privacy_enabled off), 503 (firmware gate or verification
 * unavailable), and a Desktop with no cached view key (nothing to compare).
 *
 * Run: make test-sdk filter=fw-716/14-
 */
const { run, skip, short } = require('../_helpers')

const TIMEOUT_MS = 600_000

/** GET/POST through the paired client. 403 and 503 SKIP with the body. */
async function call(sdk, method, path, body) {
  try {
    return method === 'GET'
      ? await sdk.getClient().get(path, TIMEOUT_MS)
      : await sdk.getClient().post(path, body, TIMEOUT_MS)
  } catch (e) {
    if (e.status === 403) skip(`Zcash privacy disabled (${path}: ${e.message})`)
    if (e.status === 503) skip(`${path} answered 503: ${e.message}`)
    throw e
  }
}

run('fw-716/14 Zcash read-only: status and view-key ownership (nothing signed)', async (getSdk, assert) => {
  const sdk = await getSdk()

  console.log('\n  [1] GET /api/zcash/shielded/status')
  const status = await call(sdk, 'GET', '/api/zcash/shielded/status')
  console.log(`  status: ready=${status.ready}${status.error ? ` error=${status.error}` : ''}`)
  assert('status reports ready === true', status.ready === true)

  console.log('\n  [2] GET /api/zcash/shielded/verify-device')
  console.log('  OWNER: the device will ask to export the Zcash view key - confirm.')
  console.log('         (No prompt is fine: Desktop may reuse the key it already read from this device.)')
  const v = await call(sdk, 'GET', '/api/zcash/shielded/verify-device')
  console.log(`  verify-device: ${v.message}`)
  console.log(`  deviceAk ${short(v.deviceAk)}  cachedAk ${v.cachedAk ? short(v.cachedAk) : '(none)'}`)
  assert('deviceAk is 32 bytes of hex', /^[0-9a-f]{64}$/i.test(v.deviceAk || ''))
  const noCache = v.cachedAk === null || v.cachedAk === undefined
  if (!noCache) assert('match === true (cached view key belongs to this device)', v.match === true)

  if (process.env.KK716_ZCASH_DISPLAY === '1') {
    console.log('\n  [3] POST /api/zcash/shielded/display-address')
    if (v.cachedAddress) console.log(`  Desktop's cached address: ${v.cachedAddress}`)
    console.log('  OWNER: the device shows its Zcash unified address. Write down its start and end, then confirm.')
    console.log('         After you confirm, the suite prints the address the device returned: compare the two.')
    const d = await call(sdk, 'POST', '/api/zcash/shielded/display-address', { account: 0 })
    console.log(`  device address: ${d.address}`)
    assert("display-address returns a 'u1...' address", typeof d.address === 'string' && d.address.startsWith('u1'))
    if (v.cachedAddress) {
      console.log(`  same as Desktop's cached address: ${d.address === v.cachedAddress} (info only, not asserted)`)
    }
  } else {
    console.log('\n  [3] display-address not run (set KK716_ZCASH_DISPLAY=1)')
  }

  // Deferred so the optional display step still runs. Never a pass.
  if (noCache) skip('no cached view key on this Desktop; nothing to compare')
})
