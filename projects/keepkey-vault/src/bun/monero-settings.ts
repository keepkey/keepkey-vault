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
