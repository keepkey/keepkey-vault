/**
 * The card says what the KeepKey will show, from real batch 5 emulator legs
 * (emulator-legs-20261030/batch5-test, round 2): the requests in legs.json and
 * the local TEST service's answers, signed under that run's TEST root (public
 * data only). Tampered answers are made the way that run's controls made them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { SigningRequestInfo } from '../src/shared/types'
import { evmSigningVerdict, prepareEvmTxSigningInfo } from '../src/bun/evm-presign-report'
import { evmCallRequiresAdvancedMode } from '../src/bun/evm-signing-policy'
import { forgetRefusedErc7730Definitions } from '../src/bun/erc7730-resolver'
import { describeErc7730Call } from '../src/bun/erc7730-describe'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import { trustTestRoot } from './support/clearsign-test-root'
import real from './fixtures/clearsign-batch5-test/real-legs.json'
import { createHash } from 'node:crypto'

const FW = '7.16.0'
const CAPS = [1, 4]
const originalFetch = globalThis.fetch
let restoreRoot = () => {}
beforeAll(() => { restoreRoot = trustTestRoot(real.testRootPublicKey) })
afterAll(() => restoreRoot())
afterEach(() => { globalThis.fetch = originalFetch; forgetRefusedErc7730Definitions() })

type Leg = { tx: { chainId: number; from: string; to: string; value: string; data: string } }

/** The TEST service for one leg: its kind-1 answer or ERC-7730 definition; nothing else. */
function serve(answer: { schema?: unknown; definition?: unknown }) {
  globalThis.fetch = (async (url: any) => {
    const u = String(url)
    if (u.endsWith('/v1/evm/schema') && answer.schema) return Response.json(answer.schema)
    if (u.includes('/v1/erc7730/definition') && answer.definition) return Response.json(answer.definition)
    return Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
  }) as unknown as typeof fetch
}

async function card({ tx }: Leg) {
  const info: SigningRequestInfo = {
    id: 't', method: '/eth/sign-transaction', appName: 'test', from: tx.from, to: tx.to, value: tx.value,
    chainId: tx.chainId, data: tx.data, firmwareVersion: FW,
  }
  await prepareEvmTxSigningInfo(info, { ...tx, nonce: '0x0', gas: '0x7a120', maxFeePerGas: '0x6fc23ac00', maxPriorityFeePerGas: '0x3b9aca00' }, FW, CAPS)
  const blob = info.calldataDecoded?.signedInsightBlob
  const metadata = blob ? { signedPayload: `0x${Buffer.from(blob, 'base64').toString('hex')}`, keyId: info.calldataDecoded!.insightKeyId } : undefined
  const predictAdvancedMode = evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, metadata, info.erc7730, FW, tx.value, CAPS)
  return { info, metadata, predictAdvancedMode, risk: assessSigningRisk(info) }
}

/** serve.ts tamperKind1: one byte of the body's method text, or of the signature's r. */
function tamperKind1(payload: string, where: 'body' | 'sig') {
  const b = Buffer.from(payload.replace(/^0x/, ''), 'hex')
  b[where === 'sig' ? b.length - 65 + 5 : 1 + 139 + 31] ^= 0x01
  return `0x${b.toString('hex')}`
}

/** serve.ts tamperErc7730: one signature byte, or the program's first string; re-identified. */
function tamperErc7730(definition: any, where: 'sig' | 'str') {
  const env = Buffer.from(String(definition.envelope).replace(/^0x/, ''), 'hex')
  env[where === 'sig' ? env.length - 20 : 10 + 179 + 5 + 2 + 2] ^= 0x01
  return { ...definition, envelope: `0x${env.toString('hex')}`, definitionId: `0x${createHash('sha256').update(env).digest('hex')}` }
}

