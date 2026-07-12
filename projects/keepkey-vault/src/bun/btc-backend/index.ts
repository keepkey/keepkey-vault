/**
 * BtcBackend selection.
 *
 * - offline (airplane) mode → DeviceOnlyBackend (every net op throws OFFLINE)
 * - default                 → PioneerBackend
 *
 * Self-host (core/electrum/blockbook) backends slot in here later, selected from
 * the btc_nodes config — WITHOUT touching consumers. No auto-fallback: a failed
 * self-host backend throws (verbose), it does NOT silently reroute to Pioneer —
 * that's the sovereignty stance (see design doc). The offline flag is pushed in
 * by index.ts (setBtcBackendOffline) so this module stays db/pioneer-free.
 */
import type { BtcBackend } from './types'
import { PioneerBackend } from './pioneer'
import { DeviceOnlyBackend } from './device-only'
import { makeCoreBackend, type CoreConfig } from './core'

let offlineMode = false
let nodeBackend: BtcBackend | null = null

/** Set by index.ts on startup and whenever the offline-mode setting changes. */
export function setBtcBackendOffline(v: boolean): void {
  offlineMode = v
}

/** Set by index.ts from the persisted self-host node config. null → Pioneer. */
export function setBtcNodeConfig(cfg: CoreConfig | null): void {
  nodeBackend = cfg ? makeCoreBackend(cfg) : null
}

export function getBtcBackend(): BtcBackend {
  if (offlineMode) return DeviceOnlyBackend
  // Self-host: route to the node with NO fallback to Pioneer — a failing node
  // throws a verbose error the user must fix (sovereignty stance).
  if (nodeBackend) return nodeBackend
  return PioneerBackend
}

export type { BtcBackend, BtcUtxo, BtcFeeRates, BtcBackendKind } from './types'
