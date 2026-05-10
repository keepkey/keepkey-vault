// Helpers for extracting Relay protocol metadata out of deposit calldata.
//
// Relay's request id is a bytes32 that uniquely identifies a cross-chain order.
// On the inbound chain, the deposit contract receives the request id as a
// calldata argument — every Relay deposit selector we've observed places it as
// the LAST 32 bytes of an ABI-encoded payload. Persisting this id at trackSwap
// time (when we still hold the prebuilt calldata) lets us link to Relay's
// status page without a Pioneer round-trip and without parsing a quote shape
// we don't otherwise need.

// Known Relay deposit selectors. We trust the trailing-32-bytes rule only for
// selectors we've seen, so unrelated EVM calls don't accidentally yield a
// "request id" that's actually somebody's address argument.
const KNOWN_RELAY_SELECTORS = new Set([
  '0x49290c1c', // depositNative(address recipient, bytes32 orderId)
])

/**
 * Pull the Relay request id (bytes32) out of an inbound deposit calldata.
 *
 * Returns a 0x-prefixed lowercase 32-byte hex string when the calldata looks
 * like a known Relay deposit, undefined otherwise. Pure / sync — does no I/O.
 */
export function extractRelayRequestId(calldata: string | undefined | null): string | undefined {
  if (!calldata) return undefined
  const data = calldata.startsWith('0x') ? calldata : `0x${calldata}`
  // Selector(4) + at least one bytes32 arg(32) → minimum 4 + 32 = 36 bytes = 74 hex chars + "0x"
  if (data.length < 2 + 8 + 64) return undefined
  // Must be well-formed ABI-encoded: selector + N*32-byte words.
  if ((data.length - 10) % 64 !== 0) return undefined
  const selector = data.slice(0, 10).toLowerCase()
  if (!KNOWN_RELAY_SELECTORS.has(selector)) return undefined
  // Last 32 bytes (= 64 hex) are the request id.
  const id = data.slice(-64).toLowerCase()
  return `0x${id}`
}
