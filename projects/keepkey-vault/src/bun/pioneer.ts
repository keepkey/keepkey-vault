/**
 * Pioneer API client singleton.
 *
 * Uses @pioneer-platform/pioneer-client against https://api.keepkey.info
 * to fetch balances, UTXOs, fee rates, nonces, account info, and broadcast.
 */
import Pioneer from '@pioneer-platform/pioneer-client'

const SPEC_URL = 'https://api.keepkey.info/spec/swagger.json'
const QUERY_KEY = process.env.PIONEER_API_KEY || `key:public-${Date.now()}`

let pioneerInstance: any = null
let initPromise: Promise<any> | null = null

export async function getPioneer(): Promise<any> {
  if (pioneerInstance) return pioneerInstance

  // Deduplicate concurrent init calls
  if (initPromise) return initPromise

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
