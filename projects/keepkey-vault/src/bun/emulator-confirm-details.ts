/**
 * Honest confirm-dialog detail builders for the emulator.
 *
 * These are DISPLAY-ONLY: they shape the text shown alongside the real device
 * OLED frame and never alter what is signed. The job is to not MISREPRESENT —
 * e.g. an ERC-20 transfer must show the real recipient + token amount, not the
 * token contract + "0x0"; an approval must say it is an approval; a router/
 * contract call must not forge a "To:" recipient.
 *
 * Shared by the Electrobun RPC handlers (index.ts) and the REST API
 * (rest-api.ts) so both signing entry points display the same honest detail.
 */
import type { EmulatorConfirmDetails } from './emulator-window'
import { decodeCalldataLocal } from './calldata-decoder'

const MAX_UINT256 = (1n << 256n) - 1n

// chainId -> { name, symbol } for the common EVM networks. Used so the dialog
// states the real network/asset instead of a hardcoded "Ethereum"/"ETH".
const EVM_CHAINS: Record<number, { name: string; symbol: string }> = {
  1: { name: 'Ethereum', symbol: 'ETH' },
  10: { name: 'Optimism', symbol: 'ETH' },
  56: { name: 'BNB Chain', symbol: 'BNB' },
  100: { name: 'Gnosis', symbol: 'xDAI' },
  137: { name: 'Polygon', symbol: 'MATIC' },
  250: { name: 'Fantom', symbol: 'FTM' },
  8453: { name: 'Base', symbol: 'ETH' },
  42161: { name: 'Arbitrum', symbol: 'ETH' },
  43114: { name: 'Avalanche', symbol: 'AVAX' },
}

function parseWei(v: any): bigint | null {
  try {
    if (v == null || v === '') return null
    return BigInt(String(v)) // accepts both 0x-hex and decimal strings
  } catch {
    return null
  }
}

/** wei (18dp) -> trimmed decimal string + symbol, e.g. 100000000000000000n -> "0.1 ETH". */
function weiToDecimal(wei: bigint, symbol: string): string {
  const neg = wei < 0n
  const s = (neg ? -wei : wei).toString().padStart(19, '0')
  const intPart = s.slice(0, -18) || '0'
  const frac = s.slice(-18).replace(/0+$/, '')
  return (neg ? '-' : '') + (frac ? `${intPart}.${frac}` : intPart) + ' ' + symbol
}

function shorten(addr?: string): string {
  if (!addr) return ''
  return addr.length > 16 ? addr.slice(0, 8) + '…' + addr.slice(-6) : addr
}

/**
 * Build an honest EmulatorConfirmDetails for an EVM signTx. Inspects params.data
 * with a SYNC/LOCAL decode only (never the network-backed decodeCalldata) so the
 * confirm dialog can't block on I/O.
 */
export function evmConfirmDetails(operation: string, fallbackChain: string, params: any): EmulatorConfirmDetails {
  const cid = Number(params?.chainId)
  const net = (cid && EVM_CHAINS[cid]) || { name: fallbackChain, symbol: 'ETH' }
  const chain = net.name

  // Network fee = gasLimit * (maxFeePerGas|gasPrice).
  let fee: string | undefined
  const gp = parseWei(params?.maxFeePerGas ?? params?.gasPrice)
  const gl = parseWei(params?.gasLimit)
  if (gp != null && gl != null) fee = weiToDecimal(gp * gl, net.symbol)

  // Native value carried by the tx (0 for a pure token call → omit, don't show "0").
  const wei = parseWei(params?.value)
  const nativeValue = wei != null && wei > 0n ? weiToDecimal(wei, net.symbol) : undefined

  const data: string = typeof params?.data === 'string' ? params.data.toLowerCase() : '0x'
  const hasData = data.length >= 10 && data !== '0x'

  if (!hasData) {
    // Plain native send.
    return { operation, chain, to: params?.to, value: nativeValue, fee }
  }

  const selector = data.slice(0, 10)
  const word = (i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64)
  const addrFromWord = (i: number) => '0x' + word(i).slice(24) // last 20 bytes
  const uintFromWord = (i: number) => {
    try { return BigInt('0x' + word(i)) } catch { return null }
  }

  if (selector === '0xa9059cbb') {
    // ERC-20 transfer(address recipient, uint256 amount)
    const amt = uintFromWord(1)
    return {
      operation, opLabel: 'Token Transfer', chain,
      to: addrFromWord(0), toLabel: 'To',
      value: amt != null ? `${amt.toString()} (token base units)` : undefined,
      fee,
      memo: `ERC-20 · token ${shorten(params?.to)}`,
    }
  }

  if (selector === '0x095ea7b3') {
    // ERC-20 approve(address spender, uint256 allowance)
    const raw = uintFromWord(1)
    const allowance = raw == null ? undefined
      : raw >= MAX_UINT256 ? 'Unlimited'
      : `${raw.toString()} (token base units)`
    return {
      operation, opLabel: 'Token Approval', chain,
      to: addrFromWord(0), toLabel: 'Spender',
      value: allowance,
      fee,
      memo: `Approve token ${shorten(params?.to)}`,
    }
  }

  // Arbitrary contract call (router swap, multicall, dApp tx, unknown). Do NOT
  // present the contract as a "To:" recipient — label it a contract call and
  // surface the method name when the local registry knows it.
  const decoded = decodeCalldataLocal(data)
  return {
    operation,
    opLabel: decoded?.method ? `Contract call: ${decoded.method}` : 'Contract call',
    chain,
    to: params?.to, toLabel: 'Contract',
    value: nativeValue, // any native ETH sent alongside (e.g. ETH→token swap)
    fee,
    memo: `data ${selector}${decoded ? '' : ' (unrecognized)'}`,
  }
}
