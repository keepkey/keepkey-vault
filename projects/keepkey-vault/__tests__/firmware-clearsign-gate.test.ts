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
import { firmwareClearSigns } from '../src/bun/calldata-decoder'

const ZX = '0xdef1c0ded9bec7f1a1670819833240f027b25eff'
const UNIV2 = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
const THOR = '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146'
const MAYA = '0xd89dce570de35a6f42d3bca7dba50a6d89bfc2a2'
const RANDOM = '0x1111111111111111111111111111111111111111'
const word = '00'.repeat(32)
const erc20Transfer = '0xa9059cbb' + word + word   // 68-byte standard transfer
const erc20Approve = '0x095ea7b3' + word + word

describe('firmwareClearSigns mirrors the rc3 native clear-sign allowlist', () => {
  test('THORChain/Maya deposit to the pinned router → clear-signs', () => {
    expect(firmwareClearSigns(THOR, '0x1fece7b4' + word)).toBe(true)
    expect(firmwareClearSigns(THOR, '0x44bc937b' + word)).toBe(true)
    expect(firmwareClearSigns(MAYA, '0x1fece7b4' + word)).toBe(true)
  })

  test('deposit selector to a DIFFERENT address → blind (spoof guard)', () => {
    expect(firmwareClearSigns(RANDOM, '0x1fece7b4' + word)).toBe(false)
  })

  test('0x proxy methods only at the pinned ExchangeProxy/router', () => {
    expect(firmwareClearSigns(ZX, '0x415565b0' + word)).toBe(true)   // transformERC20
    expect(firmwareClearSigns(ZX, '0xd9627aa4' + word)).toBe(true)   // sellToUniswap
    expect(firmwareClearSigns(UNIV2, '0xf305d719' + word)).toBe(true) // addLiquidityETH
    expect(firmwareClearSigns(RANDOM, '0x415565b0' + word)).toBe(false)
    expect(firmwareClearSigns(UNIV2, '0x415565b0' + word)).toBe(false) // right selector, wrong pin
  })

  test('standard 68-byte ERC-20 transfer/approve → clear-signs (any token addr)', () => {
    expect(firmwareClearSigns(RANDOM, erc20Transfer)).toBe(true)
    expect(firmwareClearSigns(RANDOM, erc20Approve)).toBe(true)
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
