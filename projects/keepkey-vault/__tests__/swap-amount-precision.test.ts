// Pure metadata and amount boundaries; no wallet, device, database or network.
import { describe, expect, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'
import { usdToCryptoAmount } from '../src/shared/locale'
import { canonicalSwapAmount, nativeSwapAssetDecimals, quantizeComputedSwapAmount, swapAmountExceedsPrecision, swapAssetDecimals } from '../src/shared/swap-amount'
import { parseAssetsResponse } from '../src/bun/swap-parsing'
import { resolveSwapAsset } from '../src/bun/swap-asset-resolver'
import type { SwapAsset } from '../src/shared/types'

const zcash = CHAINS.find(chain => chain.id === 'zcash')!
const zec: SwapAsset = { asset: 'ZEC.ZEC', chainId: 'zcash', symbol: 'ZEC', name: 'Zcash',
  chainFamily: 'utxo', caip: zcash.caip, decimals: 18 }

describe('native swap precision is independent of provider defaults', () => {
  test('recognized native ZEC uses eight decimals in helpers and provider parsing', () => {
    expect(zcash.decimals).toBe(8)
    expect(nativeSwapAssetDecimals(zec)).toBe(8)
    expect(swapAssetDecimals(zec)).toBe(8)
    for (const decimals of [18, 6, 0, 255]) {
      expect(parseAssetsResponse({ assets: [{ asset: 'ZEC.ZEC', caip: zcash.caip, decimals }] })[0])
        .toMatchObject({ caip: zcash.caip, decimals: 8 })
    }
  })

  test('native resolver repairs an already-cached provider asset without mutating its source', async () => {
    expect(await resolveSwapAsset(zcash.caip, { assets: [zec], firmwareVersion: '7.17.0' }))
      .toMatchObject({ caip: zcash.caip, decimals: 8 })
    expect(zec.decimals).toBe(18)
  })

  test('ERC-20 and SPL token precision remains the token metadata, not the gas asset', async () => {
    const contract = '0x' + '11'.repeat(20), mint = '3'.repeat(44)
    const tokens = parseAssetsResponse({ assets: [
      { asset: 'ETH.TEST-' + contract, caip: 'eip155:1/erc20:' + contract, decimals: 6 },
      { asset: 'SOL.TEST-' + mint, caip: CHAINS.find(chain => chain.id === 'solana')!.networkId + '/token:' + mint, decimals: 6 },
    ] })
    expect(tokens).toHaveLength(2)
    for (const token of tokens) {
      expect(nativeSwapAssetDecimals(token)).toBeNull()
      expect(swapAssetDecimals(token)).toBe(6)
      expect(await resolveSwapAsset(token.caip!, { assets: [token], firmwareVersion: '7.17.0' })).toBe(token)
    }
  })
})

describe('computed swap amounts round down once to atomic units', () => {
  test.each([
    ['0.123456789123', 8, '0.12345678'], ['1.999999999', 8, '1.99999999'],
    ['9007199254740993.123456789', 8, '9007199254740993.12345678'],
    ['0.0000000199999999', 8, '0.00000001'], ['1e-8', 8, '0.00000001'], ['1e-9', 8, '0'],
    ['1.23e2', 8, '123'], ['2.9999999', 0, '2'], ['1.0000009', 6, '1'],
  ] as const)('%s at %i decimals preserves the exact floored amount', (amount, decimals, expected) => {
    expect(quantizeComputedSwapAmount(amount, decimals)).toBe(expected)
  })

  test('USD and automatic $100 defaults use the canonical ZEC precision', () => {
    const decimals = swapAssetDecimals(zec)!
    expect(usdToCryptoAmount('100', 123456, decimals)).toBe('0.00081')
    expect(usdToCryptoAmount('1', 1234.56789, decimals)).toBe('0.00081')
    expect(usdToCryptoAmount('1.999999999', 1, decimals)).toBe('1.99999999')
  })

  test('unbounded, malformed or negative computed inputs are refused', () => {
    for (const amount of ['-1', 'NaN', 'Infinity', '1,234', '0x10', '1e999999999', '1e-999999999', '1'.repeat(513)]) {
      expect(quantizeComputedSwapAmount(amount, 8)).toBeNull()
    }
    expect(quantizeComputedSwapAmount('1', -1)).toBeNull()
    expect(quantizeComputedSwapAmount('1', 256)).toBeNull()
  })
})

describe('explicit input never loses a nonzero fraction silently', () => {
  test('a ninth nonzero ZEC decimal is refused, while redundant zeros are equivalent', () => {
    expect(swapAmountExceedsPrecision('0.123456789', 8)).toBe(true)
    expect(canonicalSwapAmount('0.123456789', 8)).toBeNull()
    expect(swapAmountExceedsPrecision('0.1234567800', 8)).toBe(false)
    expect(canonicalSwapAmount('0.1234567800', 8)).toBe('0.12345678')
    expect(canonicalSwapAmount('1.000000000', 8)).toBe('1')
    expect(canonicalSwapAmount('1e-8', 8)).toBeNull()
  })

  test('the same rule follows token precision and refuses unknown precision', () => {
    expect(canonicalSwapAmount('1.0000001', 6)).toBeNull()
    expect(canonicalSwapAmount('1.0000000', 6)).toBe('1')
    expect(canonicalSwapAmount('1', null)).toBeNull()
  })
})
