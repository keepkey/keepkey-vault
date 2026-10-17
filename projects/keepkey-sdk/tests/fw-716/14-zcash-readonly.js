#!/usr/bin/env node
/**
 * fw-716/14 — Zcash on 7.16 within the sign-only rule: the shielded service
 * status, and proof that the address Desktop has cached belongs to this
 * device. Nothing is signed. Never calls send, shield, deshield, build,
 * finalize or broadcast.
 *
 * verify-device is INFORMATION only: Desktop answers it from the view key it
 * remembers for this device (zcash-shielded.ts exportOrchardFvk) whenever it
 * has one, so its match compares two copies Desktop holds. The ownership proof
 * is KK716_ZCASH_DISPLAY=1: the device derives and shows its unified address,
 * and it must equal Desktop's cached address. Without it the suite SKIPs.
 *
 * Presses: 0-1 for verify-device (the device asks to export the view key only
 * when Desktop has none remembered), +1 with KK716_ZCASH_DISPLAY=1. No card.
 *
 * SKIPs: 403 (zcash_privacy_enabled off), 503 (firmware gate or verification
 * unavailable), no cached address, or KK716_ZCASH_DISPLAY unset.
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
  console.log('  OWNER: if the device asks to export the Zcash view key, confirm. No prompt means Desktop')
  console.log('         answered from the key it remembers: the device was NOT asked.')
  const v = await call(sdk, 'GET', '/api/zcash/shielded/verify-device')
  console.log(`  verify-device: ${v.message}`)
  console.log(`  deviceAk ${short(v.deviceAk)}  cachedAk ${v.cachedAk ? short(v.cachedAk) : '(none)'}`)
  assert('deviceAk is 32 bytes of hex', /^[0-9a-f]{64}$/i.test(v.deviceAk || ''))
  console.log(`  verify-device match: ${v.match} (info only: without a device prompt it compares two copies Desktop holds)`)

  if (process.env.KK716_ZCASH_DISPLAY !== '1') skip('ownership not proven: the device was not asked (set KK716_ZCASH_DISPLAY=1, +1 press)')
  if (!v.cachedAddress) skip('no cached address on this Desktop; nothing to compare')

  console.log('\n  [3] POST /api/zcash/shielded/display-address')
  console.log(`  Desktop's cached address: ${v.cachedAddress}`)
  console.log('  OWNER: the device shows its Zcash unified address. Write down its start and end, then confirm.')
  console.log('         After you confirm, the suite prints the address the device returned: compare the two.')
  const d = await call(sdk, 'POST', '/api/zcash/shielded/display-address', { account: 0 })
  console.log(`  device address: ${d.address}`)
  assert("display-address returns a 'u1...' address", typeof d.address === 'string' && d.address.startsWith('u1'))
  assert("the device's address equals Desktop's cached address (ownership)", d.address === v.cachedAddress)
})
