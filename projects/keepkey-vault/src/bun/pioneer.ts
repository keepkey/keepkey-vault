/**
 * Pioneer API client singleton.
 *
 * Uses @pioneer-platform/pioneer-client against a configurable base URL.
 * Priority: DB setting > PIONEER_API_BASE env var > https://api.keepkey.info
 *
 * PERF: Pioneer import is dynamic (lazy). The pioneer-client package pulls in
 * swagger-client + the entire @swagger-api ecosystem (~13MB, ~3500 files).
 * Loading this at startup adds ~15s to first launch on Windows because
 * Defender scans every file. Deferring it to first getPioneer() call means
 * the window appears immediately and swagger loads in background when needed.
 */
import { getSetting } from './db'

export const DEFAULT_API_BASE = 'https://api.keepkey.info'
const QUERY_KEY = process.env.PIONEER_API_KEY || `key:public-${Date.now()}`
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

      const { default: Pioneer } = await import('@pioneer-platform/pioneer-client')
      const client = new Pioneer(specUrl, { queryKey: QUERY_KEY, timeout: 60000, overrideHost })
      pioneerInstance = await client.init()
      if (!pioneerInstance) throw new Error('Pioneer client init returned null')
      console.log('[Pioneer] Client initialized successfully')
      return pioneerInstance
    } catch (err) {
      initPromise = null
      throw err
    }
  })()

  return initPromise
}
