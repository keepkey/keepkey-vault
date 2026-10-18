#!/usr/bin/env node
/**
 * fw-716/41 — batch 3a ERC-20 calls (kind-1 0x02 schema, tokenIdentity
 * 'pioneer-discovery') sign with AdvancedMode off. 3 Desktop clicks + about
 * 3-4 presses each. Run with KEEPKEY_SUITE_TIMEOUT_MS=540000 (it SKIPs below).
 *
 *   (a) USDT transfer, chain 1: 1 USDT to this device
 *   (b) LINK approve, chain 1: 1 LINK to Permit2
 *   (c) USDC transfer, Polygon 137: 1 USDC to this device
 *
 * (a) and (b) are also in the 7.16.0 built-in token table (Desktop's
 * firmware-token-table-716.json), so Desktop sends them natively and never
 * asks for the batch 3a entry: source 'native' or 'certified' both pass.
 * (c) is not in the table: only the certified entry can describe it, so the
 * signed report must say 'certified'.
 *
 * With AdvancedMode off 7.16 refuses a call it cannot describe, so a signature
 * that recovers to the device proves a clear-sign path. AdvancedMode on: SKIP.
 * value 0, SENTINEL_NONCE. Signs only: nothing is broadcast.
 */
const { run, erc20Transfer, erc20Approve } = require('../_helpers')
const F = require('./_fw716')

const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const LINK_ETH = '0x514910771af9ca656af840dff83e8264ecf986ca'
const USDC_POLYGON = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'

const cases = [
  {
    id: '(a)', name: 'USDT transfer, chain 1', chainId: 1, to: USDT_ETH, expect: ['native', 'certified'],
    data: (device) => erc20Transfer(device, 1_000_000n),
    probe: () => F.probeEvmSchema({ chainId: 1, to: USDT_ETH, selector: '0xa9059cbb' }),
    screens: (device) => [`send 1 USDT to ${device} (this device)`, 'the fee confirm'],
  },
  {
    id: '(b)', name: 'LINK approve to Permit2, chain 1', chainId: 1, to: LINK_ETH, expect: ['native', 'certified'],
    data: () => erc20Approve(F.PERMIT2, 10n ** 18n),
    probe: () => F.probeEvmSchema({ chainId: 1, to: LINK_ETH, selector: '0x095ea7b3', spender: F.PERMIT2 }),
    screens: () => [`approve ${F.PERMIT2} (Permit2) to spend 1 LINK`, 'the fee confirm'],
  },
  {
    id: '(c)', name: 'USDC transfer, Polygon', chainId: 137, to: USDC_POLYGON, expect: ['certified'],
    data: (device) => erc20Transfer(device, 1_000_000n),
    probe: () => F.probeEvmSchema({ chainId: 137, to: USDC_POLYGON, selector: '0xa9059cbb' }),
    screens: (device) => [`"USDC transfer" (KeepKey ClearSign): Recipient ${device} (this device), Amount 1 USDC`, 'the fee confirm'],
  },
]

run('fw-716/41 batch 3a tokens: USDT transfer, LINK approve (chain 1), USDC transfer (Polygon)', (getSdk, assert) =>
  F.signCases(getSdk, assert, cases, { minBudgetMs: 540_000 }))
