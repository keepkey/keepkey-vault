import type { DeviceStateInfo } from '../../shared/types'

// A firmware/bootloader flash is NOT seed-safe. The bootloader sets a storage
// protection marker right after the erase and clears it only when the upload
// completes; an upload that is interrupted (unplug, cable, host crash) leaves
// the marker set and the device wipes its storage. So an update can erase the
// recovery phrase, and the user must have it before we start one.

type FlashGateState = Pick<DeviceStateInfo, 'bootloaderMode' | 'initialized' | 'isOob'>

/**
 * Whether the user must tick "I have my recovery phrase written down" before
 * any flash starts. Fails closed: only a device we KNOW holds no wallet skips.
 *
 * In bootloader (updater) mode the device does not report `initialized`, so we
 * rely on the last app-mode read this session (`lastAppModeInitialized`, null
 * when never seen) or on `isOob` (no firmware on flash = factory/blank device).
 */
export function requiresBackupConfirmation(
  s: FlashGateState,
  lastAppModeInitialized: boolean | null,
): boolean {
  if (!s.bootloaderMode) return s.initialized
  if (s.isOob) return false
  return lastAppModeInitialized !== false
}

/**
 * Which wallet message the post-update card may show.
 *   'kept'  — the device came back in app mode and reports a wallet.
 *   'empty' — the device came back in app mode with NO wallet (never say
 *             "your wallet is untouched" here — it may have just been wiped).
 *   null    — we don't know yet; claim nothing.
 */
export function updateDoneWalletMessage(
  s: Pick<DeviceStateInfo, 'state' | 'bootloaderMode' | 'initialized'>,
): 'kept' | 'empty' | null {
  if (s.bootloaderMode) return null
  if (s.state === 'needs_init' || !s.initialized) return 'empty'
  if (s.state === 'ready' || s.state === 'needs_pin' || s.state === 'needs_passphrase') return 'kept'
  return null
}
