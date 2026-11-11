/** Public daemon configuration; wallet keys never cross this boundary. */
export function validateMoneroNode(input: { daemonUrl: string; restoreHeight: number }) {
  if (!input || typeof input.daemonUrl !== 'string' || input.daemonUrl.length > 2048) throw new Error('Enter a valid Monero daemon URL')
  let url: URL
  try { url = new URL(input.daemonUrl.trim()) } catch { throw new Error('Enter a valid Monero daemon URL') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error('Use HTTPS for a remote daemon, or HTTP for a local daemon, without embedded credentials')
  }
  if (!Number.isSafeInteger(input.restoreHeight) || input.restoreHeight < 0) throw new Error('Restore height must be a nonnegative whole number')
  return { daemonUrl: url.toString().replace(/\/$/, ''), restoreHeight: input.restoreHeight }
}

/** "New wallet" starts its scan about a week (5,040 two-minute blocks) before the tip the node reports.
 *  The node is not verified, so the UI says the height comes from it; it is never the default. */
export const RESTORE_HEIGHT_MARGIN = 5040

/** Unset, empty (an older build's "not chosen") or unreadable means 0: treat the wallet as one that may
 *  already hold XMR and scan everything. A later start is only ever a deliberate choice. */
export function storedRestoreHeight(value: string | null): number {
  if (value === null || value === '') return 0
  const height = Number(value)
  return Number.isSafeInteger(height) && height >= 0 ? height : 0
}

/** Connectivity preflight only: a remote node's reported height is not a trusted checkpoint. */
export async function checkMoneroNode(daemonUrl: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<{ height: number }> {
  const { daemonUrl: origin } = validateMoneroNode({ daemonUrl, restoreHeight: 0 })
  try {
    const response = await fetcher(`${origin}/json_rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'vault-node-check', method: 'get_info' }), redirect: 'error', signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`http:${response.status}`)
    if (!response.body) throw new Error()
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        size += value.length
        if (size > 65536) throw new Error()
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const info = JSON.parse(Buffer.concat(chunks).toString('utf8')).result
    if (info?.status !== 'OK' || info.nettype !== 'mainnet' || !Number.isSafeInteger(info.height) || info.height < 1) throw new Error()
    if (info.synchronized !== true || info.busy_syncing === true) throw new Error('syncing')
    return { height: info.height }
  } catch (error) {
    if (error instanceof Error && error.message === 'syncing') throw new Error('This node is still syncing. Choose another node or try again later.')
    if (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)) throw new Error('The node did not respond within 10 seconds.')
    const http = error instanceof Error ? /^http:([45][0-9]{2})$/.exec(error.message) : null
    if (http) throw new Error(`The node returned HTTP ${http[1]}.`)
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (/CERT|TLS/.test(code)) throw new Error('The node TLS certificate could not be verified.')
    throw new Error('Could not reach a Monero mainnet node at this address. Check the URL and try again.')
  }
}

/** The node's current height (/get_height) and the suggested scan start for a new wallet. */
export async function suggestRestoreHeight(daemonUrl: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<{ tipHeight: number; restoreHeight: number; marginBlocks: number }> {
  const { daemonUrl: origin } = validateMoneroNode({ daemonUrl, restoreHeight: 0 })
  let response: Response
  try {
    response = await fetcher(`${origin}/get_height`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(15000), redirect: 'error' })
  } catch { throw new Error('The Monero node could not be reached to read its current height') }
  const text = response.ok ? await response.text() : ''
  let height: unknown
  try { const value = text.length <= 65536 ? JSON.parse(text) : null; height = value?.status === 'OK' ? value.height : undefined } catch { /* below */ }
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1) throw new Error('The Monero node did not report its current height')
  return { tipHeight: height, restoreHeight: Math.max(0, height - RESTORE_HEIGHT_MARGIN), marginBlocks: RESTORE_HEIGHT_MARGIN }
}
