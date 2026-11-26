/**
 * What a KeepKey shows for EthereumSignTx, screen by screen, ported from
 * keepkey-firmware 378cf30 (lib/firmware/ethereum.c ethereum_signing_init,
 * layoutEthereumConfirmTx, layoutEthereumFee, ethereumFormatAmount,
 * confirm_ethereum_data_hash; ethereum_contracts/thortx.c; ethereum_tokens.c).
 * The text layout itself (wrap, pages, confirm_bytes) is the port in
 * hive-device-screens: one screen per ButtonRequest.
 *
 * Exact for the paths a host can predict: a native send, a standard ERC-20
 * transfer or approval of a token the firmware is known to name, the
 * unlimited-approval warning, the raw-data path (its "Blocked" screen without
 * AdvancedMode, the fee screen and the calldata's Keccak-256), and the fee
 * screen's network title. A THORChain/Maya router deposit is exact up to its
 * memo. Anything else returns null (or says why it is not exact): a certified
 * ClearSign description, a 0x / SA contract the firmware narrates itself, a
 * token missing from the known table. Never a guess.
 */
import { keccak_256 } from '@noble/hashes/sha3'
import { bnFormat, confirmBytesScreens, confirmScreens, type DeviceMirror, type OledScreen } from './hive-device-screens'
import { FIRMWARE_TOKENS_V7160 } from './eth-device-tokens'

export interface EthTxInput {
  chainId: number
  /** 0x-prefixed, 20 bytes; absent for a contract creation. */
  to?: string
  value: bigint
  data: Uint8Array
  gasLimit: bigint
  /** Legacy transactions. */
  gasPrice?: bigint
  /** EIP-1559 transactions: the fee screen uses max_fee_per_gas × gas_limit. */
  maxFeePerGas?: bigint
  /** The device's AdvancedMode policy (raw contract data needs it). */
  advancedMode?: boolean
  /** The host sends a ClearSign description (signed metadata or ERC-7730):
   *  the device then shows that description's screens instead. */
  clearSign?: boolean
}

const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
const bytesOf = (h: string) => Uint8Array.from((h.replace(/^0x/i, '').match(/../g) ?? []).map(x => parseInt(x, 16)))
const be = (b: Uint8Array) => b.length ? BigInt('0x' + hex(b)) : 0n
const eq = (a: Uint8Array, b: string) => hex(a) === b

/** ethereum_address_checksum(…, rskip60 = false): EIP-55. */
export function eip55(address: Uint8Array): string {
  const lower = hex(address)
  const hash = hex(keccak_256(new TextEncoder().encode(lower)))
  return '0x' + [...lower].map((c, i) => parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c).join('')
}

/** The native ticker per chain (trezor-common networks.json, as in the firmware). */
const NATIVE: Record<number, string> = {
  1: ' ETH', 2: ' EXP', 8: ' UBQ', 10: ' ETH', 20: ' EOSC', 28: ' ETSC', 30: ' RBTC', 40: ' TLOS', 56: ' BNB', 61: ' ETC',
  64: ' ELLA', 100: ' xDAI', 130: ' ETH', 137: ' POL', 8453: ' ETH', 42161: ' ETH', 43114: ' AVAX',
}
type Token = { ticker: string; decimals: number }

/** ethereumFormatAmount(): a token's ticker, else Wei below 1 gwei or on an
 *  unnamed chain, else the chain's native ticker. bn_format, no trailing zeros. */
export function ethFormatAmount(amount: bigint, token: Token | null, chainId: number): string {
  if (token) return bnFormat(amount, token.decimals) + ' ' + token.ticker
  if (amount < 1_000_000_000n || !NATIVE[chainId]) return bnFormat(amount, 0) + ' Wei'
  return bnFormat(amount, 18) + NATIVE[chainId]
}

/** ethereum_transactionTitle(): the last screen names the chain. */
export function ethTransactionTitle(chainId: number): string {
  const names: Record<number, string> = { 10: 'Optimism', 56: 'BNB Chain', 100: 'Gnosis', 130: 'Unichain', 137: 'Polygon', 8453: 'Base', 42161: 'Arbitrum', 43114: 'Avalanche' }
  if (!chainId || chainId === 1) return 'Transaction'
  return names[chainId] ? `Tx on ${names[chainId]}` : `Tx on chain ${chainId}`
}

