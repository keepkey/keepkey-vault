/**
 * Solana SPL token (mint) metadata resolver.
 *
 * EVM custom tokens read name/symbol/decimals straight off the ERC-20 contract
 * via eth_call (see evm-rpc.ts `getTokenMetadata`). Solana has no equivalent
 * on-mint name/symbol — that lives in a separate Metaplex metadata account
 * whose PDA derivation needs ed25519 curve math we don't bundle. So we:
 *
 *   1. Validate the mint and read authoritative `decimals` from the chain via
 *      `getAccountInfo` (jsonParsed). This also rejects non-mint addresses, so
 *      a user can't add an arbitrary base58 string as a "token".
 *   2. Enrich human-facing name/symbol/icon from Jupiter's token index — the
 *      de-facto SPL registry. If Jupiter lists it, the aggregators (LiFi /
 *      ShapeShift) can route it, so this is also a soft swappability signal.
 *   3. Fall back to Token-2022 inline metadata, then to a truncated mint, so a
 *      brand-new token still resolves with correct decimals even if Jupiter
 *      hasn't indexed it yet.
 *
 * Pure transport (fetch only) — no DB/settings import — so the caller passes
 * the configured RPC endpoint.
 */

import { DEFAULT_SOLANA_RPC_ENDPOINT } from './solana-alt'

/** Base58 mint address: 32–44 chars, base58 alphabet (no 0, O, I, l), not 0x. */
export const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Token program owners that produce a `mint` account jsonParsed type. */
const SPL_TOKEN_PROGRAMS = new Set<string>([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
])

export interface SolanaTokenMeta {
  symbol: string
  name: string
  decimals: number
  iconUrl?: string
}

/** On-chain validation + decimals. Returns null when the address isn't a real
 *  SPL/Token-2022 mint. Surfaces Token-2022 inline metadata when present. */
async function getMintInfo(endpoint: string, mint: string): Promise<{
  decimals: number
  inlineName?: string
  inlineSymbol?: string
} | null> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return null
  const body = await res.json() as {
    result?: { value?: { owner?: string; data?: { parsed?: { type?: string; info?: any } } } }
  }
  const value = body?.result?.value
  if (!value || !value.owner || !SPL_TOKEN_PROGRAMS.has(value.owner)) return null
  const parsed = value.data?.parsed
  if (!parsed || parsed.type !== 'mint') return null
  const decimals = parsed.info?.decimals
  if (typeof decimals !== 'number') return null

  let inlineName: string | undefined
  let inlineSymbol: string | undefined
  const exts = parsed.info?.extensions
  if (Array.isArray(exts)) {
    const md = exts.find((x: any) => x?.extension === 'tokenMetadata')?.state
    if (md) { inlineName = md.name; inlineSymbol = md.symbol }
  }
  return { decimals, inlineName, inlineSymbol }
}

/** Best-effort name/symbol/icon (+ decimals) from Jupiter's token search. */
async function getJupiterMeta(mint: string): Promise<{
  symbol?: string; name?: string; decimals?: number; icon?: string
} | null> {
  try {
    const res = await fetch(
      `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) return null
    const arr = await res.json() as Array<{
      id?: string; symbol?: string; name?: string; decimals?: number; icon?: string
    }>
    if (!Array.isArray(arr)) return null
    const hit = arr.find(a => a?.id === mint)
    if (!hit) return null
    return { symbol: hit.symbol, name: hit.name, decimals: hit.decimals, icon: hit.icon }
  } catch {
    return null
  }
}

/** Resolve an SPL mint to display metadata. Returns null when the address is
 *  not a valid mint (bad format or not a token account on-chain). */
export async function resolveSolanaMint(
  mint: string,
  endpoint: string = DEFAULT_SOLANA_RPC_ENDPOINT,
): Promise<SolanaTokenMeta | null> {
  const addr = (mint || '').trim()
  if (!SOLANA_MINT_RE.test(addr)) return null

  const onChain = await getMintInfo(endpoint, addr).catch(() => null)
  if (!onChain) return null  // not a real mint — refuse

  const jup = await getJupiterMeta(addr)
  const symbol = (jup?.symbol || onChain.inlineSymbol || `${addr.slice(0, 4)}…${addr.slice(-4)}`).trim()
  const name = (jup?.name || onChain.inlineName || 'SPL Token').trim()
  return {
    symbol: symbol || `${addr.slice(0, 4)}…${addr.slice(-4)}`,
    name: name || 'SPL Token',
    decimals: onChain.decimals,  // chain is authoritative over Jupiter
    iconUrl: jup?.icon,
  }
}
