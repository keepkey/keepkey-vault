/**
 * Pioneer API client singleton.
 *
 * Uses @pioneer-platform/pioneer-client against https://api.keepkey.info
 * to fetch balances, UTXOs, fee rates, nonces, account info, and broadcast.
 */
import Pioneer from '@pioneer-platform/pioneer-client'

const SPEC_URL = 'https://api.keepkey.info/spec/swagger.json'
const QUERY_KEY = process.env.PIONEER_API_KEY || `key:public-${Date.now()}`
const MIN_RETRY_DELAY = 5000 // 5s minimum between init retries

let pioneerInstance: any = null
let initPromise: Promise<any> | null = null
let lastInitAttempt = 0

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
      console.log('[Pioneer] Initializing client against', SPEC_URL)
      const client = new Pioneer(SPEC_URL, { queryKey: QUERY_KEY, timeout: 60000 })
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
