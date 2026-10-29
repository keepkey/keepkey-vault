/** Readable rows for a decoded EIP-712 request: token amounts in whole units
 * with their symbol, timestamps as dates, the raw value kept beside each.
 *
 * A wrong number here is worse than a raw one, so an amount is converted only
 * when the request matched a known descriptor AND the token field of the same
 * group is present and catalogued. Everything else stays raw. */
import { evmTokenIdentity } from './evm-contract-identity'
import { amountWithDecimals } from './erc20Preview'
import type { EIP712DecodedInfo } from './types'

const UNLIMITED = (1n << 160n) - 1n // uint160 max: Permit2's "unlimited"

/** `raw` is undefined when the amount could not be read; such an amount is
 * reported as unlimited, because the signer may read what this code cannot. */
export interface TypedDataAmount { label: string; text: string; symbol?: string; unlimited: boolean; raw?: bigint }

/** Decimal or 0x-hex, read as leniently as the signer does (it trims, and
 * takes the prefix in either case). */
function toBigInt(raw: unknown): bigint | undefined {
  const s = (typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : '').trim()
  if (/^\d+$/.test(s)) return BigInt(s)
  return /^0x[0-9a-f]+$/i.test(s) ? BigInt('0x' + s.slice(2)) : undefined
}

/** Label of the token field that belongs to this amount, e.g. "[2] Amount" → "[2] Token". */
function tokenLabelFor(label: string): string | undefined {
  if (label === 'Maximum Input') return 'Input Token'
  const m = /^(\[\d+\] |Output \d+ |Input )?(?:[A-Z][a-z]+ )*Amount$/.exec(label)
  return m ? `${m[1] ?? ''}Token` : undefined
}

function tokenAmount(decoded: EIP712DecodedInfo, index: number): TypedDataAmount | undefined {
  const field = decoded.fields[index]
  if (field.format !== 'amount') return undefined
  // Field names of a type this build has no descriptor for prove nothing.
  if (!decoded.isKnownType) return undefined
  const raw = toBigInt(field.raw)
  if (raw === undefined) return { label: field.label, text: `${String(field.raw)} (unreadable amount)`, unlimited: true }
  let tokenAddress: unknown
  const tokenLabel = tokenLabelFor(field.label)
  if (tokenLabel) tokenAddress = decoded.fields.find((f) => f.format === 'address' && f.label === tokenLabel)?.raw
  else if (field.label === 'Value') tokenAddress = decoded.domain.verifyingContract // ERC-2612, EIP-3009: the token is the contract
  else return undefined // a fee or price, not a token amount
  const token = typeof tokenAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(tokenAddress)
    ? evmTokenIdentity(Number(decoded.domain.chainId || 0), tokenAddress) : undefined
  const unlimited = raw >= UNLIMITED
  const text = unlimited ? `Unlimited${token ? ` ${token.symbol}` : ''}`
    : token ? `${amountWithDecimals(raw, token.decimals)} ${token.symbol}`
    : `${raw} raw token units (decimals unknown)`
  return { label: field.label, text, symbol: token?.symbol, unlimited, raw }
}

/** What a permit lets the spender take: its own amount fields, not the
 * order's outputs (those are what the signer receives). */
export function typedDataSpendAmounts(decoded: EIP712DecodedInfo): TypedDataAmount[] {
  return decoded.fields.flatMap((field, i) =>
    /^(\[\d+\] )?(Amount|Maximum Amount|Value)$/.test(field.label) ? tokenAmount(decoded, i) ?? [] : [])
}

export function typedDataRows(decoded: EIP712DecodedInfo): { label: string; value: string }[] {
  return decoded.fields.map((field, i) => {
    const amount = tokenAmount(decoded, i)
    if (amount && amount.raw !== undefined && (amount.symbol || amount.unlimited)) return { label: field.label, value: `${amount.text} (raw: ${field.raw})` }
    if (field.format === 'datetime' && field.value && field.value !== String(field.raw)) {
      return { label: field.label, value: `${field.value} (${field.raw})` }
    }
    // A known descriptor that already read this field (CoW "25,000 USDC",
    // "This wallet") keeps the signed value beside its reading.
    if (decoded.isKnownType && (field.format === 'amount' || field.format === 'address')
      && field.raw && field.value && field.value !== String(field.raw)) {
      return { label: field.label, value: `${field.value} (${field.raw})` }
    }
    return { label: field.label, value: String(field.raw || field.value) }
  })
}
