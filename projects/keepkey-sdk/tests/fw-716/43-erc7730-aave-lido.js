#!/usr/bin/env node
/**
 * fw-716/43 — batch 4 ERC-7730 calldata definitions (capability 4) sign with
 * AdvancedMode off. 3 Desktop clicks + several presses each. Run with
 * KEEPKEY_SUITE_TIMEOUT_MS=540000 (it SKIPs below).
 *
 *   (a) Aave v3 Pool supply on Base 8453: 1 USDC, onBehalfOf this device
 *   (b) Aave v3 Pool supply on Arbitrum 42161: 1 USDC, onBehalfOf this device
 *   (c) Lido stETH submit on chain 1 (payable): 0.000001 ETH, referral 0
 *
 * 40 already covers Aave supply on chain 1. The suite sends no definition:
 * Desktop fetches it from the ClearSign service and attaches it. If the device
 * refuses it, Desktop falls back to the blind path, whose card offers Advanced
 * Mode (Reject): so a signature with AdvancedMode off is the ERC-7730 review.
 *
 * AdvancedMode on: SKIP. SENTINEL_NONCE. Signs only: nothing is broadcast.
 */
const { run } = require('../_helpers')
const { Interface } = require('ethers')
const F = require('./_fw716')

const AAVE = new Interface(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)'])
const LIDO = new Interface(['function submit(address _referral) payable returns (uint256)'])

const AAVE_POOL_BASE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5'
const AAVE_POOL_ARB = '0x794a61358d6845594f94dc1db02a252b5b4814ad'
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84'
const ZERO = '0x0000000000000000000000000000000000000000'

const aaveSupply = (chainId, pool, usdc) => ({
  chainId, to: pool, gasLimit: '0x493e0', expect: ['erc7730'],
  data: (device) => AAVE.encodeFunctionData('supply', [usdc, 1_000_000n, device, 0]),
  probe: () => F.probeErc7730Case({ chainId, to: pool, selector: '0x617ba037' }),
  screens: (device) => [`"Supply": Amount to supply 1 USDC, Collateral recipient ${device} (this device)`, 'the fee confirm'],
})

const cases = [
  { id: '(a)', name: 'Aave v3 supply, Base', ...aaveSupply(8453, AAVE_POOL_BASE, F.USDC_BASE) },
  { id: '(b)', name: 'Aave v3 supply, Arbitrum', ...aaveSupply(42161, AAVE_POOL_ARB, USDC_ARB) },
  {
    id: '(c)', name: 'Lido stETH submit, chain 1', chainId: 1, to: STETH, value: '0x' + (10n ** 12n).toString(16), expect: ['erc7730'],
    data: () => LIDO.encodeFunctionData('submit', [ZERO]),
    probe: () => F.probeErc7730Case({ chainId: 1, to: STETH, selector: '0xa1903eab' }),
    screens: () => ['"Stake ETH": Amount 0.000001 ETH', 'the fee confirm'],
  },
]

run('fw-716/43 ERC-7730: Aave supply (Base, Arbitrum), Lido submit (chain 1)', (getSdk, assert) =>
  F.signCases(getSdk, assert, cases, { cap: 4, minBudgetMs: 540_000 }))
