/** What the history dialog says about an EVM transaction's ClearSign. */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet, utils } from 'ethers'
import type { SigningRequestInfo } from '../shared/types'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { signedHowText } from '../shared/tx-clearsign'
import { decodeCalldata } from './calldata-decoder'

const dir = mkdtempSync(join(tmpdir(), 'vault-signed-tx-review-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('./db')
const { evmTxid, signedTxReview, recordSignedEvmTx, txClearSign } = await import('./signed-tx-review')

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
  test('keeps the card verdict and lines exactly, and how the device signed', () => {
    const info = venice({ contractName: { name: 'Staked Venice Token', symbol: 'sVVV' }, priorUse: { count: 3, since: Date.UTC(2025, 0, 28) } })
    const review = signedTxReview(info, {})
    const risk = assessSigningRisk(info)!
    expect(review).toMatchObject({ signedHow: 'blind', tier: risk.tier, headline: risk.headline, reasons: risk.reasons, appName: 'KeepKey Browser Extension' })
    expect(signedHowText(review)).toBe('blind (Advanced Mode)')
  })

  test('the card verdict and what was sent decide how it signed', () => {
    const erc7730 = signedTxReview(venice({ needsBlindSigning: false }), { erc7730: {} })
    expect([erc7730.signedHow, signedHowText(erc7730)]).toEqual(['erc7730', 'clear-signed, from a KeepKey ClearSign description'])
    const certified = signedTxReview(venice({ needsBlindSigning: false }), { txMetadata: { keyId: 0x80 } })
    expect([certified.signedHow, signedHowText(certified)]).toEqual(['certified', 'clear-signed, from a KeepKey-certified description'])
    const provider = signedTxReview(venice({ runtimeProvider: { alias: 'Venice', fingerprint: 'ab12' } as any }), { txMetadata: { keyId: 1 } })
    expect(signedHowText(provider)).toBe("blind (Advanced Mode). Described by 'Venice', not checked by KeepKey")
    const native = signedTxReview(venice({ needsBlindSigning: false, deviceClearSigns: true }), {})
    expect([native.signedHow, signedHowText(native)]).toEqual(['native', 'clear-signed'])
    expect(signedTxReview(venice({ needsBlindSigning: undefined, data: '0x' }), {}).signedHow).toBe('native')
  })

  test('a caller 0x80 blob the firmware cannot show (7.15) is not recorded as certified', () => {
    const r = signedTxReview(venice({ firmwareVersion: '7.15.0' }), { txMetadata: { keyId: 0x80, signedPayload: 'AA==' } })
    expect(r.signedHow).toBe('provider')
    expect(signedHowText(r)).toStartWith('blind (Advanced Mode)')
  })

  test('a call with data the preview never marked is blind, not clear-signed', () => {
    expect(signedTxReview(venice({ needsBlindSigning: undefined, data: '0x12' }), {}).signedHow).toBe('blind')
  })

  test('a known call the firmware cannot show reads "not on this firmware", not "blind"', async () => {
    const data = `0xa9059cbb000000000000000000000000${OTHER}${(5_000_000n).toString(16).padStart(64, '0')}`
    const calldataDecoded = (await decodeCalldata(USDC, data, 1, '0x0'))!
    const r = signedTxReview(venice({ chainId: 1, to: USDC, data, calldataDecoded }), {})
    expect(r.call).toBe('ERC-20: transfer')
    expect(signedHowText(r)).toBe('raw data, this firmware cannot show it yet (Advanced Mode)')
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

    const section = await txClearSign(read, undefined, 8453)
    expect(section.kind).toBe('record')
  })

  test('bad signed bytes do not throw into the signing path', () => {
    expect(() => recordSignedEvmTx(scope, 1, 'not hex', venice(), {})).not.toThrow()
  })
})

describe('txClearSign without a record', () => {
  test('no call data available: no record', async () => {
    expect(await txClearSign(null, undefined, 1)).toEqual({ kind: 'none' })
  })

  test('no call data: plain transfer', async () => {
    expect(await txClearSign(null, { to: `0x${OTHER}`, value: '0xde0b6b3a7640000', data: '0x' }, 1)).toEqual({ kind: 'plain' })
  })

  test('a token transfer is decoded now, with what it does', async () => {
    const data = `0xa9059cbb000000000000000000000000${OTHER}${(5_000_000n).toString(16).padStart(64, '0')}`
    expect(await txClearSign(null, { to: USDC, value: '0x0', data }, 1)).toEqual({
      kind: 'decoded', call: 'ERC-20: transfer', reasons: [{ level: 'low', text: `Sends 5 USDC to 0x${OTHER}.` }],
    })
  })

  test('says nothing about what the device could show today', async () => {
    const unknown = await txClearSign(null, { to: VENICE, value: '0x0', data: venice().data }, 8453)
    expect(unknown).toEqual({ kind: 'decoded', reasons: [] })
    const data = `0x095ea7b3000000000000000000000000${OTHER}${'f'.repeat(64)}`
    const approve = await txClearSign(null, { to: USDC, value: '0x0', data }, 1)
    expect(approve.kind === 'decoded' && approve.reasons.map((r) => r.text)).toEqual([`Lets 0x${OTHER} spend ALL of your USDC, now and later, without asking you again.`])
    // A THORChain deposit: its only line names the firmware and Advanced Mode.
    const memo = Buffer.from('=:TRON.TRX:TMoUJ2EqVESgcaD5eJdvphkkn8K3ucXdTp:5740830833:keep:30').toString('hex')
    const w = (hex: string) => hex.padStart(64, '0')
    const thor = await txClearSign(null, {
      to: '0x00dc6100103bc402d490aee3f9a5560cbd91f1d4', value: '0x90c5e8ba98e000',
      data: `0x44bc937b${w('718f6c9df785bc4e323086de024ca822efbe8ab9')}${w('0')}${w('90c5e8ba98e000')}${w('a0')}${w('ffffffff')}${w((memo.length / 2).toString(16))}${memo.padEnd(128, '0')}`,
    }, 8453)
    expect(thor.kind === 'decoded' && thor.call).toBeTruthy()
    expect(thor.kind === 'decoded' && thor.reasons.map((r) => r.text)).toEqual(['Sends 0.04075 ETH to the contract at 0x00dc6100103bc402d490aee3f9a5560cbd91f1d4.'])
  })

  test('a received call shows what it is, with no lines about "your" funds', async () => {
    const data = `0x095ea7b3000000000000000000000000${OTHER}${'f'.repeat(64)}`
    expect(await txClearSign(null, { to: USDC, value: '0x0', data }, 1, true)).toEqual({ kind: 'decoded', call: 'ERC-20: approve', reasons: [] })
  })
})
