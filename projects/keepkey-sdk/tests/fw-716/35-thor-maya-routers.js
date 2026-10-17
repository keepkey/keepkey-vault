#!/usr/bin/env node
/**
 * fw-716/35 — THORChain Base and Maya Arbitrum deposits clear-sign natively
 * with AdvancedMode off. 2 Desktop clicks; about 9 device presses for (a) and 8
 * for (b) (router, vault, amount, [expiry], 3 swap screens, raw memo, final).
 * Run with KEEPKEY_SUITE_TIMEOUT_MS=360000 (it SKIPs below that).
 *
 * Released 7.16.0 pins THOR/Maya routers by (chainId, address), the same table
 * as 7.15 b6 (stock-716 lib/firmware/ethereum_contracts/thortx.c):
 *   Base 8453      THOR_ROUTER_BASE 0x00dc6100…f1d4 (THORChain_RouterV6)
 *   Arbitrum 42161 MAYA_ROUTER_ARB  0x700e97ef…11f4 (classic router)
 * Desktop's mirror (calldata-decoder.ts firmwareClearSigns) modelled the old
 * 7.16 line (ETH/AVAX only) until 3d94fda03 and reported these deposits as raw
 * data that needs Advanced Mode. Pass = Desktop reports source 'native' at P4
 * and the device signs; a refusal is a FAIL.
 *
 * (a) depositWithExpiry on Base: memo offset 0xa0, expiry now+3600, amount ==
 *     value (RouterV6 refuses a native amount that differs from value).
 * (b) deposit on Arbitrum (Maya): memo offset 0x80, amount == value.
 * vault = this device, asset = 0x0 (native), value 1e12 wei. Signs only, with
 * SENTINEL_NONCE: neither transaction can ever be mined. Nothing is broadcast.
 */
const { run, atEnd, skip, assertSignedByDevice } = require('../_helpers')
const F = require('./_fw716')

const THOR_ROUTER_BASE = '0x00dc6100103bc402d490aee3f9a5560cbd91f1d4'
const MIN_BUDGET_MS = 360_000
const MAYA_ROUTER_ARB = '0x700e97ef07219440487840dc472e7120a7ff11f4'
const SEL_DEPOSIT = '0x1fece7b4' // deposit(address,address,uint256,string)
const SEL_DEPOSIT_EXPIRY = '0x44bc937b' // depositWithExpiry(address,address,uint256,string,uint256)
const VALUE = 10n ** 12n // 0.000001 ETH

/** Canonical ABI as thor_confirm_deposit_tx requires it: head words, memo
 *  offset (0x80, or 0xa0 with expiry), then the memo length and the
 *  zero-padded memo ending exactly at the calldata end. */
function depositCalldata({ vault, amount, memo, expiry }) {
  const memoHex = Buffer.from(memo, 'ascii').toString('hex')
  const padded = memoHex.padEnd(Math.ceil(memoHex.length / 64) * 64, '0')
  const head = F.word(vault) + F.word('0') + F.word(amount.toString(16))
  const tail = F.word(memo.length.toString(16)) + padded
  return expiry === undefined
    ? SEL_DEPOSIT + head + F.word('80') + tail
    : SEL_DEPOSIT_EXPIRY + head + F.word('a0') + F.word(expiry.toString(16)) + tail
}

/** Desktop's "needs Advanced Mode" wording (evm-presign-report.ts, clearsign-risk.ts). */
const NEEDS_ADVANCED = /(needs|requires) Advanced Mode/i

/** The native verdict, for the pre-report and the signed report alike. */
function assertNative(assert, r, label) {
  console.log(`  ${label}: ${F.describeReport(r)}`)
  assert(`${label}: descriptor.source === 'native'`, r.descriptor.source === 'native')
  assert(`${label}: descriptor.authenticated`, r.descriptor.authenticated === true)
  assert(`${label}: protectionLevel P4`, r.protectionLevel === 'P4')
  assert(`${label}: no DEVICE_SHOWS_RAW_DATA`, !F.hasLimitation(r, 'DEVICE_SHOWS_RAW_DATA'))
  const adv = [...r.findings, ...r.limitations].filter((l) => NEEDS_ADVANCED.test(l.message))
  for (const l of adv) console.error(`    ${l.code}: ${l.message}`)
  assert(`${label}: no 'needs Advanced Mode' line`, adv.length === 0)
}

