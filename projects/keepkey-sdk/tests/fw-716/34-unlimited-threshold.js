#!/usr/bin/env node
/**
 * fw-716/34 — a native approve of 2^255 to an unknown spender signs with
 * AdvancedMode off (owner rule 2026-10-07: never refuse max). 1 Desktop click
 * + about 3-4 device presses.
 *
 * What the API proves: the signature, and that Desktop's report is red. That
 * red line is Desktop's own rule (any approve >= uint96-max to an unknown
 * spender, clearsign-risk.ts BOUND_LIMIT), not the 2^255 rule. Whether the
 * DEVICE shows "UNLIMITED" at 2^255 (ethereum.c ethereum_allowanceIsUnlimited
 * tests the top bit) is the owner's observation: NOT PROVEN by this suite.
 *
 * Chain-1 USDC (in the 7.16.0 token table, so native) approve(random unknown
 * spender, 2^255 = 0x80 followed by 31 zero bytes), value 0, SENTINEL_NONCE.
 * The random spender has no key anyone holds. Signs only: nothing is
 * broadcast and the tx can never be mined.
 */
const { run, atEnd, assertSignedByDevice, erc20Approve } = require('../_helpers')
const F = require('./_fw716')

const THRESHOLD = 1n << 255n

run('fw-716/34 native USDC approve of 2^255 signs with AdvancedMode off (device threshold owner-observed)', async (getSdk, assert) => {
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
  assert("pre-report has a red/critical finding (Desktop's uint96 rule)", red.length > 0)

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
  console.log('  NOT PROVEN by API: the device treating 2^255 as UNLIMITED. Owner: did the device show UNLIMITED?')
})
