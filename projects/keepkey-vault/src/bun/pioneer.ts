/**
 * Pioneer API client singleton.
 *
 * Uses @pioneer-platform/pioneer-client against a configurable base URL.
 * Uses the in-app server selection, or https://api.keepkey.info by default.
 */
import Pioneer from '@pioneer-platform/pioneer-client'
import { getSetting, setSetting } from './db'
import { instrumentPortfolio } from './perf-telemetry'
import { registerSwapServerCapabilities } from '../shared/swap-server-capabilities'
import { registerPioneerEventCapabilities } from '../shared/pioneer-event-capabilities'
import { DEFAULT_PIONEER_API_BASE, resolvePioneerApiBase } from '../shared/pioneer-server'

export const DEFAULT_API_BASE = DEFAULT_PIONEER_API_BASE

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
let configurationGeneration = 0
let registeredIdentity: string | null = null
let registrationPromise: Promise<boolean> | null = null
let registrationIdentity: string | null = null
let offline = false

export function setPioneerOffline(value: boolean): void {
  offline = value
}

/** Resolve the Pioneer API base URL (no trailing slash). */
export function getPioneerApiBase(): string {
  return resolvePioneerApiBase(getSetting('pioneer_api_base'))
}

/** Force re-initialization on next getPioneer() call. */
export function resetPioneer(): void {
  configurationGeneration++
  pioneerInstance = null
  initPromise = null
  lastInitAttempt = 0
  registeredIdentity = null
  registrationPromise = null
  registrationIdentity = null
}

/** Register the stable Vault query key before any authenticated route is used.
 *  The promise is shared across startup, Zerion, Hive, SSE, and SDK callers so
 *  concurrent first-use requests cannot race registration. */
export async function ensurePioneerQueryKeyRegistered(): Promise<boolean> {
  const base = getPioneerApiBase()
  const qk = getQueryKey()
  const identity = `${base}\n${qk}`
  const generation = configurationGeneration
  const isCurrent = () => generation === configurationGeneration && base === getPioneerApiBase() && qk === getQueryKey()
  if (registeredIdentity === identity) return true
  if (registrationPromise && registrationIdentity === identity) return registrationPromise

  const username = qk.startsWith('vault:')
    ? qk.slice(0, 32)
    : `vk-${qk.slice(-20)}`.slice(0, 32)
  const attempt: Promise<boolean> = Promise.resolve().then(async () => {
    try {
      if (!isCurrent()) return false
      const response = await fetch(`${base}/api/v1/user/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, queryKey: qk }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!isCurrent()) return false
      if (!response.ok && response.status !== 409) {
        console.warn('[Pioneer] queryKey registration warning:', response.status, await response.text().catch(() => ''))
        return false
      }
      registeredIdentity = identity
      console.log('[Pioneer] queryKey registered for authenticated routes')
      return true
    } catch (error: any) {
      if (isCurrent()) console.warn('[Pioneer] queryKey registration failed:', error?.message || error)
      return false
    } finally {
      if (registrationPromise === attempt) {
        registrationPromise = null
        registrationIdentity = null
      }
    }
  })
  registrationIdentity = identity
  registrationPromise = attempt
  return attempt
}

export async function getPioneer(): Promise<any> {
  if (offline) throw new Error('OFFLINE: Pioneer is disabled in offline (airplane) mode')
  if (pioneerInstance) return pioneerInstance

  // Deduplicate concurrent init calls
  if (initPromise) return initPromise

  const generation = configurationGeneration
  const base = getPioneerApiBase()
  const qk = getQueryKey()
  const isCurrent = () => !offline && generation === configurationGeneration && base === getPioneerApiBase() && qk === getQueryKey()
  const assertCurrent = () => {
    if (offline) throw new Error('OFFLINE: Pioneer initialization was cancelled by offline mode')
    if (!isCurrent()) {
      throw new Error('Pioneer server changed; retry the request')
    }
  }
  const attempt: Promise<any> = Promise.resolve().then(async () => {
    try {
      // Keep retries bounded, but bind the wait to this configuration too.
      const timeSinceLast = Date.now() - lastInitAttempt
      if (lastInitAttempt > 0 && timeSinceLast < MIN_RETRY_DELAY) {
        await new Promise(r => setTimeout(r, MIN_RETRY_DELAY - timeSinceLast))
      }
      assertCurrent()
      lastInitAttempt = Date.now()
      const specUrl = `${base}/spec/swagger.json`
      console.log('[Pioneer] Initializing client against', specUrl)

      // Bind Swagger-resolved requests to the selected server, including the
      // official default. The SDK also handles HTTP for local test servers.
      const overrideHost = new URL(base).host

      const client = new Pioneer(specUrl, { queryKey: qk, timeout: 60000, overrideHost })
      const initialized = await client.init()
      assertCurrent()
      if (!initialized) throw new Error('Pioneer client init returned null')
      registerSwapServerCapabilities(initialized, client.client?.spec)
      registerPioneerEventCapabilities(initialized, client.client?.spec)
      // Honesty guard: block BTC→Pioneer calls whenever a self-host node is enabled.
      const { installPioneerGuard } = await import('./pioneer-guard')
      assertCurrent()
      installPioneerGuard(initialized)

      // Complete registration before handing the client to authenticated SDK,
      // Zerion, Hive, telemetry, or realtime callers. Failure remains non-fatal
      // for public legacy providers, but a successful response can no longer race.
      await ensurePioneerQueryKeyRegistered()
      assertCurrent()

      // Publish only after initialization and registration both settled for
      // this server. A reset must never resurrect an obsolete client.
      instrumentPortfolio(initialized, { apiBase: base, queryKey: qk, isCurrent })
      // Delayed consumers may retain this object after Settings switches. Bind
      // every operation in place, preserving capability metadata on the object.
      for (const name of Object.getOwnPropertyNames(initialized)) {
        const descriptor = Object.getOwnPropertyDescriptor(initialized, name)
        if (typeof descriptor?.value !== 'function') continue
        const operation = descriptor.value
        Object.defineProperty(initialized, name, { ...descriptor, value: async function (this: any, ...args: any[]) {
          assertCurrent()
          const result = await operation.apply(this, args)
          assertCurrent()
          return result
        } })
      }
      pioneerInstance = initialized
      console.log('[Pioneer] Client initialized successfully')
      return initialized
    } catch (err) {
      if (initPromise === attempt) initPromise = null
      throw err
    }
  })
  initPromise = attempt

  return attempt
}
