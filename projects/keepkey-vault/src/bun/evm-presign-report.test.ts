/**
 * POST /clearsign/report must give the verdict the Desktop signing overlay
 * gives for the same bytes. Real Base transactions from 2026-10-04: a Uniswap
 * Universal Router swap and the Across depositV3 of a cross-chain swap.
 * Network is cut (fetch throws): simulation is honestly "unavailable", and the
 * certified lookups fail closed, as they do offline in the app.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SigningRequestInfo } from '../shared/types'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { buildEvmPresignReport, prepareEvmTxSigningInfo } from './evm-presign-report'
import { simulateEvmEffects } from './evm-effects'
import { uniswapReportFindingsWithState } from './uniswap-report'
import { resolvePromotedEvmArtifact } from './clearsign-artifact-resolver'
import { ClearSignReportResponse } from './schemas'

const swap = require('../../__tests__/fixtures/uniswap/base-ur-usdc-to-eth-swap.json')
const SIGNER = '0x909ef6b32dfdc12ca86aa710b54c991af3c5f82e'
const ACROSS = {
  chainId: 8453, from: SIGNER, to: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', value: '0x189e6105b7a8de7',
  data: '0x7b939232000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e0000000000000000000000004200000000000000000000000000000000000006000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000000000000000000000000000000000000000000000000189e6105b7a8de70000000000000000000000000000000000000000000000000189bfc0793fe6f50000000000000000000000000000000000000000000000000000000000000001000000000000000000000000394311a6aaa0d8e3411d8b62de4578d41322d1bd000000000000000000000000000000000000000000000000000000006ac2c7bb000000000000000000000000000000000000000000000000000000006ac2e3db000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000001dc0de00410000000c',
}
const UR = { chainId: swap.chainId, from: swap.from, to: swap.to, value: swap.value, data: swap.data }

const originalFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch })
afterEach(() => { globalThis.fetch = originalFetch })

type Tx = { chainId: number; from: string; to: string; value: string; data: string }

/** What the route does, minus HTTP. */
async function report(tx: Tx, firmwareVersion: string | undefined) {
  const endpoint = 'http://127.0.0.1:9/'
  const signingInfo: SigningRequestInfo = {
    id: 'report', method: '/eth/sign-transaction', appName: 'report', chain: 'eth',
    from: tx.from, to: tx.to, value: tx.value, chainId: tx.chainId, data: tx.data, firmwareVersion,
  }
  await prepareEvmTxSigningInfo(signingInfo, tx, firmwareVersion)
  return buildEvmPresignReport({
    signingInfo,
    deviceConnected: Boolean(firmwareVersion),
    simulation: await simulateEvmEffects(tx, endpoint),
    universalRouterFindings: await uniswapReportFindingsWithState(tx.data, tx.chainId, tx.to, tx.from, endpoint),
    artifactResolution: resolvePromotedEvmArtifact(tx.chainId, tx.to, tx.data),
  })
}

/** The Desktop risk bar for the same request, built by the signing path. */
async function desktopRisk(tx: Tx, firmwareVersion: string) {
  const s: SigningRequestInfo = { id: 'd', method: '/eth/sign-transaction', appName: 'app', from: tx.from, to: tx.to, value: tx.value, chainId: tx.chainId, data: tx.data, firmwareVersion }
  await prepareEvmTxSigningInfo(s, tx, firmwareVersion)
  return assessSigningRisk(s)!
}

const risk = (r: Awaited<ReturnType<typeof report>>) => r.findings.filter((f) => f.code.startsWith('RISK_')).map((f) => f.message)
const rows = (r: Awaited<ReturnType<typeof report>>) => r.findings.filter((f) => f.code === 'DECODED_FIELD').map((f) => f.message)

