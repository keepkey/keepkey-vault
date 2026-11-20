/** BIP-32 hardened path elements for account (and EVM address) indexes (audit v6 H8).
 *
 * A hardened element is 2^31 + index and must fit in 32 bits, so the index must be below 2^31. A larger value does not
 * fail by itself: the device keeps the low 32 bits, so 2^32 silently becomes account 0'. Every account index that
 * reaches a derivation path must therefore be checked, at the API boundary and again where the path is built. */

/** The largest BIP-32 account index: 2^31 - 1. */
export const MAX_ACCOUNT_INDEX = 0x7fffffff
const HARDENED = 0x80000000

export function isAccountIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ACCOUNT_INDEX
}

/** Throws instead of letting an out-of-range index wrap to another account. */
export function assertAccountIndex(value: unknown, label = 'Account index'): asserts value is number {
  if (!isAccountIndex(value)) throw new RangeError(`${label} must be an integer from 0 to ${MAX_ACCOUNT_INDEX}`)
}

/** The hardened path element for `index` (2^31 + index). */
export function hardenedAccount(index: number, label?: string): number {
  assertAccountIndex(index, label)
  return HARDENED + index
}
