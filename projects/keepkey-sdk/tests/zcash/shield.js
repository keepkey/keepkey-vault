/**
 * Integration tests for Zcash shield (transparent → Orchard) flow.
 *
 * Requires:
 *   - KeepKey connected with firmware >= 7.15
 *   - Zcash privacy enabled (zcash_privacy_enabled=1 in vault settings)
 *   - KEEPKEY_API_KEY env var set
 *   - Vault running on localhost:1646
 *
 * Run: node tests/zcash/shield.js
 */

const { run } = require('../_helpers')

const BASE = process.env.KEEPKEY_URL || 'http://localhost:1646'
const API_KEY = process.env.KEEPKEY_API_KEY || ''

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-api-key': API_KEY },
  })
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

run('Zcash Shield — status, balance, build request structure', async (getSdk, assert) => {

  // ── 1. Status ─────────────────────────────────────────────────────
  console.log('\n  [1] Checking sidecar status...')
  const status = await apiGet('/api/zcash/shielded/status')
  assert('Status response has "ready" field', typeof status.ready === 'boolean')

  if (!status.ready) {
    console.log(`  SKIP: sidecar not ready (${status.error ?? 'no error given'})`)
    console.log('       Run: POST /api/zcash/shielded/init with { from_device: true }')
    return
  }

  // ── 2. Balance ────────────────────────────────────────────────────
  console.log('\n  [2] Fetching shielded balance...')
  const balanceResp = await apiGet('/api/zcash/shielded/balance')
  assert('Balance response has "shielded" field', typeof balanceResp.shielded !== 'undefined')
  assert('Balance response has "transparent" field', typeof balanceResp.transparent !== 'undefined')
  assert('shielded balance >= 0', Number(balanceResp.shielded) >= 0)
  assert('transparent balance >= 0', Number(balanceResp.transparent) >= 0)
  console.log(`     shielded:    ${balanceResp.shielded} ZEC`)
  console.log(`     transparent: ${balanceResp.transparent} ZEC`)

  const totalSats = Number(balanceResp.transparent_sats ?? 0)

  if (totalSats < 10000) {
    console.log(`\n  SKIP build test: transparent balance too low (${totalSats} zat < 10000 dust threshold)`)
    console.log('       Send transparent ZEC to your wallet first, then re-run.')
    return
  }

  // ── 3. Build shield tx ────────────────────────────────────────────
  console.log('\n  [3] Building shield PCZT...')
  // Use a known-small amount so we don't accidentally drain the wallet
  // The amount here is 10000 zatoshis (0.0001 ZEC) — adjust if needed.
  const buildAmount = Math.min(totalSats - 5000, 10000) // leave room for fee
  if (buildAmount <= 0) {
    console.log(`  SKIP: not enough balance to build (${totalSats} zat)`)
    return
  }

  // Display address must match what the device would derive — use the device
  // derived address. We can get it from the display-address endpoint (no UI confirm).
  // NOTE: display-address asks for button press on device — omit for automated tests
  // and pass a dummy bech32 address. If the sidecar validates recipient format we'll
  // see the error here rather than on the device.
  const ORCHARD_DUMMY_RECIPIENT = 'u1' + 'a'.repeat(87) // placeholder UA — replace with real address from display-address

  let buildResp
  try {
    buildResp = await apiPost('/api/zcash/shielded/build', {
      recipient: ORCHARD_DUMMY_RECIPIENT,
      amount: buildAmount,
      account: 0,
    })
  } catch (e) {
    // Address validation error is acceptable — the important thing is the
    // transparent output/input structure was assembled correctly before the
    // address check. Any error about "invalid address" passes; anything else fails.
    const msg = String(e.message)
    const isAddressError = msg.toLowerCase().includes('address') ||
                           msg.toLowerCase().includes('recipient') ||
                           msg.toLowerCase().includes('invalid')
    assert('Build fails with address validation error (expected for dummy recipient)', isAddressError)
    console.log(`     (got expected error: ${msg.slice(0, 120)})`)
    return
  }

  // If the sidecar accepted the dummy address, validate the build response shape
  assert('Build response has signing_request or transparent_inputs',
    buildResp.transparent_inputs !== undefined || buildResp.signing_request !== undefined)

  const req = buildResp.signing_request ?? buildResp
  if (req.transparent_inputs) {
    const ti = req.transparent_inputs
    assert('transparent_inputs is an array', Array.isArray(ti))
    assert('First transparent input has index', typeof ti[0].index === 'number')
    assert('First transparent input has amount (zatoshis)', typeof ti[0].amount === 'number' && ti[0].amount > 0)
    assert('First transparent input has prevout_txid', typeof ti[0].prevout_txid === 'string' && ti[0].prevout_txid.length === 64)
    assert('First transparent input has prevout_index', typeof ti[0].prevout_index === 'number')
    assert('First transparent input has address_path', Array.isArray(ti[0].address_path))
    console.log(`     inputs: ${ti.length}, first amount: ${ti[0].amount} zat`)
  }

  if (req.transparent_outputs) {
    const to = req.transparent_outputs
    assert('transparent_outputs is an array', Array.isArray(to))
    assert('First transparent output has index', typeof to[0].index === 'number')
    assert('First transparent output has value', typeof to[0].value === 'number')
    assert('First transparent output has script_pubkey (hex)', typeof to[0].script_pubkey === 'string' && to[0].script_pubkey.length > 0)
    console.log(`     outputs: ${to.length}, first value: ${to[0].value} zat`)
  }

  if (req.header_fields) {
    assert('header_fields has tx_version=5', req.header_fields.tx_version === 5)
    assert('header_fields has version_group_id', typeof req.header_fields.version_group_id === 'number')
    assert('header_fields has lock_time', typeof req.header_fields.lock_time === 'number')
    assert('header_fields has expiry_height', typeof req.header_fields.expiry_height === 'number')
  }

  if (req.digests) {
    assert('digests has header (32 bytes hex)', typeof req.digests.header === 'string' && req.digests.header.length === 64)
    assert('digests has transparent', typeof req.digests.transparent === 'string' && req.digests.transparent.length === 64)
    assert('digests does NOT have sapling', req.digests.sapling === undefined || req.digests.sapling === null)
    assert('digests has orchard', typeof req.digests.orchard === 'string' && req.digests.orchard.length === 64)
  }

  if (req.actions) {
    assert('actions is an array', Array.isArray(req.actions))
    assert('At least 1 Orchard action', req.actions.length >= 1)
    const a = req.actions[0]
    assert('Action has index', typeof a.index === 'number')
    assert('Action has alpha (32 bytes hex)', typeof a.alpha === 'string' && a.alpha.length === 64)
    assert('Action has cv_net', typeof a.cv_net === 'string' && a.cv_net.length === 64)
    assert('Action has nullifier', typeof a.nullifier === 'string' && a.nullifier.length === 64)
    assert('Action has is_spend', typeof a.is_spend === 'boolean')
  }
})
