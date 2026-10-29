/**
 * ClearSign review of Safe requests: Desktop's own Safe panel gets the same
 * risk lines and coverage record a dapp's request gets, and a 32-byte value
 * Safe would count as an owner's confirmation (a personal_sign of it, or
 * approveHash on chain) is named for the transaction it confirms.
 *
 * All of it is this computer's advice. For a personal_sign or an approveHash
 * the KeepKey sees only the 32 bytes, never the SafeTx behind them.
 */
import { ethers } from 'ethers'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { evmChainLabel } from '../shared/chains'
import { evmNativeValue } from '../shared/evmFeePreview'
import { deviceErrorMessage } from '../shared/device-error'
import type { ClearSignObservationDraft, ClearSignObservationOutcome, PendingSafeTx, SafeHashLink, SafeInfo, SigningRequestInfo } from '../shared/types'
import { decodeEIP712 } from './eip712-decoder'
import { observeEvmTypedData } from './clearsign-observation'
import { safeTypedData, safeSignature, checkConfirmation, type SafeTxFields } from './safe-core'

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The document the KeepKey signs for this SafeTx, and the risk lines a dapp's request to sign it gets. */
export function reviewSafeTx(info: SafeInfo, tx: SafeTxFields, ctx: { from?: string; firmwareVersion?: string }) {
  const typedData = safeTypedData(info.chainId, info.address, info.version, tx)
  const risk = assessSigningRisk({
    id: 'safe-panel', method: '/eth/sign-typed-data', appName: 'KeepKey Desktop', chain: 'eth',
    from: ctx.from, chainId: info.chainId, firmwareVersion: ctx.firmwareVersion, typedDataDecoded: decodeEIP712(typedData),
  })
  return { typedData, risk }
}

export interface ObservationSink {
  /** undefined = not recorded (hidden wallets). */
  record: (draft: ClearSignObservationDraft) => string | undefined
  finalize: (id: string, outcome: Exclude<ClearSignObservationOutcome, 'pending'>, errorClass?: string) => void
}

/** One device signature, recorded in ClearSign coverage the way the dapp paths record theirs. */
export async function observedSign<T>(draft: ClearSignObservationDraft, sink: ObservationSink, sign: () => Promise<T>): Promise<T> {
  const id = sink.record(draft)
  try {
    const result = await sign()
    if (id) sink.finalize(id, 'signed')
    return result
  } catch (cause) {
    if (id) {
      const rejected = /reject|cancel|denied/i.test(deviceErrorMessage(cause))
      sink.finalize(id, rejected ? 'rejected' : 'failed', rejected ? 'user-rejected' : 'device-or-transport')
    }
    throw cause
  }
}

export interface SafeConfirmDeps extends ObservationSink {
  readSafe: (chainId: number, address: string) => Promise<SafeInfo>
  pendingSafeTxs: (info: SafeInfo) => Promise<PendingSafeTx[]>
  sign: (typedData: ReturnType<typeof safeTypedData>) => Promise<any>
  postConfirmation: (chainId: number, safeTxHash: string, signature: string) => Promise<void>
}

/** The panel's "Sign on KeepKey": the proposal re-read and reviewed, signed, checked and posted. */
export async function confirmSafeTx(params: { chainId: number; address: string; safeTxHash: string }, me: string, firmwareVersion: string, deps: SafeConfirmDeps) {
  // Everything is re-read here; nothing the screen sent is trusted except which proposal.
  const info = await deps.readSafe(params.chainId, params.address)
  if (!info.owners.some(o => same(o, me))) throw new Error(`${me} is not an owner of this Safe`)
  const tx = (await deps.pendingSafeTxs(info)).find(t => same(t.safeTxHash, params.safeTxHash))
  if (!tx) throw new Error('This proposal is no longer pending, or its fields do not produce that hash')
  if (!tx.hashMatches) throw new Error("Safe's service published a different hash for this proposal. Do not sign it.")
  const { typedData, risk } = reviewSafeTx(info, tx, { from: me, firmwareVersion })
  const draft = observeEvmTypedData({ typedData, chainId: info.chainId, hostDecoded: true })
  const result = await observedSign(draft, deps, () => deps.sign(typedData))
  const signature = safeSignature(typeof result === 'string' ? result : result?.signature)
  if (checkConfirmation(tx.safeTxHash, info.owners, { owner: me, signature }) !== 'verified') {
    throw new Error('The KeepKey signature does not recover to your owner address for this hash; it was not sent')
  }
  await deps.postConfirmation(info.chainId, tx.safeTxHash, signature)
  return { signature, risk }
}

