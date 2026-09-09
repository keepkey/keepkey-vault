/**
 * Pioneer API client singleton.
 *
 * Uses @pioneer-platform/pioneer-client against a configurable base URL.
 * Priority: DB setting > PIONEER_API_BASE env var > https://api.keepkey.info
 */
import Pioneer from '@pioneer-platform/pioneer-client'
import { getSetting, setSetting } from './db'
import { instrumentPortfolio } from './perf-telemetry'

export const DEFAULT_API_BASE = 'https://api.keepkey.info'

function getOrCreateQueryKey(): string {
  const saved = getSetting('pioneer_query_key')
  if (saved) return saved
  const key = `vault:${crypto.randomUUID()}`
  setSetting('pioneer_query_key', key)
  return key
}

let _queryKey: string | null = null
export function getQueryKey(): string {
  if (!_queryKey) _queryKey = process.env.PIONEER_API_KEY || getOrCreateQueryKey()
  return _queryKey
}

const MIN_RETRY_DELAY = 5000 // 5s minimum between init retries

let pioneerInstance: any = null
let initPromise: Promise<any> | null = null
let lastInitAttempt = 0
let registeredIdentity: string | null = null
let registrationPromise: Promise<boolean> | null = null

/** Resolve the Pioneer API base URL (no trailing slash). */
export function getPioneerApiBase(): string {
  const dbVal = getSetting('pioneer_api_base')
  if (dbVal) return dbVal.replace(/\/+$/, '')
  if (process.env.PIONEER_API_BASE) return process.env.PIONEER_API_BASE.replace(/\/+$/, '')
  return DEFAULT_API_BASE
}

/** Force re-initialization on next getPioneer() call. */
export function resetPioneer(): void {
  pioneerInstance = null
  initPromise = null
  registeredIdentity = null
  registrationPromise = null
}

/** Register the stable Vault query key before any authenticated route is used.
 *  The promise is shared across startup, Zerion, Hive, SSE, and SDK callers so
 *  concurrent first-use requests cannot race registration. */
export async function ensurePioneerQueryKeyRegistered(): Promise<boolean> {
  const base = getPioneerApiBase()
  const qk = getQueryKey()
  const identity = `${base}\n${qk}`
  if (registeredIdentity === identity) return true
  if (registrationPromise) return registrationPromise

  const username = qk.startsWith('vault:')
    ? qk.slice(0, 32)
    : `vk-${qk.slice(-20)}`.slice(0, 32)
  registrationPromise = (async () => {
    try {
      const response = await fetch(`${base}/api/v1/user/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, queryKey: qk }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok && response.status !== 409) {
        console.warn('[Pioneer] queryKey registration warning:', response.status, await response.text().catch(() => ''))
        return false
      }
      registeredIdentity = identity
      console.log('[Pioneer] queryKey registered for authenticated routes')
      return true
    } catch (error: any) {
      console.warn('[Pioneer] queryKey registration failed:', error?.message || error)
      return false
    } finally {
      registrationPromise = null
    }
  })()
  return registrationPromise
}

export async function getPioneer(): Promise<any> {
  if (pioneerInstance) return pioneerInstance

  // Deduplicate concurrent init calls
  if (initPromise) return initPromise

  // Enforce minimum delay between retries
  const now = Date.now()
  const timeSinceLast = now - lastInitAttempt
  if (lastInitAttempt > 0 && timeSinceLast < MIN_RETRY_DELAY) {
    await new Promise(r => setTimeout(r, MIN_RETRY_DELAY - timeSinceLast))
  }

  lastInitAttempt = Date.now()

  initPromise = (async () => {
    try {
      const base = getPioneerApiBase()
      const specUrl = `${base}/spec/swagger.json`
      console.log('[Pioneer] Initializing client against', specUrl)

      // When pointing at a non-default server, pass overrideHost so the
      // client rewrites swagger-resolved URLs to match.  The pioneer-client
      // requestInterceptor automatically forces http: for localhost/127.0.0.1,
      // which fixes the https://localhost mismatch from the server's swagger spec.
      let overrideHost: string | undefined
      if (base !== DEFAULT_API_BASE) {
        try {
          const u = new URL(base)
          overrideHost = u.host // e.g. "localhost:9001"
        } catch { /* malformed URL — let Pioneer fail naturally */ }
      }

      const qk = getQueryKey()
      const client = new Pioneer(specUrl, { queryKey: qk, timeout: 60000, overrideHost })
      pioneerInstance = await client.init()
      if (!pioneerInstance) throw new Error('Pioneer client init returned null')
      // Honesty guard: block BTC→Pioneer calls whenever a self-host node is enabled.
      const { installPioneerGuard } = await import('./pioneer-guard')
      installPioneerGuard(pioneerInstance)
      console.log('[Pioneer] Client initialized successfully')

      // Stopwatch every portfolio load and report vault-vs-API timings
      // (see src/bun/perf-telemetry.ts). Best-effort, never blocks a load.
      instrumentPortfolio(pioneerInstance, { apiBase: base, queryKey: qk })

      // Complete registration before handing the client to authenticated SDK,
      // Zerion, Hive, telemetry, or realtime callers. Failure remains non-fatal
      // for public legacy providers, but a successful response can no longer race.
      await ensurePioneerQueryKeyRegistered()

      return pioneerInstance
    } catch (err) {
      initPromise = null
      throw err
    }
  })()

  return initPromise
}
