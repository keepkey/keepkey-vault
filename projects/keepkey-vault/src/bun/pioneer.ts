/**
 * Pioneer API client singleton.
 *
 * Uses @pioneer-platform/pioneer-client against a configurable base URL.
 * Priority: DB setting > PIONEER_API_BASE env var > https://api.keepkey.info
 */
import Pioneer from '@pioneer-platform/pioneer-client'
import { getSetting, setSetting } from './db'

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

      const client = new Pioneer(specUrl, { queryKey: QUERY_KEY, timeout: 60000, overrideHost })
      pioneerInstance = await client.init()
      if (!pioneerInstance) throw new Error('Pioneer client init returned null')
      console.log('[Pioneer] Client initialized successfully')

      // Register queryKey with Pioneer so SSE auth passes (best-effort, non-fatal).
      // Username must be 3-32 chars — derive a stable short slug from the key.
      const username = QUERY_KEY.startsWith('vault:')
        ? QUERY_KEY.slice(0, 32)
        : `vk-${QUERY_KEY.slice(-20)}`.slice(0, 32)
      fetch(`${base}/api/v1/user/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, queryKey: QUERY_KEY }),
      }).then(r => {
        if (r.ok || r.status === 409) console.log('[Pioneer] queryKey registered for SSE auth')
        else r.text().then(t => console.warn('[Pioneer] SSE registration warning:', r.status, t)).catch(() => {})
      }).catch(() => { /* non-fatal — SSE degrades gracefully if unregistered */ })

      return pioneerInstance
    } catch (err) {
      initPromise = null
      throw err
    }
  })()

  return initPromise
}
