#!/usr/bin/env node
/**
 * fw-716/03 — Desktop's verdict for 15 call shapes against the connected
 * 7.16.0 device. No presses, no card, no signing: POST /clearsign/report only
 * (Desktop runs its own simulation RPC calls and logs audit-demand rows).
 *
 * Checks the three-level verdict and "Danger only when not normal" (owner rule
 * 2026-10-11), the tightened firmwareClearSigns mirror, the 7.16 THOR/Maya pin
 * mirror (3d94fda03), certified Universal Router attach only on catalog
 * routers, and the 7.16 token table (chain-1 USDC native, Base USDC not).
 *
 * "Red" here means a Desktop risk-bar line (code RISK_HIGH or RISK_CRITICAL;
 * src/shared/clearsign-risk.ts levels high/critical, report severity
 * 'danger'). Simulation lines such as SIMULATION_REVERTED depend on this
 * wallet's balances, so they are printed, never counted as the verdict.
 *
 * The external /clearsign/report gives P4 only to calls the firmware shows
 * natively; a certified attach shows as "no DEVICE_SHOWS_RAW_DATA" with
 * source 'none' (the device verifies the description at signing).
 */
const { run, erc20Transfer, erc20Approve } = require('../_helpers')
const F = require('./_fw716')
const { depositCalldata, THOR_ROUTER_BASE, MAYA_ROUTER_ARB } = require('./35-thor-maya-routers')
const { baseSwapCalldata, WETH_BASE } = require('./38-uniswap-ur-base')

const RELAY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const ZX_PROXY = '0xdef1c0ded9bec7f1a1670819833240f027b25eff'
const UNI_V2_ROUTER = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
const ACROSS_SPOKE_BASE = '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64'
const WETH_ETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const LEVELS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5']
const U256_MAX = (1n << 256n) - 1n

const hex = (n) => '0x' + BigInt(n).toString(16)
const riskRed = (r) => r.findings.filter((l) => l.code === 'RISK_HIGH' || l.code === 'RISK_CRITICAL')
const raw = (r) => F.hasLimitation(r, 'DEVICE_SHOWS_RAW_DATA')
const native = (r) => r.descriptor.source === 'native'

/** sellToUniswap(address[] tokens, uint256 sellAmount, uint256 minBuyAmount, bool isSushi). */
function zxSellToUniswap(tokens, sellAmount, minBuy) {
  return '0xd9627aa4' + F.word('80') + F.word(hex(sellAmount)) + F.word(hex(minBuy)) + F.word('0')
    + F.word(hex(tokens.length)) + tokens.map(F.word).join('')
}

/** removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, to, deadline): 196 bytes. */
function removeLiquidityETH(token, to, deadline) {
  return '0x02751cec' + F.word(token) + F.word(hex(1000)) + F.word('1') + F.word('1') + F.word(to) + F.word(hex(deadline))
}

/** depositV3(depositor, recipient, inputToken, outputToken, inputAmount, outputAmount,
 *  destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter, message). */
function acrossDepositV3({ depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, now }) {
  return '0x7b939232' + [depositor, recipient, inputToken, outputToken].map(F.word).join('')
    + F.word(hex(inputAmount)) + F.word(hex(outputAmount)) + F.word(hex(destinationChainId)) + F.word('0')
    + F.word(hex(now)) + F.word(hex(now + 3600)) + F.word('0') + F.word(hex(12 * 32)) + F.word('0')
}

/** The 15 shapes for this device: [id, title, request, checks(report) ->
 *  [[label, ok]], skipReason?]. Builds calldata only: no I/O. */
