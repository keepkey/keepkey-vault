import { createHash } from 'node:crypto'
import bs58 from 'bs58'

import type { EffectAssetChange, EffectAuthorityChange, EffectCodeIdentity, EffectReport } from '../shared/transaction-effects'
import { DEFAULT_SOLANA_RPC_ENDPOINT } from './solana-alt'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from './solana-tx'

interface SolanaTokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount?: { amount?: string; decimals?: number }
}

interface SolanaSimulationValue {
  err?: unknown
  logs?: string[] | null
  fee?: number | null
  preBalances?: number[] | null
  postBalances?: number[] | null
  preTokenBalances?: SolanaTokenBalance[] | null
  postTokenBalances?: SolanaTokenBalance[] | null
  loadedAddresses?: { writable?: string[]; readonly?: string[] } | null
  innerInstructions?: Array<{ index: number; instructions: unknown[] }> | null
}

const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
])
const SEMANTICALLY_BOUNDED_PROGRAMS = new Set([
  ...TOKEN_PROGRAMS,
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
])

async function rpc(endpoint: string, method: string, params: unknown[]): Promise<any> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`)
  const payload: any = await response.json()
  if (payload.error) throw new Error(`RPC ${method}: ${payload.error.message || 'error'}`)
  return payload.result
}

const amount = (balance: SolanaTokenBalance | undefined): bigint => {
  try { return BigInt(balance?.uiTokenAmount?.amount || '0') } catch { return 0n }
}

function u64le(data: Uint8Array, offset: number): bigint | undefined {
  if (data.length < offset + 8) return undefined
  let value = 0n
  for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(data[offset + index])
  return value
}

function authorityEffects(message: ReturnType<typeof parseSolanaMessage>, addresses: string[], wallet: string): EffectAuthorityChange[] {
  const changes: EffectAuthorityChange[] = []
  for (const ix of message.instructions) {
    const program = addresses[ix.programIdIndex]
    if (!TOKEN_PROGRAMS.has(program) || !ix.data.length) continue
    const accounts = ix.accountIndices.map(index => addresses[index] || `account-index:${index}`)
    const opcode = ix.data[0]
    if ((opcode === 4 || opcode === 13) && accounts.length >= (opcode === 4 ? 3 : 4)) {
      const owner = accounts[opcode === 4 ? 2 : 3]
      const value = u64le(ix.data, 1)
      if (owner !== wallet || value === undefined) continue
      changes.push({
        kind: 'delegate', assetOrAccount: accounts[0], authority: accounts[opcode === 4 ? 1 : 2],
        value: value.toString(), unlimited: value === (1n << 64n) - 1n, revoked: value === 0n, confidence: 'inferred',
      })
    } else if (opcode === 5 && accounts.length >= 2 && accounts[1] === wallet) {
      changes.push({
        kind: 'delegate', assetOrAccount: accounts[0], authority: 'existing-delegate',
        value: '0', revoked: true, confidence: 'inferred',
      })
    } else if (opcode === 6 && accounts.length >= 2 && accounts[1] === wallet && ix.data.length >= 3) {
      const authorityType = ix.data[1]
      const hasNewAuthority = ix.data[2] === 1 && ix.data.length >= 35
      const authority = hasNewAuthority ? bs58.encode(ix.data.subarray(3, 35)) : 'none'
      changes.push({
        kind: authorityType === 2 ? 'owner' : 'delegate', assetOrAccount: accounts[0], authority,
        revoked: !hasNewAuthority, confidence: 'inferred',
      })
    }
  }
  return changes
}

/** Normalize one real `simulateTransaction` result into user-relative effects. */
export function normalizeSolanaSimulation(
  rawTxBase64: string,
  owner: string,
  endpoint: string,
  contextSlot: number | undefined,
  value: SolanaSimulationValue,
): EffectReport {
  const raw = Uint8Array.from(Buffer.from(rawTxBase64, 'base64'))
  const tx = parseSolanaTx(raw)
  const messageBytes = solanaMessageSlice(raw, tx)
  const message = parseSolanaMessage(messageBytes)
  const staticAddresses = message.staticAccounts.map((key) => bs58.encode(key))
  const loaded = [...(value.loadedAddresses?.writable || []), ...(value.loadedAddresses?.readonly || [])]
  const addresses = [...staticAddresses, ...loaded]
  const ownerIndex = addresses.indexOf(owner)
  const assetChanges: EffectAssetChange[] = []
  const unknowns: EffectReport['unknowns'] = []

  if (ownerIndex >= 0 && value.preBalances && value.postBalances) {
    const before = BigInt(value.preBalances[ownerIndex] ?? 0)
    const after = BigInt(value.postBalances[ownerIndex] ?? 0)
    if (before !== after) assetChanges.push({
      asset: { kind: 'native', id: 'solana:native', symbol: 'SOL', decimals: 9 },
      account: owner,
      delta: (after - before).toString(),
      confidence: 'observed',
    })
  } else {
    unknowns.push({ code: 'SOL_BALANCE_UNAVAILABLE', message: 'Simulation did not return the wallet’s pre/post SOL balance.', severity: 'warning' })
  }

  const pre = new Map((value.preTokenBalances || []).filter((b) => b.owner === owner).map((b) => [`${b.accountIndex}:${b.mint}`, b]))
  const post = new Map((value.postTokenBalances || []).filter((b) => b.owner === owner).map((b) => [`${b.accountIndex}:${b.mint}`, b]))
  for (const key of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(key)
    const after = post.get(key)
    const delta = amount(after) - amount(before)
    if (delta === 0n) continue
    const sample = after || before!
    assetChanges.push({
      asset: { kind: 'token', id: sample.mint, decimals: sample.uiTokenAmount?.decimals },
      account: addresses[sample.accountIndex] || `account-index:${sample.accountIndex}`,
      delta: delta.toString(),
      confidence: 'observed',
    })
  }

  const invokedCode: EffectCodeIdentity[] = []
  for (const ix of message.instructions) {
    const program = addresses[ix.programIdIndex] || `account-index:${ix.programIdIndex}`
    if (!invokedCode.some((entry) => entry.address === program && entry.invocation === 'program')) {
      invokedCode.push({ address: program, invocation: 'program' })
    }
  }
  const cpiPrograms = new Set<string>()
  for (const line of value.logs || []) {
    const match = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke /.exec(line)
    if (match && !invokedCode.some((entry) => entry.address === match[1])) cpiPrograms.add(match[1])
  }
  for (const address of cpiPrograms) invokedCode.push({ address, invocation: 'cpi' })
  const authorityChanges = value.err == null ? authorityEffects(message, addresses, owner) : []
  const uninterpretedPrograms = invokedCode.filter(entry => !SEMANTICALLY_BOUNDED_PROGRAMS.has(entry.address))
  if (uninterpretedPrograms.length) unknowns.push({
    code: 'PROGRAM_STATE_CHANGES_UNINTERPRETED',
    message: `${uninterpretedPrograms.length} invoked program(s) may change authority or protocol state that generic simulation cannot label.`,
    severity: 'warning',
  })

  const hasTokenArrays = Array.isArray(value.preTokenBalances) && Array.isArray(value.postTokenBalances)
  if (!hasTokenArrays) unknowns.push({
    code: 'TOKEN_BALANCES_UNAVAILABLE',
    message: 'The RPC did not return complete pre/post token balances.',
    severity: 'warning',
  })
  if (message.altEntries.length > 0 && loaded.length === 0) unknowns.push({
    code: 'LOOKUP_TABLES_UNRESOLVED',
    message: 'The transaction uses address lookup tables but the simulation did not return loaded addresses.',
    severity: 'danger',
  })

  const reverted = value.err != null
  return {
    version: 1,
    chain: 'Solana',
    transactionFingerprint: createHash('sha256').update(messageBytes).digest('hex'),
    stateReference: { blockOrSlot: contextSlot === undefined ? undefined : String(contextSlot), endpoint },
    status: reverted ? 'revert' : unknowns.length ? 'incomplete' : 'success',
    assetChanges,
    authorityChanges,
    invokedCode,
    warnings: reverted ? [{ code: 'SIMULATION_REVERTED', message: `Simulation failed: ${JSON.stringify(value.err).slice(0, 180)}`, severity: 'danger' }] : [],
    unknowns,
    fee: value.fee == null ? undefined : { asset: 'SOL', amount: String(value.fee) },
    completeness: {
      accountCoverage: message.altEntries.length === 0 || loaded.length > 0 ? 'complete' : 'partial',
      innerExecution: Array.isArray(value.innerInstructions) ? 'complete' : 'unknown',
      tokenCoverage: hasTokenArrays ? 'complete' : 'unknown',
      authorityCoverage: uninterpretedPrograms.length ? 'partial' : 'complete',
    },
  }
}

export async function simulateSolanaEffects(
  rawTxBase64: string,
  owner: string,
  endpoint = DEFAULT_SOLANA_RPC_ENDPOINT,
): Promise<EffectReport> {
  const fingerprint = createHash('sha256').update(Buffer.from(rawTxBase64, 'base64')).digest('hex')
  try {
    const result = await rpc(endpoint, 'simulateTransaction', [rawTxBase64, {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      innerInstructions: true,
    }])
    if (!result?.value) throw new Error('simulation returned no value')
    return normalizeSolanaSimulation(rawTxBase64, owner, endpoint, result.context?.slot, result.value)
  } catch (error: any) {
    return {
      version: 1, chain: 'Solana', transactionFingerprint: fingerprint,
      stateReference: { endpoint }, status: 'unavailable', assetChanges: [], authorityChanges: [], invokedCode: [], warnings: [],
      unknowns: [{ code: 'SIMULATION_UNAVAILABLE', message: error?.message || String(error), severity: 'danger' }],
      completeness: { accountCoverage: 'unknown', innerExecution: 'unknown', tokenCoverage: 'unknown', authorityCoverage: 'unknown' },
    }
  }
}
