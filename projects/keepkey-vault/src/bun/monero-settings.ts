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

/** A new wallet starts its scan about a week (5,040 two-minute blocks) before the node's tip:
 *  scanning from block 0 takes hours, and the margin still catches anything received this week. */
export const RESTORE_HEIGHT_MARGIN = 5040

/** Unset ('' or missing) means no scan start was chosen yet; Desktop then offers the suggestion. */
export function storedRestoreHeight(value: string | null): number | null {
  if (value === null || value === '') return null
  const height = Number(value)
  return Number.isSafeInteger(height) && height >= 0 ? height : null
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