function shapes(device, relayEntry, now) {
  const thorData = depositCalldata({ vault: F.randomAddress(), amount: 10n ** 12n, memo: `=:ETH.ETH:${device}:1`, expiry: now + 3600 })

  return [
    ['A', 'native ETH send to self, chain 1', { chainId: 1, to: device, data: '0x', value: hex(10n ** 12n) },
      (r) => [["source 'native'", native(r)], ['P4', r.protectionLevel === 'P4'], ['no DEVICE_SHOWS_RAW_DATA', !raw(r)]]],
    ['B', 'Relay bridgeDeposit, chain 1, catalog contract',
      { chainId: 1, to: relayEntry?.contract || RELAY, data: '0x49290c1c' + F.word(device) + F.word(F.randomHex(32)), value: hex(10n ** 12n) },
      (r) => [['no DEVICE_SHOWS_RAW_DATA (certified attach)', !raw(r)]],
      relayEntry ? undefined : "no catalog entry 'Relay bridgeDeposit chain 1'"],
    ['C', 'THOR depositWithExpiry on the Base V6 router', { chainId: 8453, to: THOR_ROUTER_BASE, data: thorData, value: hex(10n ** 12n) },
      (r) => [["source 'native'", native(r)], ['P4', r.protectionLevel === 'P4'], ['no DEVICE_SHOWS_RAW_DATA', !raw(r)]]],
    ['D', 'the same THOR calldata on 8453 to a non-pinned contract', { chainId: 8453, to: F.randomAddress(), data: thorData, value: hex(10n ** 12n) },
      (r) => [['DEVICE_SHOWS_RAW_DATA present', raw(r)], ["source 'none'", r.descriptor.source === 'none']]],
    ['E', 'Maya deposit on the Arbitrum router',
      { chainId: 42161, to: MAYA_ROUTER_ARB, data: depositCalldata({ vault: F.randomAddress(), amount: 10n ** 12n, memo: `=:ETH.ETH:${device}:1` }), value: hex(10n ** 12n) },
      (r) => [["source 'native'", native(r)], ['P4', r.protectionLevel === 'P4'], ['no DEVICE_SHOWS_RAW_DATA', !raw(r)]]],
    ['F1', 'chain-1 USDC transfer, value 0', { chainId: 1, to: F.USDC_ETH, data: erc20Transfer(device, 1), value: '0x0' },
      (r) => [["source 'native'", native(r)], ['no DEVICE_SHOWS_RAW_DATA', !raw(r)]]],
    ['F2', 'chain-1 USDC transfer, value 1 wei', { chainId: 1, to: F.USDC_ETH, data: erc20Transfer(device, 1), value: '0x1' },
      (r) => [['DEVICE_SHOWS_RAW_DATA present', raw(r)], ['a red finding', riskRed(r).length > 0]]],
    ['G', '0x sellToUniswap on Base (no Base tokens in the 7.16 table)',
      { chainId: 8453, to: ZX_PROXY, data: zxSellToUniswap([F.USDC_BASE, WETH_BASE], 10_000, 1), value: '0x0' },
      (r) => [['DEVICE_SHOWS_RAW_DATA present', raw(r)]]],
    ['H', 'V2 removeLiquidityETH, 196 bytes, value 1 wei',
      { chainId: 1, to: UNI_V2_ROUTER, data: removeLiquidityETH(F.USDC_ETH, device, now + 1800), value: '0x1' },
      (r) => [['DEVICE_SHOWS_RAW_DATA present', raw(r)]]],
    ['I', 'Across depositV3 on the Base SpokePool (Base WETH -> Ethereum WETH, to self)',
      { chainId: 8453, to: ACROSS_SPOKE_BASE, value: hex(10n ** 12n),
        data: acrossDepositV3({ depositor: device, recipient: device, inputToken: WETH_BASE, outputToken: WETH_ETH,
          inputAmount: 10n ** 12n, outputAmount: 999n * 10n ** 9n, destinationChainId: 1, now }) },
      (r) => [['DEVICE_SHOWS_RAW_DATA present', raw(r)], ['no red/critical finding (known protocol)', riskRed(r).length === 0]]],
    ['J', 'chain-1 USDC approve 1 USDC to Permit2', { chainId: 1, to: F.USDC_ETH, data: erc20Approve(F.PERMIT2, 1_000_000), value: '0x0' },
      (r) => [['no red/critical finding (normal setup)', riskRed(r).length === 0]]],
    ['K', 'chain-1 USDC approve 2^256-1 to a fresh random address', { chainId: 1, to: F.USDC_ETH, data: erc20Approve(F.randomAddress(), U256_MAX), value: '0x0' },
      (r) => [['at least one red/critical finding', riskRed(r).length > 0]]],
    ['L', '0xdeadbeef + 32 bytes to a random contract, chain 1', { chainId: 1, to: F.randomAddress(), data: '0xdeadbeef' + F.word(F.randomHex(32)), value: '0x0' },
      (r) => [["source 'none'", r.descriptor.source === 'none'], ['DEVICE_SHOWS_RAW_DATA present', raw(r)],
        ['protectionLevel below P4', LEVELS.indexOf(r.protectionLevel) < LEVELS.indexOf('P4')], ['red', riskRed(r).length > 0]]],
    ['M', 'the 38-uniswap-ur-base calldata to a Base address that is not a catalog router',
      { chainId: 8453, to: F.randomAddress(), data: baseSwapCalldata(device), value: '0x0' },
      (r) => [["source 'none'", r.descriptor.source === 'none'], ['DEVICE_SHOWS_RAW_DATA present', raw(r)]]],
    ['N', 'Base USDC transfer, value 0 (printed only; feeds 31)', { chainId: 8453, to: F.USDC_BASE, data: erc20Transfer(device, 1), value: '0x0' },
      (r) => {
        console.log(`     source '${r.descriptor.source}'; DEVICE_SHOWS_RAW_DATA ${raw(r) ? 'PRESENT: no certified attach' : 'absent: only a certified attach does that'}`)
        return []
      }],
  ]
}

function main() {
  run('fw-716/03 Desktop verdict matrix (no presses, report only)', async (getSdk, assert) => {
    const sdk = await getSdk()
    const f = await sdk.system.info.getFeatures()
    console.log(`  firmware ${f.major_version}.${f.minor_version}.${f.patch_version}, label ${f.label}`)
    const { eth: device } = await F.deviceAddresses(sdk)
    console.log(`  device: ${device}\n`)
    const relayEntry = await F.findEvmEntry({ kind: 'schema', chainId: 1, selector: '0x49290c1c', method: 'bridgeDeposit' })

    for (const [id, title, req, checks, skipReason] of shapes(device, relayEntry, Math.floor(Date.now() / 1000))) {
      console.log(`  ── ${id}: ${title} ──`)
      if (skipReason) {
        console.log(`  SKIPPED (shape ${id} only): ${skipReason}\n`)
        continue
      }
      const r = await sdk.clearsign.report({ chain: 'evm', from: device, ...req })
      console.log(`     ${F.describeReport(r)}`)
      if (r.descriptor.label || r.descriptor.resolution) console.log(`     label '${r.descriptor.label || ''}' resolution ${r.descriptor.resolution || '-'}`)
      for (const l of [...r.findings, ...r.limitations]) {
        if (l.code === 'DECODED_FIELD') continue
        console.log(`     ${l.severity.padEnd(7)} ${l.code}: ${String(l.message).slice(0, 150)}`)
      }
      F.assertDeviceConnected(assert, r, id)
      for (const [label, ok] of checks(r)) assert(`${id}: ${label}`, ok)
      console.log('')
    }
  })
}

if (require.main === module) main()
module.exports = { shapes, riskRed }
