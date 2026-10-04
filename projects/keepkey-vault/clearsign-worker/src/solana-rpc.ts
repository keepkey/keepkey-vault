import { ALT_PROGRAM_ID, parseAltAccountData, type AltAccountFetcher } from '../../src/bun/solana-alt'

export interface SolanaRpcConfig {
  CLEARSIGN_SOLANA_RPC_ENDPOINTS?: string
  CLEARSIGN_SOLANA_RPC_ENDPOINT?: string
}

export class SolanaRpcUnavailableError extends Error {
  readonly code = 'SOLANA_RPC_UNAVAILABLE'
  constructor() { super('Solana account RPC is unavailable. Please retry shortly.') }
}

// Public Relay lookup table used by the synthetic readiness check. No wallet
// or transaction data is used by this probe.
const PROBE_TABLE = 'Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP'
const TIMEOUT_MS = 1_800
const MAX_PROVIDERS = 3

export function solanaRpcEndpoints(env: SolanaRpcConfig): string[] {
  const raw = env.CLEARSIGN_SOLANA_RPC_ENDPOINTS || env.CLEARSIGN_SOLANA_RPC_ENDPOINT || ''
  const endpoints = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))]
  if (!endpoints.length || endpoints.length > MAX_PROVIDERS) throw new SolanaRpcUnavailableError()
  for (const endpoint of endpoints) {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password) throw new SolanaRpcUnavailableError()
  }
  return endpoints
}

interface RpcHealth {
  status: 'ready' | 'degraded' | 'unavailable'
  providerCount: number
  failedProviders: number
  checkedAt: string
}
const health = new Map<string, { value: RpcHealth; expiresAt: number }>()
const pendingHealth = new Map<string, Promise<RpcHealth>>()
const keyFor = (env: SolanaRpcConfig) => env.CLEARSIGN_SOLANA_RPC_ENDPOINTS || env.CLEARSIGN_SOLANA_RPC_ENDPOINT || ''

/** Every request remains server-side. Fail over only between operator-configured
 * RPCs; never accept a node URL or resolved accounts from the transaction caller. */
export function createResilientSolanaAccountFetcher<T>(
  env: SolanaRpcConfig,
  encoding: 'base64' | 'jsonParsed',
  validate: (value: any, key: string) => T,
  fetcher: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): (keys: string[]) => Promise<T[]> {
  return async keys => {
    if (!keys.length) return []
    const endpoints = solanaRpcEndpoints(env)
    let failed = 0
    for (const endpoint of endpoints) {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let reason = 'connection_failed'
      try {
        // The deadline includes JSON parsing, and still settles if a broken
        // fetch implementation ignores AbortSignal.
        const accounts = await Promise.race([
          (async () => {
            const response = await fetcher(endpoint, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding, commitment: 'confirmed' }] }),
              signal: controller.signal,
            })
            if (!response.ok) { reason = `http_${response.status}`; throw new Error(reason) }
            const body: any = await response.json()
            if (body.error) { reason = 'rpc_error'; throw new Error(reason) }
            const values = body.result?.value
            if (!Array.isArray(values) || values.length !== keys.length) { reason = 'invalid_response'; throw new Error(reason) }
            reason = 'invalid_account'
            return values.map((value, i) => validate(value, keys[i]))
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { reason = 'timeout'; controller.abort(); reject(new Error(reason)) }, timeoutMs)
          }),
        ])
        health.set(keyFor(env), { value: { status: failed ? 'degraded' : 'ready', providerCount: endpoints.length, failedProviders: failed, checkedAt: new Date().toISOString() }, expiresAt: Date.now() + 30_000 })
        return accounts
      } catch {
        failed++
        // Never log endpoint URLs, RPC error bodies, lookup keys, or calldata.
        console.warn(`[clearsign] Solana RPC provider ${failed}/${endpoints.length} failed: ${reason}`)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    health.set(keyFor(env), { value: { status: 'unavailable', providerCount: endpoints.length, failedProviders: failed, checkedAt: new Date().toISOString() }, expiresAt: Date.now() + 5_000 })
    throw new SolanaRpcUnavailableError()
  }
}

export function createResilientSolanaAltFetcher(
  env: SolanaRpcConfig, fetcher: typeof fetch = fetch, timeoutMs = TIMEOUT_MS,
): AltAccountFetcher {
  return createResilientSolanaAccountFetcher(env, 'base64', value => {
    if (!value || value.owner !== ALT_PROGRAM_ID || value.data?.[1] !== 'base64' || typeof value.data[0] !== 'string') throw new Error('invalid lookup account')
    const data = Buffer.from(value.data[0], 'base64')
    if (data.toString('base64') !== value.data[0]) throw new Error('noncanonical lookup account')
    parseAltAccountData(data)
    return { data, owner: value.owner }
  }, fetcher, timeoutMs)
}

export async function solanaRpcHealth(env: SolanaRpcConfig): Promise<RpcHealth> {
  const key = keyFor(env)
  const cached = health.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  if (pendingHealth.has(key)) return pendingHealth.get(key)!
  const probe = (async () => {
    try { await createResilientSolanaAltFetcher(env)([PROBE_TABLE]) } catch { /* read state below */ }
    return health.get(key)?.value || { status: 'unavailable' as const, providerCount: 0, failedProviders: 0, checkedAt: new Date().toISOString() }
  })()
  pendingHealth.set(key, probe)
  try { return await probe } finally { pendingHealth.delete(key) }
}
