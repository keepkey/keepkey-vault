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
import { thor714MemoConfirms, firmwareClearSigns, firmwareKnowsToken } from '../src/bun/calldata-decoder'
import firmwareTokenTable from '../src/bun/firmware-token-table.json'
import firmwareTokenTable716 from '../src/bun/firmware-token-table-716.json'

const ZX = '0xdef1c0ded9bec7f1a1670819833240f027b25eff'
const UNIV2 = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d'
const THOR = '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146'
const MAYA = '0xd89dce570de35a6f42d3bca7dba50a6d89bfc2a2'
const RANDOM = '0x1111111111111111111111111111111111111111'
const SAPROXY = '0xbd6a40bb904aea5a49c59050b5395f7484a4203d'
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const word = '00'.repeat(32)
const erc20Transfer = '0xa9059cbb' + word + word   // 68-byte standard transfer
const erc20Approve = '0x095ea7b3' + word + word
const w = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
// sellToUniswap(USDC → USDT), canonical: offset 0x80, two tokens the table knows.
const zxSell = '0xd9627aa4' + w('80') + w('de0b6b3a7640000') + w('1') + w('0') + w('2') + w(USDC_ETH) + w(USDT_ETH)
// addLiquidityETH(USDC, …): 196 bytes, clean words, u64 deadline.
const univ2Add = '0xf305d719' + w(USDC_ETH) + w('1') + w('1') + w('1') + w(RANDOM) + w('ffffffff')

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
    expect(firmwareClearSigns(ZX, zxSell, 1)).toBe(true)        // sellToUniswap
    expect(firmwareClearSigns(UNIV2, univ2Add, 1)).toBe(true)   // addLiquidityETH
    expect(firmwareClearSigns(RANDOM, '0x415565b0' + word, 1)).toBe(false)
    expect(firmwareClearSigns(UNIV2, '0x415565b0' + word, 1)).toBe(false) // right selector, wrong pin
  })

  test('pinned contracts are chain-scoped like firmware ethereum_contracts.c', () => {
    // 0x Exchange Proxy: zx_isExchangeProxyChain = 1, 56, 137, 8453, 42161, 43114,
    // and then only for tokens that chain's table names (see the 0x test below).
    expect(firmwareClearSigns(ZX, zxSell, 1)).toBe(true)
    expect(firmwareClearSigns(ZX, zxSell, 10)).toBe(false)   // different proxy on Optimism
    expect(firmwareClearSigns(ZX, zxSell)).toBe(false)       // no chain id
    // Uniswap V2 liquidity + saproxy: Ethereum mainnet only.
    expect(firmwareClearSigns(UNIV2, univ2Add, 8453)).toBe(false)
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
    for (const fw of ['7.15.0', '7.16.0', '7.16.1', '7.17.0']) {
      expect(firmwareClearSigns(BASE_ROUTER, deposit, 8453, fw)).toBe(true)
      expect(firmwareClearSigns(BSC_ROUTER, deposit, 56, fw)).toBe(true)
    }
    // Unknown firmware: the older two-chain switch.
    expect(firmwareClearSigns(BASE_ROUTER, deposit, 8453, undefined)).toBe(false)
    expect(firmwareClearSigns(BSC_ROUTER, deposit, 56, undefined)).toBe(false)
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
      expect(firmwareClearSigns('0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146', real, 1, fw)).toBe(true)
      // The device would show a deposit to ANY contract; Desktop keeps the
      // gate for one that is not a router it knows.
      expect(firmwareClearSigns('0x00000000000000000000000000000000000000aa', real, 1, fw)).toBe(false)
    }
    // Same bytes on the pinned lines: Base from 7.15.
    expect(firmwareClearSigns(BASE_ROUTER, real, 8453, '7.15.0')).toBe(true)
    expect(firmwareClearSigns(BASE_ROUTER, real, 8453, '7.16.0')).toBe(true)
    // thor_confirmThorTx refuses: non-canonical ABI, memo over 256 bytes, expiry over uint64.
    expect(firmwareClearSigns(BASE_ROUTER, '0x44bc937b' + '00'.repeat(256), 8453, '7.14.2')).toBe(false)
    expect(firmwareClearSigns(BASE_ROUTER, withExpiry('=:BTC.BTC:' + 'x'.repeat(250)), 8453, '7.14.2')).toBe(false)
    expect(firmwareClearSigns(BASE_ROUTER, withExpiry('=:BTC.BTC:x', '1' + '0'.repeat(16)), 8453, '7.14.2')).toBe(false)
  })

  test('7.14.2 memo parser: what thorchain_parseConfirmMemo confirms', () => {
    expect(thor714MemoConfirms('=:TRON.TRX:TMoUJ2EqVESgcaD5eJdvphkkn8K3ucXdTp:5740830833:keep:30')).toBe(true)
    expect(thor714MemoConfirms('SWAP:ETH.USDT-0xdac17f958d2ee523a2206206994597c13d831ec7:0x41e5:420')).toBe(true)
    expect(thor714MemoConfirms('+:ETH.ETH')).toBe(true)
    for (const refused of [
      '',                          // empty
      '=:ETH.ETH::0',              // empty field
      '=:ETH.ETH:dest :0',         // space
      '=:ETH:ETH:dest',            // no dot in the asset field
      '=:ETH.ETH:a.b',             // second dot (dotted destination)
      'TRADE+:ETH.ETH:dest',       // operation the parser does not know
      '-:ETH.ETH:5000',            // withdraw: predicted refused
      'x'.repeat(257),
    ]) expect(thor714MemoConfirms(refused)).toBe(false)
  })

  test('Maya router pins follow the firmware line', () => {
    const LEGACY = '0xd89dce570de35a6f42d3bca7dba50a6d89bfc2a2'
    const V4 = '0xe3985e6b61b814f7cdb188766562ba71b446b46d'
    const ARB = '0x700e97ef07219440487840dc472e7120a7ff11f4'
    const dep = '0x1fece7b4' + '00'.repeat(256)
    expect(firmwareClearSigns(V4, dep, 1, '7.15.0')).toBe(true)
    expect(firmwareClearSigns(ARB, dep, 42161, '7.15.0')).toBe(true)
    expect(firmwareClearSigns(LEGACY, dep, 1, '7.15.0')).toBe(false)
    expect(firmwareClearSigns(V4, dep, 1, '7.16.0')).toBe(true)
    expect(firmwareClearSigns(ARB, dep, 42161, '7.16.0')).toBe(true)
    expect(firmwareClearSigns(LEGACY, dep, 1, undefined)).toBe(true)
    expect(firmwareClearSigns(V4, dep, 1, undefined)).toBe(false)
  })

  test('pinned calls only count when the calldata fits the first 1024-byte chunk', () => {
    // A real 0x quote carries a tail past the ABI extent; the firmware allows it.
    const fits = zxSell + '00'.repeat(1024 - (zxSell.length - 2) / 2)
    const spills = fits + '00'
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

  test('ERC-20 transfer/approve with native value attached → not native (ethereum_valueIsZero)', () => {
    for (const data of [erc20Transfer, erc20Approve]) {
      for (const zero of [undefined, null, '', '0x', '0x0', '0x00', '0', 0]) {
        expect(firmwareClearSigns(USDC_ETH, data, 1, '7.16.0', zero)).toBe(true)
      }
      for (const value of ['0x16345785d8a0000', '1', 1, 'junk']) {
        expect(firmwareClearSigns(USDC_ETH, data, 1, '7.16.0', value)).toBe(false)
        expect(firmwareClearSigns(USDC_ETH, data, 1, '7.15.0', value)).toBe(false)
      }
    }
  })

  test('0x sellToUniswap mirrors zxswap_resolveBothTokens', () => {
    const head = (offset: string, sushi: string, count: string) =>
      '0xd9627aa4' + w(offset) + w('de0b6b3a7640000') + w('1') + w(sushi) + w(count)
    const ETH = '0x' + 'e'.repeat(40)
    const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
    expect(firmwareClearSigns(ZX, head('80', '1', '2') + w(USDC_ETH) + w(USDT_ETH), 1, '7.16.0')).toBe(true)   // Sushiswap
    expect(firmwareClearSigns(ZX, head('80', '0', '3') + w(ETH) + w(DAI) + w(USDC_ETH), 1, '7.16.0')).toBe(true) // ETH sentinel, 3 hops
    expect(firmwareClearSigns(ZX, head('80', '0', '2') + w(ETH) + w(USDC_ETH), 8453, '7.16.0')).toBe(false)    // sentinel is mainnet-only
    expect(firmwareClearSigns(ZX, head('80', '0', '3') + w(USDC_ETH) + w(RANDOM) + w(USDT_ETH), 1, '7.16.0')).toBe(false) // unknown middle hop
    expect(firmwareClearSigns(ZX, head('80', '2', '2') + w(USDC_ETH) + w(USDT_ETH), 1, '7.16.0')).toBe(false)  // isSushi not 0/1
    expect(firmwareClearSigns(ZX, head('80', '0', '4') + w(USDC_ETH) + w(USDT_ETH) + w(DAI) + w(ETH), 1, '7.16.0')).toBe(false)
    expect(firmwareClearSigns(ZX, head('80', '0', '2') + w(USDC_ETH) + 'ff' + w(USDT_ETH).slice(2), 1, '7.16.0')).toBe(false) // dirty word
    expect(firmwareClearSigns(ZX, head('80', '0', '2') + w(USDC_ETH), 1, '7.16.0')).toBe(false)                // short
  })

  test('Uniswap V2 add/removeLiquidityETH mirror liquidity_shape_is_clear_signable', () => {
    const remove = '0x02751cec' + univ2Add.slice(10)
    expect(firmwareClearSigns(UNIV2, univ2Add, 1, '7.16.0', '0xde0b6b3a7640000')).toBe(true)
    expect(firmwareClearSigns(UNIV2, remove, 1, '7.16.0', '0x0')).toBe(true)
    expect(firmwareClearSigns(UNIV2, remove, 1, '7.16.0', '0x1')).toBe(false)
    expect(firmwareClearSigns(UNIV2, univ2Add + word, 1, '7.16.0')).toBe(false)                             // not 196 bytes
    expect(firmwareClearSigns(UNIV2, univ2Add.slice(0, -64) + w('1' + '0'.repeat(16)), 1, '7.16.0')).toBe(false) // deadline over u64
    expect(firmwareClearSigns(UNIV2, univ2Add.replace(w(RANDOM), 'ff' + w(RANDOM).slice(2)), 1, '7.16.0')).toBe(false) // dirty recipient
    expect(firmwareClearSigns(UNIV2, univ2Add.replace(w(USDC_ETH), w(RANDOM)), 1, '7.16.0')).toBe(false)    // token not in the table
  })

  test('firmware token table is pinned (regenerate: bun scripts/gen-firmware-token-table.ts)', () => {
    // 500 .def lines (350 ethereum-lists + 150 uniswap) deduped on (chain, address).
    expect(firmwareTokenTable.tokens.length).toBe(418)
    expect(new Set(firmwareTokenTable.tokens).size).toBe(418)
    for (const entry of firmwareTokenTable.tokens) expect(entry).toMatch(/^\d+:0x[0-9a-f]{40}$/)
    expect(firmwareKnowsToken(1, USDC_ETH)).toBe(true)
    expect(firmwareKnowsToken(8453, USDC_BASE)).toBe(false)
  })

  test('7.16.0 token table is pinned: priority-only, 153 mainnet entries, inside the 7.15 table', () => {
    // 49 ethereum-lists (--profile priority-only) + 150 uniswap (fill), deduped.
    expect(firmwareTokenTable716.tokens.length).toBe(153)
    expect(new Set(firmwareTokenTable716.tokens).size).toBe(153)
    const t715 = new Set(firmwareTokenTable.tokens)
    for (const entry of firmwareTokenTable716.tokens) {
      expect(entry).toMatch(/^1:0x[0-9a-f]{40}$/)
      expect(t715.has(entry)).toBe(true)
    }
  })

  test('ERC-20 prediction follows the firmware line: 7.16.0 ships the smaller table', () => {
    const LEO = '0x2af5d2ad76741191d15dfe7bf6ac92d4bd912ca3'  // in 7.15, not 7.16
    const OP = '0x4200000000000000000000000000000000000042'   // Optimism, in 7.15, not 7.16
    for (const fw of ['7.14.2', '7.15.0', '7.15.2']) {
      expect(firmwareClearSigns(LEO, erc20Transfer, 1, fw)).toBe(true)
      expect(firmwareClearSigns(LEO, erc20Approve, 1, fw)).toBe(true)
      expect(firmwareClearSigns(OP, erc20Transfer, 10, fw)).toBe(true)
    }
    for (const fw of ['7.16.0', '7.16.1', '7.17.0']) {
      expect(firmwareClearSigns(LEO, erc20Transfer, 1, fw)).toBe(false)
      expect(firmwareClearSigns(LEO, erc20Approve, 1, fw)).toBe(false)
      expect(firmwareClearSigns(OP, erc20Transfer, 10, fw)).toBe(false)
    }
    // Stablecoins are in both.
    for (const fw of ['7.15.0', '7.16.0', undefined]) {
      expect(firmwareClearSigns(USDT_ETH, erc20Transfer, 1, fw)).toBe(true)
      expect(firmwareClearSigns(USDC_ETH, erc20Approve, 1, fw)).toBe(true)
    }
    // Unknown version: the smaller (7.16) table.
    expect(firmwareKnowsToken(1, LEO)).toBe(false)
    expect(firmwareClearSigns(LEO, erc20Transfer, 1, undefined)).toBe(false)
    expect(firmwareClearSigns(OP, erc20Transfer, 10, '')).toBe(false)
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