function main() {
  run('fw-716/35 THOR Base + Maya Arbitrum router deposits (AdvancedMode off, native)', async (getSdk, assert) => {
    // Two signs of ~9 and ~8 screens: a kill mid-sign leaves the device
    // waiting on screens with no host.
    const budget = Number(process.env.KEEPKEY_SUITE_TIMEOUT_MS) || 180_000
    if (budget < MIN_BUDGET_MS) {
      skip(`needs KEEPKEY_SUITE_TIMEOUT_MS=${MIN_BUDGET_MS}: run-all.js would kill it at ${budget} ms mid-sign`)
    }
    const sdk = await getSdk()
    const f = await sdk.system.info.getFeatures()
    const version = `${f.major_version}.${f.minor_version}.${f.patch_version}`
    console.log(`  firmware ${version}, label ${f.label}`)
    assert(`firmware ${version} pins the Base/Arbitrum routers (7.15+)`,
      Number(f.major_version) > 7 || (Number(f.major_version) === 7 && Number(f.minor_version) >= 15))
    await F.requireAdvancedModeOff(sdk, assert)
    const { eth: device } = await F.deviceAddresses(sdk)
    console.log(`  device: ${device}`)

    // Last step, also after a crash: AdvancedMode must still be off. If it
    // reads on (an Enable click on a card), turn it off and FAIL.
    atEnd(async () => {
      console.log(`\n  waiting ${F.FEATURES_WAIT_MS / 1000} s for Desktop's features cache...`)
      const on = F.advancedMode(await F.waitFeatures(sdk))
      if (on === false) return assert('AdvancedMode is still off at the end', true)
      const after = await F.restoreAdvancedMode(sdk)
      throw new Error(`AdvancedMode read ${on} at the end (now ${after}); this suite never turns it on`)
    })

    const expiry = Math.floor(Date.now() / 1000) + 3600
    const vaultHex = device.slice(2).toLowerCase()
    const cases = [
      {
        name: '(a) THOR depositWithExpiry on Base', chainId: 8453, to: THOR_ROUTER_BASE,
        data: depositCalldata({ vault: device, amount: VALUE, memo: `=:BASE.ETH:${device}`, expiry }),
        screens: [
          'Thorchain data: "Routing through Thorchain router"',
          `Thorchain data: "Pays UNVERIFIED vault ${vaultHex}" (this device)`,
          'Thorchain data: "Confirm sending 0.000001 ETH"',
          `Thorchain data: "Expiry epoch ${expiry}"`,
          'Thorchain swap: "Confirm swap asset ETH on chain BASE", "Confirm to <this device>", "Confirm limit none"',
          'Memo: the raw memo, paged',
          'the final amount + fee confirm',
        ],
      },
      {
        name: '(b) Maya deposit on Arbitrum', chainId: 42161, to: MAYA_ROUTER_ARB,
        data: depositCalldata({ vault: device, amount: VALUE, memo: `=:ARB.ETH:${device}` }),
        screens: [
          'Maya data: "Routing through Maya router"',
          `Maya data: "Pays UNVERIFIED vault ${vaultHex}" (this device)`,
          'Maya data: "Confirm sending 0.000001 ETH"',
          'Thorchain swap: "Confirm swap asset ETH on chain ARB", "Confirm to <this device>", "Confirm limit none"',
          'Memo: the raw memo, paged',
          'the final amount + fee confirm',
        ],
      },
    ]

    for (const c of cases) {
      console.log(`\n  ── ${c.name} (chainId ${c.chainId}, router ${c.to}) ──`)
      const tx = F.evmTx({ from: device, to: c.to, data: c.data, value: '0x' + VALUE.toString(16), chainId: c.chainId })

      const pre = await sdk.clearsign.report(F.reportBody(tx))
      F.assertDeviceConnected(assert, pre, 'pre-report')
      assertNative(assert, pre, 'pre-report')

      console.log('  OWNER: approve the Desktop card (do NOT enable Advanced Mode), then confirm on the device:')
      for (const s of c.screens) console.log(`    - ${s}`)
      let out
      try {
        out = await sdk.eth.ethSignTransaction(tx)
      } catch (e) {
        const msg = String(e?.message || e)
        console.error(`  sign refused: ${msg}${/advanced/i.test(msg) ? "  <- the 'needs Advanced Mode' refusal" : ''}`)
        assert(`${c.name}: device signed`, false)
        continue
      }
      assertSignedByDevice(assert, out, device, c.chainId)
      const r = out.clearSignReport
      assert('response carries clearSignReport', !!r)
      if (r) assertNative(assert, r, 'signed report')
    }
  })
}

if (require.main === module) main()
module.exports = { depositCalldata, THOR_ROUTER_BASE, MAYA_ROUTER_ARB, SEL_DEPOSIT, SEL_DEPOSIT_EXPIRY }
