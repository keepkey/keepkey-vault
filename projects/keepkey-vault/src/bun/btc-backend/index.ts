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
import { makeCoreBackend } from './core'
import { makeBlockbookBackend } from './blockbook'

/** Persisted self-host node config. Blockbook (xpub-native, what Pioneer speaks)
 *  or Bitcoin Core (scantxoutset). */
export type NodeConfig =
  | { type: 'blockbook'; url: string; headers?: Record<string, string> }
  | { type: 'core'; url: string; auth?: string }

let offlineMode = false
let nodeBackend: BtcBackend | null = null

/** Set by index.ts on startup and whenever the offline-mode setting changes. */
export function setBtcBackendOffline(v: boolean): void {
  offlineMode = v
}

/** Set by index.ts from the persisted self-host node config. null → Pioneer. */
export function setBtcNodeConfig(cfg: NodeConfig | null): void {
  nodeBackend = !cfg ? null
    : cfg.type === 'blockbook' ? makeBlockbookBackend(cfg)
    : makeCoreBackend(cfg)
}

export function getBtcBackend(): BtcBackend {
  if (offlineMode) return DeviceOnlyBackend
  // Self-host: route to the node with NO fallback to Pioneer — a failing node
  // throws a verbose error the user must fix (sovereignty stance).
  if (nodeBackend) return nodeBackend
  return PioneerBackend
}

export type { BtcBackend, BtcUtxo, BtcFeeRates, BtcBackendKind } from './types'