const TRANSFER = 'a9059cbb' + '0'.repeat(24)
const APPROVE = '095ea7b3' + '0'.repeat(24)
const ALLOWANCE_SELECTORS = ['095ea7b3', '39509351', 'd73dd623']
const OASIS_DEX = '39755357759ce0d7f32dc8dc45414cca409ae24e'
const ETH_ASSET = '0'.repeat(40)
const THOR_ROUTERS: Record<string, { chain: number; protocol: 'Thorchain data' | 'Maya data'; label: string; v6: boolean }> = {
  '1:d37bbe5744d730a1d98d8dc97c42f0ca46ad7146': { chain: 1, protocol: 'Thorchain data', label: 'Thorchain router', v6: false },
  '43114:00dc6100103bc402d490aee3f9a5560cbd91f1d4': { chain: 43114, protocol: 'Thorchain data', label: 'Thorchain router', v6: true },
  '56:b30ec53f98ff5947ede720d32ac2da7e52a5f56b': { chain: 56, protocol: 'Thorchain data', label: 'Thorchain router', v6: false },
  '8453:00dc6100103bc402d490aee3f9a5560cbd91f1d4': { chain: 8453, protocol: 'Thorchain data', label: 'Thorchain router', v6: true },
  '1:e3985e6b61b814f7cdb188766562ba71b446b46d': { chain: 1, protocol: 'Maya data', label: 'Maya router', v6: false },
  '42161:700e97ef07219440487840dc472e7120a7ff11f4': { chain: 42161, protocol: 'Maya data', label: 'Maya router', v6: false },
}
const THOR_DEPOSIT = '1fece7b4', THOR_DEPOSIT_EXPIRY = '44bc937b'
/** The 0x / SA contracts ethereum_contractHandled() narrates in its own words. */
const ZX_PROXY = 'def1c0ded9bec7f1a1670819833240f027b25eff'

/** tokenByChainAddress(): a token the firmware names; 'unknown' where the 7.16
 *  table names none (every chain but Ethereum); 'uncertain' for an Ethereum
 *  contract missing from it (a later table may name it). */
type Lookup = Token | 'unknown' | 'uncertain'
const lookup = (chainId: number, address: Uint8Array): Lookup => {
  const t = FIRMWARE_TOKENS_V7160[`${chainId}:${hex(address)}`]
  return t ? { ticker: t[0], decimals: t[1] } : chainId === 1 ? 'uncertain' : 'unknown'
}

function screens(title: string, body: string): OledScreen[] {
  const s = confirmScreens(title, body)
  if (!s) throw new Error('unformattable')
  return s
}

/** thor_confirm_deposit_tx(), up to the memo screens (not ported yet). */
function thorDepositPrefix(tx: EthTxInput, d: Uint8Array, pin: (typeof THOR_ROUTERS)[string]): DeviceMirror | null {
  const selector = hex(d.slice(0, 4))
  const expiry = selector === THOR_DEPOSIT_EXPIRY
  if (d.length < (expiry ? 196 : 164)) return null
  const word = (i: number) => d.slice(4 + 32 * i, 4 + 32 * (i + 1))
  const vault = word(0).slice(12), asset = word(1).slice(12)
  const amount = be(word(2))
  const native = hex(asset) === ETH_ASSET
  if (!native && tx.value !== 0n) return null
  const assetToken = native ? null : lookup(tx.chainId, asset)
  if (assetToken === 'uncertain') return null // the firmware may name it: not drawn
  const shown = native ? tx.value : amount
  const out: OledScreen[] = []
  out.push(...screens(pin.protocol, `Routing through ${pin.label}`))
  out.push(...screens(pin.protocol, `Pays UNVERIFIED vault ${hex(vault)}`))
  const amountStr = assetToken === 'unknown' ? `${bnFormat(amount, 0)} unformatted` : ethFormatAmount(shown, assetToken, tx.chainId)
  if (assetToken === 'unknown') {
    out.push(...screens(pin.protocol, `from asset ${hex(asset)}`))
    out.push(...screens(pin.protocol, `amount ${amountStr}`))
  } else {
    out.push(...screens(pin.protocol, `Confirm sending ${amountStr}`))
  }
  if (native && amount !== 0n && amount !== tx.value)
    out.push(...screens('Router amount', `${ethFormatAmount(amount, null, tx.chainId)} (ignored by router; value sent: ${amountStr})`))
  if (expiry) {
    const e = be(word(4))
    out.push(...screens(pin.protocol, e === 0n ? 'No expiry' : `Expiry epoch ${e}`))
  }
  return { exact: false, screens: out, reason: 'The memo screens that follow, and the fee screen after them, are not reproduced here yet.' }
}

