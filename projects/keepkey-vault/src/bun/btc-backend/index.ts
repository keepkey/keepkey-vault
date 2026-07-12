/**
 * BtcBackend selection. Phase 0: Pioneer is the only backend.
 *
 * Later phases slot in here — WITHOUT touching consumers:
 *   - offlineMode setting     → DeviceOnlyBackend (every net op throws OFFLINE)
 *   - btc_nodes config enabled → CoreBackend / ElectrumBackend / BlockbookBackend
 * No auto-fallback: a failed self-host backend throws (verbose), it does NOT
 * silently reroute to Pioneer — that's the sovereignty stance (see design doc).
 */
import type { BtcBackend } from './types'
import { PioneerBackend } from './pioneer'

export function getBtcBackend(): BtcBackend {
  return PioneerBackend
}

export type { BtcBackend, BtcUtxo, BtcFeeRates, BtcBackendKind } from './types'
