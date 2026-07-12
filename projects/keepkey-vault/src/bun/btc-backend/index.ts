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

let offlineMode = false

/** Set by index.ts on startup and whenever the offline-mode setting changes. */
export function setBtcBackendOffline(v: boolean): void {
  offlineMode = v
}

export function getBtcBackend(): BtcBackend {
  return offlineMode ? DeviceOnlyBackend : PioneerBackend
}

export type { BtcBackend, BtcUtxo, BtcFeeRates, BtcBackendKind } from './types'
