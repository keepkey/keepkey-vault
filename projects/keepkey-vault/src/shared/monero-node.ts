export const MONERO_LOCAL_URL = 'http://127.0.0.1:18081'
export const MONERO_NODE_ESTIMATE_BYTES = 105 * 1024 ** 3
export const MONERO_NODE_RESERVE_BYTES = 25 * 1024 ** 3

export interface MoneroNodeStatus {
  available: boolean
  state: 'stopped' | 'starting' | 'syncing' | 'ready' | 'stopping' | 'error'
  dataDir: string
  logPath: string
  rpcUrl: string
  pruned: true
  diskBytes: number
  freeBytes: number | null
  reserveBytes: number
  estimatedBytes: number
  height: number | null
  targetHeight: number | null
  percent: number | null
  peers: number | null
  error?: string
}

/** Existing, deliberately configured remote URLs keep working after upgrading. */
export function moneroNodeMode(mode: string | null, storedUrl: string | null): 'local' | 'remote' {
  return mode === 'remote' || (mode !== 'local' && !!storedUrl && storedUrl !== MONERO_LOCAL_URL) ? 'remote' : 'local'
}

export function moneroNodeProgress(info: Record<string, unknown>) {
  const uint = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null
  if (info.status !== 'OK' || info.nettype !== 'mainnet' || info.untrusted === true) throw new Error('The local node did not report a mainnet status')
  const height = uint(info.height), target = uint(info.target_height)
  if (height === null || target === null) throw new Error('The local node returned an invalid block height')
  const ready = height > 0 && info.synchronized === true && info.busy_syncing !== true && (target === 0 || height >= target)
  const targetHeight = target > 0 ? Math.max(height, target) : ready ? height : null
  return { state: ready ? 'ready' as const : 'syncing' as const, height, targetHeight,
    percent: ready ? 100 : targetHeight ? Math.min(99.9, height / targetHeight * 100) : null,
    peers: info.restricted === true ? null : (uint(info.incoming_connections_count) ?? 0) + (uint(info.outgoing_connections_count) ?? 0) }
}
