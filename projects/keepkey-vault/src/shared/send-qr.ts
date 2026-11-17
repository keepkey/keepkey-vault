import type { ChainDef } from './chains'
import { validateAddress } from './address-validation'
import { baseUnitsToDecimalString, normalizeDecimals } from './max-send'

const UINT256_MAX = (1n << 256n) - 1n
const SCHEMES: Readonly<Record<string, readonly string[]>> = {
  bitcoin: ['bitcoin'], litecoin: ['litecoin'], dogecoin: ['dogecoin'], dash: ['dash'],
  digibyte: ['digibyte'], bitcoincash: ['bitcoincash'], zcash: ['zcash'],
  cosmos: ['cosmos'], thorchain: ['thorchain', 'thor'], mayachain: ['mayachain', 'maya'], osmosis: ['osmosis', 'osmo'],
  ripple: ['xrp', 'xrpl', 'ripple'], solana: ['solana'], tron: ['tron'], ton: ['ton'], hive: ['hive'], monero: ['monero'],
}

/** EIP-681 native value is an integer in atomic units, including decimal scientific
 * notation. Bound lengths/exponents before allocating, and never round through Number.
 * https://eips.ethereum.org/EIPS/eip-681 */
export function eip681ValueToAmount(value: string, decimals: number): string | null {
  if (value.length > 256 || normalizeDecimals(decimals) === null) return null
  const match = value.trim().match(/^\+?(\d*)(?:\.(\d+))?(?:e(\d+))?$/i)
  if (!match || (!match[1] && !match[2])) return null
  const [, whole, fraction = '', exponent = '0'] = match
  const shift = Number(exponent)
  if (!Number.isSafeInteger(shift) || shift > 77 || shift < fraction.length) return null
  const digits = (whole + fraction).replace(/^0+/, '') || '0'
  if (digits.length + shift - fraction.length > 78) return null
  const units = BigInt(digits + '0'.repeat(shift - fraction.length))
  return units <= UINT256_MAX ? baseUnitsToDecimalString(units, decimals) : null
}

function coinAmount(value: string, decimals: number): string | null {
  const precision = normalizeDecimals(decimals)
  if (precision === null || value.length > 256 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null
  const [whole = '', fraction = ''] = value.split('.')
  if (fraction.length > precision) return null
  const units = BigInt((whole || '0') + fraction.padEnd(precision, '0'))
  return units <= UINT256_MAX ? baseUnitsToDecimalString(units, precision) : null
}

export interface ScannedPayment {
  recipient: string
  /** Exact native display units. Absent means the QR did not set an amount. */
  amount?: string
  /** Always replace the old memo/tag, including when this is empty. */
  memo: string
}

/** Parse an address/payment request only for the selected network. Unsupported
 * function calls, ambiguous amounts, invalid tags and wrong networks fail as a
 * whole; the caller must leave the current draft untouched on null. */
export function parseSendQr(data: string, chain: ChainDef, isTokenSend = false): ScannedPayment | null {
  const clean = data.trim()
  if (!clean || clean.length > 4096 || /[\x00-\x1f\x7f#]/.test(clean)) return null
  const schemeMatch = clean.match(/^([a-z][a-z0-9+.-]*):(.*)$/i)
  const scheme = schemeMatch?.[1].toLowerCase()
  if (scheme && (scheme === 'ethereum' ? chain.chainFamily !== 'evm' : !SCHEMES[chain.id]?.includes(scheme))) return null
  const payload = schemeMatch ? schemeMatch[2] : clean
  const separator = payload.indexOf('?')
  let recipient = separator < 0 ? payload : payload.slice(0, separator)
  const params = new URLSearchParams(separator < 0 ? '' : payload.slice(separator + 1))
  for (const key of params.keys()) if (key.startsWith('req-')) return null
  for (const key of ['amount', 'value', 'memo', 'dt']) if (params.getAll(key).length > 1) return null

  if (scheme === 'ethereum') {
    // Contract/function requests cannot be reinterpreted as ordinary sends.
    const target = recipient.match(/^(?:pay-)?(0x[0-9a-f]{40})(?:@([0-9]{1,78}))?$/i)
    if (!target) return null
    const selectedChainId = chain.networkId.match(/^eip155:(\d+)$/)?.[1]
    if (target[2] && (!selectedChainId || BigInt(target[2]) !== BigInt(selectedChainId))) return null
    recipient = target[1]
  }
  if (!validateAddress(recipient, chain).valid) return null

  let amount: string | undefined
  if (!isTokenSend) {
    if (params.has('value') && (scheme !== 'ethereum' || params.has('amount'))) return null
    const requested = params.has('value') ? eip681ValueToAmount(params.get('value')!, chain.decimals)
      : params.has('amount') ? coinAmount(params.get('amount')!, chain.decimals) : undefined
    if (requested === null) return null
    amount = requested
  }
  // A memo on a chain with no visible memo field must not become a hidden
  // on-chain value or disappear from a request that relied on it (e.g. Zcash).
  if (!isTokenSend && chain.chainFamily !== 'cosmos' && chain.chainFamily !== 'xrp' && params.get('memo')) return null
  let memo = ''
  if (!isTokenSend && chain.chainFamily === 'xrp') {
    if (params.has('dt')) {
      const tag = params.get('dt')!
      // DestinationTag is UInt32. Preserve its digits in the form; the builder
      // normalizes the integer after the user reviews the destination.
      if (!/^\d{1,10}$/.test(tag) || BigInt(tag) > 4294967295n) return null
      memo = tag
    }
  } else if (!isTokenSend && chain.chainFamily === 'cosmos') memo = params.get('memo') ?? ''
  // BIP-21/321 label and message are presentation metadata, never on-chain memo.
  return { recipient, ...(amount !== undefined ? { amount } : {}), memo }
}
