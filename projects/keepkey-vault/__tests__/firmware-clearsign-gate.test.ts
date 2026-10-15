/**
 * firmwareClearSigns allowlist guard (pure unit — no device, no network).
 *
 * `firmwareClearSigns` decides whether the Vault overlay forces AdvancedMode:
 * it must mirror the rc3 device's `ethereum_contractHandled` + native ERC-20
 * path EXACTLY. Two failure directions this locks down:
 *   - under-warn: claiming a tx is clear-signed when the device blind-signs it
 *   - over-force: forcing global AdvancedMode on a tx the device clear-signs
 *     natively (re-opens the drain vector PR #261/#303 closed).
 *
 * Run: cd projects/keepkey-vault && bun test __tests__/firmware-clearsign-gate.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { firmwareClearSigns, firmwareKnowsToken } from '../src/bun/calldata-decoder'
import firmwareTokenTable from '../src/bun/firmware-token-table.json'

const ZX = '0xdef1c0ded9bec7f1a1670819833240f027b25eff'
const UNIV2 = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
const THOR = '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146'
const MAYA = '0xd89dce570de35a6f42d3bca7dba50a6d89bfc2a2'
const RANDOM = '0x1111111111111111111111111111111111111111'
const SAPROXY = '0xbd6a40bb904aea5a49c59050b5395f7484a4203d'
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const word = '00'.repeat(32)
const erc20Transfer = '0xa9059cbb' + word + word   // 68-byte standard transfer
const erc20Approve = '0x095ea7b3' + word + word

describe('firmwareClearSigns mirrors the rc3 native clear-sign allowlist', () => {
  test('THORChain/Maya deposit to the pinned router → clear-signs', () => {
    expect(firmwareClearSigns(THOR, '0x1fece7b4' + word, 1)).toBe(true)
    expect(firmwareClearSigns(THOR, '0x44bc937b' + word, 1)).toBe(true)
    expect(firmwareClearSigns(MAYA, '0x1fece7b4' + word, 1)).toBe(true)
  })

  test('THORChain/Maya deposit without an explicit chain id → blind', () => {
    expect(firmwareClearSigns(THOR, '0x1fece7b4' + word)).toBe(false)
    expect(firmwareClearSigns(MAYA, '0x1fece7b4' + word)).toBe(false)
  })

  test('deposit selector to a DIFFERENT address → blind (spoof guard)', () => {
    expect(firmwareClearSigns(RANDOM, '0x1fece7b4' + word)).toBe(false)
  })

  test('0x proxy methods only at the pinned ExchangeProxy/router', () => {
    expect(firmwareClearSigns(ZX, '0x415565b0' + word, 1)).toBe(false)  // transformERC20
    expect(firmwareClearSigns(ZX, '0xd9627aa4' + word, 1)).toBe(true)   // sellToUniswap
    expect(firmwareClearSigns(UNIV2, '0xf305d719' + word, 1)).toBe(true) // addLiquidityETH
    expect(firmwareClearSigns(RANDOM, '0x415565b0' + word, 1)).toBe(false)
    expect(firmwareClearSigns(UNIV2, '0x415565b0' + word, 1)).toBe(false) // right selector, wrong pin
  })

  test('pinned contracts are chain-scoped like firmware ethereum_contracts.c', () => {
    // 0x Exchange Proxy: zx_isExchangeProxyChain = 1, 56, 137, 8453, 42161, 43114.
    for (const chain of [1, 56, 137, 8453, 42161, 43114]) {
      expect(firmwareClearSigns(ZX, '0xd9627aa4' + word, chain)).toBe(true)
    }
    expect(firmwareClearSigns(ZX, '0xd9627aa4' + word, 10)).toBe(false)   // different proxy on Optimism
    expect(firmwareClearSigns(ZX, '0xd9627aa4' + word)).toBe(false)       // no chain id
    // Uniswap V2 liquidity + saproxy: Ethereum mainnet only.
    expect(firmwareClearSigns(UNIV2, '0xf305d719' + word, 8453)).toBe(false)
    expect(firmwareClearSigns(SAPROXY, '0xfea7c53f' + word, 1)).toBe(true)
    expect(firmwareClearSigns(SAPROXY, '0xfea7c53f' + word, 137)).toBe(false)
    // THORChain router: before 7.15 thortx.c knows chains 1 and 43114 only.
    expect(firmwareClearSigns('0x00dc6100103bc402d490aee3f9a5560cbd91f1d4', '0x1fece7b4' + word, 43114)).toBe(true)
    expect(firmwareClearSigns('0x00dc6100103bc402d490aee3f9a5560cbd91f1d4', '0x1fece7b4' + word, 8453)).toBe(false)
  })

  test('THORChain router pins follow the firmware version (7.15 adds BSC and Base)', () => {
    const BASE_ROUTER = '0x00dc6100103bc402d490aee3f9a5560cbd91f1d4'
    const BSC_ROUTER = '0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b'
    const deposit = '0x44bc937b' + '00'.repeat(256) // depositWithExpiry, as in Base tx 0xd567902e…
    for (const fw of ['7.15.0', '7.17.0']) {
      expect(firmwareClearSigns(BASE_ROUTER, deposit, 8453, fw)).toBe(true)
      expect(firmwareClearSigns(BSC_ROUTER, deposit, 56, fw)).toBe(true)
    }
    // The 7.16 line still has the two-chain switch (develop 27d72042c).
    for (const fw of ['7.16.0', '7.16.1', undefined]) {
      expect(firmwareClearSigns(BASE_ROUTER, deposit, 8453, fw)).toBe(false)
      expect(firmwareClearSigns(BSC_ROUTER, deposit, 56, fw)).toBe(false)
    }
    // The pin is (chain, address): right address on the wrong chain is not native.
    expect(firmwareClearSigns(BSC_ROUTER, deposit, 8453, '7.17.0')).toBe(false)
    expect(firmwareClearSigns(BASE_ROUTER, deposit, 56, '7.17.0')).toBe(false)
    expect(firmwareClearSigns('0x00000000000000000000000000000000000000aa', deposit, 8453, '7.17.0')).toBe(false)
  })

  test('7.14.x pins no router: any canonical deposit is shown, on any chain', () => {
    const memoHex = (m: string) => Buffer.from(m).toString('hex')
    const w = (h: string) => h.padStart(64, '0')
    const withExpiry = (memo: string, expiry = 'ffffffff') => {
      const m = memoHex(memo)
      return `0x44bc937b${w('718f6c9df785bc4e323086de024ca822efbe8ab9')}${w('0')}${w('90c5e8ba98e000')}${w('a0')}${w(expiry)}${w((m.length / 2).toString(16))}${m.padEnd(Math.ceil(m.length / 64) * 64, '0')}`
    }
    const BASE_ROUTER = '0x00dc6100103bc402d490aee3f9a5560cbd91f1d4'
    const real = withExpiry('=:TRON.TRX:TMoUJ2EqVESgcaD5eJdvphkkn8K3ucXdTp:5740830833:keep:30')
    for (const fw of ['7.14.0', '7.14.2', '7.14.3']) {
      expect(firmwareClearSigns(BASE_ROUTER, real, 8453, fw)).toBe(true)
      expect(firmwareClearSigns('0x00000000000000000000000000000000000000aa', real, 1, fw)).toBe(true)
    }
    // Same bytes on the pinned lines: Base only from 7.15, never on 7.16.
    expect(firmwareClearSigns(BASE_ROUTER, real, 8453, '7.15.0')).toBe(true)
    expect(firmwareClearSigns(BASE_ROUTER, real, 8453, '7.16.0')).toBe(false)
    // thor_confirmThorTx refuses: non-canonical ABI, memo over 256 bytes, expiry over uint64.
    expect(firmwareClearSigns(BASE_ROUTER, '0x44bc937b' + '00'.repeat(256), 8453, '7.14.2')).toBe(false)
    expect(firmwareClearSigns(BASE_ROUTER, withExpiry('=:BTC.BTC:' + 'x'.repeat(250)), 8453, '7.14.2')).toBe(false)
    expect(firmwareClearSigns(BASE_ROUTER, withExpiry('=:BTC.BTC:x', '1' + '0'.repeat(16)), 8453, '7.14.2')).toBe(false)
  })

  test('pinned calls only count when the calldata fits the first 1024-byte chunk', () => {
    const fits = '0xd9627aa4' + '00'.repeat(1020)
    const spills = '0xd9627aa4' + '00'.repeat(1021)
    expect(firmwareClearSigns(ZX, fits, 1)).toBe(true)
    expect(firmwareClearSigns(ZX, spills, 1)).toBe(false)
    expect(firmwareClearSigns(THOR, '0x1fece7b4' + '00'.repeat(1021), 1)).toBe(false)
  })

  test('68-byte ERC-20 transfer/approve is native ONLY for a token in the firmware table on that chain', () => {
    expect(firmwareClearSigns(USDC_ETH, erc20Transfer, 1)).toBe(true)
    expect(firmwareClearSigns(USDC_ETH.toUpperCase().replace('0X', '0x'), erc20Approve, 1)).toBe(true)
    // Same address on another chain is a different contract.
    expect(firmwareClearSigns(USDC_ETH, erc20Transfer, 8453)).toBe(false)
    // Base USDC is not in the firmware table → AdvancedMode (or a certified schema).
    expect(firmwareClearSigns(USDC_BASE, erc20Transfer, 8453)).toBe(false)
    expect(firmwareClearSigns(RANDOM, erc20Transfer, 1)).toBe(false)
    expect(firmwareClearSigns(RANDOM, erc20Approve, 1)).toBe(false)
    expect(firmwareClearSigns(USDC_ETH, erc20Transfer)).toBe(false) // no chain id
  })

  test('firmware token table is pinned (regenerate: bun scripts/gen-firmware-token-table.ts)', () => {
    // 500 .def lines (350 ethereum-lists + 150 uniswap) deduped on (chain, address).
    expect(firmwareTokenTable.tokens.length).toBe(418)
    expect(new Set(firmwareTokenTable.tokens).size).toBe(418)
    for (const entry of firmwareTokenTable.tokens) expect(entry).toMatch(/^\d+:0x[0-9a-f]{40}$/)
    expect(firmwareKnowsToken(1, USDC_ETH)).toBe(true)
    expect(firmwareKnowsToken(8453, USDC_BASE)).toBe(false)
  })

  test('non-standard-length transfer selector → blind (not the 68-byte path)', () => {
    expect(firmwareClearSigns(RANDOM, '0xa9059cbb' + word)).toBe(false) // 36-byte, malformed
  })

  test('firmware-unknown contracts → blind (Uniswap / 1inch / relay)', () => {
    expect(firmwareClearSigns(UNIV2, '0x38ed1739' + word)).toBe(false) // swapExactTokensForTokens
    expect(firmwareClearSigns(RANDOM, '0x12aa3caf' + word)).toBe(false) // 1inch
    expect(firmwareClearSigns(RANDOM, '0xdeadbeef' + word)).toBe(false) // relay/opaque
  })

  test('empty / missing calldata → blind', () => {
    expect(firmwareClearSigns(THOR, '0x')).toBe(false)
    expect(firmwareClearSigns(undefined, erc20Transfer)).toBe(false)
    expect(firmwareClearSigns(THOR, undefined)).toBe(false)
  })
})
