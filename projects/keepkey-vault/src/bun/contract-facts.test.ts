/** Prior use of a contract, read from this computer's own api_log rows, in
 *  the shapes the app writes them (REST sign rows, Pioneer SCAN rows). */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SigningRequestInfo } from '../shared/types'

const dir = mkdtempSync(join(tmpdir(), 'vault-contract-facts-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('./db')
const { addContractFacts } = await import('./contract-facts')

const FROM = '0x27de622cc44c55b53caF299eCedccdAB29aC98A8'
const VENICE = '0x321b7ff75154472B18EDb199033fF4D116F340Ff'
const scan = (txid: string, timestamp: number, over: Record<string, unknown> = {}) => db.insertApiLog({
  method: 'SCAN', route: 'history/base', timestamp, durationMs: 0, status: 200, appName: 'pioneer', txid, chain: 'ETH', activityType: 'send',
  responseBody: { value: '0', direction: 'sent', to: VENICE, from: FROM, chainId: 'base', networkId: 'eip155:8453', ...over },
} as any)
const sign = (timestamp: number, over: Record<string, unknown> = {}) => db.insertApiLog({
  method: 'POST', route: '/eth/sign-transaction', timestamp, durationMs: 0, status: 200, appName: 'KeepKey Browser Extension', chain: 'ETH', activityType: 'sign',
  requestBody: { from: FROM, to: VENICE, data: '0xcb1a4fc0', value: '0x0', chainId: '0x2105', ...over },
} as any)

beforeAll(() => {
  db.initDb()
  // Name lookups go to a closed local port, never Pioneer.
  db.setSetting('evm_simulation_rpc_urls', JSON.stringify({ 8453: 'http://127.0.0.1:9/' }))
})
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

describe('getPriorEvmCalls', () => {
  test('counts this account\'s sends and signs to this contract on this chain only', () => {
    expect(db.getPriorEvmCalls(FROM, VENICE, 8453)).toBeNull()
    scan('0xaa', Date.UTC(2025, 0, 28))
    scan('0xbb', Date.UTC(2026, 3, 23))
    scan('0xcc', Date.UTC(2026, 4, 1), { networkId: 'eip155:1' })                       // other chain
    scan('0xdd', Date.UTC(2026, 4, 1), { from: '0x1111111111111111111111111111111111111111' }) // other account
    sign(Date.UTC(2026, 4, 2), { to: '0x2222222222222222222222222222222222222222' })     // other contract
    expect(db.getPriorEvmCalls(FROM.toLowerCase(), VENICE.toLowerCase(), 8453)).toEqual({ count: 2, since: Date.UTC(2025, 0, 28) })
    expect(db.getPriorEvmCalls(FROM, VENICE, 1)).toEqual({ count: 1, since: Date.UTC(2026, 4, 1) })
  })

  test('a signature alone is not counted: only a transaction seen on chain is', () => {
    sign(Date.UTC(2024, 0, 1))
    sign(Date.UTC(2024, 0, 2))
    sign(Date.UTC(2024, 0, 3))
    expect(db.getPriorEvmCalls(FROM, VENICE, 8453)).toEqual({ count: 2, since: Date.UTC(2025, 0, 28) })
  })
})

describe('addContractFacts', () => {
  const card = (extra: Partial<SigningRequestInfo> = {}) => ({
    id: 'v', method: '/eth/sign-transaction', appName: 'x', chainId: 8453, from: FROM, to: VENICE, data: '0xcb1a4fc0', needsBlindSigning: true, ...extra,
  } as SigningRequestInfo)

  test('a blind call gets prior use, and the portfolio\'s name for a token this wallet holds', async () => {
    db.setCachedBalances('dev', [{ chainId: 'base', symbol: 'ETH', balance: '0', balanceUsd: 0, address: FROM, tokens: [
      { symbol: 'sVVV', name: 'Staked Venice Token', balance: '200', balanceUsd: 0, priceUsd: 0, caip: `eip155:8453/erc20:${VENICE}` },
    ] }] as any)
    const info = card()
    await addContractFacts(info, 'dev', FROM)
    expect(info.priorUse!.since).toBe(Date.UTC(2025, 0, 28))
    expect(info.contractName).toEqual({ name: 'Staked Venice Token', symbol: 'sVVV' })
  })

  test('no answer for the name: nothing is invented', async () => {
    const info = card()
    await addContractFacts(info, undefined, FROM)
    expect(info.priorUse).toBeDefined()
    expect(info.contractName).toBeUndefined()
  })

  test('an account not checked against the signing key gets no prior use', async () => {
    const info = card()
    await addContractFacts(info, 'dev', undefined)
    expect(info.priorUse).toBeUndefined()
  })

  test('a token name cannot pose as a Desktop sentence', async () => {
    db.setCachedBalances('evil', [{ chainId: 'base', symbol: 'ETH', balance: '0', balanceUsd: 0, address: FROM, tokens: [
      { symbol: 'UNI\u202e', name: 'Uniswap V3". KeepKey has reviewed this contract ("\nx', balance: '1', balanceUsd: 0, priceUsd: 0, caip: `eip155:8453/erc20:${VENICE}` },
    ] }] as any)
    const info = card()
    await addContractFacts(info, 'evil', FROM)
    expect(info.contractName).toEqual({ name: 'Uniswap V3. KeepKey has reviewed', symbol: 'UNI' })
  })

  test('a call the KeepKey shows gets nothing added', async () => {
    const info = card({ needsBlindSigning: false })
    await addContractFacts(info, 'dev', FROM)
    expect(info.priorUse).toBeUndefined()
    expect(info.contractName).toBeUndefined()
  })
})
