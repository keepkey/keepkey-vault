#!/usr/bin/env node
/**
 * fw-716/40 — ERC-7730 runtime review on released 7.16.0 with AdvancedMode
 * off (D-007), end to end. SKIP today; once production serves a definition:
 * 1 Desktop click + N device presses.
 *
 * Target: KK716_ERC7730_CALL='{"chainId":1,"to":"0x…","data":"0x…"}', or the
 * first _fw716.js candidate that is word-aligned, not an approve, has no
 * certified catalog entry for the same call (certified wins: one description
 * per transaction) and that the worker answers 200 for.
 *
 * The suite sends no definition: Desktop fetches it from the ClearSign service
 * and attaches it. Signs only, with SENTINEL_NONCE: the tx can never be mined.
 *
 * PASS: the pre-report says source 'erc7730'; the signature recovers to the
 * device; the response's clearSignReport says source 'erc7730' with no
 * ERC7730_DEFINITION_REFUSED limitation.
 */
const { run, skip, assertSignedByDevice, erc20Transfer } = require('../_helpers')
const F = require('./_fw716')

/** Desktop's rule (shared/erc7730-support.ts): approvals and calls whose
 *  arguments are not whole 32-byte words never get a definition. */
const REFUSED_SELECTORS = new Set(['0x095ea7b3', '0x39509351'])

/** Calldata for a candidate, from the device address. Amounts are 1 base unit. */
function candidateData(c, device) {
  if (c.id === 'a') return erc20Transfer(device, 1)
  // supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
  if (c.id === 'b') return c.selector + F.word(F.USDC_ETH) + F.word('1') + F.word(device) + F.word('0')
  throw new Error(`no calldata for candidate ${c.id}`)
}

/** KK716_ERC7730_CALL, checked. A malformed value is the operator's error: crash (FAIL). */
function envCall() {
  const raw = process.env.KK716_ERC7730_CALL
  if (!raw) return undefined
  const c = JSON.parse(raw)
  if (!Number.isSafeInteger(c.chainId) || c.chainId <= 0) throw new Error('KK716_ERC7730_CALL.chainId must be a positive integer')
  if (!/^0x[0-9a-fA-F]{40}$/.test(c.to || '')) throw new Error('KK716_ERC7730_CALL.to must be an address')
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(c.data || '') || c.data.length < 10) throw new Error('KK716_ERC7730_CALL.data must be hex calldata')
  const selector = c.data.slice(0, 10).toLowerCase()
  if (REFUSED_SELECTORS.has(selector)) throw new Error(`KK716_ERC7730_CALL: ${selector} is an approval; 7.16 refuses it with a definition`)
  if ((c.data.length - 10) % 64 !== 0) throw new Error('KK716_ERC7730_CALL: arguments are not whole 32-byte words')
  return { id: 'env', name: 'KK716_ERC7730_CALL', chainId: c.chainId, to: c.to.toLowerCase(), selector, data: c.data }
}

run('fw-716/40 ERC-7730 runtime review (AdvancedMode off)', async (getSdk, assert) => {
  // Pick the target from the worker alone: no Desktop contact before we know
  // something can attach.
  let target = envCall()
  if (target) {
    const probe = await F.probeErc7730(target)
    console.log(`  worker (env) chain ${target.chainId} ${target.to} ${target.selector}: ${probe.status} ${probe.code || ''}`)
    if (probe.status !== 200) skip(`production ERC-7730 route answers ${probe.status} ${probe.code || '-'}: no definition can attach on this device`)
    if (probe.body?.embeddedCalls === true) skip('the served definition has embedded calls: Desktop never sends these on 7.16')
  } else {
    const probed = await F.servedErc7730Candidates()
    for (const c of probed) {
      const certified = await F.findEvmEntry({ chainId: c.chainId, contract: c.to, selector: c.selector })
      c.eligible = c.wordAligned && !c.refused && !certified && c.probe.status === 200 && c.probe.body?.embeddedCalls !== true
      console.log(`  worker (${c.id}) ${c.name}: ${c.probe.status} ${c.probe.code || ''}${certified ? ` [certified ${certified.kind} covers it]` : ''}`)
    }
    target = probed.find((c) => c.eligible)
    if (!target) {
      const per = probed.map((c) => `${c.id}=${c.probe.status} ${c.probe.code || '-'}`).join(', ')
      skip(`production ERC-7730 route answers ${per}: no definition can attach on this device`)
    }
  }
  console.log(`  target: (${target.id}) ${target.name} chain ${target.chainId} ${target.to} ${target.selector}`)

  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  // The fallback card (device refused the definition) offers Advanced Mode.
  F.guardAdvancedModeOff(sdk, assert)
  const { eth: device } = await F.deviceAddresses(sdk)
  console.log(`  device: ${device}`)

  const data = target.data || candidateData(target, device)
  const tx = F.evmTx({ from: device, to: target.to, data, value: '0x0', chainId: target.chainId })

  const pre = await sdk.clearsign.report(F.reportBody(tx))
  F.assertDeviceConnected(assert, pre, 'pre-report')
  console.log(`  pre-report: ${F.describeReport(pre)}`)
  assert("pre-report: Desktop attached the definition (source 'erc7730')", pre.descriptor.source === 'erc7730')
  if (pre.descriptor.source !== 'erc7730') {
    console.error("  worker serves it, Desktop did not attach. Check the Desktop log for '[erc7730] ... not attached (<reason>)'. Not signing.")
    return
  }

  console.log('  OWNER: Desktop shows one card describing the call (no Advanced Mode offer): Approve.')
  console.log(`         Device: the ${target.name} review built from the ERC-7730 definition, then amount and fee: confirm each.`)
  console.log('         If Desktop shows a SECOND card for the same call (now a blind call, offering Advanced Mode): click Reject.')
  console.log('         That card means the device refused the definition: FAIL.')
  let out
  try {
    out = await sdk.eth.ethSignTransaction(tx)
  } catch (e) {
    const msg = String(e?.message || e)
    assert(`signed with the ERC-7730 definition (got: ${msg.slice(0, 160)})`, false)
    if (/rejected by user/i.test(msg)) {
      console.error('  A card was rejected. If it was the second card, the device refused the ERC-7730 definition (see the Desktop log line "[REST] the device refused the ERC-7730 definition (<reason>)").')
    }
    return
  }

  assertSignedByDevice(assert, out, device, target.chainId)

  const r = out.clearSignReport
  assert('response carries clearSignReport', !!r)
  if (!r) return
  console.log(`  signed report: ${F.describeReport(r)}`)
  const refused = r.limitations.find((l) => l.code === 'ERC7730_DEFINITION_REFUSED')
  assert(`no ERC7730_DEFINITION_REFUSED${refused ? ` (${refused.message})` : ''}`, !refused)
  assert("signed report: descriptor.source === 'erc7730'", r.descriptor.source === 'erc7730')
  console.log(`  signed report: protectionLevel ${r.protectionLevel}, authenticated ${r.descriptor.authenticated} (printed, not asserted)`)
})
