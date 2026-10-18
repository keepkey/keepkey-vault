#!/usr/bin/env node
/**
 * fw-716/42 — batch 2 certified intent (0x05 body, capability 5): USDT0
 * approve to Permit2 on Arbitrum 42161, AdvancedMode off. 1 Desktop click +
 * about 3-4 presses.
 *
 * approve(Permit2, 1 USDT0). The worker selects the Permit2-pinned
 * 'Shared approval' entry from the spender (entry id ends ':permit2'). USDT0
 * is not in the 7.16.0 token table, so only that entry can describe the call:
 * the signed report must say 'certified'. 32 covers the same intent for Base
 * USDC; this is the Arbitrum USDT0 entry.
 *
 * AdvancedMode on: SKIP. value 0, SENTINEL_NONCE. Signs only: nothing is
 * broadcast.
 */
const { run, erc20Approve } = require('../_helpers')
const F = require('./_fw716')

const USDT0_ARB = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'

const cases = [
  {
    id: '(a)', name: 'USDT0 approve to Permit2, Arbitrum', chainId: 42161, to: USDT0_ARB, expect: ['certified'],
    data: () => erc20Approve(F.PERMIT2, 1_000_000n),
    probe: () => F.probeEvmSchema({ chainId: 42161, to: USDT0_ARB, selector: '0x095ea7b3', spender: F.PERMIT2 }),
    screens: () => ['"Shared approval": Let Uniswap\'s shared approval contract ... spend up to 1 USDT0', 'the fee confirm'],
  },
]

run('fw-716/42 certified Shared approval: USDT0 to Permit2 on Arbitrum', (getSdk, assert) =>
  F.signCases(getSdk, assert, cases, { cap: 5 }))
