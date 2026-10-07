export type WipeReason = 'downgrade' | 'signed-to-unsigned' | 'unsigned-to-signed' | 'bitcoin-only-lock' | 'unknown-installed'

/**
 * Why flashing this image endangers the wallet, or undefined if it does not.
 * - Crossing the signed/unsigned boundary either way: the bootloader skips
 *   restoring storage (usb_flash.c should_restore).
 * - A downgrade: the older firmware finds a newer storage format at boot and
 *   resets it (owner policy: expected — say so plainly).
 * - 'bitcoin-only-lock': bitcoin-only firmware stamps its wallet into a storage
 *   band that multi-chain firmware (7.14.3+) and an older bitcoin-only build
 *   REFUSE — the wallet stays in flash but is unusable until the bitcoin-only
 *   firmware is reinstalled. Not a wipe, but just as much a surprise.
 * - 'unknown-installed': firmware is installed but neither its version nor its
 *   variant can be told (bootloader mode, unrecognized hash), so no outcome can
 *   be ruled out — including a wipe.
 * Unknown signing status (undefined) claims neither boundary.
 */
export function flashWipeReason(p: {
  isSigned: boolean
  currentFirmwareVerified?: boolean
  isDowngrade: boolean
  /** Installed firmware is bitcoin-only (true), multi-chain (false), or unknown. */
  currentBitcoinOnly?: boolean
  targetBitcoinOnly?: boolean
  /** Firmware is installed but its version is unknown. */
  installedUnknown?: boolean
}): WipeReason | undefined {
  if (!p.isSigned && p.currentFirmwareVerified === true) return 'signed-to-unsigned'
  if (p.isSigned && p.currentFirmwareVerified === false) return 'unsigned-to-signed'
  if (p.currentBitcoinOnly === true) {
    // An older multi-chain build predates the band and wipes it (a downgrade).
    if (!p.targetBitcoinOnly && !p.isDowngrade) return 'bitcoin-only-lock'
    if (p.targetBitcoinOnly && p.isDowngrade) return 'bitcoin-only-lock'
  }
  if (p.isDowngrade) return 'downgrade'
  if (p.installedUnknown) return 'unknown-installed'
  return undefined
}
