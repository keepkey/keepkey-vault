/**
 * Safe multisig, read side. Owners, threshold, nonce and version come from
 * the chain (through Pioneer). Safe's Transaction Service only answers which
 * Safes this key owns and which transactions are proposed; every proposal's
 * hash and confirmations are re-derived here (safe-core.ts), so a tampered or
 * spoofed proposal shows as a mismatch instead of being shown as real.
 */
import { ethers } from 'ethers'
import { ethCall } from './evm-rpc'
import { decodeCalldata } from './calldata-decoder'
import { safeTxHash, checkConfirmation, approvedHashCall, SAFE_READS, decodeSafeRead, type SafeTxFields } from './safe-core'
import type { SafeInfo, PendingSafeTx } from '../shared/types'

const SAFE_CONFIG_URL = 'https://safe-config.safe.global/api/v1/chains/?limit=200'
const CONFIG_TTL_MS = 60 * 60 * 1000

let chainsCache: { at: number; services: Map<number, string> } | null = null

/** chainId -> Transaction Service base URL, from Safe's own chain config. */
export async function safeTxServices(): Promise<Map<number, string>> {
  if (chainsCache && Date.now() - chainsCache.at < CONFIG_TTL_MS) return chainsCache.services
  const resp = await fetch(SAFE_CONFIG_URL, { signal: AbortSignal.timeout(10_000) })
  if (!resp.ok) throw new Error(`Safe chain config HTTP ${resp.status}`)
  const body = await resp.json() as { results?: { chainId: string; transactionService?: string }[] }
  const services = new Map<number, string>()
  for (const c of body.results ?? []) {
    if (c.transactionService && /^https:\/\//.test(c.transactionService)) services.set(Number(c.chainId), c.transactionService.replace(/\/+$/, ''))
  }
  chainsCache = { at: Date.now(), services }
  return services
}

/** Every page of a list from the Transaction Service, never following a link off its host. */
async function txServiceAll(chainId: number, path: string): Promise<any[]> {
  const base = (await safeTxServices()).get(chainId)
  if (!base) throw new Error(`Safe does not support chain ${chainId}`)
  const results: any[] = []
  let url: string | null = `${base}/api${path}`
  // ponytail: 20-page cap; raise it if a Safe ever has more owners' Safes or pending txs than that.
  for (let page = 0; url && page < 20; page++) {
    if (!url.startsWith(`${base}/`)) throw new Error('Safe Transaction Service sent a page link to another host')
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!resp.ok) throw new Error(`Safe Transaction Service HTTP ${resp.status} for ${path}`)
    const body = await resp.json() as { results?: any[]; next?: string | null }
    results.push(...(body.results ?? []))
    url = body.next ?? null
  }
  return results
}

/** Safes on this chain that list `owner` as an owner (discovery only). */
export async function listOwnedSafes(chainId: number, owner: string): Promise<string[]> {
  const safes = await txServiceAll(chainId, `/v2/owners/${ethers.utils.getAddress(owner)}/safes/`)
  return safes.map((s: { address: string }) => ethers.utils.getAddress(s.address))
}

/** The Safe's configuration as the chain reports it. */
export async function readSafe(chainId: number, address: string): Promise<SafeInfo> {
  const safe = ethers.utils.getAddress(address)
  const source = `eip155:${chainId}`
  const [owners, threshold, nonce, version] = await Promise.all([
    ethCall(source, safe, SAFE_READS.getOwners).then(r => decodeSafeRead('getOwners', r) as string[]),
    ethCall(source, safe, SAFE_READS.getThreshold).then(r => Number(decodeSafeRead('getThreshold', r))),
    ethCall(source, safe, SAFE_READS.nonce).then(r => Number(decodeSafeRead('nonce', r))),
    ethCall(source, safe, SAFE_READS.VERSION).then(r => String(decodeSafeRead('VERSION', r))),
  ])
  return { chainId, address: safe, owners: owners.map(o => ethers.utils.getAddress(o)), threshold, nonce, version }
}

/** Not-yet-executed proposals from the current nonce, oldest first. */
export async function pendingSafeTxs(info: SafeInfo): Promise<PendingSafeTx[]> {
  const results = await txServiceAll(info.chainId, `/v2/safes/${info.address}/multisig-transactions/?executed=false&nonce__gte=${info.nonce}&ordering=nonce&limit=20`)
  const source = `eip155:${info.chainId}`
  const txs: PendingSafeTx[] = []
  for (const t of results) {
    const fields: SafeTxFields = {
      to: ethers.utils.getAddress(t.to), value: String(t.value), data: t.data ?? null, operation: Number(t.operation),
      safeTxGas: String(t.safeTxGas), baseGas: String(t.baseGas), gasPrice: String(t.gasPrice),
      gasToken: ethers.utils.getAddress(t.gasToken), refundReceiver: ethers.utils.getAddress(t.refundReceiver), nonce: String(t.nonce),
    }
    const hash = safeTxHash(info.chainId, info.address, info.version, fields)
    // Each confirmation is checked on its own against the owner it names.
    const verified: string[] = [], unverified: string[] = []
    for (const c of (t.confirmations ?? []) as { owner: string; signature?: string }[]) {
      let result = checkConfirmation(hash, info.owners, c)
      if (result === 'approved-hash') {
        const approved = await ethCall(source, info.address, approvedHashCall(c.owner, hash))
        result = BigInt(decodeSafeRead('approvedHashes', approved).toString()) !== 0n ? 'verified' : 'unverified'
      }
      const owner = ethers.utils.getAddress(c.owner)
      const list = result === 'verified' ? verified : unverified
      if (!list.includes(owner)) list.push(owner)
    }
    const decoded = fields.data && fields.data !== '0x'
      ? await decodeCalldata(fields.to, fields.data, info.chainId, fields.value).catch(() => null)
      : null
    txs.push({
      ...fields, safeTxHash: hash, hashMatches: String(t.safeTxHash).toLowerCase() === hash.toLowerCase(),
      confirmedBy: verified, unverifiedConfirmations: unverified.filter(a => !verified.includes(a)),
      delegateCall: fields.operation === 1, decoded, submittedAt: t.submissionDate ?? null,
    })
  }
  return txs
}
