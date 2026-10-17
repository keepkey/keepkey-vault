#!/usr/bin/env node
/**
 * fw-716/31 — certified intent (0x05 body, capability 5) on a Base USDC
 * transfer, AdvancedMode off, chainId 8453. 1 Desktop click + about 3-5
 * device presses.
 *
 * Base USDC is not in the 7.16.0 token table (FIRMWARE_TOKENS_716 has no Base
 * entries), so without the certified envelope the device would show raw data
 * and need AdvancedMode. Desktop must attach the catalog's 'Token transfer'
 * intent itself; the suite sends no txMetadata.
 *
 * transfer(this device, 1) = 0.000001 USDC to itself, value 0, SENTINEL_NONCE.
 * Signs only: nothing is broadcast and the tx can never be mined.
 */
const { run, atEnd, skip, assertSignedByDevice, erc20Transfer } = require('../_helpers')
const F = require('./_fw716')

const CHAIN = 8453

run('fw-716/31 certified intent: Base USDC transfer (AdvancedMode off, Desktop attaches)', async (getSdk, assert) => {
  const entry = await F.findEvmEntry({ kind: 'intent', chainId: CHAIN, contract: F.USDC_BASE, selector: '0xa9059cbb', title: 'Token transfer' })
  if (!entry) skip(`no catalog intent entry 'Base USDC transfer' (Token transfer, chain ${CHAIN}, ${F.USDC_BASE})`)
  console.log(`  catalog: ${entry.id} '${entry.title}': ${entry.intent}`)
  const env = await F.evmSchema(CHAIN, F.USDC_BASE, '0xa9059cbb', 68)
  console.log(`  worker /v1/evm/schema: ${env.status} ${env.body?.classification} keyId=${env.body?.keyId} fingerprint=${env.body?.fingerprint}`)

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

  const tx = F.evmTx({ from: device, to: F.USDC_BASE, data: erc20Transfer(device, 1), chainId: CHAIN, gasLimit: '0x186a0' })
  const pre = await sdk.clearsign.report(F.reportBody(tx))
  F.assertDeviceConnected(assert, pre, 'pre-report')
  console.log(`  pre-report: ${F.describeReport(pre)}`)
  if (F.hasLimitation(pre, 'DEVICE_SHOWS_RAW_DATA')) console.error('  pre-report has DEVICE_SHOWS_RAW_DATA: Desktop found no certified intent to attach')

  console.log('  OWNER: approve the Desktop card (do NOT enable Advanced Mode), then confirm on the device:')
  console.log(`    - "Token transfer": Send 0.000001 USDC to ${device} (this device), certified by KeepKey ClearSign`)
  console.log('    - the fee confirm')
  let out
  try {
    out = await sdk.eth.ethSignTransaction(tx)
  } catch (e) {
    console.error(`  sign refused: ${String(e?.message || e).slice(0, 300)}`)
    assert('device signed the transfer', false)
    return
  }
  assertSignedByDevice(assert, out, device, CHAIN)
  const r = out.clearSignReport
  assert('response carries clearSignReport', !!r)
  if (!r) return
  console.log(`  signed report: ${F.describeReport(r)}`)
  const certified = r.descriptor.source === 'certified'
  assert(`descriptor.source === 'certified'${certified ? '' : ` (read '${r.descriptor.source}': Desktop did not attach the certified intent)`}`, certified)
  assert('descriptor.authenticated', r.descriptor.authenticated === true)
  assert('protectionLevel P4', r.protectionLevel === 'P4')
})
