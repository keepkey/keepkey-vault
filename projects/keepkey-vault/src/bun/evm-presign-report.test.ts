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