/** EthereumSignTx as ethereum_signing_init() shows it (address type not TRANSFER). */
export function ethSignTxMirror(tx: EthTxInput): DeviceMirror | null {
  try {
    if (!tx.chainId || tx.chainId < 1) return null
    if (tx.clearSign) return null // the certified description's screens come from it
    const to = tx.to ? bytesOf(tx.to) : new Uint8Array()
    if (to.length !== 0 && to.length !== 20) return null
    const data = tx.data, total = data.length
    const d = data.slice(0, 1024)
    const sel = hex(d.slice(0, 4))
    const out: OledScreen[] = []
    const refused = (reason: string): DeviceMirror => ({ exact: true, screens: out, reason })

    // Allowance policy: needs both words, then warns before anything else on UNLIMITED.
    if (to.length === 20 && total >= 4 && ALLOWANCE_SELECTORS.includes(sel)) {
      if (d.length < 68) return refused('The KeepKey refuses an approval without both of its words.')
      if (d.slice(4, 16).some(b => b !== 0)) return refused('The KeepKey refuses a malformed ERC-20 approval.')
      if (d[36]! & 0x80) {
        const t = lookup(tx.chainId, to)
        if (t === 'uncertain') return null // the firmware may name this token
        out.push(...screens('UNLIMITED approval', `Allow ${eip55(d.slice(16, 36))} to spend ALL your ${t === 'unknown' ? eip55(to) : t.ticker}`))
      }
    }

    // Contracts the firmware narrates itself (whole calldata in the first chunk).
    let needsConfirm = true, dataNeedsConfirm = true
    if (total === d.length && to.length === 20 && d.length >= 4) {
      const pin = THOR_ROUTERS[`${tx.chainId}:${hex(to)}`]
      if (pin && (sel === THOR_DEPOSIT || sel === THOR_DEPOSIT_EXPIRY)) {
        const prefix = thorDepositPrefix(tx, d, pin)
        return prefix && { ...prefix, screens: [...out, ...prefix.screens] }
      }
      if (eq(to, ZX_PROXY)) return null
    }

    // A standard ERC-20 transfer / approval: a named token, or the unknown-token review.
    let tok: Token | 'unknown' | null = null, isApprove = false
    const valueZero = tx.value === 0n
    const erc20 = total === 68 && to.length === 20 && valueZero
    if (erc20 && (hex(d.slice(0, 16)) === TRANSFER || hex(d.slice(0, 16)) === APPROVE)) {
      const t = lookup(tx.chainId, to)
      if (t === 'uncertain') return null // the firmware may name this token
      tok = t
      isApprove = hex(d.slice(0, 16)) === APPROVE
    }
    // A certified contact relabels a plain send or a named-token transfer.
    const contactPossible = !isApprove && (tok === null ? total === 0 : tok !== 'unknown')

    if (needsConfirm && tok === 'unknown') {
      // ethereumFormatUnknownTokenReview()
      const raw = be(d.slice(36, 68))
      const amount = isApprove && (d[36]! & 0x80) ? 'UNLIMITED' : `${bnFormat(raw, 0)} base units`
      const body = isApprove
        ? `Unknown token contract ${eip55(to)}\nAllow ${eip55(d.slice(16, 36))} to withdraw up to ${amount}?`
        : `Unknown token contract ${eip55(to)}\nSend ${amount} to ${eip55(d.slice(16, 36))}?`
      out.push(...screens(isApprove ? 'Approve' : 'Send', body))
    } else if (needsConfirm) {
      const named = tok as Token | null // never 'unknown' on this branch
      const recipient = named ? d.slice(16, 36) : to
      const raw = named ? be(d.slice(36, 68)) : tx.value
      const amount = !named && raw === 0n ? 'message' : ethFormatAmount(raw, named, tx.chainId)
      const address = recipient.length && tx.chainId === 1 && eq(recipient, OASIS_DEX) ? 'OasisDEX' : eip55(recipient)
      const approveAll = isApprove && hex(d.slice(36, 68)) === 'f'.repeat(64)
      const body = isApprove && raw === 0n ? `Remove ability for ${address} to withdraw ${named!.ticker}?`
        : approveAll ? `Unlock full ${named!.ticker} balance for withdrawal by ${address}?`
        : isApprove ? `Approve withdrawal of up to ${amount} by ${address}?`
        : `Send ${amount} to ${recipient.length ? address : 'new contract?'}`
      out.push(...screens(isApprove ? 'Approve' : 'Send', body))
    }
    const contactSlot = contactPossible ? out.length : -1

    // Raw contract data (an unknown token's too): AdvancedMode, then its full
    // Keccak-256 after the fee.
    let dataHash = false
    if ((!tok || tok === 'unknown') && total > 0 && dataNeedsConfirm) {
      if (tx.advancedMode === false) {
        out.push(...screens('Blocked', "Signing of arbitrary ETH contract data requires AdvancedMode. Enable 'AdvancedMode' policy in device settings."))
        return refused('Without AdvancedMode the KeepKey shows this and refuses to sign.')
      }
      dataHash = true
    }
    if (isApprove) tok = null

    const perGas = tx.maxFeePerGas ?? tx.gasPrice
    if (perGas === undefined) return null
    const gas = ethFormatAmount(perGas * tx.gasLimit, null, tx.chainId)
    const value = tx.value === 0n ? (tok ? 'the tokens' : 'the message') : ethFormatAmount(tx.value, null, tx.chainId)
    out.push(...screens(ethTransactionTitle(tx.chainId), `Send ${value} from your wallet, paying up to ${gas} for gas?`))

    if (dataHash) {
      const digest = new TextEncoder().encode(hex(keccak_256(data)))
      const s = confirmBytesScreens('Ethereum Data Hash', digest)
      if (!s) return null
      out.push(...s)
    }
    return contactSlot >= 0
      ? { exact: true, screens: out, mayPrepend: 'contact-address', contactBefore: [contactSlot] }
      : { exact: true, screens: out }
  } catch {
    return null
  }
}

