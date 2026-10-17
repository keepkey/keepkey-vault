#!/usr/bin/env node
/**
 * fw-716/32 — certified intents (0x05 body, capability 5) for Base USDC
 * approvals, AdvancedMode off. 2 Desktop clicks + about 6-10 device presses.
 * Run with KEEPKEY_SUITE_TIMEOUT_MS=360000 (it SKIPs below that).
 *
 * (a) 'Token approval': approve(spender, 1e6 = 1 USDC). The catalog entry pins
 *     no spender today, so the spender is a Base Universal Router with a
 *     certified name record (0x6ff5693b…9b43), or the entry's pin if it has one.
 * (b) 'Shared approval': approve(Permit2, 2^256-1), UNLIMITED. On 7.16 the
 *     unlimited warning waits for a certified review that states the amount
 *     (SRS-7.16 R-7.4, ethereum.c unlimited_deferred); which screens appear is
 *     the owner's observation, never asserted.
 *
 * Both on chainId 8453, value 0, SENTINEL_NONCE. The suite sends no
 * txMetadata: Desktop attaches each envelope itself. Signs only: nothing is
 * broadcast and neither tx can ever be mined.
 */
const { run, atEnd, skip, assertSignedByDevice, erc20Approve } = require('../_helpers')
const F = require('./_fw716')

const MIN_BUDGET_MS = 360_000

const CHAIN = 8453
const UR_BASE_NAMED = '0x6ff5693b99212da76ad316178a184ab56d299b43'
const U256_MAX = (1n << 256n) - 1n

run('fw-716/32 certified intents: Base USDC Token approval + unlimited Shared approval to Permit2', async (getSdk, assert) => {
  // Two signs with a person reading each screen: 3 min is not enough, and a
  // kill mid-sign leaves the device waiting on screens with no host.
  const budget = Number(process.env.KEEPKEY_SUITE_TIMEOUT_MS) || 180_000
  if (budget < MIN_BUDGET_MS) {
    skip(`needs KEEPKEY_SUITE_TIMEOUT_MS=${MIN_BUDGET_MS}: run-all.js would kill it at ${budget} ms mid-sign`)
  }
  const bounded = await F.findEvmEntry({ kind: 'intent', chainId: CHAIN, contract: F.USDC_BASE, selector: '0x095ea7b3', title: 'Token approval' })
  const shared = await F.findEvmEntry({ kind: 'intent', chainId: CHAIN, contract: F.USDC_BASE, selector: '0x095ea7b3', title: 'Shared approval', pinned: F.PERMIT2 })
  const spender = bounded && (bounded.pinned || [])[0] ? bounded.pinned[0] : UR_BASE_NAMED
  const cases = [
    {
      id: '(a)', name: "'Token approval' 1 USDC", entry: bounded, spender, amount: 1_000_000n,
      missing: `no catalog intent entry 'Token approval' (Base USDC ${F.USDC_BASE})`,
      screens: [`"Token approval": Allow ${spender} to spend up to 1 USDC`, 'the fee confirm'],
    },
    {
      id: '(b)', name: "'Shared approval' UNLIMITED to Permit2", entry: shared, spender: F.PERMIT2, amount: U256_MAX,
      missing: `no catalog intent entry 'Shared approval' pinned to Permit2 (Base USDC ${F.USDC_BASE})`,
      // The catalog states no amount cap today; a capped entry would refuse UNLIMITED.
      refusesUnlimited: shared && (shared.maxAmount != null || shared.unlimited === false),
      screens: ['"Shared approval": Let Uniswap\'s shared approval contract ... spend up to UNLIMITED USDC', 'the fee confirm'],
    },
  ]
  for (const c of cases) {
    if (!c.entry) c.skip = c.missing
    else if (c.refusesUnlimited) c.skip = "the 'Shared approval' entry refuses unlimited amounts"
    else console.log(`  ${c.id} catalog: ${c.entry.id} '${c.entry.title}': ${c.entry.intent}`)
  }
  if (cases.every((c) => c.skip)) skip(cases.map((c) => `${c.id} ${c.skip}`).join('; '))

  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  const { eth: device } = await F.deviceAddresses(sdk)
  console.log(`  device: ${device}`)
  console.log(`  (a) spender: ${spender} (certified name: ${(await F.certifiedName(CHAIN, spender)) || 'none'})`)
  atEnd(async () => {
    console.log(`\n  waiting ${F.FEATURES_WAIT_MS / 1000} s for Desktop's features cache...`)
    const on = F.advancedMode(await F.waitFeatures(sdk))
    if (on === false) return assert('AdvancedMode is still off at the end', true)
    const after = await F.restoreAdvancedMode(sdk)
    throw new Error(`AdvancedMode read ${on} at the end (now ${after}); this suite never turns it on`)
  })

  for (const c of cases) {
    console.log(`\n  ── ${c.id} ${c.name} ──`)
    if (c.skip) {
      console.log(`  SKIPPED (${c.id} only): ${c.skip}`)
      continue
    }
    const env = await F.worker('/v1/evm/schema', { chainId: CHAIN, contract: F.USDC_BASE, selector: '0x095ea7b3', calldataLength: 68, spender: c.spender })
    console.log(`  worker /v1/evm/schema: ${env.status} ${env.body?.classification} entry=${env.body?.entry} keyId=${env.body?.keyId} fingerprint=${env.body?.fingerprint}`)

    const tx = F.evmTx({ from: device, to: F.USDC_BASE, data: erc20Approve(c.spender, c.amount), chainId: CHAIN, gasLimit: '0x186a0' })
    const pre = await sdk.clearsign.report(F.reportBody(tx))
    F.assertDeviceConnected(assert, pre, `${c.id} pre-report`)
    console.log(`  pre-report: ${F.describeReport(pre)}`)
    if (F.hasLimitation(pre, 'DEVICE_SHOWS_RAW_DATA')) console.error('  pre-report has DEVICE_SHOWS_RAW_DATA: Desktop found no certified intent to attach')

    console.log('  OWNER: approve the Desktop card (do NOT enable Advanced Mode), then confirm on the device:')
    for (const s of c.screens) console.log(`    - ${s}`)
    if (c.amount === U256_MAX) console.log('  OWNER: note whether UNLIMITED appeared, and whether before or after the certified review')
    let out
    try {
      out = await sdk.eth.ethSignTransaction(tx)
    } catch (e) {
      console.error(`  sign refused: ${String(e?.message || e).slice(0, 300)}`)
      assert(`${c.id} device signed`, false)
      continue
    }
    assertSignedByDevice(assert, out, device, CHAIN)
    const r = out.clearSignReport
    assert(`${c.id} response carries clearSignReport`, !!r)
    if (!r) continue
    console.log(`  signed report: ${F.describeReport(r)}`)
    assert(`${c.id} descriptor.source === 'certified'`, r.descriptor.source === 'certified')
    assert(`${c.id} protectionLevel P4`, r.protectionLevel === 'P4')
  }
})
