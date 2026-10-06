export type WipeReason = 'downgrade' | 'signed-to-unsigned' | 'unsigned-to-signed'

/**
 * Why flashing this image erases the wallet, or undefined if it does not.
 * - Crossing the signed/unsigned boundary either way: the bootloader skips
 *   restoring storage (usb_flash.c should_restore).
 * - A downgrade: the older firmware finds a newer storage format at boot and
 *   resets it (owner policy: expected — say so plainly).
 * Unknown installed firmware (undefined) claims neither boundary.
 */
export function flashWipeReason(p: { isSigned: boolean; currentFirmwareVerified?: boolean; isDowngrade: boolean }): WipeReason | undefined {
  if (!p.isSigned && p.currentFirmwareVerified === true) return 'signed-to-unsigned'
  if (p.isSigned && p.currentFirmwareVerified === false) return 'unsigned-to-signed'
  if (p.isDowngrade) return 'downgrade'
  return undefined
}
