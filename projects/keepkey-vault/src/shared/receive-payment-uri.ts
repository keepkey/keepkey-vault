import type { ChainDef } from './chains'
import { evmAssetReceiveUri } from './vault-asset-account'

// Address-only payment requests: Bitcoin BIP-321, Zcash ZIP-321, and the
// corresponding Litecoin/Dogecoin/Dash/DigiByte Core URI formatters.
const PAYMENT_SCHEMES: Readonly<Record<string, string>> = {
  bitcoin: 'bitcoin',
  litecoin: 'litecoin',
  dogecoin: 'dogecoin',
  dash: 'dash',
  digibyte: 'digibyte',
  zcash: 'zcash',
  bitcoincash: 'bitcoincash',
}

/** QR payload only. Keep the account address unchanged for display and copy. */
export function receivePaymentUri(
  chain: Pick<ChainDef, 'id' | 'chainFamily' | 'networkId' | 'caip'>,
  address: string,
  assetCaip = chain.caip,
): string {
  if (chain.chainFamily === 'evm')
    return evmAssetReceiveUri(chain.networkId, assetCaip, address)
  if (chain.chainFamily === 'solana') return `solana:${address}`

  const scheme = Object.prototype.hasOwnProperty.call(PAYMENT_SCHEMES, chain.id) ? PAYMENT_SCHEMES[chain.id] : undefined
  if (!scheme) return address
  // CashAddr commonly already includes its network prefix; it is also the
  // payment URI scheme. Preserve its case and include the prefix exactly once.
  if (scheme === 'bitcoincash' && /^bitcoincash:/i.test(address)) return address
  return `${scheme}:${address}`
}
