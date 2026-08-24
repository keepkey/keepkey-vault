import type { BtcAddressIndices, BtcBackendKind } from './types'

/** Parse Blockbook/Pioneer address tokens into the first indexes after the
 * highest used receive and change addresses. Malformed paths never advance an
 * index. This is intentionally pure so the privacy-critical selection rule can
 * be exhaustively fixture-tested without a network client. */
export function addressIndicesFromTokens(tokens: unknown, source: BtcBackendKind): BtcAddressIndices {
  let maxReceive = -1
  let maxChange = -1

  if (Array.isArray(tokens)) {
    for (const token of tokens) {
      if (!token || typeof token !== 'object') continue
      const { path, transfers } = token as { path?: unknown; transfers?: unknown }
      if (typeof path !== 'string' || Number(transfers) <= 0) continue
      const match = /(?:^|\/)([01])\/(\d+)$/.exec(path)
      if (!match) continue
      const index = Number(match[2])
      if (!Number.isSafeInteger(index) || index < 0) continue
      if (match[1] === '0') maxReceive = Math.max(maxReceive, index)
      else maxChange = Math.max(maxChange, index)
    }
  }

  return {
    receiveIndex: maxReceive + 1,
    changeIndex: maxChange + 1,
    discoveryAvailable: true,
    source,
  }
}