describe('POST /clearsign/report — Desktop parity', () => {
  test('Uniswap UR swap on Base: P2, named, Desktop risk lines verbatim, swap rows', async () => {
    const r = await report(UR, '7.15.0')
    expect(ClearSignReportResponse.safeParse(r).success).toBe(true)
    expect(r.simulation.status).toBe('unavailable')
    expect(r.protectionLevel).toBe('P2')
    expect(r.headline).toBe('Decoded on this computer; not authenticated by KeepKey')
    expect(r.descriptor).toMatchObject({ source: 'none', authenticated: false, label: 'Uniswap Universal Router swap', resolution: 'reviewed-decoder' })
    const desktop = await desktopRisk(UR, '7.15.0')
    expect(risk(r)).toEqual(desktop.reasons.map((x) => x.text))
    expect(r.findings[0].message).toContain('You would be signing blind')
    expect(risk(r).join('\n')).toContain('This computer reads it as: Swaps 300 USDC for at least 0.108123518386717195 ETH through the Uniswap Universal Router')
    expect(rows(r)).toContain('Action: Swap 300 USDC for at least 0.108123518386717195 ETH')
    expect(rows(r)).toContain('Minimum output: 0.108123518386717195 ETH')
    expect(rows(r).some((x) => x.startsWith('Deadline: '))).toBe(true)
    expect(r.limitations.map((l) => l.code)).toContain('DEVICE_SHOWS_RAW_DATA')
  })

  test('Across depositV3 Base → Ethereum: P2, named, blind truth kept', async () => {
    const r = await report(ACROSS, '7.15.0')
    expect(ClearSignReportResponse.safeParse(r).success).toBe(true)
    expect(r.protectionLevel).toBe('P2')
    expect(r.descriptor).toMatchObject({ label: 'Across bridge deposit', resolution: 'reviewed-decoder' })
    const desktop = await desktopRisk(ACROSS, '7.15.0')
    expect(risk(r)).toEqual(desktop.reasons.map((x) => x.text))
    expect(r.findings[0].message).toContain('Across bridge deposit to the Across SpokePool on Base. Your KeepKey cannot decode bridge deposits yet')
    expect(r.findings[0].severity).toBe('danger')
    expect(rows(r)).toContain('Action: Across bridge deposit: Base → Ethereum (chain id 1)')
    expect(rows(r).some((x) => x.startsWith('Recipient gets: '))).toBe(true)
    expect(r.limitations.map((l) => l.code)).toContain('DEVICE_SHOWS_RAW_DATA')
  })

  test('no device: same decode, says the firmware was not checked', async () => {
    const r = await report(UR, undefined)
    expect(r.protectionLevel).toBe('P2')
    expect(r.descriptor.label).toBe('Uniswap Universal Router swap')
    const codes = r.limitations.map((l) => l.code)
    expect(codes).toContain('DEVICE_NOT_CONNECTED')
    expect(codes).not.toContain('DEVICE_SHOWS_RAW_DATA')
    expect(r.findings[0].message).toContain('You would be signing blind')
  })

  test('the same swap calldata to an unknown contract stays P1, unnamed, no rows', async () => {
    const r = await report({ ...UR, to: '0x1111111111111111111111111111111111111111' }, '7.15.0')
    expect(r.protectionLevel).toBe('P1')
    expect(r.headline).toBe('Unknown transaction — blind review required')
    expect(r.descriptor.label).toBeUndefined()
    expect(r.descriptor.resolution).toBe('no-artifact')
    expect(rows(r)).toEqual([])
    expect(risk(r)[0]).toContain('You would be signing blind')
  })
})

// ── In-app swap card (buildEvmReportForTx, signerVerdict) ──────────────────
// Real Relay transactions on Base (Blockscout, 2026-10-05) and the approve the
// in-app swap builds before them (encodeApprove(relay.to, amount)).
const relayFixtures = require('../../__tests__/fixtures/relay/depository-deposits.json')
const RELAY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const DEPOSIT = relayFixtures.transactions.find((t: any) => t.hash.startsWith('0xb397762233'))
const APPROVE = {
  chainId: 8453, from: DEPOSIT.from, to: BASE_USDC, value: '0x0',
  data: `0x095ea7b3${RELAY.slice(2).padStart(64, '0')}${'2d4760d'.padStart(64, '0')}`,
}

