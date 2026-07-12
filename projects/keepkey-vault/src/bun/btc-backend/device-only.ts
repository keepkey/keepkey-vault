/**
 * DeviceOnlyBackend — offline (airplane) mode. Every network op throws OFFLINE.
 * The device still works locally (xpub read, address derive, signing) — those
 * paths don't go through BtcBackend, so they're unaffected. This backend only
 * refuses the four things that genuinely need the internet.
 */
import type { BtcBackend } from './types'

const OFFLINE_MSG =
  'OFFLINE: Vault is in offline (airplane) mode — no network. Turn off offline mode in settings to reconnect.'

function offline(): never {
  throw new Error(OFFLINE_MSG)
}

export const DeviceOnlyBackend: BtcBackend = {
  kind: 'device-only',
  capabilities: { history: false, push: false },
  async listUnspent() { return offline() },
  async feeRate() { return offline() },
  async broadcast() { return offline() },
  async rawTxHex() { return offline() },
}
