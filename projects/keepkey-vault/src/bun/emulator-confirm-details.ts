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

// ── Hive ────────────────────────────────────────────────────────────────
//
// /hive/sign-operations sends the device a pre-serialized Graphene blob, so
// unlike every other chain the confirm dialog has no params to read amounts
// out of — without this it showed "Hive Sign Operations / Chain: HIVE" and
// nothing else, for a tx that may carry up to four distinct operations. The
// caller passes the ORIGINAL op array (the same one it serialized) purely for
// display; nothing here feeds the serializer.
//
// Multi-screen ops (claim_reward_balance is 2 screens, limit_order_create 2,
// comment_options 2 + one per beneficiary) raise one prompt PER firmware
// ButtonRequest, so the same summary is shown on each press. That is intended:
// the OLED behind it is what changes, and it stays authoritative.

/** Human label per op — same wording the extension's approval card uses. */
const HIVE_OP_LABELS: Record<string, string> = {
  vote: 'Vote',
  comment: 'Post / Comment',
  comment_options: 'Payout Options',
  custom_json: 'Custom JSON',
  transfer_to_vesting: 'Power Up',
  withdraw_vesting: 'Power Down',
  delegate_vesting_shares: 'Delegate HP',
  transfer_to_savings: 'Savings Deposit',
  transfer_from_savings: 'Savings Withdraw',
  claim_reward_balance: 'Claim Rewards',
  convert: 'Convert HBD',
  account_update2: 'Update Profile',
  limit_order_create: 'Market Order',
  limit_order_cancel: 'Cancel Order',
}

/**
 * The counterparty account an op acts on, and what to call it. Returns null
 * when an op has no meaningful counterparty (claim, cancel, profile update) —
 * better to show no "To:" row than to forge one from the signer's own name.
 */
function hiveCounterparty(name: string, p: any): { to: string; toLabel: string } | null {
  const at = (v: any) => (typeof v === 'string' && v ? `@${v}` : null)
  switch (name) {
    case 'vote': {
      const a = at(p?.author)
      return a ? { to: `${a}/${p?.permlink ?? ''}`, toLabel: 'Post' } : null
    }
    case 'comment_options': {
      const a = at(p?.author)
      return a ? { to: `${a}/${p?.permlink ?? ''}`, toLabel: 'Post' } : null
    }
    case 'transfer_to_vesting': {
      // to may be "" meaning self — say so rather than showing an empty row.
      const a = at(p?.to)
      return { to: a ?? 'self', toLabel: 'To' }
    }
    case 'transfer_to_savings':
    case 'transfer_from_savings': {
      const a = at(p?.to)
      return a ? { to: a, toLabel: 'To' } : null
    }
    case 'delegate_vesting_shares': {
      const a = at(p?.delegatee)
      return a ? { to: a, toLabel: 'Delegatee' } : null
    }
    default:
      return null
  }
}

/** The amount an op moves, verbatim as serialized (already a Hive asset string). */
function hiveValue(name: string, p: any): string | undefined {
  const asset = (v: any) => (typeof v === 'string' && v ? v : undefined)
  switch (name) {
    case 'transfer_to_vesting':
    case 'transfer_to_savings':
    case 'transfer_from_savings':
    case 'convert':
      return asset(p?.amount)
    case 'withdraw_vesting':
    case 'delegate_vesting_shares':
      return asset(p?.vesting_shares)
    case 'limit_order_create':
      return asset(p?.amount_to_sell) && asset(p?.min_to_receive)
        ? `${p.amount_to_sell} → ${p.min_to_receive}`
        : asset(p?.amount_to_sell)
    case 'claim_reward_balance': {
      // Only the non-zero rewards — a claim is typically 2 of 3, and printing
      // "0.000 HIVE" alongside the real one buries it.
      const parts = [p?.reward_hive, p?.reward_hbd, p?.reward_vests]
        .filter((v: any) => typeof v === 'string' && v && !/^0(\.0+)? /.test(v))
      return parts.length ? parts.join(' + ') : undefined
    }
    case 'vote': {
      // Weight is basis points (-10000..10000), so 1bp = 0.01%. toFixed(0)
      // would round a real 0.5% vote to "1%" and a 0.01% vote to "0%" —
      // misreporting the value being signed. Keep up to two decimals and drop
      // trailing zeros so whole percentages still read as "100%".
      const w = Number(p?.weight)
      if (!Number.isFinite(w)) return undefined
      return `${Number((w / 100).toFixed(2))}%`
    }
    default:
      return undefined
  }
}

/**
 * Build confirm details for a Hive operation batch.
 *
 * `ops` is the condenser-style [[name, params], …] array. A single op gets the
 * full treatment (label, counterparty, amount); a batch names the count and
 * lists the ops, since one dialog cannot honestly claim a single recipient for
 * four operations.
 */
export function hiveConfirmDetails(operation: string, ops: any): EmulatorConfirmDetails {
  const list: Array<[string, any]> = Array.isArray(ops)
    ? ops.filter((o: any) => Array.isArray(o) && typeof o[0] === 'string')
    : []

  if (list.length === 0) {
    // Unparseable/absent — say nothing rather than guess. The OLED still shows
    // the real thing; this dialog just adds no claim of its own.
    return { operation, chain: 'Hive' }
  }

  if (list.length === 1) {
    const [name, p] = list[0]
    const party = hiveCounterparty(name, p)
    return {
      operation,
      opLabel: HIVE_OP_LABELS[name] ?? name,
      chain: 'Hive',
      ...(party ? { to: party.to, toLabel: party.toLabel } : {}),
      value: hiveValue(name, p),
      memo: name, // the raw op name, so an unlabeled op is still identifiable
    }
  }

  return {
    operation,
    opLabel: `${list.length} Hive operations`,
    chain: 'Hive',
    memo: list.map(([name]) => HIVE_OP_LABELS[name] ?? name).join(' · '),
  }
}

/**
 * One-line preview of a Hive signBuffer payload for the confirm dialog.
 *
 * Keychain signBuffer is overwhelmingly dApp login, where the message names the
 * site and account being logged into — the single fact worth showing. Binary
 * payloads are reported as a byte count rather than rendered as mojibake.
 */
export function hiveMessagePreview(messageBytes: ArrayLike<number>): string {
  const bytes = Buffer.from(Array.from(messageBytes))
  const txt = bytes.toString('utf8')
  const binary = `${bytes.length} bytes (binary)`
  // Round-trip check: a lossy decode means it was not UTF-8 text.
  if (!Buffer.from(txt, 'utf8').equals(bytes)) return binary
  // A round-trip alone is not enough: 00 01 02 03 and embedded NULs are VALID
  // UTF-8, so they survive it and would render as invisible "text". Bidi and
  // other format controls are worse than invisible — they reorder what the
  // user reads, so a payload could display as something other than what is
  // signed. Anything carrying control or format characters is reported by
  // byte count instead of rendered.
  //   \p{C} = control, format, surrogate, private-use, unassigned
  // Tab/newline/CR are ordinary whitespace in a login message and are folded
  // to spaces below, so they are dropped before the test rather than exempted
  // inside it (a trailing \p{C} in one pattern would match them too).
  if (/\p{C}/u.test(txt.replace(/[\t\n\r]/g, ''))) return binary
  const oneLine = txt.replace(/\s+/g, ' ').trim()
  if (!oneLine) return binary
  return oneLine.length > 64 ? `${oneLine.slice(0, 64)}…` : oneLine
}
