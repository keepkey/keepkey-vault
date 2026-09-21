import { createHash } from 'node:crypto'
import { SigningKey } from '@ethersproject/signing-key'
import bs58 from 'bs58'
import { createResilientSolanaAccountFetcher, solanaRpcEndpoints, type SolanaRpcConfig } from './solana-rpc'
import { ARG_TOKEN_AMOUNT, CERTIFIED_SOLANA_CATALOG, type SolanaSchemaSpec } from '../../src/bun/solana-certified-schema'
import type { SolanaInstruction } from '../../src/bun/solana-tx'

export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const identityCache = new Map<string, { token: NonNullable<ReturnType<typeof inspectPumpToken>>; expires: number }>()
const pendingIdentity = new Map<string, Promise<ReturnType<typeof inspectPumpToken>>>()
/** Token identities the reviewed catalog pins, by mint. A signed token
 * definition is not bound to a schema, so a pinned mint is held to its pin
 * whichever entry asks for it (a Pump buy of that mint included). */
const PINNED_TOKENS = new Map(Object.values(CERTIFIED_SOLANA_CATALOG).flatMap(spec => spec.token ? [[spec.token.mint, spec.token] as const] : []))

/** Version 2 is a compact-review eligibility attestation, not merely a label.
 * The certified delegate checks the actual mint owner, scale and immutable
 * on-chain symbol, and excludes extensions that could change transfer amounts
 * or invoke other programs. No dapp text or off-chain URI is trusted/fetched.
 * Firmware binds the token program and mint again against the signed buy.
 */
export function inspectPumpToken(value: any, mint: string) {
  if (value === null) return undefined
  if (!value || value.executable || value.owner !== TOKEN_2022
    || value.data?.program !== 'spl-token-2022' || value.data?.parsed?.type !== 'mint') return undefined
  const info = value.data.parsed.info
  if (!info?.isInitialized || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 9) return undefined
  const extensions = info.extensions
  if (!Array.isArray(extensions) || extensions.length !== 2) return undefined
  const pointer = extensions.find(e => e.extension === 'metadataPointer')?.state
  const metadata = extensions.find(e => e.extension === 'tokenMetadata')?.state
  if (!pointer || pointer.authority !== null || pointer.metadataAddress !== mint
    || !metadata || metadata.mint !== mint || metadata.updateAuthority !== null
    || typeof metadata.symbol !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/.test(metadata.symbol)) return undefined
  return { mint, tokenProgram: TOKEN_2022, symbol: metadata.symbol as string, decimals: info.decimals as number }
}

export function pumpTokenPreimage(token: { mint: string; tokenProgram: string; symbol: string; decimals: number }): Buffer {
  const decimals = Buffer.alloc(4); decimals.writeUInt32LE(token.decimals)
  return Buffer.concat([Buffer.from('KeepKeySolanaTokenDef/2'), Buffer.from(bs58.decode(token.mint)),
    Buffer.from(bs58.decode(token.tokenProgram)), decimals, Buffer.from(token.symbol, 'ascii')])
}

async function resolvePumpToken(env: SolanaRpcConfig, mint: string, fetcher: typeof fetch) {
  const key = JSON.stringify([solanaRpcEndpoints(env), mint])
  const cached = identityCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.token
  identityCache.delete(key)
  if (pendingIdentity.has(key)) return pendingIdentity.get(key)!
  const pending = (async () => {
    const [token] = await createResilientSolanaAccountFetcher(env, 'jsonParsed', inspectPumpToken, fetcher)([mint])
    // One provider answers (failover, not quorum). For a pinned mint, refuse
    // and do not cache an answer that differs from the reviewed values.
    const pin = PINNED_TOKENS.get(mint)
    if (token && pin && (token.tokenProgram !== pin.tokenProgram || token.decimals !== pin.decimals || token.symbol !== pin.symbol)) {
      console.warn('[clearsign] Solana token identity contradicts the reviewed catalog pin; not certified')
      return undefined
    }
    // Only immutable identities with no transfer-changing or close-account
    // extensions are eligible. Never cache errors or caller-provided labels.
    if (token) {
      if (identityCache.size >= 256) identityCache.delete(identityCache.keys().next().value!)
      identityCache.set(key, { token, expires: Date.now() + 86_400_000 })
    }
    return token
  })()
  pendingIdentity.set(key, pending)
  try { return await pending } finally { pendingIdentity.delete(key) }
}

export async function certifyPumpToken(env: SolanaRpcConfig, mint: string, delegateKey: string, fetcher: typeof fetch = fetch) {
  const token = await resolvePumpToken(env, mint, fetcher)
  if (!token) return undefined
  const digest = createHash('sha256').update(pumpTokenPreimage(token)).digest('hex')
  const signed = new SigningKey(`0x${delegateKey}`).signDigest(`0x${digest}`)
  return { ...token, signature: signed.r.slice(2) + signed.s.slice(2), signerKeyId: 0x80 }
}

/** SolanaSignTx.token_info max_count in firmware. */
const MAX_TOKEN_INFO = 4

/**
 * Attest the token identity of every mint the matched schema displays an
 * amount in: Pump buys (instruction account 3) and each v2 TOKEN_AMOUNT arg
 * (instruction account `mintAccount`). `accountKeys` is the transaction's
 * full account list (static, then resolved lookup accounts), which is what
 * firmware indexes. A mint that is not eligible simply gets no token info;
 * firmware then shows the raw amount and the full mint address. An entry
 * that pins its token (`spec.token`) certifies no other mint.
 */
export async function certifySchemaTokens(
  env: SolanaRpcConfig,
  catalogKey: string,
  spec: SolanaSchemaSpec,
  instruction: SolanaInstruction,
  accountKeys: Uint8Array[],
  delegateKey: string,
  fetcher: typeof fetch = fetch,
) {
  const mintAccounts = catalogKey === 'pumpAmmBuy'
    ? [3]
    : (spec.args || []).filter(arg => arg.type === ARG_TOKEN_AMOUNT).map(arg => arg.mintAccount!)
  const mints = [...new Set(mintAccounts.map(index => accountKeys[instruction.accountIndices[index]])
    .filter(Boolean).map(key => bs58.encode(key)))]
  if (!mints.length) return {}
  const tokenInfo = []
  for (const mint of mints.slice(0, MAX_TOKEN_INFO)) {
    if (spec.token && mint !== spec.token.mint) continue
    const token = await certifyPumpToken(env, mint, delegateKey, fetcher)
    if (token) tokenInfo.push(token)
  }
  return {
    ...(tokenInfo.length ? { tokenInfo } : {}),
    tokenMetadataStatus: tokenInfo.length === mints.length ? 'certified-on-chain' : 'detailed-review-required',
  }
}
