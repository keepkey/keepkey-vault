/**
 * Shared token/asset utility functions.
 *
 * Single source of truth for chain-capability checks and token identification.
 */

/** UTXO chains (bip122:*) never have tokens. EVM + Cosmos + others do. */
export const supportsTokens = (networkId: string): boolean => {
  if (!networkId) return false
  return !networkId.startsWith('bip122:')
}

/**
 * Detect whether a CAIP-19 identifier refers to a token (not a native asset).
 *
 * Native assets have the form  `<namespace>:<reference>/slip44:<coinType>`
 * Tokens have contract-style suffixes like `/erc20:0x...` or `/ibc:...`
 */
export const isTokenCaip = (caip: string): boolean => {
  if (!caip) return false
  const parts = caip.split('/')
  if (parts.length < 2) return false
  const assetPart = parts[parts.length - 1]
  // slip44 = native coin; anything else (erc20, ibc, bep2, etc.) = token
  return !assetPart.startsWith('slip44:')
}

/**
 * Determine if a balance entry from the Pioneer API represents a token balance
 * (as opposed to a native chain balance).
 */
export const isTokenBalance = (balance: { caip?: string; isToken?: boolean }): boolean => {
  if (balance.isToken !== undefined) return balance.isToken
  if (balance.caip) return isTokenCaip(balance.caip)
  return false
}
