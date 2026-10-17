#!/usr/bin/env node
/**
 * fw-716/02 — ERC-7730: does production serve any calldata definition for this
 * production-root device, and does Desktop attach it? No presses.
 *
 * Per candidate (_fw716.js ERC7730_CANDIDATES):
 *   1. GET {worker}/v1/erc7730/definition: HTTP status and body.code.
 *   2. POST /clearsign/report for the same call from the device address:
 *      descriptor.source and the limitation codes. The report does no device
 *      I/O; it writes one local audit-demand row to the Desktop DB.
 *
 * PASS only when a decisive candidate is served (word-aligned, not an
 * approve, no certified catalog entry for the same call, no embedded calls)
 * and its report says descriptor.source === 'erc7730'. A served decisive
 * candidate without it FAILs: "worker serves it, Desktop did not attach".
 *
 * A certified catalog entry for the same call (Base USDC transfer is a
 * certified 'Token transfer' intent) wins over ERC-7730: Desktop sends one
 * description per transaction. Such a candidate is printed, never decisive.
 *
 * (c) approve and (d) non-word-aligned must never report 'erc7730'. A breach
 * FAILs; holding is printed and never counted as a pass (it holds trivially
 * while nothing is served).
 *
 * SKIP (exit 3) while no decisive candidate answers 200. On 2026-10-16 every
 * candidate answered 422 NOT_IN_SIGNED_CATALOG.
 */
const { run, skip, ETH_PATH, erc20Transfer, erc20Approve } = require('../_helpers')
const F = require('./_fw716')

/** Calldata for each candidate, from the device address. Amounts are 1 base unit. */
function candidateData(c, device) {
  switch (c.id) {
    case 'a': return erc20Transfer(device, 1)
    // supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
    case 'b': return c.selector + F.word(F.USDC_ETH) + F.word('1') + F.word(device) + F.word('0')
    case 'c': return erc20Approve(F.PERMIT2, 1)
    // transfer(device, 1) plus one stray byte: arguments are not whole words.
    case 'd': return erc20Transfer(device, 1) + '00'
    default: throw new Error(`no calldata for candidate ${c.id}`)
  }
}

/** A check that may only FAIL: holding prints a note and is not counted. */
function mustHold(assert, label, ok) {
  if (ok) console.log(`  (holds, not counted) ${label}`)
  else assert(label, false)
}

run('fw-716/02 ERC-7730 availability (zero press)', async (getSdk, assert) => {
  const probed = await F.servedErc7730Candidates()
  for (const c of probed) {
    c.certified = await F.findEvmEntry({ chainId: c.chainId, contract: c.to, selector: c.selector })
    c.embedded = c.probe.status === 200 && c.probe.body?.embeddedCalls === true
    c.decisive = c.wordAligned && !c.refused && !c.certified && !c.embedded
    console.log(`  worker (${c.id}) ${c.name}: ${c.probe.status} ${c.probe.code || ''}`
      + `${c.certified ? ` [certified ${c.certified.kind} '${c.certified.title || c.certified.method}' covers this call]` : ''}`
      + `${c.embedded ? ' [embeddedCalls: Desktop never sends these]' : ''}`)
  }

  const sdk = await getSdk()
  const f = await sdk.system.info.getFeatures()
  const version = `${f.major_version}.${f.minor_version}.${f.patch_version}`
  const caps = Array.isArray(f.capabilities) ? f.capabilities : undefined
  console.log(`  firmware ${version}, capabilities ${caps ? `[${caps.join(', ')}]` : '(not reported by this Desktop build)'}`)
  const device = (await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })).address
  console.log(`  device: ${device}\n`)

  for (const c of probed) {
    const report = await sdk.clearsign.report({
      chain: 'evm', chainId: c.chainId, from: device, to: c.to, data: candidateData(c, device), value: '0x0',
    })
    c.source = report.descriptor?.source
    console.log(`  report (${c.id}): ${F.describeReport(report)}`)
    mustHold(assert, `(${c.id}) Desktop saw the device`, !F.hasLimitation(report, 'DEVICE_NOT_CONNECTED'))
  }
  console.log('')

  // Desktop must never attach a definition the device refuses.
  for (const c of probed.filter((x) => x.refused || !x.wordAligned)) {
    mustHold(assert, `(${c.id}) ${c.name}: source is not 'erc7730' (got ${c.source})`, c.source !== 'erc7730')
  }

  const served = probed.filter((c) => c.probe.status === 200)
  const decisive = served.filter((c) => c.decisive)
  if (decisive.length === 0) {
    const per = probed.map((c) => `${c.id}=${c.probe.status} ${c.probe.code || '-'}`).join(', ')
    if (served.length === 0) skip(`ERC-7730 not served by production: ${per}`)
    skip(`ERC-7730 served only for calls this suite cannot decide (${served.map((c) => c.id).join(', ')}: approve, non-word-aligned, certified-covered or embedded): ${per}`)
  }

  if (f.major_version < 7 || (f.major_version === 7 && f.minor_version < 16)) {
    skip(`firmware ${version} predates ERC-7730 (7.16.0)`)
  }
  if (caps && !caps.includes(4)) skip(`device does not report capability 4 (ERC-7730 runtime review): [${caps.join(', ')}]`)

  for (const c of decisive) {
    assert(`(${c.id}) ${c.name}: served and Desktop attached it (source 'erc7730')`, c.source === 'erc7730')
    if (c.source !== 'erc7730') {
      console.error(`  (${c.id}) worker serves it, Desktop did not attach (source ${c.source}). Check the Desktop log for '[erc7730] ... not attached (<reason>)'.`)
    }
  }
})
