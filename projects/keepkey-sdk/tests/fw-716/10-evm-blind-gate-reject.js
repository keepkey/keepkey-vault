#!/usr/bin/env node
/**
 * fw-716/10 — blind-sign gate with AdvancedMode off: an unknown contract call
 * stays red and the Desktop card blocks it. 1 Desktop click (Reject), 0
 * device presses.
 *
 * 0xdeadbeef + 32 random bytes to a random contract on chain 1, value 0,
 * SENTINEL_NONCE. The owner clicks Reject on the card; the pass is Desktop's
 * own answer (HTTP 403 'Signing rejected by user') within 115 s. A rejection
 * at 119 s or later is the card's own timeout, not a click: INCONCLUSIVE, and
 * reported as a FAIL. Nothing reaches the device, nothing is signed.
 */
const { run, atEnd, short } = require('../_helpers')
const F = require('./_fw716')

const REJECTED = 'Signing rejected by user'
const CLICK_LIMIT_MS = 115_000
const CARD_TIMEOUT_MS = 119_000

run('fw-716/10 blind-sign gate: unknown contract, AdvancedMode off, card Reject', async (getSdk, assert) => {
  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  const { eth: device } = await F.deviceAddresses(sdk)
  console.log(`  device: ${device}`)
  atEnd(async () => {
    console.log(`\n  waiting ${F.FEATURES_WAIT_MS / 1000} s for Desktop's features cache...`)
    const on = F.advancedMode(await F.waitFeatures(sdk))
    if (on === false) return assert('AdvancedMode is still off afterwards', true)
    const after = await F.restoreAdvancedMode(sdk)
    throw new Error(`AdvancedMode read ${on} afterwards (now ${after}): Enable must not be clicked in this suite`)
  })

  const tx = F.evmTx({ from: device, to: F.randomAddress(), data: '0xdeadbeef' + F.word(F.randomHex(32)), chainId: 1 })
  console.log(`  to ${tx.to} (random), data ${short(tx.data)}`)

  const pre = await sdk.clearsign.report(F.reportBody(tx))
  F.assertDeviceConnected(assert, pre, 'pre-report')
  console.log(`  pre-report: ${F.describeReport(pre)}`)
  const red = pre.findings.filter((l) => l.code === 'RISK_HIGH' || l.code === 'RISK_CRITICAL')
  for (const l of red) console.log(`    ${l.code}: ${String(l.message).slice(0, 140)}`)
  assert('pre-report is red (a RISK_HIGH or RISK_CRITICAL line)', red.length > 0)
  assert("pre-report descriptor.source === 'none'", pre.descriptor.source === 'none')
  assert('pre-report has DEVICE_SHOWS_RAW_DATA', F.hasLimitation(pre, 'DEVICE_SHOWS_RAW_DATA'))

  console.log('\n  OWNER: the card offers Enable Advanced Mode - click Reject. Nothing should appear on the device.')
  const started = Date.now()
  let out, err
  try {
    out = await sdk.eth.ethSignTransaction(tx)
  } catch (e) {
    err = e
  }
  const elapsed = Date.now() - started
  console.log(`  answered after ${(elapsed / 1000).toFixed(1)} s: ${err ? `${err.status} ${String(err.message).slice(0, 160)}` : 'a result'}`)

  assert('no signature', !(out && (out.signature || out.v || out.r)))
  assert('no serialized tx', !(out && (out.serialized || out.serializedTx)))
  if (out) console.error(`  SIGNED: ${short(out.serialized || out.serializedTx)} (the gate let a blind call through)`)
  assert(`HTTP 403 '${REJECTED}'`, err?.status === 403 && String(err.message).includes(REJECTED))
  if (elapsed >= CARD_TIMEOUT_MS) {
    console.error(`  INCONCLUSIVE: ${(elapsed / 1000).toFixed(0)} s is the card timeout, not a Reject click`)
  }
  assert(`answered within ${CLICK_LIMIT_MS / 1000} s (a click, not the card timeout)`, elapsed < CLICK_LIMIT_MS)
})
