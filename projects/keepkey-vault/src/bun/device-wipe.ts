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
 * `wipeInProgress` is the ownership flag. The PIN auto-retry and every REST
 * device route (requireWallet) check it.
 */
export interface WipeHost {
  wallet: { cancel(): Promise<unknown>; wipe(): Promise<unknown> } | null
  wipeInProgress: boolean
  /** Bring the PIN prompt back after a refused or failed wipe: the device is still locked. */
  repromptPin(): void
}

export const WIPE_BUSY_MESSAGE = 'KeepKey is busy: a wipe is waiting for confirmation on the device'

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
  host.wipeInProgress = true
  try {
    await wallet.cancel().catch(() => {})
    await confirm(() => wallet.wipe())
    await settle()
  } catch (e) {
    host.wipeInProgress = false
    host.repromptPin()
    throw e
  } finally {
    host.wipeInProgress = false
  }
}
