/**
 * The original of a SafeMessage, for the approval card. Safe{Wallet} asks each
 * owner to sign SafeMessage { message: hashMessage(text) } or the EIP-712 hash
 * of a typed document, so the request itself never carries what the Safe
 * approves. Safe's Transaction Service keeps the original under the
 * SafeMessage's own hash once the first owner has signed. It is read here
 * before approval and kept only when it hashes to the signed value, so the
 * service cannot put words in it. Read-only, one GET, never blocks signing.
 */
import { utils } from 'ethers'
import type { SigningRequestInfo } from '../shared/types'
import { decodeEIP712 } from './eip712-decoder'
import { normalizeEvmChainId, recognizedTypedDataSpender } from './evm-signing-preview'

const SAFE_CONFIG_URL = 'https://safe-config.safe.global/api/v1/chains/?limit=200'
const CONFIG_TTL_MS = 60 * 60 * 1000
/** The whole lookup, chain config included: the card waits for it. */
const LOOKUP_MS = 5_000

let chainsCache: { at: number; services: Map<number, string> } | null = null

/** chainId -> Transaction Service base URL, from Safe's own chain config (https only). */
async function txServiceBase(chainId: number, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
  if (!chainsCache || Date.now() - chainsCache.at >= CONFIG_TTL_MS) {
    const resp = await fetchImpl(SAFE_CONFIG_URL, { signal })
    if (!resp.ok) throw new Error(`Safe chain config HTTP ${resp.status}`)
    const body = await resp.json() as { results?: { chainId: string; transactionService?: string }[] }
    const services = new Map<number, string>()
    for (const c of body.results ?? []) {
      if (c.transactionService && /^https:\/\//.test(c.transactionService)) services.set(Number(c.chainId), c.transactionService.replace(/\/+$/, ''))
    }
    chainsCache = { at: Date.now(), services }
  }
  return chainsCache.services.get(chainId)
}

export async function attachSafeMessagePreimage(info: SigningRequestInfo, fetchImpl: typeof fetch = fetch, timeoutMs = LOOKUP_MS): Promise<void> {
  const d = info.typedDataDecoded
  if (d?.primaryType !== 'SafeMessage' || !d.hashes?.messageHash) return
  const signed = String(d.fields.find((x) => x.label === 'Message')?.raw ?? '').toLowerCase()
  // Readable bytes are described as they are; only a hash stands for something else.
  if (!/^0x[0-9a-f]{64}$/.test(signed)) return
  const chainId = normalizeEvmChainId(d.domain.chainId ?? info.chainId)
  if (!chainId) return
  // The id the service files it under: the SafeMessage's own EIP-712 digest.
  const safeMessageHash = utils.keccak256(utils.concat(['0x1901', d.hashes.domainHash, d.hashes.messageHash]))
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const base = await txServiceBase(chainId, fetchImpl, signal)
    if (!base) return
    const resp = await fetchImpl(`${base}/api/v1/messages/${safeMessageHash}/`, { signal })
    if (resp.status === 404) { info.safeMessageOriginal = { status: 'not-found' }; return }
    if (!resp.ok) throw new Error(`Safe Transaction Service HTTP ${resp.status}`)
    const original = (await resp.json() as { message?: unknown }).message
    // Safe{Wallet}'s own rule: text is hashMessage(UTF-8), a document its EIP-712 hash.
    if (typeof original === 'string') {
      info.safeMessageOriginal = utils.hashMessage(original).toLowerCase() === signed ? { status: 'text', text: original } : { status: 'mismatch' }
      return
    }
    const doc = original as { domain?: any; types?: Record<string, any>; primaryType?: string; message?: any } | null
    let hash: string | undefined
    try {
      const { EIP712Domain: _domain, ...types } = doc?.types ?? {}
      // The hash takes the root type from `types` and ignores primaryType; the
      // description reads the message as primaryType. They must be the same type.
      if (utils._TypedDataEncoder.from(types).primaryType === doc?.primaryType) {
        hash = utils._TypedDataEncoder.hash(doc?.domain ?? {}, types, doc?.message ?? {}).toLowerCase()
      }
    } catch { /* not a typed document */ }
    if (hash !== signed) { info.safeMessageOriginal = { status: 'mismatch' }; return }
    const decoded = decodeEIP712(doc, d.domain.verifyingContract)
    info.safeMessageOriginal = { status: 'typed', decoded, recognizedSpender: recognizedTypedDataSpender(decoded, normalizeEvmChainId(decoded.domain.chainId)) }
  } catch (e) {
    console.warn('[safe-message] original not read:', e instanceof Error ? e.message : e)
    info.safeMessageOriginal = { status: 'failed' }
  }
}
