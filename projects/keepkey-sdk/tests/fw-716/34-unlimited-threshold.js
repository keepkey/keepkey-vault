#!/usr/bin/env node
/**
 * fw-716/34 — on 7.16 "unlimited" means an allowance >= 2^255 (ERC-7730's
 * threshold; ethereum.c ethereum_allowanceIsUnlimited tests the top bit), not
 * only all-ff. A native unlimited approve to an unknown spender warns and
 * still signs (owner rule 2026-10-07: never refuse max). 1 Desktop click +
 * about 3-4 device presses.
 *
 * Chain-1 USDC (in the 7.16.0 token table, so native) approve(random unknown
 * spender, 2^255 = 0x80 followed by 31 zero bytes), value 0, SENTINEL_NONCE.
 * The random spender has no key anyone holds. Signs only: nothing is
 * broadcast and the tx can never be mined.
 */
const { run, atEnd, assertSignedByDevice, erc20Approve } = require('../_helpers')
const F = require('./_fw716')

const THRESHOLD = 1n << 255n

run('fw-716/34 unlimited threshold 2^255: native USDC approve to an unknown spender warns and signs', async (getSdk, assert) => {
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

  const spender = F.randomAddress()
  const data = erc20Approve(spender, THRESHOLD)
  assert('amount word is 0x80 followed by 31 zero bytes', data.slice(74) === '80' + '0'.repeat(62))
  const tx = F.evmTx({ from: device, to: F.USDC_ETH, data, chainId: 1, gasLimit: '0x186a0' })
  console.log(`  spender ${spender} (random, unknown)`)

  const pre = await sdk.clearsign.report(F.reportBody(tx))
  F.assertDeviceConnected(assert, pre, 'pre-report')
  console.log(`  pre-report: ${F.describeReport(pre)}`)
  const red = pre.findings.filter((l) => l.code === 'RISK_HIGH' || l.code === 'RISK_CRITICAL')
  for (const l of red) console.log(`    ${l.code}: ${String(l.message).slice(0, 140)}`)
  assert('pre-report has a red/critical finding', red.length > 0)

  console.log('  OWNER: approve the Desktop card (do NOT enable Advanced Mode), then confirm on the device:')
  console.log(`    - "UNLIMITED approval": Allow ${spender} to spend ALL your USDC`)
  console.log('    - the approve review and the fee confirm')
  console.log('  OWNER: note whether the device showed UNLIMITED')
  let out
  try {
    out = await sdk.eth.ethSignTransaction(tx)
  } catch (e) {
    console.error(`  sign refused: ${String(e?.message || e).slice(0, 300)}  <- 'never refuse max' says it must sign`)
    assert('device signed the unlimited approve', false)
    return
  }
  assertSignedByDevice(assert, out, device, 1)
  const r = out.clearSignReport
  assert('response carries clearSignReport', !!r)
  if (!r) return
  console.log(`  signed report: ${F.describeReport(r)}`)
  assert("descriptor.source === 'native'", r.descriptor.source === 'native')
})
