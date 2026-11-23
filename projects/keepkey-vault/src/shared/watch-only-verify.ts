/** A watch-only "Verify on device" whose KeepKey showed a DIFFERENT address than the
 *  host derived from the saved xpub. That makes the host address suspect, unlike a
 *  cancel, timeout or busy device, which only leave the address unconfirmed. */
export function watchOnlyAddressMismatchMessage(shown: string, expected: string): string {
  return `The KeepKey showed ${shown}, not ${expected}. Do not use this address.`
}

const MISMATCH = /The KeepKey showed \S+, not \S+\. Do not use this address\./

export function isWatchOnlyAddressMismatch(e: unknown): boolean {
  const message = typeof e === 'string' ? e : (e as { message?: unknown } | null)?.message
  return typeof message === 'string' && MISMATCH.test(message)
}

/** Run the watch-only device check. A mismatch hides the address (onMismatch); any
 *  other failure is rethrown so ReceiveView explains it like any account's check. */
export async function showWatchOnlyAddress(show: () => Promise<unknown>, onMismatch: (message: string) => void): Promise<void> {
  try {
    await show()
  } catch (e) {
    if (!isWatchOnlyAddressMismatch(e)) throw e
    onMismatch((e as Error).message ?? String(e))
  }
}
