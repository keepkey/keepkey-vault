/** Readable rows for a decoded EIP-712 request: token amounts in whole units
 * with their symbol, timestamps as dates, the raw value kept beside each. */
import { evmTokenIdentity } from './evm-contract-identity'
import { amountWithDecimals } from './erc20Preview'
import type { EIP712DecodedField, EIP712DecodedInfo } from './types'

const UNLIMITED = (1n << 160n) - 1n // uint160 max: Permit2's "unlimited"

export interface TypedDataAmount { label: string; text: string; symbol?: string; unlimited: boolean }

/** A token amount field, or undefined for anything else (fees are not token amounts). */
function tokenAmount(decoded: EIP712DecodedInfo, index: number): TypedDataAmount | undefined {
  const field = decoded.fields[index]
  if (field.format !== 'amount' || field.raw === undefined || !/^\d+$/.test(String(field.raw))) return undefined
  const chainId = Number(decoded.domain.chainId || 0)
  let tokenAddress: string | undefined
  if (/Amount$/.test(field.label) || field.label === 'Maximum Input') {
    for (let i = index - 1; i >= 0 && !tokenAddress; i--) {
      const f = decoded.fields[i]
      if (f.format === 'address' && /Token$/.test(f.label)) tokenAddress = f.raw
    }
  } else if (/Value$/.test(field.label)) {
    tokenAddress = decoded.domain.verifyingContract // ERC-2612 and EIP-3009: the token is the contract
  } else return undefined
  const raw = BigInt(field.raw)
  const token = tokenAddress ? evmTokenIdentity(chainId, tokenAddress) : undefined
  const unlimited = raw >= UNLIMITED
  const text = unlimited ? `Unlimited${token ? ` ${token.symbol}` : ''}`
    : token ? `${amountWithDecimals(raw, token.decimals)} ${token.symbol}`
    : `${field.raw} raw token units (decimals unknown)`
  return { label: field.label, text, symbol: token?.symbol, unlimited }
}

export function typedDataAmounts(decoded: EIP712DecodedInfo): TypedDataAmount[] {
  return decoded.fields.map((_, i) => tokenAmount(decoded, i)).filter((a): a is TypedDataAmount => !!a)
}

export function typedDataRows(decoded: EIP712DecodedInfo): { label: string; value: string }[] {
  return decoded.fields.map((field: EIP712DecodedField, i) => {
    const amount = tokenAmount(decoded, i)
    if (amount) return { label: field.label, value: amount.symbol || amount.unlimited ? `${amount.text} (raw: ${field.raw})` : amount.text }
    if (field.format === 'datetime' && field.value && field.value !== String(field.raw)) {
      return { label: field.label, value: `${field.value} (${field.raw})` }
    }
    return { label: field.label, value: field.raw || field.value }
  })
}
