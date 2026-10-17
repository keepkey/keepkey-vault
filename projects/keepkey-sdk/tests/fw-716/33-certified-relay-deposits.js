#!/usr/bin/env node
/**
 * fw-716/33 — certified Relay intents (0x05 body, capability 5):
 * depositNative and depositErc20 with a pinned token, AdvancedMode off.
 * 2 Desktop clicks + about 6-10 device presses. Run with
 * KEEPKEY_SUITE_TIMEOUT_MS=360000 (it SKIPs below that).
 *
 * (a) depositNative(depositor = this device, id = random bytes32), 68 bytes,
 *     value 1e12 wei (0.000001 ETH).
 * (b) depositErc20(depositor = this device, token = USDC, amount 1,
 *     id = random bytes32), 132 bytes, value 0. USDC is the token the
 *     catalog entry pins.
 *
 * Chain 8453 (Base USDC); KK716_RELAY_CHAIN=42161 runs the Arbitrum entries
 * (Arbitrum USDC). Contract = the catalog's Relay Depository. SENTINEL_NONCE,
 * no txMetadata (Desktop attaches each envelope). Signs only: nothing is
 * broadcast and neither tx can ever be mined.
 */
const { run, atEnd, skip, notCovered, assertSignedByDevice } = require('../_helpers')
const F = require('./_fw716')

const MIN_BUDGET_MS = 360_000

const CHAIN = Number(process.env.KK716_RELAY_CHAIN || 8453)
const USDC = { 8453: F.USDC_BASE, 42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' }[CHAIN]
const SEL_NATIVE = '0x49290c1c'
const SEL_ERC20 = '0xe8017952'

run(`fw-716/33 certified Relay depositNative + depositErc20 on chain ${CHAIN} (AdvancedMode off)`, async (getSdk, assert) => {
  // Two signs with a person reading each screen: 3 min is not enough, and a
  // kill mid-sign leaves the device waiting on screens with no host.
  const budget = Number(process.env.KEEPKEY_SUITE_TIMEOUT_MS) || 180_000
  if (budget < MIN_BUDGET_MS) {
    skip(`needs KEEPKEY_SUITE_TIMEOUT_MS=${MIN_BUDGET_MS}: run-all.js would kill it at ${budget} ms mid-sign`)
  }
  if (!USDC) skip(`KK716_RELAY_CHAIN=${CHAIN}: only 8453 and 42161 are supported`)
  const native = await F.findEvmEntry({ kind: 'intent', chainId: CHAIN, selector: SEL_NATIVE, method: 'depositNative' })
  const erc20 = await F.findEvmEntry({ kind: 'intent', chainId: CHAIN, selector: SEL_ERC20, method: 'depositErc20', pinned: USDC })
  const cases = [
    {
      id: '(a)', name: 'depositNative', entry: native, selector: SEL_NATIVE, value: 10n ** 12n,
      missing: `no catalog entry 'Relay depositNative' (chain ${CHAIN}, selector ${SEL_NATIVE})`,
      screens: ['"Relay": Bridge 0.000001 ETH through Relay for this device; delivery is by Relay', 'the amount and fee confirm'],
    },
    {
      id: '(b)', name: 'depositErc20 USDC', entry: erc20, selector: SEL_ERC20, value: 0n, token: USDC,
      missing: `no catalog entry 'Relay depositErc20' (chain ${CHAIN}, selector ${SEL_ERC20}, token USDC ${USDC})`,
      screens: ['"Relay": Bridge 0.000001 USDC through Relay for this device; delivery is by Relay', 'the fee confirm'],
    },
  ]
  for (const c of cases) {
    if (!c.entry) c.skip = c.missing
    else console.log(`  ${c.id} catalog: ${c.entry.id} '${c.entry.title}': ${c.entry.intent}`)
  }
  if (cases.every((c) => c.skip)) skip(cases.map((c) => `${c.id} ${c.skip}`).join('; '))

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

  for (const c of cases) {
    console.log(`\n  ── ${c.id} ${c.name} ──`)
    if (c.skip) {
      notCovered(`${c.id}: ${c.skip}`)
      continue
    }
    const id = F.word(F.randomHex(32))
    const data = c.token
      ? c.selector + F.word(device) + F.word(c.token) + F.word('1') + id
      : c.selector + F.word(device) + id
    const env = await F.worker('/v1/evm/schema', {
      chainId: CHAIN, contract: c.entry.contract, selector: c.selector, calldataLength: (data.length - 2) / 2,
      ...(c.token ? { token: c.token } : {}),
    })
    console.log(`  worker /v1/evm/schema: ${env.status} ${env.body?.classification} entry=${env.body?.entry} keyId=${env.body?.keyId} fingerprint=${env.body?.fingerprint}`)

    const tx = F.evmTx({ from: device, to: c.entry.contract, data, value: '0x' + c.value.toString(16), chainId: CHAIN })
    const pre = await sdk.clearsign.report(F.reportBody(tx))
    F.assertDeviceConnected(assert, pre, `${c.id} pre-report`)
    console.log(`  pre-report: ${F.describeReport(pre)}`)
    if (F.hasLimitation(pre, 'DEVICE_SHOWS_RAW_DATA')) console.error('  pre-report has DEVICE_SHOWS_RAW_DATA: Desktop found no certified intent to attach')

    console.log('  OWNER: approve the Desktop card (do NOT enable Advanced Mode), then confirm on the device:')
    for (const s of c.screens) console.log(`    - ${s}`)
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
