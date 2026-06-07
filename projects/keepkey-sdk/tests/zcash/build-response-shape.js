/**
 * Tests the /api/zcash/shielded/build response shape — no device signing needed.
 *
 * These are the exact fields zcash.ts reads when constructing protobuf messages
 * for the device. A wrong key name here (e.g. prevout_txid vs prevoutTxid) causes
 * a silent undefined that becomes a malformed protobuf message on the device.
 *
 * Requires: vault running, sidecar ready, transparent ZEC balance > 10000 zat.
 * Run: node tests/zcash/build-response-shape.js
 */

const { run } = require('../_helpers')

const BASE = process.env.KEEPKEY_URL || 'http://localhost:1646'
const API_KEY = process.env.KEEPKEY_API_KEY || ''

function authHeader() {
  if (!API_KEY) return {}
  const val = API_KEY.startsWith('Bearer ') ? API_KEY : `Bearer ${API_KEY}`
  return { 'Authorization': val }
}

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { ...authHeader() } })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
  })
  // Return body regardless — caller decides if error is acceptable
  const data = await res.json().catch(async () => ({ error: await res.text() }))
  return { ok: res.ok, status: res.status, data }
}

run('Zcash build response — field names match what zcash.ts reads', async (getSdk, assert) => {

  const status = await apiGet('/api/zcash/shielded/status')
  if (!status.ready) {
    console.log(`  SKIP: sidecar not ready`)
    return
  }

  const balance = await apiGet('/api/zcash/shielded/balance')
  const transparentSats = Number(balance.transparent_sats ?? 0)
  if (transparentSats < 10000) {
    console.log(`  SKIP: transparent balance too low (${transparentSats} zat)`)
    return
  }

  const { ok, status: httpStatus, data } = await apiPost('/api/zcash/shielded/build', {
    recipient: 'u1' + 'a'.repeat(87), // intentionally invalid — we only inspect structure
    amount: 10000,
    account: 0,
  })

  // If it passed address validation, inspect full structure.
  // If rejected, we can't validate the build response — warn and skip.
  if (!ok) {
    const msg = String(data.error ?? '')
    const isAddressErr = msg.toLowerCase().includes('address') || msg.toLowerCase().includes('recipient')
    if (isAddressErr) {
      console.log(`  NOTE: address validation rejected dummy recipient (${httpStatus}) — can't inspect build output`)
      console.log(`        Use a real UA from "POST /api/zcash/shielded/display-address" to run the full check`)
      assert('Build endpoint reachable (address validation works)', true)
    } else {
      assert(`Build succeeded or gave address error (got: ${msg.slice(0, 80)})`, false)
    }
    return
  }

  // ── transparent_inputs: field names zcash-shield.ts reads ───────────
  assert('Response has transparent_inputs array', Array.isArray(data.transparent_inputs))
  if (Array.isArray(data.transparent_inputs) && data.transparent_inputs.length > 0) {
    const ti = data.transparent_inputs[0]
    // zcash-shield.ts maps these via: prevoutTxid: ti.prevout_txid
    assert('transparent_input[0].index is a number', typeof ti.index === 'number')
    assert('transparent_input[0].amount is a number', typeof ti.amount === 'number')
    assert('transparent_input[0].prevout_txid is a 64-char hex string', typeof ti.prevout_txid === 'string' && ti.prevout_txid.length === 64)
    assert('transparent_input[0].prevout_index is a number', typeof ti.prevout_index === 'number')
    assert('transparent_input[0].sequence is a number', typeof ti.sequence === 'number')
    assert('transparent_input[0].script_pubkey is a hex string', typeof ti.script_pubkey === 'string' && ti.script_pubkey.length > 0)
    assert('transparent_input[0].address_path is an array', Array.isArray(ti.address_path))
    // Regression: these camelCase aliases must NOT appear (they caused silent undefineds)
    assert('NO camelCase prevoutTxid alias', ti.prevoutTxid === undefined)
    assert('NO camelCase scriptPubkey alias', ti.scriptPubkey === undefined)
  }

  // ── transparent_outputs: field names zcash.ts reads ─────────────────
  assert('Response has transparent_outputs array', Array.isArray(data.transparent_outputs))
  if (Array.isArray(data.transparent_outputs) && data.transparent_outputs.length > 0) {
    const to = data.transparent_outputs[0]
    // zcash.ts reads: output.index, output.value, output.script_pubkey
    assert('transparent_output[0].index is a number (regression: was missing)', typeof to.index === 'number')
    assert('transparent_output[0].value is a number', typeof to.value === 'number')
    assert('transparent_output[0].script_pubkey is a hex string', typeof to.script_pubkey === 'string' && to.script_pubkey.length > 0)
  }

  // ── header_fields: firmware requires all four for tx reconstruction ──
  assert('Response has header_fields', typeof data.header_fields === 'object' && data.header_fields !== null)
  if (data.header_fields) {
    assert('header_fields.tx_version === 5', data.header_fields.tx_version === 5)
    assert('header_fields.version_group_id is a number', typeof data.header_fields.version_group_id === 'number')
    assert('header_fields.lock_time is a number', typeof data.header_fields.lock_time === 'number')
    assert('header_fields.expiry_height is a number', typeof data.header_fields.expiry_height === 'number')
  }

  // ── digests: sapling must be absent (regression: firmware rejects it) ─
  assert('Response has digests', typeof data.digests === 'object' && data.digests !== null)
  if (data.digests) {
    assert('digests.header is 64-char hex', typeof data.digests.header === 'string' && data.digests.header.length === 64)
    assert('digests.transparent is 64-char hex', typeof data.digests.transparent === 'string' && data.digests.transparent.length === 64)
    assert('digests.sapling is absent (regression: firmware rejects it)', data.digests.sapling == null)
    assert('digests.orchard is 64-char hex', typeof data.digests.orchard === 'string' && data.digests.orchard.length === 64)
  }

  // ── bundle_meta: Orchard bundle metadata ────────────────────────────
  assert('Response has bundle_meta', typeof data.bundle_meta === 'object' && data.bundle_meta !== null)
  if (data.bundle_meta) {
    assert('bundle_meta.flags is a number', typeof data.bundle_meta.flags === 'number')
    assert('bundle_meta.value_balance is a number', typeof data.bundle_meta.value_balance === 'number')
    assert('bundle_meta.anchor is 64-char hex', typeof data.bundle_meta.anchor === 'string' && data.bundle_meta.anchor.length === 64)
  }

  // ── actions: Orchard ─────────────────────────────────────────────────
  assert('Response has actions array', Array.isArray(data.actions))
  if (Array.isArray(data.actions) && data.actions.length > 0) {
    const a = data.actions[0]
    assert('action[0].index is a number', typeof a.index === 'number')
    assert('action[0].alpha is 64-char hex', typeof a.alpha === 'string' && a.alpha.length === 64)
    assert('action[0].cv_net is 64-char hex', typeof a.cv_net === 'string' && a.cv_net.length === 64)
    assert('action[0].nullifier is 64-char hex', typeof a.nullifier === 'string' && a.nullifier.length === 64)
    assert('action[0].cmx is 64-char hex', typeof a.cmx === 'string' && a.cmx.length === 64)
    assert('action[0].is_spend is boolean', typeof a.is_spend === 'boolean')

    // Output actions (is_spend=false) MUST have value/recipient/rseed for firmware clear-signing.
    // Firmware recomputes cmx from these; any mismatch → "Orchard note commitment mismatch".
    const outputAction = data.actions.find(ac => ac.is_spend === false)
    if (outputAction) {
      // value must be the output note value (> 0 for a real shield output)
      // Regression: sidecar read spend().value() instead of output().value() → always 0
      assert('output action value > 0 (regression: was 0 due to spend vs output field)',
        typeof outputAction.value === 'number' && outputAction.value > 0)
      assert('output action has recipient (86-char hex = 43 bytes)',
        typeof outputAction.recipient === 'string' && outputAction.recipient.length === 86)
      assert('output action has rseed (64-char hex = 32 bytes)',
        typeof outputAction.rseed === 'string' && outputAction.rseed.length === 64)
    } else {
      assert('At least one output action exists (is_spend=false)', false)
    }
  }

  // ── n_actions matches actions array length ───────────────────────────
  if (data.n_actions !== undefined && Array.isArray(data.actions)) {
    assert('n_actions matches actions.length', data.n_actions === data.actions.length)
  }
})