describe('a certified envelope Desktop cannot verify is never attached or shown green', () => {
  test('kind-1 OpolisPay payPayroll (L01): the signed answer attaches; a changed body or signature does not', async () => {
    const leg = real.legs.L01
    serve({ schema: leg.service })
    const good = await card(leg)
    expect(good.metadata?.signedPayload).toBe(leg.service.signedPayload)
    expect(good.predictAdvancedMode).toBe(false)
    expect(good.risk?.tier).toBe('green')

    for (const where of ['body', 'sig'] as const) {
      serve({ schema: { ...leg.service, signedPayload: tamperKind1(leg.service.signedPayload, where) } })
      const bad = await card(leg)
      expect(bad.metadata).toBeUndefined()
      expect(bad.info.needsBlindSigning).toBe(true)
      expect(bad.predictAdvancedMode).toBe(true)
      expect(bad.risk?.tier).not.toBe('green')
    }
  })

  test('kind-1 Venice (L02, L03): a changed signature is not attached', async () => {
    for (const leg of [real.legs.L02, real.legs.L03]) {
      serve({ schema: { ...leg.service, signedPayload: tamperKind1(leg.service.signedPayload, 'sig') } })
      const bad = await card(leg)
      expect(bad.metadata).toBeUndefined()
      expect(bad.predictAdvancedMode).toBe(true)
      expect(bad.risk?.tier).not.toBe('green')
    }
  })

  test('ERC-7730 Morpho deposit (R001): the signed definition attaches; a changed signature or string does not', async () => {
    const leg = real.legs.R001
    serve({ definition: leg.definition })
    const good = await card(leg)
    expect(good.info.erc7730?.primaryDefinitionId).toBe(leg.definition.definitionId)
    expect(good.predictAdvancedMode).toBe(false)

    for (const where of ['sig', 'str'] as const) {
      serve({ definition: tamperErc7730(leg.definition, where) })
      const bad = await card(leg)
      expect(bad.info.erc7730).toBeUndefined()
      expect(bad.info.needsBlindSigning).toBe(true)
      expect(bad.predictAdvancedMode).toBe(true)
      expect(bad.risk?.tier).not.toBe('green')
      // The gate agrees even when a caller hands the same envelope over itself.
      const catalog = { primaryDefinitionId: tamperErc7730(leg.definition, where).definitionId, definitions: [{ ...tamperErc7730(leg.definition, where), kind: 1 }] }
      expect(evmCallRequiresAdvancedMode(leg.tx.to, leg.tx.data, leg.tx.chainId, false, undefined, catalog, FW, leg.tx.value, CAPS)).toBe(true)
    }
  })
})

describe('a certified long-tail call reads as the device shows it', () => {
  const fields = (info: SigningRequestInfo) => Object.fromEntries((info.calldataDecoded?.fields ?? []).map((f) => [f.name, f.value]))

  test('OpolisPay payPayroll (L01): device "OPOLIS PAYROLL: Pay 2987.5 USDT to the Opolis payroll contract"', async () => {
    serve({ schema: real.legs.L01.service })
    const { info } = await card(real.legs.L01)
    expect(info.calldataDecoded).toMatchObject({ dappName: 'Opolis Payroll', method: 'payPayroll', source: 'local' })
    expect(fields(info)).toEqual({
      Summary: 'Pay 2987.5 USDT to the Opolis payroll contract',
      token: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      amount: '2987.5 USDT',
      payrollId: `0x${'0'.repeat(60)}eb72`,
    })
  })

  test('Venice claimAndStake (L02) and initiateUnstake (L03)', async () => {
    serve({ schema: real.legs.L02.service })
    const l02 = (await card(real.legs.L02)).info
    expect(l02.calldataDecoded).toMatchObject({ dappName: 'Venice Staking', method: 'claimAndStake' })
    expect(fields(l02)).toEqual({ Summary: 'Claim your pending VVV staking rewards and stake them' })

    serve({ schema: real.legs.L03.service })
    const l03 = (await card(real.legs.L03)).info
    expect(l03.calldataDecoded).toMatchObject({ dappName: 'Venice Staking', method: 'initiateUnstake' })
    expect(fields(l03).amount).toBe('210.294203596150805794 sVVV')
    expect(fields(l03).Summary).toStartWith('Start unstaking 210.294203596150805794 sVVV; pending VVV rewards are paid;')
  })
})