// ── A 32-byte confirmation, linked to its SafeTx ──────────────────────

const APPROVE_HASH = /^0xd4d9bdcd([0-9a-f]{64})$/

/** The 32 bytes Safe would count as this owner's confirmation, or null. */
export function confirmationHash(req: SigningRequestInfo): string | null {
  if (req.method === '/eth/sign') {
    const raw = String(req.ethMessageDecoded?.messageRaw ?? req.data ?? '')
    return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : null
  }
  if (req.method === '/eth/sign-transaction') {
    const m = APPROVE_HASH.exec(String(req.data ?? '').toLowerCase())
    return m ? `0x${m[1]}` : null
  }
  return null
}

export interface SafeLookupDeps {
  /** Chains to search when the request names none (a REST personal_sign carries no chain). */
  chains: () => Promise<number[]>
  /** Safes that may list `owner`; each is re-read before it counts. [] where Safe has no service. */
  ownedSafes: (chainId: number, owner: string) => Promise<string[]>
  readSafe: (chainId: number, address: string) => Promise<SafeInfo>
  pendingSafeTxs: (info: SafeInfo) => Promise<PendingSafeTx[]>
}

function summarize(info: SafeInfo, tx: PendingSafeTx): string {
  const value = BigInt(tx.value || '0') > 0n ? evmNativeValue(tx.value, info.chainId) : null
  const to = same(tx.to, info.address) ? `the Safe itself (${tx.to})` : tx.to
  if (!tx.data || tx.data === '0x') return value ? `sends ${value} to ${to}` : `calls ${to} with no data and no value`
  const method = tx.decoded?.method && tx.decoded.method !== 'Unknown' ? `${tx.decoded.method} on ` : ''
  return `${tx.operation === 1 ? 'delegatecall' : 'call'} to ${method}${to}${value ? `, sending ${value}` : ''}`
}

function matched(info: SafeInfo, tx: PendingSafeTx): SafeHashLink {
  return {
    status: 'match', chainId: info.chainId, chainName: evmChainLabel(info.chainId)?.name ?? `chain ${info.chainId}`,
    safe: info.address, nonce: tx.nonce, summary: summarize(info, tx),
    safeTx: decodeEIP712(safeTypedData(info.chainId, info.address, info.version, tx)),
  }
}

/** The hash among one Safe's pending transactions, each hash recomputed from its fields here. */
async function findIn(info: SafeInfo, hash: string, deps: SafeLookupDeps): Promise<SafeHashLink> {
  const tx = (await deps.pendingSafeTxs(info)).find(t => same(t.safeTxHash, hash))
  return tx ? matched(info, tx) : { status: 'no-match', safes: [info.address] }
}

async function lookup(req: SigningRequestInfo, hash: string, owner: string, deps: SafeLookupDeps): Promise<SafeHashLink | undefined> {
  if (req.method === '/eth/sign-transaction') {
    // approveHash is called on the Safe itself, and only an owner's call does anything.
    if (!req.to || !req.chainId) return undefined
    const info = await deps.readSafe(Number(req.chainId), req.to)
    return info.owners.some(o => same(o, owner)) ? findIn(info, hash, deps) : undefined
  }
  const chainIds = req.chainId ? [Number(req.chainId)] : await deps.chains()
  const results = await Promise.allSettled(chainIds.map(async chainId => {
    const found: SafeHashLink[] = []
    for (const address of await deps.ownedSafes(chainId, owner)) {
      const info = await deps.readSafe(chainId, address)
      // The service only suggests Safes; one whose contract does not list this owner is not theirs.
      if (info.owners.some(o => same(o, owner))) found.push(await findIn(info, hash, deps))
    }
    return found
  }))
  const links = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
  const match = links.find(l => l.status === 'match')
  if (match) return match
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
  return links.length ? { status: 'no-match', safes: links.flatMap(l => l.status === 'no-match' ? l.safes : []) } : undefined
}

/**
 * What this request's 32-byte confirmation approves, if the signer owns a
 * Safe. Never throws: a lookup that fails or runs out of time is reported as
 * unchecked, so the card says so instead of falling back to a generic line.
 */
export async function safeHashLink(req: SigningRequestInfo, deps: SafeLookupDeps, timeoutMs = 12_000): Promise<SafeHashLink | undefined> {
  const hash = confirmationHash(req)
  const owner = req.from
  if (!hash || !owner || !ethers.utils.isAddress(owner)) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      lookup(req, hash, owner, deps),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs) }),
    ])
  } catch (e) {
    return { status: 'unchecked', error: deviceErrorMessage(e) }
  } finally {
    clearTimeout(timer)
  }
}
