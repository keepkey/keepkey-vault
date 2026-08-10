/**
 * Hive phase-3 clear-sign ops — limit_order_create / limit_order_cancel.
 *
 * Proves (against the running Vault + attached device/emulator) that
 * `/hive/sign-operations` now accepts the two ops added in firmware #315 /
 * vault #373, and that the vault's host-side validation (mirroring the
 * firmware parser's degenerate-order rejections) still fires without a
 * device round-trip.
 *
 * Prerequisites, all outside this test's control:
 *   - firmware >= release/7.15.0-rc15 (fw #315 — 11 new clear-sign ops)
 *   - vault's local setting `hive_enabled = '1'` (POST /hive/sign-operations
 *     403s with "Hive is disabled" otherwise — the STAGED gate in
 *     rest-api.ts, not a bug in this test)
 *   - live Pioneer reachable at /api/v1/hive/tx-params (real TaPoS header
 *     fetch, not mocked — a 502 here means Pioneer, not this suite)
 *
 * Account names ('alice', etc.) are synthetic — this is a SIGNING test, not
 * a broadcast test. The device signs whatever bytes it's given; it does not
 * validate that an account exists on-chain. Same pattern as
 * tests/thorchain/ruji.js.
 *
 * Run: node tests/hive/phase3-ops.js   (Vault must be live on :1646)
 */
const { run } = require('../_helpers')

// SLIP-0048: m/48'/13'/role'/account'/0'. limit_order_create/cancel are
// active-tier — see hive-ops.ts serializeOp().
const HIVE_ACTIVE_PATH = [0x80000030, 0x8000000d, 0x80000001, 0x80000000, 0x80000000]

const sig = (r) => r && (r.signature || r.serialized || r.serializedTx)

// Same vector as firmware's Hive.LimitOrderCreateRetainsEveryDisplayedField
// and vault's hive-ops.test.ts CREATE fixture.
const CREATE = {
  owner: 'alice', orderid: 42,
  amount_to_sell: '1.500 HIVE', min_to_receive: '0.400 HBD',
  fill_or_kill: true, expiration: 1700003600,
}

run('Hive phase-3: limit_order_create / limit_order_cancel', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  // ── Address sanity — proves the device answers on the active role path ──
  const { address } = await sdk.address.hiveGetAddress({ address_n: HIVE_ACTIVE_PATH, show_display: false })
  assert('derives hive active-role public key', !!address)

  // ── limit_order_create signs ─────────────────────────────────────────
  let createRes, createErr
  try {
    createRes = await sdk.hive.hiveSignOperations({ operations: [['limit_order_create', CREATE]] })
  } catch (e) { createErr = e }
  assert('limit_order_create signs', !createErr && !!sig(createRes))
  if (createErr) console.error(`     ↳ ${String(createErr.message || createErr).slice(0, 200)}`)

  // ── limit_order_cancel signs ─────────────────────────────────────────
  let cancelRes, cancelErr
  try {
    cancelRes = await sdk.hive.hiveSignOperations({
      operations: [['limit_order_cancel', { owner: 'alice', orderid: 42 }]],
    })
  } catch (e) { cancelErr = e }
  assert('limit_order_cancel signs', !cancelErr && !!sig(cancelRes))
  if (cancelErr) console.error(`     ↳ ${String(cancelErr.message || cancelErr).slice(0, 200)}`)

  // ── Host-side degenerate-order rejections (no device round-trip) ────
  let sameSymErr
  try {
    await sdk.hive.hiveSignOperations({
      operations: [['limit_order_create', { ...CREATE, min_to_receive: '0.400 HIVE' }]],
    })
  } catch (e) { sameSymErr = e }
  assertThrows('rejects same-symbol order', sameSymErr, 'symbols must differ')

  let zeroAmtErr
  try {
    await sdk.hive.hiveSignOperations({
      operations: [['limit_order_create', { ...CREATE, amount_to_sell: '0.000 HIVE' }]],
    })
  } catch (e) { zeroAmtErr = e }
  assertThrows('rejects zero amount_to_sell', zeroAmtErr, 'greater than zero')

  let vestsErr
  try {
    await sdk.hive.hiveSignOperations({
      operations: [['limit_order_create', { ...CREATE, amount_to_sell: '1.500000 VESTS' }]],
    })
  } catch (e) { vestsErr = e }
  assertThrows('rejects VESTS on the internal market', vestsErr, 'HIVE or HBD')

  // ── Cannot mix posting-tier and active-tier ops in one tx ───────────
  let mixedTierErr
  try {
    await sdk.hive.hiveSignOperations({
      operations: [
        ['limit_order_cancel', { owner: 'alice', orderid: 1 }],
        ['vote', { voter: 'alice', author: 'bob', permlink: 'p', weight: 10000 }],
      ],
    })
  } catch (e) { mixedTierErr = e }
  assertThrows('rejects mixed posting/active tiers', mixedTierErr, 'posting-tier and active-tier')
})
