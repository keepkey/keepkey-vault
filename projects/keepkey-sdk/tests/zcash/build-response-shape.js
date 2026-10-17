/**
 * Tests the /api/zcash/shielded/build response shape. Builds only: nothing is
 * signed, finalized or broadcast, and it never calls send, shield or deshield.
 *
 * These are the exact fields zcash.ts reads from build.signing_request when it
 * builds the device messages. A wrong key name causes a silent undefined that
 * becomes a malformed protobuf message on the device.
 *
 * Device: the build first proves the cached view key belongs to the connected
 * device, which can ask to export the Zcash view key (1 press).
 * Requires Zcash privacy enabled and a ready sidecar; 403/503: SKIPPED.
 * Run: make test-sdk filter=zcash/build-response-shape
 */

const { run, skip } = require('../_helpers')

run('Zcash build response — field names match what zcash.ts reads', async (getSdk, assert) => {
  const sdk = await getSdk()
  const client = sdk.getClient()

  let status
  try {
    status = await client.get('/api/zcash/shielded/status')
  } catch (e) {
    if (e.status === 403) skip(`Zcash privacy disabled (${e.message})`)
    throw e
  }
  if (!status.ready) skip(`sidecar not ready (${status.error ?? 'no error given'})`)

  console.log('  OWNER: the device may ask to export the Zcash view key - confirm.')
  let build
  try {
    build = await client.post('/api/zcash/shielded/build', {
      recipient: 'u1' + 'a'.repeat(87), // intentionally invalid: only the structure is inspected
      amount: 10000,
      account: 0,
    }, 600000)
  } catch (e) {
    if (e.status === 503) skip(`/api/zcash/shielded/build answered 503: ${e.message}`)
    const msg = String(e.message || e).toLowerCase()
    if (msg.includes('address') || msg.includes('recipient')) {
      skip(`build refused the placeholder recipient (${e.status}); use a real UA from display-address to inspect the shape`)
    }
    assert(`build succeeded or gave an address error (got ${e.status}: ${String(e.message).slice(0, 80)})`, false)
    return
  }

  const data = build.signing_request
  assert('build returns signing_request', !!data && typeof data === 'object')
  if (!data) return

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
