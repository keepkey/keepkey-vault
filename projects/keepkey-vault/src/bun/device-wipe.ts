/**
 * Wiping a KeepKey, including one that is locked and waiting for its PIN.
 *
 * The wipe owns the device from its Cancel until the device answers. A pending
 * PIN prompt holds the transport (the wipe would deadlock behind it), so it is
 * cancelled first. Any other message sent while the device shows the wipe
 * confirmation knocks the exchange out of sequence: the intruder gets
 * "Unknown message", the wipe gets "Unexpected message" and fails back to the
 * PIN prompt. That happened on 2026-10-22 with a REST get-features poll.
 *
 * `wipeInProgress` is the ownership flag. The PIN prompt, syncState, the USB
 * attach handler and every REST device route (requireWallet) check it.
 *
 * A device that can't hear Desktop is never sent anything. After 3+ wrong PINs
 * the firmware (pin_sm.c pin_protect) counts down 2^fails seconds BEFORE it
 * shows the PIN matrix, and reads no USB until it does: 9 fails is longer than
 * hdwallet's 5 min LONG_TIMEOUT, so the wipe timed out behind the unlock
 * request, and the timeout quarantines the transport for good (1.6.5 support
 * case, 2026-10-24). WipeDevice itself needs no PIN, so the way out is a
 * replug: the device boots without the countdown, and the host sends the wipe
 * on the new connection before any PIN request can restart it.
 */
export interface WipeHost {
  wallet: {
    cancel(): Promise<unknown>
    wipe(): Promise<unknown>
    transport?: { userActionRequired: boolean; isOpened(): Promise<boolean> }
  } | null
  wipeInProgress: boolean
  /** The seed-access request waiting on the PIN, if any. */
  unlockRequest: Promise<unknown> | null
  /** Arrange for the wipe to be sent after the user replugs this same device; false if that can't be done here. */
  deferWipeUntilReplug(): boolean
  /** Bring the PIN prompt back after a refused or failed wipe: the device is still locked. */
  repromptPin(): void
}

export const WIPE_BUSY_MESSAGE = 'KeepKey is busy: a wipe is waiting for confirmation on the device'
export const WIPE_REPLUG_PENDING_MESSAGE = 'KeepKey is busy: a wipe is waiting for the device to be unplugged and plugged back in'

export const WIPE_AFTER_REPLUG_MESSAGE =
  "Your KeepKey can't hear Desktop right now: after wrong PINs it makes you wait before it listens again. " +
  'Unplug it and plug it back in. Desktop will ask it to wipe as soon as it reconnects; confirm on the KeepKey.'
export const WIPE_UNREACHABLE_MESSAGE = "Your KeepKey isn't answering. Unplug it, plug it back in, and try the wipe again."

/** `confirm` wraps the device call (the emulator auto-presses its confirm screens);
 *  `settle` re-reads the device once the wipe has landed. */
export async function wipeOwningDevice(
  host: WipeHost,
  confirm: (wipe: () => Promise<unknown>) => Promise<unknown>,
  settle: () => Promise<void>,
): Promise<void> {
  const wallet = host.wallet
  if (!wallet) throw new Error('No device connected')
  if (host.wipeInProgress) throw new Error(WIPE_BUSY_MESSAGE)
  host.wipeInProgress = true // before any await: a second wipe or a PIN prompt must not slip in
  try {
    const transport = wallet.transport
    const open = !!transport && await transport.isOpened()
    const unlock = host.unlockRequest
    // Unlock sent but no PIN matrix yet = the device is in its countdown; a closed transport = quarantined by a timeout.
    if (!open || (unlock && !transport!.userActionRequired)) {
      throw new Error(host.deferWipeUntilReplug() ? WIPE_AFTER_REPLUG_MESSAGE : WIPE_UNREACHABLE_MESSAGE)
    }
    await wallet.cancel().catch(() => {})
    // Let the cancelled unlock read its "PIN Cancelled" before the wipe starts reading.
    if (unlock) await Promise.race([unlock.catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
    try {
      await confirm(() => wallet.wipe())
    } catch (e) {
      host.wipeInProgress = false
      host.repromptPin()
      throw e
    }
  } finally {
    host.wipeInProgress = false
  }
  await settle() // the wipe has landed; the device is free again
}
