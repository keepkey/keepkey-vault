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
import { CHAINS } from '../shared/chains'

const MAX_UINT256 = (1n << 256n) - 1n

/**
 * Resolve an EVM chainId to its real { name, symbol } from the shared chain
 * registry — covers every built-in EVM chain (Ethereum/Polygon/Arbitrum/…/
 * Monad/Hyperliquid). For an unknown/custom chainId, fall back to a chainId-
 * labeled name with NO symbol: better to omit the symbol than to falsely
 * assert "ETH" for a non-Ethereum network.
 */
function evmNet(params: any, fallbackChain: string): { name: string; symbol: string } {
  const raw = params?.chainId
  if (raw != null && raw !== '') {
    const n = Number(raw) // normalize number / decimal string / 0x-hex
    if (Number.isFinite(n)) {
      const cid = String(n)
      const def = CHAINS.find(c => c.chainFamily === 'evm' && c.chainId === cid)
      if (def) return { name: def.coin, symbol: def.symbol }
      return { name: `EVM chain ${cid}`, symbol: '' }
    }
  }
  return { name: fallbackChain, symbol: '' }
}

/** Decode hex calldata to UTF-8 if it is entirely printable text — used to tell
 * a native-send memo (printable) apart from ABI calldata (0x00 padding makes it
 * non-printable). Returns null when not printable text. */
function hexToPrintableUtf8(data: string): string | null {
  try {
    const txt = Buffer.from(data.slice(2), 'hex').toString('utf8')
    if (txt && /^[\t\n\r\x20-\x7e]*$/.test(txt)) return txt
  } catch { /* not valid bytes */ }
  return null
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
  return (neg ? '-' : '') + (frac ? `${intPart}.${frac}` : intPart) + (symbol ? ' ' + symbol : '')
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
  const net = evmNet(params, fallbackChain)
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

  // A native send can carry a UTF-8 memo encoded as `data` (see txbuilder/
  // evm.ts). If the data is entirely printable text it's a memo on a NATIVE
  // send — show the recipient + memo, not a forged "Contract". ABI calldata has
  // 0x00 padding (non-printable), so a real contract call falls through below.
  const memoText = hexToPrintableUtf8(data)
  if (memoText != null) {
    return { operation, chain, to: params?.to, value: nativeValue, fee, memo: memoText.slice(0, 64) }
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
