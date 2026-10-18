/**
 * Keep, per signed EVM transaction, what the approval card showed, and say in
 * plain words what a finished transaction did: the call, what moved in and out
 * of this wallet, the result, and how it was signed. Names only, no addresses.
 */
import { utils } from 'ethers'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { evmChainLabel } from '../shared/chains'
import { evmContractIdentity, evmTokenIdentity } from '../shared/evm-contract-identity'
import { REVIEWED_EVM_TOKENS } from '../shared/reviewed-evm-tokens'
import type { CalldataDecodedInfo, SigningRequestInfo, TokenBalance } from '../shared/types'
import type { SignedTxReview, TxDetailLine } from '../shared/tx-clearsign'
import { decodeCalldata } from './calldata-decoder'
import { plain } from './contract-facts'
import { getCachedBalances, getTokenVisibility, saveSignedTxReview } from './db'
import { findEvmNameRecord } from './evm-certified-schema'

/** The broadcast txid: keccak256 of the signed RLP (legacy) or typed envelope. */
export const evmTxid = (serialized: string) => utils.keccak256(serialized).toLowerCase()

const knownMethod = (d?: CalldataDecodedInfo | null) =>
  d?.method && !/^Unknown \(|^\(runtime signer\)$/.test(d.method) ? d.method : undefined

/** The card's verdict, recomputed from the very object the card was built from. */
export function signedTxReview(info: SigningRequestInfo, signedMsg: any): SignedTxReview {
  const risk = assessSigningRisk(info)
  // From the card's verdict, not from what was sent: a caller's 0x80 blob this
  // firmware cannot show still signs blind. Unmarked calls with data are blind.
  const blind = info.needsBlindSigning ?? (!info.deviceClearSigns && !!info.data && info.data !== '0x')
  return {
    signedHow: signedMsg?.erc7730 ? 'erc7730'
      : blind ? (signedMsg?.txMetadata ? 'provider' : 'blind')
        : info.deviceClearSigns ? 'native'
          : signedMsg?.txMetadata?.keyId === 0x80 ? 'certified'
            : 'native',
    tier: risk?.tier, headline: risk?.headline, reasons: risk?.reasons ?? [],
    call: knownMethod(info.calldataDecoded), contract: info.contractName?.name,
    provider: info.runtimeProvider?.alias, appName: info.appName,
    signedAt: Date.now(),
  }
}

/** Never throws: a missing record must not fail a signature. */
export function recordSignedEvmTx(
  scope: { deviceId: string; walletId: string }, chainId: number, serialized: string, info: SigningRequestInfo, signedMsg: any,
) {
  try { saveSignedTxReview(`eip155:${chainId}`, evmTxid(serialized), scope.deviceId, scope.walletId, signedTxReview(info, signedMsg)) }
  catch (e: any) { console.warn('[signed-tx-review] not recorded:', e?.message) }
}

/** The on-chain transaction, as a node returns it. */
export interface EvmTxFacts { to?: string | null; from?: string; value?: string; data?: string }
export interface EvmLog { address: string; topics: string[]; data: string }
export interface EvmReceiptFacts { status: 0 | 1; logs: EvmLog[] }
export interface EvmToken { symbol: string; decimals: number }

/** Pioneer's LookupTx, given a few seconds: a hung call must not leave the dialog waiting. */
export async function lookupEvmTx(pioneer: any, networkId: string, txid: string, timeoutMs = 5000): Promise<{ tx: EvmTxFacts; receipt?: EvmReceiptFacts } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const res = await Promise.race([
    pioneer.LookupTx({ networkId, txid }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('LookupTx timed out')), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
  const { tx, receipt } = res?.data?.data ?? {}
  if (!tx || typeof tx.hash !== 'string' || tx.hash.toLowerCase() !== txid.toLowerCase()) return undefined
  const data = tx.data ?? tx.input
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return undefined
  const value = tx.value?.hex ?? tx.value
  const status = Number(receipt?.status)
  const mined = receipt?.transactionHash?.toLowerCase() === txid.toLowerCase() && (status === 0 || status === 1) && Array.isArray(receipt.logs)
  return {
    tx: { to: tx.to, from: tx.from, value: value == null ? undefined : String(value), data },
    receipt: mined ? {
      status: status as 0 | 1,
      logs: receipt.logs.filter((l: any) => typeof l?.address === 'string' && Array.isArray(l.topics) && typeof l.data === 'string'),
    } : undefined,
  }
}

const ADDRESS = /0x[0-9a-fA-F]{6,}/
// A token's self-reported name or symbol, only when it reads as one: spam
// tokens name themselves after links and claims.
const tokenText = (s: unknown, max: number) => {
  const t = String(s ?? '').trim()
  return t.length <= max && /^[A-Za-z0-9$][A-Za-z0-9 .+_$-]*$/.test(t) && !/\.[a-z]{2,}\b|^unknown$/i.test(t) && !ADDRESS.test(t) ? t : undefined
}

/** This wallet's EVM addresses and the token names Desktop has: reviewed
 *  tokens, the token catalog, and the portfolio (minus tokens the user hid). */
export function walletBook(chainId: number, deviceId?: string) {
  const balances = deviceId ? getCachedBalances(deviceId)?.balances ?? [] : []
  const own = balances.map((b) => b.address?.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a ?? ''))
  const held = new Map<string, TokenBalance>()
  for (const t of balances.flatMap((b) => b.tokens ?? [])) {
    const caip = t.caip?.toLowerCase() ?? ''
    if (caip.startsWith(`eip155:${chainId}/erc20:`) && Number.isInteger(t.decimals) && !held.has(caip.slice(-42)) && getTokenVisibility(caip) !== 'hidden') held.set(caip.slice(-42), t)
  }
  const tokenOf = (address: string): EvmToken | undefined => {
    const a = address.toLowerCase()
    const known = REVIEWED_EVM_TOKENS[`${chainId}:${a}`] ?? evmTokenIdentity(chainId, a)
    const t = known && tokenText(known.symbol, 12) ? known : held.get(a)
    const symbol = tokenText(t?.symbol, 12)
    return symbol && t ? { symbol, decimals: t.decimals! } : undefined
  }
  const nameOf = (address: string) =>
    findEvmNameRecord(chainId, address)?.name ?? tokenText(evmContractIdentity(chainId, address), 32)
      ?? tokenText(held.get(address.toLowerCase())?.name, 32) ?? tokenOf(address)?.symbol
  return { own, tokenOf, nameOf }
}

/** Base units as a short decimal: whole part grouped, at most 6 significant fraction digits. */
function amount(raw: bigint, decimals: number): string {
  const [whole, frac = ''] = utils.formatUnits(raw, decimals).split('.')
  const lead = whole === '0' ? Math.max(frac.search(/[1-9]/), 0) : 0
  const f = frac.slice(0, lead + 6).replace(/0+$/, '')
  return `${BigInt(whole).toLocaleString('en-US')}${f ? `.${f}` : ''}`
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'
const topicAddress = (t?: string) => (t && /^0x0{24}[0-9a-fA-F]{40}$/.test(t) ? `0x${t.slice(26)}`.toLowerCase() : '')

/** What the receipt's Transfer logs moved in and out of `own`, net per token.
 *  A token Desktop cannot name is left out. */
export function tokenMoves(logs: EvmLog[], own: Set<string>, tokenOf: (address: string) => EvmToken | undefined): TxDetailLine[] {
  const net = new Map<string, bigint>()
  for (const log of logs) {
    const [sig, a, b, c] = log.topics.map((t) => t.toLowerCase())
    let from: string, to: string, n: bigint, key: string
    if (sig === TRANSFER && log.topics.length === 3 && /^0x[0-9a-fA-F]{64}$/.test(log.data)) {
      [from, to, n, key] = [topicAddress(a), topicAddress(b), BigInt(log.data), log.address.toLowerCase()]
    } else if (sig === TRANSFER && log.topics.length === 4) {
      [from, to, n, key] = [topicAddress(a), topicAddress(b), 1n, 'nft']
    } else if (sig === TRANSFER_SINGLE && log.topics.length === 4 && /^0x[0-9a-fA-F]{128}$/.test(log.data)) {
      [from, to, n, key] = [topicAddress(b), topicAddress(c), BigInt(`0x${log.data.slice(66)}`), 'nft']
    } else continue
    const sign = (own.has(to) ? 1n : 0n) - (own.has(from) ? 1n : 0n)
    if (sign) net.set(key, (net.get(key) ?? 0n) + sign * n)
  }
  const lines: TxDetailLine[] = []
  for (const [key, n] of net) {
    if (n === 0n) continue
    const abs = n < 0n ? -n : n
    const token = key === 'nft' ? undefined : tokenOf(key)
    const value = key === 'nft' ? `${abs} NFT${abs > 1n ? 's' : ''}` : token && `${amount(abs, token.decimals)} ${token.symbol}`
    if (value) lines.push({ label: n > 0n ? 'Received' : 'Sent', value })
  }
  return lines
}

const ACTIONS: Record<string, string> = {
  transferFrom: 'Transfer', 'deposit (Wrap ETH)': 'Wrap', 'withdraw (Unwrap WETH)': 'Unwrap',
  'safeTransferFrom (NFT)': 'Transfer', 'setApprovalForAll (NFT)': 'Approve all',
}
/** A method name in plain words: "claimAndStake" -> "Claim and stake". */
function actionText(method: string, name?: string): string {
  if (ACTIONS[method]) return ACTIONS[method]
  if (/swap|sell/i.test(method)) return 'Swap'
  let m = method.replace(/\s*\(.*\)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  if (name && m.toLowerCase().startsWith(`${name.toLowerCase()} `)) m = m.slice(name.length + 1)
  return m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()
}

const SHOWN = { native: 'Shown on your KeepKey', certified: 'Shown on your KeepKey', erc7730: 'Shown on your KeepKey', provider: 'Signed as raw data on your KeepKey', blind: 'Signed as raw data on your KeepKey' } as const

export interface TxDetailsInput {
  record: SignedTxReview | null
  tx?: EvmTxFacts
  receipt?: EvmReceiptFacts
  chainId: number
  /** This wallet's addresses, lowercased. */
  own: Set<string>
  tokenOf: (address: string) => EvmToken | undefined
  nameOf: (address: string) => string | undefined
}

/** The Details rows for a finished transaction, or null when Desktop has nothing to say. */
export async function txDetails({ record, tx, receipt, chainId, own, tokenOf, nameOf }: TxDetailsInput): Promise<TxDetailLine[] | null> {
  const lines: TxDetailLine[] = []
  const to = tx?.to?.toLowerCase()
  if (to && tx?.data && tx.data !== '0x') {
    const decoded = await decodeCalldata(to, tx.data, chainId, tx.value)
    const dapp = decoded && decoded.source !== 'none' ? decoded.dappName : 'Unknown'
    const name = dapp === 'ERC-20' || dapp === 'NFT' ? tokenOf(to)?.symbol ?? (dapp === 'NFT' ? 'NFT' : undefined)
      : dapp !== 'Unknown' ? dapp : nameOf(to) ?? tokenText(record?.contract, 32)
    const method = knownMethod(decoded) ?? record?.call
    const action = method ? actionText(method, name) : name && 'Contract call'
    if (action) lines.push({ label: 'Action', value: name ? `${name} · ${action}` : action })
  }
  const wei = /^(0x[0-9a-fA-F]+|\d+)$/.test(tx?.value ?? '') ? BigInt(tx!.value!) : 0n
  const symbol = evmChainLabel(chainId)?.symbol
  const from = tx?.from?.toLowerCase() ?? ''
  if (wei > 0n && symbol && own.has(from) !== own.has(to ?? '')) {
    lines.push({ label: own.has(from) ? 'Sent' : 'Received', value: `${amount(wei, 18)} ${symbol}` })
  }
  if (receipt) {
    lines.push(...tokenMoves(receipt.logs, own, tokenOf))
    lines.push({ label: 'Result', value: receipt.status === 1 ? 'Succeeded' : 'Failed' })
  }
  if (record) {
    lines.push({ label: 'Signing', value: SHOWN[record.signedHow] })
    const app = plain(record.appName)
    if (app) lines.push({ label: 'Requested by', value: app })
    const by = record.signedHow === 'provider' ? plain(record.provider)
      : record.signedHow === 'certified' ? 'KeepKey (certified)' : record.signedHow === 'erc7730' ? 'KeepKey ClearSign (ERC-7730)' : ''
    if (by) lines.push({ label: 'Described by', value: by })
  }
  const shown = lines.filter((l) => !ADDRESS.test(l.value))
  return shown.length ? shown : null
}