const big = (v: unknown): bigint | undefined => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'string' && v.trim()) { try { return BigInt(v.trim()) } catch { return undefined } }
  return undefined
}

/** The signing input from an /eth/sign-transaction body (REST/hdwallet field
 *  names, hex or decimal), or null when a field the screens need is missing. */
export function ethTxFromBody(body: Record<string, unknown> | undefined, extra: { chainId?: unknown; advancedMode?: boolean; clearSign?: boolean } = {}): EthTxInput | null {
  if (!body) return null
  const chainId = Number(big(extra.chainId ?? body.chainId ?? body.chain_id) ?? NaN)
  const gasLimit = big(body.gasLimit ?? body.gas ?? body.gas_limit)
  const data = typeof body.data === 'string' ? body.data : '0x'
  if (!Number.isFinite(chainId) || gasLimit === undefined || !/^(0x)?([0-9a-fA-F]{2})*$/.test(data)) return null
  const to = typeof body.to === 'string' && body.to ? body.to : undefined
  return {
    chainId, to, gasLimit, data: bytesOf(data),
    value: big(body.value) ?? 0n,
    gasPrice: big(body.gasPrice ?? body.gas_price),
    maxFeePerGas: big(body.maxFeePerGas ?? body.max_fee_per_gas),
    advancedMode: extra.advancedMode, clearSign: extra.clearSign,
  }
}
