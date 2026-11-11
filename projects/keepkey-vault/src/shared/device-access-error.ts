/** Local device admission failures do not say anything about a balance server.
 * Desktop RPC currently preserves only the message, so match complete messages
 * emitted by the device gates rather than generic words such as "busy"/"locked".
 * When a status survives transport, require the matching device status too. */
export function isLocalDeviceAccessError(error: unknown): boolean {
  const value = error as { message?: unknown; status?: unknown; statusCode?: unknown } | null
  const message = typeof error === 'string' ? error : value?.message
  if (typeof message !== 'string') return false
  const status = value && typeof value === 'object' ? value.status ?? value.statusCode : undefined
  const matches = (expectedStatus: number, pattern: RegExp) =>
    (status === undefined || status === expectedStatus) && pattern.test(message.trim())

  return matches(409, /^KeepKey is busy with another request\. Wait for it to finish, then try again\.$/)
    || matches(409, /^KeepKey is busy with device setup\.$/)
    || matches(409, /^KeepKey is busy: .+\. Try again when it finishes\.$/)
    || matches(409, /^KeepKey is busy: a wipe is waiting for (?:confirmation on the device|the device to be unplugged and plugged back in)$/)
    || matches(429, /^Too many pending KeepKey requests\. Wait for the current request to finish\.$/)
    || matches(504, /^Timed out waiting for the KeepKey request\. Try again\.$/)
    || matches(423, /^KeepKey is locked\. Unlock it before requesting new device data\.$/)
    || matches(423, /^KeepKey is locked: enter the PIN in KeepKey Desktop, then try again$/)
    || matches(423, /^KeepKey is waiting for its PIN or passphrase: enter it in KeepKey Desktop, then try again$/)
    || matches(423, /^Device access is required; unlock KeepKey to load this account$/)
    || matches(423, /^Unlock KeepKey to load this account$/)
    || matches(409, /^KeepKey is not ready for wallet operations\. Finish device setup or reconnect it\.$/)
    || matches(503, /^No device connected$/)
}
