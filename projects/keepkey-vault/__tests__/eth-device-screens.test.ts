import { describe, expect, test } from 'bun:test'
import { keccak_256 } from '@noble/hashes/sha3'
import { eip55, ethFormatAmount, ethSignTxMirror, ethTransactionTitle, ethTxFromBody, type EthTxInput } from '../src/shared/eth-device-screens'
import { mirrorPosition } from '../src/shared/hive-device-screens'

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const bytes = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map(x => parseInt(x, 16)))
const word = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const VITALIK = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const ROUTER = '0x1111111254eeb25477b68fb85ed929f73a960582'
const tx = (over: Partial<EthTxInput>): EthTxInput => ({ chainId: 1, to: VITALIK, value: 0n, data: new Uint8Array(), gasLimit: 21000n, maxFeePerGas: 30_000_000_000n, advancedMode: true, ...over })
/** Title, then the rows exactly as drawn (an address wraps mid-word, as on the device). */
const text = (m: ReturnType<typeof ethSignTxMirror>) => m!.screens.map(s => `${s.title}: ${s.rows.join(' | ')}`)

describe('firmware formatting (ethereum.c @ 378cf30, ported unittests)', () => {
  test('NativeAmountsUseTheSigningChainsTicker', () => {
    const v = 1_500_000_000_000_000_000n
    expect([43114, 10, 8453, 42161, 130, 56, 137].map(c => ethFormatAmount(v, null, c))).toEqual(['1.5 AVAX', '1.5 ETH', '1.5 ETH', '1.5 ETH', '1.5 ETH', '1.5 BNB', '1.5 POL'])
    expect(ethFormatAmount(v, null, 59144)).toBe('1500000000000000000 Wei') // unmapped chain: Wei, never a bare number
    expect(ethFormatAmount(999_999_999n, null, 1)).toBe('999999999 Wei') // below 1 gwei
  })
  test('LastScreenTitleNamesTheChain', () => {
    expect([1, 0, 8453, 42161, 10, 130, 59144, 11155111].map(ethTransactionTitle))
      .toEqual(['Transaction', 'Transaction', 'Tx on Base', 'Tx on Arbitrum', 'Tx on Optimism', 'Tx on Unichain', 'Tx on chain 59144', 'Tx on chain 11155111'])
  })
  test('EIP-55 (the address the screens print)', () => {
    expect(eip55(bytes('5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'))).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
  })
})

