/** What the history dialog keeps and says about an EVM transaction. */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet, utils } from 'ethers'
import type { SigningRequestInfo } from '../shared/types'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { decodeCalldata } from './calldata-decoder'

const dir = mkdtempSync(join(tmpdir(), 'vault-signed-tx-review-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('./db')
const { evmTxid, signedTxReview, recordSignedEvmTx, tokenMoves, txDetails, walletBook, lookupEvmTx } = await import('./signed-tx-review')

beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const FROM = '0x27de622cc44c55b53caf299ecedccdab29ac98a8'
const VENICE = '0x321b7ff75154472B18EDb199033fF4D116F340Ff'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const OTHER = '1111111111111111111111111111111111111111'
const venice = (extra: Partial<SigningRequestInfo> = {}) => ({
  id: 'v', method: '/eth/sign-transaction', appName: 'KeepKey Browser Extension', chainId: 8453, from: FROM, to: VENICE,
  value: '0x0', data: '0xae5ac92100000000000000000000000000000000000000000000000b666b17fbf83e1522', needsBlindSigning: true, ...extra,
} as SigningRequestInfo)

describe('evmTxid', () => {
  test('the EIP-155 example transaction hashes to its known txid', () => {
    expect(evmTxid('0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83'))
      .toBe('0x33469b22e9f636356c4160a87eb19df52b7412e8eac32a4a55ffe88ea8350788')
  })

  test('equals the transaction hash for legacy, EIP-2930 and EIP-1559 envelopes', async () => {
    const key = new Wallet('0x' + '11'.repeat(32))
    const base = { to: `0x${OTHER}`, nonce: 3, gasLimit: 21000, value: 1n, chainId: 1, data: '0x' }
    for (const tx of [
      { ...base, type: 0, gasPrice: 1_000_000_000 },
      { ...base, type: 1, gasPrice: 1_000_000_000, accessList: [] },
      { ...base, type: 2, maxFeePerGas: 2_000_000_000, maxPriorityFeePerGas: 1_000_000 },
    ]) {
      const serialized = await key.signTransaction(tx as any)
      const parsed = utils.parseTransaction(serialized)
      expect(parsed.type ?? 0).toBe(tx.type)
      expect(evmTxid(serialized)).toBe(parsed.hash!.toLowerCase())
    }
  })
})

describe('signedTxReview', () => {
  test('keeps the card verdict and lines exactly, how the device signed, and the contract name', () => {
    const info = venice({ contractName: { name: 'Staked Venice Token', symbol: 'sVVV' }, priorUse: { count: 3, since: Date.UTC(2025, 0, 28) } })
    const review = signedTxReview(info, {})
    const risk = assessSigningRisk(info)!
    expect(review).toMatchObject({ signedHow: 'blind', tier: risk.tier, headline: risk.headline, reasons: risk.reasons, appName: 'KeepKey Browser Extension', contract: 'Staked Venice Token' })
    expect(review.call).toBeUndefined()
  })

  test('the card verdict and what was sent decide how it signed', () => {
    const erc7730 = signedTxReview(venice({ needsBlindSigning: false }), { erc7730: {} })
    expect(erc7730.signedHow).toBe('erc7730')
    const certified = signedTxReview(venice({ needsBlindSigning: false }), { txMetadata: { keyId: 0x80 } })
    expect(certified.signedHow).toBe('certified')
    const provider = signedTxReview(venice({ runtimeProvider: { alias: 'Venice', fingerprint: 'ab12' } as any }), { txMetadata: { keyId: 1 } })
    expect([provider.signedHow, provider.provider]).toEqual(['provider', 'Venice'])
    const native = signedTxReview(venice({ needsBlindSigning: false, deviceClearSigns: true }), {})
    expect(native.signedHow).toBe('native')
    expect(signedTxReview(venice({ needsBlindSigning: undefined, data: '0x' }), {}).signedHow).toBe('native')
  })

  test('a caller 0x80 blob the firmware cannot show (7.15) is not recorded as certified', () => {
    const r = signedTxReview(venice({ firmwareVersion: '7.15.0' }), { txMetadata: { keyId: 0x80, signedPayload: 'AA==' } })
    expect(r.signedHow).toBe('provider')
  })

  test('a call with data the preview never marked is blind, not clear-signed', () => {
    expect(signedTxReview(venice({ needsBlindSigning: undefined, data: '0x12' }), {}).signedHow).toBe('blind')
  })

  test('keeps the decoded method name', async () => {
    const data = `0xa9059cbb000000000000000000000000${OTHER}${(5_000_000n).toString(16).padStart(64, '0')}`
    const calldataDecoded = (await decodeCalldata(USDC, data, 1, '0x0'))!
    const r = signedTxReview(venice({ chainId: 1, to: USDC, data, calldataDecoded }), {})
    expect(r.call).toBe('transfer')
  })
})

describe('the record', () => {
  const scope = { deviceId: 'dev', walletId: `dev:${FROM}` }
  const key = new Wallet('0x' + '22'.repeat(32))

  test('is written by txid and read back only for the same wallet', async () => {
    const serialized = await key.signTransaction({ to: VENICE, nonce: 1, gasLimit: 90000, chainId: 8453, type: 2, maxFeePerGas: 1, maxPriorityFeePerGas: 1, data: venice().data })
    const txid = utils.parseTransaction(serialized).hash!
    recordSignedEvmTx(scope, 8453, serialized, venice(), {})
    const read = db.getSignedTxReview('eip155:8453', txid.toUpperCase().replace('0X', '0x'), scope.deviceId, scope.walletId)
    expect(read?.signedHow).toBe('blind')
    expect(db.getSignedTxReview('eip155:8453', txid, scope.deviceId, 'dev:0xother')).toBeNull()
    expect(db.getSignedTxReview('eip155:1', txid, scope.deviceId, scope.walletId)).toBeNull()
  })

  test('bad signed bytes do not throw into the signing path', () => {
    expect(() => recordSignedEvmTx(scope, 1, 'not hex', venice(), {})).not.toThrow()
  })
})


// ── What a finished transaction did ──
const VVV = '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const UR_BASE = '0x6ff5693b99212da76ad316178a184ab56d299b43'
const ZERO = '0x0000000000000000000000000000000000000000'
const ADDRESS = /0x[0-9a-fA-F]{6,}/
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`
const transfer = (token: string, from: string, to: string, n: bigint) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: word(n) })
const own = new Set([FROM])
const tokens: Record<string, { symbol: string; decimals: number }> = {
  [VVV]: { symbol: 'VVV', decimals: 18 }, [VENICE.toLowerCase()]: { symbol: 'sVVV', decimals: 18 },
  [BASE_USDC]: { symbol: 'USDC', decimals: 6 }, [BASE_WETH]: { symbol: 'WETH', decimals: 18 }, [USDC]: { symbol: 'USDC', decimals: 6 },
}
const tokenOf = (a: string) => tokens[a.toLowerCase()]
const nameOf = (a: string) => (a.toLowerCase() === VENICE.toLowerCase() ? 'Staked Venice Token' : a.toLowerCase() === UR_BASE ? 'Uniswap Universal Router' : tokenOf(a)?.symbol)
const details = (input: Partial<Parameters<typeof txDetails>[0]>) => txDetails({ record: null, chainId: 8453, own, tokenOf, nameOf, ...input })
const CLAIMED = 210_294_203_596_150_800_000n
const RANDOM = '0x9999999999999999999999999999999999999999'

describe('tokenMoves', () => {
  test('nets each token in and out of this wallet and names it', () => {
    expect(tokenMoves([
      transfer(BASE_USDC, FROM, RANDOM, 5_000_000n),
      transfer(BASE_WETH, RANDOM, FROM, 1_234_567_000_000_000n),
      transfer(VVV, RANDOM, FROM, 3n * 10n ** 18n), transfer(VVV, FROM, RANDOM, 3n * 10n ** 18n),
    ], own, tokenOf)).toEqual([{ label: 'Sent', value: '5 USDC' }, { label: 'Received', value: '0.00123456 WETH' }])
  })

  test('leaves out transfers between others, tokens Desktop cannot name, and malformed logs', () => {
    const unknownToken = '0x1111111111111111111111111111111111111111'
    expect(tokenMoves([
      transfer(BASE_USDC, RANDOM, VENICE, 5_000_000n),
      transfer(unknownToken, RANDOM, FROM, 1n),
      { address: BASE_USDC, topics: [TRANSFER, topic(RANDOM), topic(FROM)], data: '0x12' },
      { address: BASE_USDC, topics: ['0x1234'], data: word(1n) },
    ], own, tokenOf)).toEqual([])
  })

  test('counts ERC-721 and ERC-1155 items', () => {
    const single = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'
    expect(tokenMoves([
      { address: RANDOM, topics: [TRANSFER, topic(ZERO), topic(FROM), word(7n)], data: '0x' },
      { address: RANDOM, topics: [single, topic(RANDOM), topic(RANDOM), topic(FROM)], data: `${word(1n)}${word(2n).slice(2)}` },
    ], own, tokenOf)).toEqual([{ label: 'Received', value: '3 NFTs' }])
  })

  test('large and tiny amounts stay short', () => {
    expect(tokenMoves([transfer(BASE_USDC, RANDOM, FROM, 1_234_567_891_234n)], own, tokenOf)[0].value).toBe('1,234,567.891234 USDC')
    expect(tokenMoves([transfer(VVV, RANDOM, FROM, 123_456_789n)], own, tokenOf)[0].value).toBe('0.000000000123456 VVV')
  })
})

describe('txDetails', () => {
  test('(a) Venice claimAndStake signed via the extension: name, what moved, result, how it was signed', async () => {
    const record = signedTxReview(venice({ contractName: { name: 'Staked Venice Token', symbol: 'sVVV' }, runtimeProvider: { alias: 'Venice', fingerprint: 'ab12' } as any }), { txMetadata: { keyId: 1 } })
    const lines = await details({
      record,
      tx: { to: VENICE, from: FROM, value: '0x0', data: venice().data },
      // Rewards paid out to the wallet and pulled straight into staking; sVVV minted to the wallet.
      receipt: { status: 1, logs: [transfer(VVV, RANDOM, FROM, CLAIMED), transfer(VVV, FROM, VENICE, CLAIMED), transfer(VENICE, ZERO, FROM, CLAIMED)] },
    })
    expect(lines).toEqual([
      { label: 'Action', value: 'Staked Venice Token · Contract call' },
      { label: 'Received', value: '210.294203 sVVV' },
      { label: 'Result', value: 'Succeeded' },
      { label: 'Signing', value: 'Signed as raw data on your KeepKey' },
      { label: 'Requested by', value: 'KeepKey Browser Extension' },
      { label: 'Described by', value: 'Venice' },
    ])
  })

  test('(b) a received 0-value contract call with no record: decoded, what came in', async () => {
    const data = `0xa9059cbb${topic(FROM).slice(2)}${word(25_000_000n).slice(2)}`
    expect(await details({
      tx: { to: BASE_USDC, from: RANDOM, value: '0x0', data },
      receipt: { status: 1, logs: [transfer(BASE_USDC, RANDOM, FROM, 25_000_000n)] },
    })).toEqual([
      { label: 'Action', value: 'USDC · Transfer' },
      { label: 'Received', value: '25 USDC' },
      { label: 'Result', value: 'Succeeded' },
    ])
  })

  test('(c) a plain ETH send', async () => {
    expect(await details({
      chainId: 1, tx: { to: RANDOM, from: FROM, value: '0x16345785d8a0000', data: '0x' }, receipt: { status: 1, logs: [] },
    })).toEqual([{ label: 'Sent', value: '0.1 ETH' }, { label: 'Result', value: 'Succeeded' }])
  })

  test('(d) a Uniswap swap with token transfers', async () => {
    expect(await details({
      tx: { to: UR_BASE, from: FROM, value: '0x0', data: '0x24856bc3' + '00'.repeat(64) },
      receipt: { status: 1, logs: [transfer(BASE_USDC, FROM, RANDOM, 100_000_000n), transfer(BASE_WETH, RANDOM, FROM, 41_250_000_000_000_000n)] },
    })).toEqual([
      { label: 'Action', value: 'Uniswap · Swap' },
      { label: 'Sent', value: '100 USDC' },
      { label: 'Received', value: '0.04125 WETH' },
      { label: 'Result', value: 'Succeeded' },
    ])
  })

  test('a failed approve says so; an unlimited approval adds no warning', async () => {
    const data = `0x095ea7b3${topic(RANDOM).slice(2)}${'f'.repeat(64)}`
    expect(await details({ chainId: 1, tx: { to: USDC, from: FROM, value: '0x0', data }, receipt: { status: 0, logs: [] } }))
      .toEqual([{ label: 'Action', value: 'USDC · Approve' }, { label: 'Result', value: 'Failed' }])
  })

  test('a shown-on-device record without the chain data still says how it was signed', async () => {
    const record = signedTxReview(venice({ needsBlindSigning: false }), { erc7730: {} })
    expect(await details({ record })).toEqual([
      { label: 'Signing', value: 'Shown on your KeepKey' },
      { label: 'Requested by', value: 'KeepKey Browser Extension' },
      { label: 'Described by', value: 'KeepKey ClearSign (ERC-7730)' },
    ])
  })

  test('nothing to show is null', async () => {
    expect(await details({})).toBeNull()
    // An unknown call to a contract Desktop cannot name, still pending.
    expect(await details({ tx: { to: RANDOM, from: RANDOM, value: '0x0', data: venice().data } })).toBeNull()
  })

  test('never prints an address, whatever names it is given', async () => {
    const record = { ...signedTxReview(venice({ appName: `dapp ${RANDOM}`, runtimeProvider: { alias: RANDOM } as any }), { txMetadata: { keyId: 1 } }), contract: RANDOM, call: `call${RANDOM}` }
    const lines = await txDetails({
      record, chainId: 8453, own, tokenOf: () => ({ symbol: RANDOM, decimals: 18 }), nameOf: () => RANDOM,
      tx: { to: RANDOM, from: FROM, value: '0x1', data: venice().data },
      receipt: { status: 1, logs: [transfer(RANDOM, RANDOM, FROM, 1n)] },
    })
    expect(lines!.length).toBeGreaterThan(0)
    for (const l of lines!) expect(`${l.label} ${l.value}`).not.toMatch(ADDRESS)
  })
})

describe('walletBook', () => {
  test('names tokens from the catalog and the portfolio, never a hidden or spam-named one', () => {
    const t = (contract: string, symbol: string, name: string, decimals?: number) =>
      ({ symbol, name, decimals, caip: `eip155:8453/erc20:${contract}`, balance: '1', balanceUsd: 0, priceUsd: 0 })
    const HIDDEN = '0x2222222222222222222222222222222222222222'
    const SPAM = '0x3333333333333333333333333333333333333333'
    db.setCachedBalances('book', [{ chainId: 'base', symbol: 'ETH', balance: '0', balanceUsd: 0, address: FROM, tokens: [
      t(VENICE.toLowerCase(), 'sVVV', 'Staked Venice Token'), t(VENICE.toLowerCase(), 'sVVV', 'Staked Venice Token', 18),
      t(HIDDEN, 'HID', 'Hidden', 18), t(SPAM, 'Visit claim.xyz', 'Telegram @Bot', 18),
    ] }] as any)
    db.setTokenVisibility(`eip155:8453/erc20:${HIDDEN}`, 'hidden')
    const book = walletBook(8453, 'book')
    expect(book.own).toEqual([FROM])
    expect(book.tokenOf(BASE_USDC)).toEqual({ symbol: 'USDC', decimals: 6 })
    expect(book.tokenOf(VENICE)).toEqual({ symbol: 'sVVV', decimals: 18 })
    expect(book.nameOf(VENICE)).toBe('Staked Venice Token')
    expect(book.nameOf(UR_BASE)).toBe('Uniswap Universal Router')
    expect([book.tokenOf(HIDDEN), book.tokenOf(SPAM), book.nameOf(SPAM)]).toEqual([undefined, undefined, undefined])
    expect(walletBook(8453).own).toEqual([])
  })
})

describe('lookupEvmTx', () => {
  const txid = `0x${'ab'.repeat(32)}`
  test('returns the call and the mined receipt', async () => {
    const pioneer = { LookupTx: async () => ({ data: { data: {
      tx: { hash: txid, to: VENICE, from: FROM, value: { type: 'BigNumber', hex: '0x00' }, data: '0xae5ac921' },
      receipt: { transactionHash: txid, status: 1, logs: [transfer(VVV, RANDOM, FROM, 1n), { bogus: true }] },
    } } }) }
    expect(await lookupEvmTx(pioneer, 'eip155:8453', txid)).toEqual({
      tx: { to: VENICE, from: FROM, value: '0x00', data: '0xae5ac921' },
      receipt: { status: 1, logs: [transfer(VVV, RANDOM, FROM, 1n)] },
    })
  })

  test('a pending transaction has no receipt', async () => {
    const pioneer = { LookupTx: async () => ({ data: { data: { tx: { hash: txid, data: '0x' }, receipt: null } } }) }
    expect((await lookupEvmTx(pioneer, 'eip155:1', txid))?.receipt).toBeUndefined()
  })

  test('a hung Pioneer call gives up', async () => {
    const pioneer = { LookupTx: () => new Promise(() => {}) }
    await expect(lookupEvmTx(pioneer, 'eip155:1', txid, 20)).rejects.toThrow('timed out')
  })
})