describe('emulator TEST-root QA: the ERC-7730 description uses the root the device trusts', () => {
  test('R001 is described under the trusted TEST root, and not under the production root', () => {
    const { tx, definition } = real.legs.R001
    const d = describeErc7730Call(definition.envelope, { ...tx, from: tx.from, firmwareVersion: FW })
    expect(d?.intent).toBeTruthy()
    restoreRoot()
    try {
      expect(describeErc7730Call(definition.envelope, { ...tx, from: tx.from, firmwareVersion: FW })).toBeUndefined()
    } finally { restoreRoot = trustTestRoot(real.testRootPublicKey) }
  })
})

describe('WalletConnect eth_sendTransaction reports the call the way REST does', () => {
  // The emulator legs (emulator-legs-20261030/wc-legs) signed these on 7.16.0 with the
  // device showing every field, while the WalletConnect report read P1 "blind review".
  const unavailable = { status: 'unavailable', transactionFingerprint: 'f', assetChanges: [], authorityChanges: [], warnings: [], unknowns: [] } as any
  const restVerdict = async (leg: Leg) => evmSigningVerdict((await card(leg)).info, {}, unavailable, false)

  /** The card WalletConnect shows for this transaction (declined, so nothing is signed). */
  async function wcCard({ tx }: Leg): Promise<SigningRequestInfo> {
    const { WalletConnectManager } = await import('../src/bun/walletconnect')
    const cards: SigningRequestInfo[] = []
    const manager: any = new WalletConnectManager({
      getEvmAddressInfo: () => ({ address: tx.from, addressIndex: 0 }),
      getFirmwareVersion: () => FW,
      getDeviceCapabilities: () => CAPS,
      getAdvancedModeEnabled: () => false,
      getEvmSimulationEndpoint: () => 'http://127.0.0.1:9/',
      recordClearSignObservation: () => undefined,
      authenticateClearSignObservation: () => {},
      finalizeClearSignObservation: () => {},
      requestSigningApproval: async (info: SigningRequestInfo) => { cards.push(info); return false },
      ethSignTx: async () => { throw new Error('nothing is signed in this test') },
      dismissSigning: () => {},
      log: () => {},
    } as any)
    await expect(manager.signTransaction({
      ...tx, chainId: `0x${tx.chainId.toString(16)}`, nonce: '0x0', gas: '0x7a120', maxFeePerGas: '0x6fc23ac00', maxPriorityFeePerGas: '0x3b9aca00',
    }, [0x8000002c, 0x8000003c, 0x80000000, 0, 0], 'test-dapp', tx.chainId, false)).rejects.toThrow('User rejected signing')
    expect(cards.length).toBe(1)
    return cards[0]
  }

  test('a certified call (L01 OpolisPay): P4 from the certified description; a changed signature is not', async () => {
    const leg = real.legs.L01
    serve({ schema: leg.service })
    const wc = (await wcCard(leg)).clearSignReport!
    expect(wc.protectionLevel).toBe('P4')
    expect(wc.descriptor).toMatchObject({ source: 'certified', authenticated: true, format: 'EVM_METADATA', label: 'payPayroll' })
    expect(wc.descriptor).toMatchObject((await restVerdict(leg)).descriptor)

    serve({ schema: { ...leg.service, signedPayload: tamperKind1(leg.service.signedPayload, 'sig') } })
    const bad = (await wcCard(leg)).clearSignReport!
    expect(bad.protectionLevel).not.toBe('P4')
    expect(bad.descriptor.authenticated).toBe(false)
  })

  test('a call the firmware shows natively (1 USDT transfer): P4, as on REST', async () => {
    const leg: Leg = { tx: { chainId: 1, from: real.legs.L01.tx.from, to: '0xdac17f958d2ee523a2206206994597c13d831ec7', value: '0x0',
      data: `0xa9059cbb${'5'.repeat(40).padStart(64, '0')}${(1_000_000).toString(16).padStart(64, '0')}` } }
    serve({})
    const wc = (await wcCard(leg)).clearSignReport!
    expect(wc.protectionLevel).toBe('P4')
    expect(wc.descriptor).toMatchObject({ source: 'native', authenticated: true, format: 'FIRMWARE_NATIVE' })
    expect(wc.descriptor).toMatchObject((await restVerdict(leg)).descriptor)
  })
})
