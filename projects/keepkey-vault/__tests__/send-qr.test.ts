import { describe, expect, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'
import { eip681ValueToAmount, parseSendQr } from '../src/shared/send-qr'
import { receivePaymentUri } from '../src/shared/receive-payment-uri'

const chain = (id: string) => CHAINS.find(c => c.id === id)!
const ethereum = chain('ethereum'), bitcoin = chain('bitcoin'), xrp = chain('ripple'), cosmos = chain('cosmos')
const eth = '0x3333333333333333333333333333333333333333'
const btc = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const ripple = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const atom = 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd02'

describe('EIP-681 atomic amounts', () => {
  test.each([
    ['10000000000000000', '0.01'], ['2.014e18', '2.014'], ['.1e19', '1'],
    ['10000000000000001', '0.010000000000000001'], ['9007199254740993', '0.009007199254740993'],
    ['1', '0.000000000000000001'], ['0', '0'], ['+1e18', '1'],
    [((1n << 256n) - 1n).toString(), '115792089237316195423570985008687907853269984665640564039457.584007913129639935'],
  ])('%s preserves every atomic unit', (value, expected) => {
    expect(eip681ValueToAmount(value, 18)).toBe(expected)
  })
  test.each(['0.1', '1e-1', '-1', '1e9999999999999999999999', '1e78', '2.014e2', '1e', 'NaN', 'Infinity', '1,000',
    (1n << 256n).toString(), '0'.repeat(257)])('%s is refused without rounding or unbounded allocation', value => {
    expect(eip681ValueToAmount(value, 18)).toBeNull()
  })
})

describe('selected network and amount binding', () => {
  test('EIP-681 current-network, explicit-chain and pay- requests preserve native units', () => {
    for (const target of [eth, `${eth}@1`, `pay-${eth}@0001`]) {
      expect(parseSendQr(`ethereum:${target}?value=2.014e18`, ethereum)).toEqual({ recipient: eth, amount: '2.014', memo: '' })
    }
    expect(parseSendQr(`ethereum:${eth}@8453?value=1`, chain('base'))?.amount).toBe('0.000000000000000001')
  })
  test('BIP-21 amounts are exact whole-coin decimals and metadata is not a memo', () => {
    expect(parseSendQr(`bitcoin:${btc}?amount=0.50000001&label=Alice&message=Hello`, bitcoin))
      .toEqual({ recipient: btc, amount: '0.50000001', memo: '' })
    expect(parseSendQr(`bitcoin:${btc}?amount=0`, bitcoin)?.amount).toBe('0')
  })
  test.each([
    `ethereum:${eth}@8453?value=1`, `bitcoin:${btc}?amount=1`,
    `ethereum:${eth}/transfer?address=${eth}&uint256=1`, `ethereum:${eth}@1?amount=1&value=1`,
    `ethereum:${eth}?value=1&value=2`, `ethereum:${eth}?req-unknown=1`, `ethereum:${eth}#hidden`,
    `ethereum:${eth}?value=1e999999`,
  ])('unsupported or ambiguous request fails as a whole: %s', uri => {
    expect(parseSendQr(uri, ethereum)).toBeNull()
  })
  test('a valid EVM address on the wrong network cannot lose its explicit chain binding', () => {
    expect(parseSendQr(`ethereum:${eth}@1?value=1`, chain('base'))).toBeNull()
    expect(parseSendQr(`ethereum:${eth}?value=1`, bitcoin)).toBeNull()
    expect(parseSendQr(`cosmos:${ripple}?dt=7`, xrp)).toBeNull()
    expect(parseSendQr(`${ripple}?dt=7`, cosmos)).toBeNull()
  })
  test.each(['0.000000001', '1e-8', '1,5', '-1', 'NaN', ''])('invalid BTC amount %s cannot be truncated', amount => {
    expect(parseSendQr(`bitcoin:${btc}?amount=${amount}`, bitcoin)).toBeNull()
  })
  test('native URI amounts never price the selected ERC-20 token', () => {
    expect(parseSendQr(`ethereum:${eth}@1?value=2.014e18`, ethereum, true)).toEqual({ recipient: eth, memo: '' })
    expect(parseSendQr(`ethereum:${eth}/transfer?address=${eth}&uint256=1`, ethereum, true)).toBeNull()
  })
  test('typed Ethereum arguments and calldata cannot become ordinary native payments', () => {
    for (const query of [`address=${eth}&uint256=1`, 'data=0xa9059cbb', 'uint256=1']) {
      for (const token of [false, true]) expect(parseSendQr(`ethereum:${eth}?${query}`, ethereum, token)).toBeNull()
    }
  })
  test('unsupported asset bindings never price a token quantity as native coins', () => {
    const solana = chain('solana'), address = '11111111111111111111111111111111'
    expect(parseSendQr(`solana:${address}?amount=1`, solana)?.amount).toBe('1')
    for (const token of [false, true]) {
      expect(parseSendQr(`solana:${address}?amount=1&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, solana, token)).toBeNull()
      expect(parseSendQr(`ethereum:${eth}?amount=1&token=${eth}`, ethereum, token)).toBeNull()
      expect(parseSendQr(`cosmos:${atom}?amount=1&denom=uusdc`, cosmos, token)).toBeNull()
    }
  })
  test('unreadable, incomplete and oversized scans do not create partial drafts', () => {
    for (const data of ['', 'ethereum:', `${eth}\0?value=1`, eth + 'x'.repeat(4096)]) expect(parseSendQr(data, ethereum)).toBeNull()
  })
})

describe('memo and XRP destination tag meaning', () => {
  test.each(['0', '7', '0000000007', '4294967295'])('XRP dt=%s remains an explicit UInt32 tag', dt => {
    expect(parseSendQr(`xrp:${ripple}?dt=${dt}&label=Alice&memo=hello`, xrp)).toEqual({ recipient: ripple, memo: dt })
    expect(parseSendQr(`${ripple}?dt=${dt}`, xrp)?.memo).toBe(dt)
  })
  test.each(['-1', '+7', '1.5', '1e3', '4294967296', '', '123abc'])('invalid XRP dt=%s rejects the request', dt => {
    expect(parseSendQr(`xrpl:${ripple}?dt=${encodeURIComponent(dt)}`, xrp)).toBeNull()
  })
  test('labels and XRP memo parameters clear old metadata instead of becoming tags', () => {
    expect(parseSendQr(`ripple:${ripple}?label=Alice&memo=hello`, xrp)).toEqual({ recipient: ripple, memo: '' })
    expect(parseSendQr(`cosmos:${atom}?label=Alice&dt=7`, cosmos)).toEqual({ recipient: atom, memo: '' })
    expect(parseSendQr(`cosmos:${atom}?memo=12345&label=Alice&dt=7`, cosmos)).toEqual({ recipient: atom, memo: '12345' })
    expect(parseSendQr(`xrp:${ripple}?dt=1&dt=2`, xrp)).toBeNull()
  })
  test('unsupported memos cannot become hidden payment data or disappear silently', () => {
    expect(parseSendQr(`bitcoin:${btc}?memo=on-chain-data`, bitcoin)).toBeNull()
  })
})

describe('TON deep links', () => {
  const ton = chain('ton')
  const uq = 'UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XglxD'
  const eq = 'EQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG'
  test("Vault's own TON receive QR (ton://transfer/<address>) scans into Send", () => {
    expect(parseSendQr(`ton://transfer/${uq}`, ton)).toEqual({ recipient: uq, memo: '' })
    expect(parseSendQr(`ton://transfer/${eq}`, ton)).toEqual({ recipient: eq, memo: '' })
  })
  test('the receive QR round-trips through the Send scanner', () => {
    for (const address of [uq, eq]) expect(parseSendQr(receivePaymentUri(ton, address), ton)?.recipient).toBe(address)
  })
  test('amount is in nanotons, never whole TON', () => {
    expect(parseSendQr(`ton://transfer/${uq}?amount=1000000000`, ton)?.amount).toBe('1')
    expect(parseSendQr(`ton://transfer/${uq}?amount=1500000`, ton)?.amount).toBe('0.0015')
    expect(parseSendQr(`ton:${uq}?amount=1000000000`, ton)?.amount).toBe('1')
  })
  test.each([
    `ton://transfer/${uq}?amount=1.5`, `ton://transfer/${uq}?amount=-1`, `ton://transfer/${uq}?amount=1e9`,
    `ton://transfer/${uq}?text=deposit-42`, `ton://transfer/${uq}?text=&text=deposit-42`,
    `ton://transfer/${uq}?bin=te6cc`, `ton://transfer/${uq}?init=te6cc`,
    `ton://transfer/${uq}?jetton=EQAbc`, `ton://transfer/${uq}/extra`, `ton://stake/${uq}`, `ton://transfer/`,
  ])('%s fails as a whole', data => {
    expect(parseSendQr(data, ton)).toBeNull()
  })
  test('an empty comment is no comment', () => {
    expect(parseSendQr(`ton://transfer/${uq}?text=`, ton)).toEqual({ recipient: uq, memo: '' })
  })
})
