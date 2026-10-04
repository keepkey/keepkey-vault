import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'

import type {
  EffectAssetChange,
  EffectAuthorityChange,
  EffectCodeIdentity,
  EffectReport,
} from '../shared/transaction-effects'

const TRANSFER_TOPIC = ethersUtils.id('Transfer(address,address,uint256)').toLowerCase()
const APPROVAL_TOPIC = ethersUtils.id('Approval(address,address,uint256)').toLowerCase()
const APPROVAL_FOR_ALL_TOPIC = ethersUtils.id('ApprovalForAll(address,address,bool)').toLowerCase()
const NATIVE_TRANSFER_EMITTER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const UINT256_MAX = (1n << 256n) - 1n

export interface EvmSimulationTx {
  chainId: number
  from: string
  to?: string
  input?: string
  data?: string
  value?: string
  gas?: string
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  nonce?: string
}

interface EvmLog { address?: string; topics?: string[]; data?: string }

const addressTopic = (value: string | undefined): string | undefined => {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return undefined
  return `0x${value.slice(-40)}`.toLowerCase()
}

const word = (value: string | undefined): bigint | undefined => {
  if (!value || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return undefined
  try { return BigInt(value) } catch { return undefined }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function addDelta(changes: EffectAssetChange[], asset: EffectAssetChange['asset'], account: string, delta: bigint) {
  if (delta === 0n) return
  const existing = changes.find((entry) => entry.asset.kind === asset.kind && entry.asset.id === asset.id && entry.account === account)
  if (existing) existing.delta = (BigInt(existing.delta) + delta).toString()
  else changes.push({ asset, account, delta: delta.toString(), confidence: 'observed' })
}

function effectsFromLogs(logs: EvmLog[], wallet: string): {
  assetChanges: EffectAssetChange[]
  authorityChanges: EffectAuthorityChange[]
} {
  const assetChanges: EffectAssetChange[] = []
  const authorityChanges: EffectAuthorityChange[] = []
  const owner = wallet.toLowerCase()

  for (const log of logs) {
    const emitter = String(log.address || '').toLowerCase()
    const topics = (log.topics || []).map((topic) => topic.toLowerCase())
    if (topics[0] === TRANSFER_TOPIC && topics.length >= 3) {
      const from = addressTopic(topics[1])
      const to = addressTopic(topics[2])
      const isNft = topics.length >= 4
      const raw = word(isNft ? topics[3] : log.data)
      if (raw === undefined) continue
      const asset: EffectAssetChange['asset'] = emitter === NATIVE_TRANSFER_EMITTER
        ? { kind: 'native', id: 'eip155:native' }
        : isNft ? { kind: 'nft', id: `${emitter}:${raw}` } : { kind: 'token', id: emitter }
      const quantity = isNft ? 1n : raw
      if (from === owner) addDelta(assetChanges, asset, owner, -quantity)
      if (to === owner) addDelta(assetChanges, asset, owner, quantity)
    } else if (topics[0] === APPROVAL_TOPIC && topics.length >= 3 && addressTopic(topics[1]) === owner) {
      const spender = addressTopic(topics[2])
      const raw = word(log.data)
      if (!spender || raw === undefined) continue
      authorityChanges.push({
        kind: 'allowance', assetOrAccount: emitter, authority: spender,
        value: raw.toString(), unlimited: raw === UINT256_MAX, revoked: raw === 0n,
        confidence: 'observed',
      })
    } else if (topics[0] === APPROVAL_FOR_ALL_TOPIC && topics.length >= 3 && addressTopic(topics[1]) === owner) {
      const operator = addressTopic(topics[2])
      const enabled = word(log.data)
      if (!operator || enabled === undefined) continue
      authorityChanges.push({
        kind: 'operator', assetOrAccount: emitter, authority: operator,
        value: enabled === 0n ? 'false' : 'true', revoked: enabled === 0n,
        confidence: 'observed',
      })
    }
  }
  return { assetChanges, authorityChanges }
}

function flattenTrace(node: any, out: EffectCodeIdentity[] = [], top = true): EffectCodeIdentity[] {
  if (!node || typeof node !== 'object') return out
  const type = String(node.type || (top ? 'CALL' : '')).toUpperCase()
  const address = String(node.to || node.address || '').toLowerCase()
  if (/^0x[0-9a-f]{40}$/.test(address)) {
    const invocation: EffectCodeIdentity['invocation'] = top ? 'top-level'
      : type === 'DELEGATECALL' ? 'delegatecall'
        : type === 'CREATE' || type === 'CREATE2' ? 'create' : 'call'
    if (!out.some((entry) => entry.address === address && entry.invocation === invocation)) out.push({ address, invocation })
  }
  for (const child of node.calls || []) flattenTrace(child, out, false)
  return out
}

function traceLogs(node: any, out: EvmLog[] = []): EvmLog[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node.logs)) out.push(...node.logs)
  for (const child of node.calls || []) traceLogs(child, out)
  return out
}

