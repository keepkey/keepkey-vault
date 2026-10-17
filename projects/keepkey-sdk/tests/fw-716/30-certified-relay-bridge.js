#!/usr/bin/env node
/**
 * fw-716/30 — certified EVM schema (0x02 body, delegate keyId 0x80) attached by
 * Desktop itself signs with AdvancedMode off. 1 Desktop click + ~3-4 presses.
 *
 * The suite sends NO txMetadata: Desktop must fetch the production envelope and
 * attach it. The device then decodes depositor and orderId from the tx bytes.
 * Signs only, with SENTINEL_NONCE: the tx can never be mined.
 *
 * Expected device screens: "Verified by KeepKey" / bridgeDeposit / depositor
 * (this device) / orderId, then the amount and fee.
 */
const { run, atEnd, SENTINEL_NONCE, recoverEvm, short, skip } = require('../_helpers')
const F = require('./_fw716')

const SELECTOR = '0x49290c1c'

run('fw-716/30 certified Relay bridgeDeposit (AdvancedMode off, Desktop attaches)', async (getSdk, assert) => {
  const entry = await F.findEvmEntry({ kind: 'schema', chainId: 1, selector: SELECTOR, method: 'bridgeDeposit' })
  if (!entry) skip("no catalog entry 'Relay bridgeDeposit chain 1'")

  const { status, body } = await F.evmSchema(1, entry.contract, SELECTOR, 68)
  console.log(`  worker /v1/evm/schema: ${status} ${body?.classification} keyId=${body?.keyId} fingerprint=${body?.fingerprint}`)
  if (!F.isProductionEnvelope(body)) {
    skip(`'Relay bridgeDeposit chain 1' is not a production envelope (classification ${body?.classification}, fingerprint ${body?.fingerprint}, expected ${F.EXPECT_FINGERPRINT})`)
  }

  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  const { eth: device } = await F.deviceAddresses(sdk)
  console.log(`  device: ${device}`)
  atEnd(async () => {
    console.log(`\n  waiting ${F.FEATURES_WAIT_MS / 1000} s for Desktop's features cache...`)
    const on = F.advancedMode(await F.waitFeatures(sdk))
    if (on === false) return assert('AdvancedMode is still off at the end', true)
    const after = await F.restoreAdvancedMode(sdk)
    throw new Error(`AdvancedMode read ${on} at the end (now ${after}); this suite never turns it on`)
  })

  const data = SELECTOR + F.word(device) + F.word(F.randomHex(32))
  const tx = F.evmTx({ from: device, to: entry.contract, data, value: '0x' + (1e12).toString(16), chainId: 1 })

  const pre = await sdk.clearsign.report(F.reportBody(tx))
  F.assertDeviceConnected(assert, pre, 'pre-report')
  console.log(`  pre-report: ${F.describeReport(pre)}`)

  console.log('  OWNER: approve the Desktop card (do NOT enable Advanced Mode), then confirm on the device:')
  console.log(`    - "Verified by KeepKey" bridgeDeposit: depositor ${device} (this device), orderId`)
  console.log('    - the amount (0.000001 ETH) and fee confirm')
  let out
  try {
    out = await sdk.eth.ethSignTransaction(tx)
  } catch (e) {
    console.error(`  sign refused: ${String(e?.message || e).slice(0, 300)}`)
    assert('device signed bridgeDeposit', false)
    return
  }
  const serialized = out.serialized || out.serializedTx
  assert('returns a serialized envelope', !!serialized)
  if (!serialized) return
  const signed = recoverEvm(serialized)
  console.log(`  signed: ${short(serialized)} recovered ${signed.from}`)
  assert('signature recovers to the device', signed.from === device.toLowerCase())
  assert(`nonce is the sentinel ${SENTINEL_NONCE}`, signed.nonce === BigInt(SENTINEL_NONCE))
  assert('chainId 1', signed.chainId === 1)

  const r = out.clearSignReport
  assert('response carries clearSignReport', !!r)
  if (!r) return
  console.log(`  signed report: ${F.describeReport(r)}`)
  assert("descriptor.source === 'certified'", r.descriptor.source === 'certified')
  assert('descriptor.authenticated', r.descriptor.authenticated === true)
  assert('protectionLevel P4', r.protectionLevel === 'P4')
})
