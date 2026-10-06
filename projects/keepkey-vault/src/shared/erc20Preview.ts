/** Exact, offline ERC-20 preview for the signing overlay. Never infer a swap
 * from a caller's label or a function selector alone. */
import { evmTokenIdentity, evmContractIdentity } from './evm-contract-identity'

function amountWithDecimals(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = (raw / divisor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

export function erc20Preview(to?: string, chainId?: number, data?: string): {
  summary: string
  amount: string
  rawAmount: string
  tokenAddress: string
  tokenIdentity?: string
  counterpartyAddress: string
  counterpartyIdentity?: string
  counterpartyLabel: string
} | null {
  if (!to || !chainId || !data || !/^0x[0-9a-fA-F]{136}$/.test(data)) return null
  const selector = data.slice(0, 10).toLowerCase()
  if (selector !== '0xa9059cbb' && selector !== '0x095ea7b3') return null
  const addressWord = data.slice(10, 74)
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(addressWord)) return null
  const address = `0x${addressWord.slice(24)}`
  const rawAmount = BigInt(`0x${data.slice(74, 138)}`).toString()
  const token = evmTokenIdentity(chainId, to)
  const unlimited = selector === '0x095ea7b3' && BigInt(rawAmount) === (1n << 256n) - 1n
  const amount = unlimited ? `Unlimited${token ? ` ${token.symbol}` : ''}` : token
    ? `${amountWithDecimals(BigInt(rawAmount), token.decimals)} ${token.symbol}`
    : `${rawAmount} raw token units (decimals unknown)`
  const summary = selector === '0x095ea7b3'
    ? `Allow ${address} to spend up to ${amount}`
    : `Send ${amount} to ${address}`
  return { summary, amount, rawAmount, tokenAddress: to,
    tokenIdentity: token?.symbol, counterpartyAddress: address,
    counterpartyIdentity: evmContractIdentity(chainId, address),
    counterpartyLabel: selector === '0x095ea7b3' ? 'Spender' : 'Recipient' }
}