function nativeEffectsFromTrace(trace: any, wallet: string): EffectAssetChange[] {
  const changes: EffectAssetChange[] = []
  const owner = wallet.toLowerCase()
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return
    const type = String(node.type || 'CALL').toUpperCase()
    const from = String(node.from || '').toLowerCase()
    const to = String(node.to || '').toLowerCase()
    let value = 0n
    try { value = BigInt(node.value || '0x0') } catch { /* malformed trace value */ }
    if (value > 0n && type !== 'DELEGATECALL' && type !== 'STATICCALL') {
      const asset = { kind: 'native' as const, id: 'eip155:native' }
      if (from === owner) addDelta(changes, asset, owner, -value)
      if (to === owner) addDelta(changes, asset, owner, value)
    }
    for (const child of node.calls || []) visit(child)
  }
  visit(trace)
  return changes
}

export function normalizeEvmSimulation(
  tx: EvmSimulationTx,
  endpoint: string,
  blockReference: string | undefined,
  callResult: any,
  trace?: any,
): EffectReport {
  const logsAvailable = Array.isArray(callResult?.logs) || Boolean(trace && traceLogs(trace).length)
  const logs: EvmLog[] = Array.isArray(callResult?.logs) ? callResult.logs : trace ? traceLogs(trace) : []
  const { assetChanges, authorityChanges } = effectsFromLogs(logs, tx.from)
  if (trace && !assetChanges.some(change => change.asset.kind === 'native')) {
    for (const change of nativeEffectsFromTrace(trace, tx.from)) addDelta(assetChanges, change.asset, change.account, BigInt(change.delta))
  }
  const invokedCode = trace ? flattenTrace(trace) : tx.to ? [{ address: tx.to.toLowerCase(), invocation: 'top-level' as const }] : []
  const statusCode = callResult?.status
  const reverted = statusCode === '0x0' || callResult?.error != null
  const unknowns: EffectReport['unknowns'] = []
  if (!trace) unknowns.push({ code: 'CALL_TRACE_UNAVAILABLE', message: 'Nested calls and delegatecalls were not available.', severity: 'warning' })
  if (!logsAvailable) unknowns.push({ code: 'LOGS_UNAVAILABLE', message: 'Simulation returned no event logs for token and approval interpretation.', severity: 'warning' })
  return {
    version: 1,
    chain: 'Ethereum',
    transactionFingerprint: createHash('sha256').update(canonical(tx)).digest('hex'),
    stateReference: { blockOrSlot: blockReference, endpoint },
    status: reverted ? 'revert' : unknowns.length ? 'incomplete' : 'success',
    assetChanges,
    authorityChanges,
    invokedCode,
    warnings: reverted ? [{ code: 'SIMULATION_REVERTED', message: callResult?.error?.message || 'The simulated transaction reverted.', severity: 'danger' }] : [],
    unknowns,
    completeness: {
      accountCoverage: 'complete',
      innerExecution: trace ? 'complete' : 'unknown',
      tokenCoverage: logsAvailable ? 'partial' : 'unknown',
    },
  }
}

