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
import { setPioneerGuardActive } from '../pioneer-guard'

/** Persisted self-host node config. Blockbook (xpub-native, what Pioneer speaks)
 *  or Bitcoin Core (scantxoutset). */
export type NodeConfig =
  | { type: 'blockbook'; url: string; headers?: Record<string, string> }
  | { type: 'core'; url: string; auth?: string }

let offlineMode = false
let nodeBackend: BtcBackend | null = null
// The persisted node config is GLOBAL, but only a btc-only device may use it. A
// multichain device (or no device yet) must never inherit another device's
// self-host node — its BTC stays on Pioneer. Set from index.ts on every device
// state-change; false until a btc-only device reaches ready.
let deviceBtcOnly = false

/** The persisted node is live only when a btc-only device is connected. */
function nodeActive(): boolean { return nodeBackend !== null && deviceBtcOnly }

/** BTC no longer routes to Pioneer whenever the node is active OR we're offline. Keep
 *  the honesty guard in lock-step so those Pioneer BTC calls throw instead of cheating. */
function syncPioneerGuard(): void {
  setPioneerGuardActive(offlineMode || nodeActive())
}

/** Set by index.ts on startup and whenever the offline-mode setting changes. */
export function setBtcBackendOffline(v: boolean): void {
  offlineMode = v
  syncPioneerGuard()
}

/** Set by index.ts from the persisted self-host node config. null → Pioneer. */
export function setBtcNodeConfig(cfg: NodeConfig | null): void {
  nodeBackend = !cfg ? null
    : cfg.type === 'blockbook' ? makeBlockbookBackend(cfg)
    : makeCoreBackend(cfg)
  syncPioneerGuard()
}

/** Set from index.ts on every device state-change. A non-btc-only (or absent)
 *  device suppresses the persisted node so it can't hijack a multichain wallet's
 *  BTC — that user can't even see the node control to disable it. */
export function setBtcNodeDeviceEligible(isBtcOnly: boolean): void {
  deviceBtcOnly = isBtcOnly
  syncPioneerGuard()
}

export function getBtcBackend(): BtcBackend {
  if (offlineMode) return DeviceOnlyBackend
  // Self-host: route to the node with NO fallback to Pioneer — a failing node
  // throws a verbose error the user must fix (sovereignty stance). Node only
  // applies to a btc-only device (nodeActive); else BTC stays on Pioneer.
  if (nodeActive()) return nodeBackend!
  return PioneerBackend
}

const BTC_NETWORK_ID = 'bip122:000000000019d6689c085ae165831e93'

/** Network-scoped backend. The self-host node (and offline device-only mode) only
 *  answer Bitcoin — every OTHER UTXO chain (LTC/DOGE/BCH…) must keep using Pioneer,
 *  or a BTC Core node silently returns nothing for their addresses. Use this
 *  anywhere the network isn't guaranteed to be Bitcoin (e.g. the audit sweep). */
export function getBackendForNetwork(networkId: string): BtcBackend {
  return networkId === BTC_NETWORK_ID ? getBtcBackend() : PioneerBackend
}

/** Broadcast a BTC tx through the self-host node when one is enabled, else Pioneer.
 *  Unifies every BTC broadcast site (send / sweep / REST) so none can silently cheat
 *  past the node. Returns the txid. */
export async function broadcastBtcTx(pioneer: any, networkId: string, serialized: string): Promise<string> {
  if (networkId === BTC_NETWORK_ID && getBtcBackend().kind !== 'pioneer') {
    return (await getBtcBackend().broadcast({ network: networkId, rawTxHex: serialized })).txid
  }
  const resp = await pioneer.Broadcast({ networkId, serialized })
  const data = resp?.data ?? resp
  const txid = data?.txid || data?.tx_hash || data?.hash
  if (!txid) throw new Error(`Broadcast failed: ${JSON.stringify(data).slice(0, 200)}`)
  return String(txid)
}

export type { BtcBackend, BtcUtxo, BtcFeeRates, BtcBackendKind } from './types'
