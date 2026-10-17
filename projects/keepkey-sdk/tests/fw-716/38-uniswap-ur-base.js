#!/usr/bin/env node
/**
 * fw-716/38 — certified Uniswap Universal Router decoder (uniswap_ur.c) on a
 * Base catalog router, AdvancedMode off. 1 Desktop click + about 4-6 presses.
 *
 * execute(0x3593564c) with one V3_SWAP_EXACT_IN: 0.01 USDC -> WETH, pool fee
 * 500, recipient this device, amountOutMinimum 1, payerIsUser, deadline
 * now+30 min, value 0, SENTINEL_NONCE. Desktop must attach the certified 0x07
 * swap entry itself (findCertifiedUniswapSwap); the device decodes the swap
 * from the tx bytes and shows it. Signs only: nothing is broadcast.
 *
 * The calldata was checked offline against Desktop's urPrecheck
 * (src/bun/uniswap-ur.ts) and the independent decoder in stock-716
 * scripts/uniswap/gen_ur_vectors.py (decode_plan + summarize): both accept it.
 *
 * Expected device screens: "Verified by KeepKey" Uniswap swap, pay 0.01 USDC,
 * receive at least 0.000000000000000001 WETH, "Output goes to" this device,
 * then the fee confirm.
 */
const { run, atEnd, skip, assertSignedByDevice } = require('../_helpers')
const F = require('./_fw716')

const UR_BASE = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad'
const WETH_BASE = '0x4200000000000000000000000000000000000006'
const UR_EXECUTE = '0x3593564c'

const pad32 = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')

/** execute(bytes commands, bytes[] inputs, uint256 deadline) with one
 *  V3_SWAP_EXACT_IN (command 0x00). Its input is
 *  abi.encode(address recipient, uint256 amountIn, uint256 amountOutMin,
 *  bytes path, bool payerIsUser); path = tokenIn | fee(3 bytes) | tokenOut. */
function urV3ExactIn({ recipient, amountIn, minOut, tokenIn, fee, tokenOut, deadline }) {
  const path = tokenIn.replace(/^0x/, '') + fee.toString(16).padStart(6, '0') + tokenOut.replace(/^0x/, '')
  const input = F.word(recipient) + F.word(BigInt(amountIn).toString(16)) + F.word(BigInt(minOut).toString(16))
    + F.word('a0') + F.word('1') + F.word((path.length / 2).toString(16)) + pad32(path)
  const commands = F.word('1') + pad32('00')
  const inputs = F.word('1') + F.word('20') + F.word((input.length / 2).toString(16)) + input
  return UR_EXECUTE + F.word('60') + F.word((0x60 + commands.length / 2).toString(16))
    + F.word(deadline.toString(16)) + commands + inputs
}

/** The swap this suite signs, for `device`. 03 (shape M) sends the same bytes elsewhere. */
function baseSwapCalldata(device) {
  return urV3ExactIn({
    recipient: device, amountIn: 10_000n, minOut: 1n, tokenIn: F.USDC_BASE, fee: 500, tokenOut: WETH_BASE,
    deadline: Math.floor(Date.now() / 1000) + 30 * 60,
  })
}

function main() {
  run('fw-716/38 certified Uniswap UR swap on Base (AdvancedMode off, Desktop attaches)', async (getSdk, assert) => {
    const lc = (x) => String(x || '').toLowerCase()
    const entry = (await F.catalogEntries()).find((e) => e.kind === 'uniswap-ur' && e.chainId === 8453
      && lc(e.contract) === UR_BASE && lc(e.selector) === UR_EXECUTE
      && [F.USDC_BASE, WETH_BASE].every((t) => (e.tokens || []).some((x) => lc(x.address) === t)))
    if (!entry) skip(`no catalog entry for router ${UR_BASE} (Base) with the token pair USDC ${F.USDC_BASE} / WETH ${WETH_BASE}`)
    console.log(`  catalog: ${entry.id} tokens ${entry.tokens.map((t) => t.symbol).join('/')}`)

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

    const tx = F.evmTx({ from: device, to: UR_BASE, data: baseSwapCalldata(device), chainId: 8453, gasLimit: '0x61a80' })
    const pre = await sdk.clearsign.report(F.reportBody(tx))
    F.assertDeviceConnected(assert, pre, 'pre-report')
    console.log(`  pre-report: ${F.describeReport(pre)}`)
    const preRaw = F.hasLimitation(pre, 'DEVICE_SHOWS_RAW_DATA')
    assert(`pre-report: no DEVICE_SHOWS_RAW_DATA${preRaw ? ' (findCertifiedUniswapSwap did not attach)' : ''}`, !preRaw)

    console.log('  OWNER: approve the Desktop card (do NOT enable Advanced Mode), then confirm on the device:')
    console.log('    - "Verified by KeepKey" Uniswap swap: pay 0.01 USDC, receive at least 0.000000000000000001 WETH')
    console.log(`    - "Output goes to" ${device} (this device)`)
    console.log('    - the fee confirm')
    let out
    try {
      out = await sdk.eth.ethSignTransaction(tx)
    } catch (e) {
      console.error(`  sign refused: ${String(e?.message || e).slice(0, 300)}`)
      assert('device signed the swap', false)
      return
    }
    assertSignedByDevice(assert, out, device, 8453)
    const r = out.clearSignReport
    assert('response carries clearSignReport', !!r)
    if (!r) return
    console.log(`  signed report: ${F.describeReport(r)}`)
    const certified = r.descriptor.source === 'certified'
    assert(`descriptor.source === 'certified'${certified ? '' : ` (read '${r.descriptor.source}': findCertifiedUniswapSwap did not attach)`}`, certified)
    assert('descriptor.authenticated', r.descriptor.authenticated === true)
    assert('protectionLevel P4', r.protectionLevel === 'P4')
  })
}

if (require.main === module) main()
module.exports = { urV3ExactIn, baseSwapCalldata, UR_BASE, WETH_BASE }