export async function evmRpc(endpoint: string, method: string, params: unknown[]): Promise<any> {
  if (endpoint.startsWith('eip155:')) {
    const [{ getPioneer }, { pioneerEvmRpc }] = await Promise.all([
      import('./pioneer'),
      import('./pioneer-evm'),
    ])
    return pioneerEvmRpc(await getPioneer(), endpoint, method, params)
  }
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    // Pre-sign UX must stay responsive. Failure becomes explicit "unavailable"
    // evidence; it never blocks or silently reports a safe result.
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`)
  const payload: any = await response.json()
  if (payload.error) throw new Error(`RPC ${method}: ${payload.error.message || 'error'}`)
  return payload.result
}

async function bindRuntimeCode(report: EffectReport, endpoint: string, blockTag: string): Promise<EffectReport> {
  const failures: string[] = []
  const externallyOwned = new Set<string>()
  await Promise.all(report.invokedCode.map(async (identity) => {
    if (identity.invocation === 'create') return
    try {
      const code = await evmRpc(endpoint, 'eth_getCode', [identity.address, blockTag])
      if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) throw new Error('invalid runtime code')
      if (code === '0x') { externallyOwned.add(identity.address); return }
      identity.codeHash = ethersUtils.keccak256(code).toLowerCase()
    } catch { failures.push(identity.address) }
  }))
  report.invokedCode = report.invokedCode.filter(identity => !externallyOwned.has(identity.address))
  if (failures.length) {
    report.unknowns.push({
      code: 'CODE_IDENTITY_UNAVAILABLE',
      message: `Runtime bytecode could not be pinned for ${failures.length} invoked contract${failures.length === 1 ? '' : 's'}.`,
      severity: 'warning',
    })
    if (report.status === 'success') report.status = 'incomplete'
  }
  return report
}

/** Simulate first; tracing is additive and may be unavailable on public RPCs. */
export async function simulateEvmEffects(tx: EvmSimulationTx, endpoint: string): Promise<EffectReport> {
  const fingerprint = createHash('sha256').update(canonical(tx)).digest('hex')
  const call = { ...tx, input: tx.input || tx.data || '0x' } as Record<string, unknown>
  delete call.chainId
  delete call.data
  let blockReference: string | undefined
  try { blockReference = await evmRpc(endpoint, 'eth_blockNumber', []) } catch { /* provider head remains explicit unknown */ }
  const blockTag = blockReference || 'latest'
  let simulationError: unknown
  try {
    const result = await evmRpc(endpoint, 'eth_simulateV1', [{
      blockStateCalls: [{ calls: [call] }],
      traceTransfers: true,
      validation: true,
      returnFullTransactions: false,
    }, blockTag])
    const block = Array.isArray(result) ? result[0] : undefined
    const callResult = block?.calls?.[0]
    if (!callResult) throw new Error('eth_simulateV1 returned no call result')
    let trace: any
    try { trace = await evmRpc(endpoint, 'debug_traceCall', [call, blockTag, { tracer: 'callTracer', tracerConfig: { withLog: true }, timeout: '5s' }]) } catch { /* optional */ }
    const stateBlock = block?.number || blockReference
    return bindRuntimeCode(normalizeEvmSimulation(tx, endpoint, stateBlock, callResult, trace), endpoint, stateBlock || blockTag)
  } catch (error) { simulationError = error }

  // Widely deployed fallback: callTracer gives nested calls, value flow, and
  // (where supported) logs even when eth_simulateV1 is unavailable.
  try {
    const trace = await evmRpc(endpoint, 'debug_traceCall', [call, blockTag, {
      tracer: 'callTracer', tracerConfig: { withLog: true }, timeout: '5s',
    }])
    return bindRuntimeCode(normalizeEvmSimulation(tx, endpoint, blockReference, {
      status: trace?.error ? '0x0' : '0x1', error: trace?.error ? { message: String(trace.error) } : undefined,
      ...(traceLogs(trace).length ? { logs: traceLogs(trace) } : {}),
    }, trace), endpoint, blockTag)
  } catch { /* fall through to execution-only evidence */ }

  // eth_call proves only success/revert at the pinned state. It cannot expose
  // logs or nested effects, so the normalized result is necessarily incomplete.
  try {
    await evmRpc(endpoint, 'eth_call', [call, blockTag])
    return bindRuntimeCode(normalizeEvmSimulation(tx, endpoint, blockReference, { status: '0x1' }), endpoint, blockTag)
  } catch (callError: any) {
    const message = callError?.message || String(callError)
    if (/revert/i.test(message)) return normalizeEvmSimulation(tx, endpoint, blockReference, {
      status: '0x0', error: { message },
    })
    return {
      version: 1, chain: 'Ethereum', transactionFingerprint: fingerprint,
      stateReference: { endpoint }, status: 'unavailable', assetChanges: [], authorityChanges: [], invokedCode: [], warnings: [],
      unknowns: [{
        code: 'SIMULATION_UNAVAILABLE',
        message: `${message}; eth_simulateV1: ${String((simulationError as any)?.message || simulationError || 'unavailable')}`.slice(0, 300),
        severity: 'danger',
      }],
      completeness: { accountCoverage: 'unknown', innerExecution: 'unknown', tokenCoverage: 'unknown' },
    }
  }
}