describe('EthereumSignTx, screen by screen', () => {
  test('native send: amount + recipient, then the fee screen; a certified contact may add one screen after the first', () => {
    const m = ethSignTxMirror(tx({ value: 50_000_000_000_000_000n }))!
    expect(m.exact).toBe(true)
    expect(text(m)).toEqual([
      'Send: Send 0.05 ETH to | 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9 | 6045',
      'Transaction: Send 0.05 ETH from your wallet, paying up | to 0.00063 ETH for gas?',
    ])
    expect(m.mayPrepend).toBe('contact-address')
    expect([1, 2, 3].map(n => mirrorPosition(m, n))).toEqual([{ from: 0, to: 0 }, { from: 1, to: 1 }, { from: 1, to: 1 }])
  })

  test('USDC transfer (token the firmware names): token amount, "the tokens" on the fee screen, no data hash', () => {
    const data = bytes('a9059cbb' + word(VITALIK) + word((1_500_000n).toString(16)))
    const m = ethSignTxMirror(tx({ to: USDC, data, gasLimit: 65000n }))!
    expect(text(m)).toEqual([
      'Send: Send 1.5 USDC to | 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9 | 6045',
      'Transaction: Send the tokens from your wallet, paying | up to 0.00195 ETH for gas?',
    ])
  })

  test('USDC approve, exact amount; unlimited gets its warning first', () => {
    const exact = ethSignTxMirror(tx({ to: USDC, gasLimit: 50000n, data: bytes('095ea7b3' + word(ROUTER) + word((250_000_000n).toString(16))) }))!
    expect(text(exact)).toEqual([
      'Approve: Approve withdrawal of up to 250 USDC by | 0x1111111254EEB25477B68fb85Ed929f73A96058 | 2?',
      'Transaction: Send the message from your wallet, paying | up to 0.0015 ETH for gas?',
    ])
    expect(exact.mayPrepend).toBeUndefined() // an approval is never relabelled by a contact
    const unlimited = ethSignTxMirror(tx({ to: USDC, gasLimit: 50000n, data: bytes('095ea7b3' + word(ROUTER) + 'f'.repeat(64)) }))!
    expect(unlimited.screens.map(s => s.title)).toEqual(['UNLIMITED approval', 'Approve', 'Transaction'])
    expect(unlimited.screens[0]!.rows).toEqual(['Allow', '0x1111111254EEB25477B68fb85Ed929f73A96058', '2 to spend ALL your USDC'])
    expect(unlimited.screens[1]!.rows).toEqual(['Unlock full USDC balance for withdrawal by', '0x1111111254EEB25477B68fb85Ed929f73A96058', '2?'])
  })

  test('contract call on Base with AdvancedMode (the swaps.pro case): Send message, the fee, then the calldata hash — three screens', () => {
    const data = bytes('12345678' + word('ab') + word('cd'))
    const m = ethSignTxMirror(tx({ chainId: 8453, to: '0xb2c4000000000000000000000000000000000001', data, gasLimit: 200000n, maxFeePerGas: 10_000_000n }))!
    expect(m.exact).toBe(true)
    expect(m.screens.map(s => s.title)).toEqual(['Send', 'Tx on Base', 'Ethereum Data Hash'])
    expect(m.screens[0]!.rows).toEqual(['Send message to', '0xb2C40000000000000000000000000000000', '00001'])
    expect(m.screens[1]!.rows).toEqual(['Send the message from your wallet, paying', 'up to 0.000002 ETH for gas?'])
    expect(m.screens[2]!.rows.join('')).toBe(hex(keccak_256(data))) // the full Keccak-256, as ASCII hex
  })

  test('without AdvancedMode the KeepKey shows "Blocked" after the Send screen, then refuses', () => {
    const m = ethSignTxMirror(tx({ to: ROUTER, data: bytes('12345678'), advancedMode: false }))!
    expect(m.screens.map(s => s.title)).toEqual(['Send', 'Blocked'])
    expect(m.reason).toMatch(/AdvancedMode/)
  })

  test('ERC-20 on a chain whose tokens the firmware does not name: the unknown-token review, then the hash', () => {
    const data = bytes('a9059cbb' + word(VITALIK) + word('1'))
    const m = ethSignTxMirror(tx({ chainId: 8453, to: USDC, data, gasLimit: 65000n }))!
    // Its body does not fit one screen: confirm() pages it ("Send n/3"); the
    // second page opens on the body's newline, an empty first row.
    expect(text(m).slice(0, 4)).toEqual([
      'Send 1/3: Unknown token contract | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606e | B48',
      'Send 2/3:  | Send 1 base units to | 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9',
      'Send 3/3: 6045?',
      'Tx on Base: Send the tokens from your wallet, paying | up to 0.00195 ETH for gas?',
    ])
    expect(m.screens.at(-1)!.title).toBe('Ethereum Data Hash')
  })

  test('THORChain router deposit: exact up to the memo, then said to be approximate', () => {
    const memo = new TextEncoder().encode('=:BTC.BTC:bc1qxyz:0/1/0')
    const padded = hex(memo).padEnd(Math.ceil(memo.length / 32) * 64, '0')
    const data = bytes('1fece7b4' + word('7cf4b2c5a8b9b2b4c2f1e0d9c8b7a6f5e4d3c2b1') + word('0') + word('16345785d8a0000') + word('80') + word(memo.length.toString(16)) + padded)
    const m = ethSignTxMirror(tx({ to: '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146', value: 100_000_000_000_000_000n, data, gasLimit: 80000n }))!
    expect(m.exact).toBe(false)
    expect(text(m)).toEqual([
      'Thorchain data: Routing through Thorchain router',
      'Thorchain data: Pays UNVERIFIED vault | 7cf4b2c5a8b9b2b4c2f1e0d9c8b7a6f5e4d3c2 | b1',
      'Thorchain data: Confirm sending 0.1 ETH',
    ])
    expect(m.reason).toMatch(/memo/)
  })

  test('never a guess: a certified description, or an Ethereum token the newest table may name', () => {
    expect(ethSignTxMirror(tx({ to: ROUTER, data: bytes('12345678'), clearSign: true }))).toBeNull()
    expect(ethSignTxMirror(tx({ to: '0x1234567890123456789012345678901234567890', gasLimit: 65000n, data: bytes('a9059cbb' + word(VITALIK) + word('1')) }))).toBeNull()
  })

  test('reads REST / hdwallet bodies (hex or decimal fields)', () => {
    const t = ethTxFromBody({ to: VITALIK, value: '0xb1a2bc2ec50000', gas: '0x5208', maxFeePerGas: '0x6fc23ac00', data: '0x', chainId: '0x1' }, { advancedMode: true })!
    expect(text(ethSignTxMirror(t))[0]).toBe('Send: Send 0.05 ETH to | 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9 | 6045')
  })
})
