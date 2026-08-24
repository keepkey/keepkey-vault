export const OFFLINE_OPERATION_ERROR =
  'OFFLINE: Vault is in offline (airplane) mode — network balance, history, build, and broadcast operations are disabled.'

export function assertOnline(offline: boolean, operation: string): void {
  if (offline) throw new Error(`${OFFLINE_OPERATION_ERROR} (${operation})`)
}

/** REST surfaces that can initiate outbound traffic. Device metadata routes and
 * raw v1 device signing routes are intentionally absent. */
export function isOfflineNetworkRoute(path: string, method: string): boolean {
  if (path === '/api/v1/activity/rebuild' && method === 'POST') return true
  if (!path.startsWith('/api/v2/')) return false
  return !path.startsWith('/api/v2/devices')
}