/** The ClearSign service for reviewed shapes: the real catalog body inside a
 * stand-in certificate and signature (the device, not Vault, checks those). */
function catalogService(sent: any[]) {
  const { findCertifiedEvmSchemaByShape, buildEvmSchemaBody, evmEntryId } = require('./evm-certified-schema')
  return (async (url: any, init: any) => {
    if (!String(url).endsWith('/v1/evm/schema')) throw new Error('offline')
    const body = JSON.parse(init.body)
    sent.push(body)
    const spec = findCertifiedEvmSchemaByShape(body.chainId, body.contract, body.selector, body.calldataLength, body.spender, body.token)
    if (!spec) return Response.json({ classification: 'OPAQUE' }, { status: 422 })
    const certificate = Buffer.alloc(139, 0x11)
    certificate.writeUInt32BE(spec.chainId, 2)
    return Response.json({
      classification: 'VERIFIED', keyId: 0x80, entry: evmEntryId(spec), method: spec.method,
      chainId: spec.chainId, contract: spec.contract, selector: spec.selector, expectedCalldataLength: spec.expectedCalldataLength,
      signedPayload: `0x03${certificate.toString('hex')}${buildEvmSchemaBody(spec).toString('hex')}${'22'.repeat(65)}`,
    })
  }) as unknown as typeof fetch
}

const inApp = async (tx: Tx, firmwareVersion: string | undefined) => {
  const { buildEvmReportForTx } = await import('./evm-presign-report')
  return (await buildEvmReportForTx({ tx, firmwareVersion, endpoint: 'http://127.0.0.1:9/', signerVerdict: true, measure: async () => { throw new Error('offline') } })).report
}

