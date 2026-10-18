/**
 * The card reads an ERC-7730 definition the way the KeepKey does: the same
 * intent, labels and values from the same envelope bytes, and only when the
 * signature checks out to the production root. Fixtures are the
 * production ClearSign service's own responses (erc7730-describe.fixtures.json)
 * and the TEST-root replay fixture the resolver tests use.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { SigningRequestInfo } from '../shared/types'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { buildClearSignReport } from '../shared/clearsign-report'
import { describeErc7730Call } from './erc7730-describe'
import { evmSigningVerdict, prepareEvmTxSigningInfo, withoutErc7730Description } from './evm-presign-report'
import { forgetRefusedErc7730Definitions } from './erc7730-resolver'
import served from './erc7730-describe.fixtures.json'
import testRoot from './erc7730-resolver.fixtures.json'

const ME = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const word = (v: string) => v.toLowerCase().replace(/^0x/, '').padStart(64, '0')
// SDK suite fw-716/40: supply(USDC, 1, onBehalfOf = the signer, referral 0).
const SUPPLY = `0x617ba037${word(USDC)}${word('0x1')}${word(ME)}${word('0x0')}`
const aave = { chainId: 1, to: served.aaveSupply1.contractAddress, data: SUPPLY, value: '0x0', from: ME }
const UNAVAILABLE = { status: 'unavailable', transactionFingerprint: 'f', assetChanges: [], authorityChanges: [], warnings: [],
  unknowns: [{ code: 'SIMULATION_UNAVAILABLE', message: "Couldn't simulate this transaction.", severity: 'danger' }] } as any

describe('describeErc7730Call: the lines the KeepKey shows', () => {
  test('Aave V3 supply on Ethereum: intent, fields, this wallet, signer, name and links', () => {
    expect(describeErc7730Call(served.aaveSupply1.envelope, aave)).toEqual({
      signedBy: 'KeepKey ClearSign',
      intent: 'Supply',
      fields: [
        { label: 'Amount to supply', value: '0.000001 USDC' },
        { label: 'Collateral recipient', value: `${ME}\n(this wallet)` },
      ],
      protocol: {
        name: 'Aave V3', url: 'https://aave.com',
        about: 'Deposits the token into Aave, where it earns interest. The collateral recipient gets aTokens for it, which are redeemed with a withdraw.',
      },
      explorerUrl: 'https://etherscan.io/address/0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    })
  })

  test('Aave V3 supply on Base: the device\'s unknown token, this computer\'s reading, another recipient', () => {
    const other = '0x1111111111111111111111111111111111111111'
    const data = `0x617ba037${word('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')}${word('0xf4240')}${word(other)}${word('0x0')}`
    const d = describeErc7730Call(served.aaveSupply8453.envelope, { chainId: 8453, to: served.aaveSupply8453.contractAddress, data, from: ME })
    expect(d?.signedBy).toBe('KeepKey ClearSign')
    expect(d?.fields).toEqual([
      // 7.16 has no Base tokens: the device line, then this computer's own reading.
      { label: 'Amount to supply', value: '1000000\nunknown token\n0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', note: 'This computer reads it as 1 USDC.' },
      { label: 'Collateral recipient', value: other },
    ])
    expect(d?.explorerUrl).toBe('https://basescan.org/address/0xA238Dd80C259a72e81d7e4664a9801593F98d1c5')
    // Signed for Base: no description for the same bytes on another chain.
    expect(describeErc7730Call(served.aaveSupply8453.envelope, { chainId: 1, to: served.aaveSupply8453.contractAddress, data, from: ME })).toBeUndefined()
  })

  test('the device\'s own markers: threshold message, signer label, and this wallet only for the matched signer', () => {
    // withdraw(WETH, 2^256-1, me) on the Aave V3 Pool; the definition marks 2^256-1 as "Max".
    const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    const supplyWeth = { ...aave, data: `0x617ba037${word(WETH)}${word('0xde0b6b3a7640000')}${word(ME)}${word('0x0')}` }
    expect(describeErc7730Call(served.aaveSupply1.envelope, supplyWeth)?.fields[0]).toEqual({ label: 'Amount to supply', value: '1 WETH' })
    const max = describeErc7730Call(served.aaveWithdraw1.envelope, { ...aave, data: `0x69328dec${word(WETH)}${'f'.repeat(64)}${word(ME)}` })
    expect(max?.fields[0].value).toBe('Signer: Max\n115792089237316195423570985008687907853269984665640564039457.584007913129639935 WETH')
    const borrow = describeErc7730Call(served.aaveBorrow1.envelope, { ...aave, data: `0xa415bcad${word(USDC)}${word('0x1')}${word('0x2')}${word('0x0')}${word(ME)}` })
    expect(borrow?.fields[1]).toEqual({ label: 'Interest Rate mode', value: 'label set by signer\nvariable (2)' })
    // No matched signer (a REST path this computer did not match to `from`): no "(this wallet)".
    expect(describeErc7730Call(served.aaveSupply1.envelope, { ...aave, from: undefined })?.fields[1]).toEqual({ label: 'Collateral recipient', value: ME })
  })

  test('Lido submit: the interpolated intent and the coin sent with the call (@.value)', () => {
    const d = describeErc7730Call(served.lidoSubmit1.envelope, {
      chainId: 1, to: served.lidoSubmit1.contractAddress, data: `0xa1903eab${word('0x0')}`, value: '0x2386f26fc10000', from: ME,
    })
    expect(d).toMatchObject({ signedBy: 'KeepKey ClearSign', intent: 'Stake ETH', summary: 'Stake 0.01 ETH', fields: [{ label: 'Amount', value: '0.01 ETH' }] })
    expect(d?.protocol).toMatchObject({ name: 'Lido', url: 'https://lido.fi' })
  })

  test('described only when the certificate and the catalog signature check out', () => {
    // A TEST-root envelope: never described.
    const { tx, definition } = testRoot.plain
    expect(describeErc7730Call(definition.envelope, { ...tx, from: ME })).toBeUndefined()
    // One flipped bit in the signature, or in the program (another Merkle leaf).
    const env = served.aaveSupply1.envelope
    const flip = (at: number) => `${env.slice(0, at)}${(parseInt(env[at], 16) ^ 1).toString(16)}${env.slice(at + 1)}`
    expect(describeErc7730Call(flip(env.length - 4), aave)).toBeUndefined()
    const label = env.indexOf(Buffer.from('Amount to supply').toString('hex'))
    expect(describeErc7730Call(flip(label + 1), aave)).toBeUndefined()
  })

  test('calldata the ABI does not fit: no description rather than a guess', () => {
    expect(describeErc7730Call(served.aaveSupply1.envelope, { ...aave, data: SUPPLY.slice(0, 74) })).toBeUndefined()
  })
})

describe('the approval card for SDK suite fw-716/40 (Aave supply)', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  test('names Aave, says who signed it, and carries no filler', async () => {
    forgetRefusedErc7730Definitions()
    globalThis.fetch = (async (url: any) => String(url).includes('/v1/erc7730/definition')
      ? Response.json(served.aaveSupply1)
      : Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })) as unknown as typeof fetch
    const info: SigningRequestInfo = {
      id: 'card', method: '/eth/sign-transaction', appName: 'dapp', chain: 'eth',
      from: ME, to: aave.to, value: '0x0', chainId: 1, data: SUPPLY, firmwareVersion: '7.16.0', advancedModeEnabled: false,
    }
    await prepareEvmTxSigningInfo(info, { to: aave.to, data: SUPPLY, value: '0x0', from: ME }, '7.16.0', [1, 4])
    expect(info.erc7730Description?.protocol?.name).toBe('Aave V3')
    const verdict = evmSigningVerdict(info, {}, UNAVAILABLE, false)
    expect(verdict.descriptor).toMatchObject({ source: 'erc7730', authenticated: true, signer: 'KeepKey ClearSign' })
    info.clearSignReport = buildClearSignReport({ ...verdict, simulation: UNAVAILABLE })
    expect(info.clearSignReport.headline).toBe('Signed by KeepKey ClearSign')
    expect(info.clearSignReport.limitations.map((l) => l.code)).not.toContain('DESCRIPTION_WITHOUT_COMPLETE_SIMULATION')
    const risk = assessSigningRisk(info)!
    expect(risk.tier).toBe('green')
    expect(risk.reasons.map((r) => r.text)).toEqual(['Supply on Aave V3: your KeepKey shows it from a KeepKey ClearSign description.'])
    // Refused by the device: the description goes with the definition.
    expect(withoutErc7730Description(info).erc7730Description).toBeUndefined()
  })
})