describe('in-app swap card — the Desktop signing verdict for the same bytes', () => {
  test('approve of reviewed Base USDC to the Relay Depository: certified, P4, spender named', async () => {
    const sent: any[] = []
    globalThis.fetch = catalogService(sent)
    const r = await inApp(APPROVE, '7.16.0')
    expect(ClearSignReportResponse.safeParse(r).success).toBe(true)
    expect(r.protectionLevel).toBe('P4')
    expect(r.headline).toBe('Authenticated ClearSign description')
    expect(r.descriptor).toMatchObject({ source: 'certified', authenticated: true, format: 'EVM_METADATA', label: 'approve' })
    expect(sent).toEqual([{ chainId: 8453, contract: BASE_USDC, selector: '0x095ea7b3', calldataLength: 68, spender: RELAY }])
    expect(risk(r).join('\n')).toContain(`Lets ${RELAY} (the Relay Depository) spend up to 47478285 units of token ${BASE_USDC}`)
    expect(r.limitations.map((l) => l.code)).not.toContain('DEVICE_SHOWS_RAW_DATA')
  })

  test('real Relay depositErc20 on Base: certified per-token entry, P4, decoded rows', async () => {
    const sent: any[] = []
    globalThis.fetch = catalogService(sent)
    const tx = { chainId: 8453, from: DEPOSIT.from, to: RELAY, value: '0x0', data: DEPOSIT.data }
    const r = await inApp(tx, '7.16.0')
    expect(r.protectionLevel).toBe('P4')
    expect(r.descriptor).toMatchObject({ source: 'certified', authenticated: true, label: 'Relay deposit (depositErc20)', resolution: 'no-artifact' })
    // Only the shape and the token that selects the entry leave the host.
    expect(sent).toEqual([{ chainId: 8453, contract: RELAY, selector: '0xe8017952', calldataLength: 132, token: BASE_USDC }])
    expect(risk(r)[0]).toBe('Relay deposit on Base: sends 47.478285 USDC to the Relay Depository, credited to your account. Your KeepKey shows this deposit from a KeepKey-certified description and refuses it if that description is not genuine. Check the amount there.')
    expect(risk(r).join('\n')).toContain("set by Relay's off-chain order")
    expect(rows(r)).toContain('Action: Relay deposit on Base: 47.478285 USDC')
    expect(rows(r)).toContain(`Credited to (depositor): ${DEPOSIT.from}`)
    expect(rows(r).some((x) => x.startsWith('Relay order id: 0x001c161a'))).toBe(true)
  })

  test('service unreachable: the deposit stays blind and says so, but is decoded (P2)', async () => {
    const tx = { chainId: 8453, from: DEPOSIT.from, to: RELAY, value: '0x0', data: DEPOSIT.data }
    const r = await inApp(tx, '7.16.0')
    expect(r.protectionLevel).toBe('P2')
    expect(r.descriptor).toMatchObject({ authenticated: false, label: 'Relay deposit', resolution: 'reviewed-decoder' })
    expect(risk(r)[0]).toContain('Your KeepKey cannot decode this deposit')
    expect(r.limitations.map((l) => l.code)).toContain('DEVICE_SHOWS_RAW_DATA')
    const approve = await inApp(APPROVE, '7.16.0')
    expect(approve.protectionLevel).toBe('P1')
    expect(approve.limitations.map((l) => l.code)).toContain('DEVICE_SHOWS_RAW_DATA')
  })

  test('7.15 firmware: no certified path, never P4', async () => {
    globalThis.fetch = catalogService([])
    const r = await inApp({ chainId: 8453, from: DEPOSIT.from, to: RELAY, value: '0x0', data: DEPOSIT.data }, '7.15.0')
    expect(r.protectionLevel).toBe('P2')
    expect(r.descriptor.authenticated).toBe(false)
  })

  test('Uniswap UR swap: the same verdict and words as the Desktop overlay', async () => {
    const r = await inApp(UR, '7.15.0')
    expect(r.protectionLevel).toBe('P2')
    expect(r.descriptor).toMatchObject({ source: 'none', authenticated: false, label: 'Uniswap Universal Router swap' })
    const desktop = await desktopRisk(UR, '7.15.0')
    expect(risk(r)).toEqual(desktop.reasons.map((x) => x.text))
    expect(rows(r)).toContain('Action: Swap 300 USDC for at least 0.108123518386717195 ETH')
  })

  test('the overlay and the card share one verdict function', async () => {
    const { evmSigningVerdict } = await import('./evm-presign-report')
    globalThis.fetch = catalogService([])
    const s: SigningRequestInfo = { id: 'd', method: '/eth/sign-transaction', appName: 'app', from: APPROVE.from, to: APPROVE.to, value: APPROVE.value, chainId: 8453, data: APPROVE.data, firmwareVersion: '7.16.0' }
    await prepareEvmTxSigningInfo(s, APPROVE, '7.16.0')
    const overlay = evmSigningVerdict(s, {}, await simulateEvmEffects(APPROVE, 'http://127.0.0.1:9/'), false)
    const card = await inApp(APPROVE, '7.16.0')
    expect(card.protectionLevel).toBe(overlay.requestedLevel)
    expect(card.descriptor).toMatchObject(overlay.descriptor)
  })
})

describe('Relay Depository decode — real calls', () => {
  const { decodeRelayDeposit } = require('../shared/relayDeposit')
  test('every exact-width deposit decodes; trailing bytes and other contracts do not', () => {
    for (const t of relayFixtures.transactions) {
      const d = decodeRelayDeposit(RELAY, t.data, t.chainId)
      const width = (t.data.length - 2) / 2
      if (width === 132 || width === 68) {
        expect(d?.kind).toBe(width === 132 ? 'erc20' : 'native')
        expect(d.depositor).toMatch(/^0x[0-9a-f]{40}$/)
        if (d.kind === 'erc20') expect(BigInt(`0x${t.data.slice(138, 202)}`)).toBe(d.amount)
      } else expect(d).toBeNull()
      expect(decodeRelayDeposit('0x1111111111111111111111111111111111111111', t.data, t.chainId)).toBeNull()
      expect(decodeRelayDeposit(RELAY, t.data, 100)).toBeNull()
    }
  })
})
