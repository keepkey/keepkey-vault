/**
 * Discovery layer for the asset picker.
 *
 * Merges three things into one unified `AssetEntry[]`, keyed by CAIP-19:
 *   1. `pioneer-discovery`'s generatedAssetData.json — the universe (~30k entries)
 *   2. Pioneer's GetAvailableAssets cached list — the swappable subset
 *   3. The user's per-chain balances — for "do I hold this?"
 *
 * Search index is built lazily on first call so the 30k pre-process doesn't
 * happen unless the dialog actually opens. After that it's cached for the
 * session.
 */
import type { SwapAsset, ChainBalance } from './types'
import { CHAINS } from './chains'
import { COIN_MAP_LONG } from '@pioneer-platform/pioneer-coins'
import { assessAvailability, normalizeChainCaip2, CHAIN_CAIP2_ALIASES, type AvailabilityAssessment } from './swap-support-matrix'
// Static-imported chains metadata — ~218KB, used synchronously by
// networkDisplayName + chainMetaForCaip2 from both bun and frontend. Vite
// inlines as a JSON module. The bigger generatedAssetData.json (~10MB) stays
// lazy because the picker is the only consumer and the user may never open it.
import discoveryChainsJson from '@pioneer-platform/pioneer-discovery/lib/chains.json'

/** Vault chain id → canonical THORChain short prefix. Built from
 *  `pioneer-coins` `COIN_MAP_LONG` (which maps THOR prefix → chain id) plus
 *  vault-specific overrides where pioneer-coins's chain id disagrees with
 *  vault's, and where it conflates THORChain *chain* prefixes with asset
 *  *symbols* (THORChain memos use GAIA.ATOM, THOR.RUNE — chain prefix wins).
 *  Defined here in shared/ so both the picker (frontend) and synthesis path
 *  can use it without crossing into bun/. */
export const VAULT_CHAIN_TO_THOR: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [thorPrefix, chainId] of Object.entries(COIN_MAP_LONG as Record<string, string>)) {
    if (!out[chainId]) out[chainId] = thorPrefix
  }
  // pioneer-coins uses 'binance' for BSC; vault uses 'bsc'.
  out.bsc = 'BSC'
  // pioneer-coins's first hits put symbols (ATOM, RUNE) under cosmos/thorchain
  // — restore the THORChain *chain* prefix that memos use.
  out.cosmos    = 'GAIA'
  out.thorchain = 'THOR'
  out.mayachain = 'MAYA'
  out.tron      = 'TRON'  // THORChain memos use TRON.TRX (not TRX.TRX)
  return out
})()

/** Shape of one entry inside pioneer-discovery's generatedAssetData.json. */
interface DiscoveryAssetRaw {
  symbol: string
  name?: string
  chainId: string
  assetId: string
  decimals: number
  icon?: string
  type?: string
  isNative?: boolean
  color?: string
}

export interface AssetEntry {
  /** CAIP-19 — primary key */
  caip: string
  symbol: string
  name: string
  /** CAIP-2 chain id */
  chainId: string
  decimals: number
  iconUrl?: string
  /** True for native chain assets, false for tokens. */
  isNative: boolean
  /** Holdings — present iff user has a balance for this asset on the connected chain. */
  balance?: { amount: string; usd: number }
  /** Asset name in THORChain format (BTC.BTC, ETH.USDT-0x...) — only present if Pioneer reports it as swappable. */
  swappableAsset?: string
  /** SwapAsset reference — only present if Pioneer's GetAvailableAssets included it. */
  swappable?: SwapAsset
  availability: AvailabilityAssessment
}

/** Sort key bucket — lower numbers float to the top. */
export type SortBucket = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Compute the bucket each entry falls into. Sub-bucketing native vs token
 *  prevents long-tail tokens from outranking real native assets when the
 *  user types a generic symbol like "BTC". */
export function bucketFor(entry: AssetEntry): SortBucket {
  const usd = entry.balance?.usd || 0
  if (usd > 0) return 0                                // held + valued
  if (entry.balance) return 1                          // held + zero-USD
  if (entry.swappable) return entry.isNative ? 2 : 3   // Pioneer-confirmed
  if (entry.availability.status === 'swappable') return entry.isNative ? 4 : 5
  if (entry.availability.status === 'unknown') return 6
  return 7                                             // unsupported
}

/** Compare two entries: bucket asc → bucket-specific tiebreak. */
export function compareEntries(a: AssetEntry, b: AssetEntry): number {
  const ba = bucketFor(a)
  const bb = bucketFor(b)
  if (ba !== bb) return ba - bb

  if (ba === 0) return (b.balance!.usd) - (a.balance!.usd)

  const symA = a.symbol.toUpperCase()
  const symB = b.symbol.toUpperCase()
  if (symA !== symB) return symA < symB ? -1 : 1
  return a.name < b.name ? -1 : 1
}

// ── Lazy search index ────────────────────────────────────────────────────

let cachedDiscovery: Map<string, DiscoveryAssetRaw> | null = null

async function getDiscoveryMap(): Promise<Map<string, DiscoveryAssetRaw>> {
  if (cachedDiscovery) return cachedDiscovery
  // Dynamic import keeps the 30k JSON out of the initial bundle parse if the
  // user never opens the asset picker.
  const mod = await import('@pioneer-platform/pioneer-discovery')
  const data = (mod as any).assetData as Record<string, DiscoveryAssetRaw>
  cachedDiscovery = new Map(Object.entries(data))
  return cachedDiscovery
}

/** Test-only: drop the cached discovery map. */
export function _resetDiscoveryCacheForTests(): void {
  cachedDiscovery = null
}

// ── Network labels + chain CAIP-19 lookup ───────────────────────────────

interface ChainMeta {
  /** Vault internal chain id (e.g. 'bitcoin', 'ethereum') — needed for
   *  SwapAsset.chainId which downstream code uses to resolve config. */
  vaultChainId: string
  /** Full CAIP-19 native asset id for the chain (e.g. 'eip155:1/slip44:60') —
   *  what AssetIcon's chainCaip prop expects. */
  nativeCaip: string
  /** Display name (e.g. 'Ethereum'). */
  displayName: string
  chainFamily: string
}

let cachedChainMetaByCaip2: Map<string, ChainMeta> | null = null

/** Canonicalize a chain CAIP-2 (no-op for already-canonical values). Delegates
 *  to swap-support-matrix's table so the matrix and the picker dedupe path
 *  share a single source — adding a new alias there fixes both at once. */
export function canonicalizeChainCaip2(chainCaip2: string): string {
  return normalizeChainCaip2(chainCaip2)
}

/** Token-namespace prefixes that mean "this CAIP describes a contract token,
 *  not a chain-native asset". Native assets use `/slip44:N` regardless of
 *  chain family. BEP-20 was missing from the picker's earlier isNative check,
 *  which silently classified BSC tokens as native and stripped their contract
 *  address during synthesis — caller used native BNB balances instead. */
const TOKEN_NAMESPACES = ['/erc20:', '/bep20:', '/token:'] as const

/** Parse a CAIP-19 into its components. Returns the contract address (raw
 *  case-preserving) for token CAIPs, undefined for natives. Single source so
 *  swap-discovery, swap.ts, and synthesizeSwapAsset agree. */
export function parseCaip(caip: string): {
  chainCaip2: string
  isToken: boolean
  /** Token contract address — raw case (TRON tokens are case-sensitive). */
  contractAddress?: string
} {
  const slash = caip.indexOf('/')
  if (slash < 0) return { chainCaip2: caip, isToken: false }
  const chainCaip2 = caip.slice(0, slash)
  const tail = caip.slice(slash) // includes leading '/'
  for (const ns of TOKEN_NAMESPACES) {
    if (tail.startsWith(ns)) {
      return { chainCaip2, isToken: true, contractAddress: tail.slice(ns.length) }
    }
  }
  return { chainCaip2, isToken: false }
}

/** BSC tokens are equivalently expressible as `/erc20:` (CAIP-19 standard for
 *  EVM tokens) or `/bep20:` (BSC-specific extension pioneer-discovery emits).
 *  Pioneer-server's quote endpoint only routes the `/erc20:` form — sending
 *  `/bep20:` returns "No quotes available" (verified live 2026-05). Fold to
 *  `/erc20:` at canonicalization so the picker, matrix, and outgoing quote
 *  CAIP all agree. */
function canonicalizeTokenNamespace(caip: string): string {
  // Only BSC has the bep20/erc20 split; other chains' namespaces are unique.
  return caip.replace(/^eip155:56\/bep20:/, 'eip155:56/erc20:')
}

/** Canonicalize a full CAIP-19 by remapping the chain prefix when it has
 *  alternate encodings, AND folding the token namespace where multiple forms
 *  exist. Both `tron:27Lqcw/slip44:195` and `tron:27lqcw/slip44:195` collapse
 *  to `tron:0x2b6653dc/slip44:195`; `eip155:56/bep20:0x...` collapses to
 *  `eip155:56/erc20:0x...`. */
export function canonicalizeCaip(caip: string): string {
  const slash = caip.indexOf('/')
  if (slash < 0) return canonicalizeChainCaip2(caip)
  const chain = caip.slice(0, slash)
  const canonical = canonicalizeChainCaip2(chain)
  const withChain = canonical === chain ? caip : `${canonical}${caip.slice(slash)}`
  return canonicalizeTokenNamespace(withChain)
}

/** Build CAIP-2 → ChainMeta map. Memoized — CHAINS is static. Both canonical
 *  and alternate encodings populate the map so chainMetaForCaip2 resolves
 *  pioneer-discovery's TRON entries (base58) to vault's TRON ChainDef (hex). */
function getChainMetaMap(): Map<string, ChainMeta> {
  if (cachedChainMetaByCaip2) return cachedChainMetaByCaip2
  const out = new Map<string, ChainMeta>()
  for (const c of CHAINS) {
    if (!c.networkId) continue
    const meta: ChainMeta = {
      vaultChainId: c.id,
      nativeCaip: c.caip,
      displayName: c.coin,
      chainFamily: c.chainFamily,
    }
    out.set(c.networkId, meta)
    // Also register any alternate encodings that map TO this chain.
    for (const [alt, canonical] of Object.entries(CHAIN_CAIP2_ALIASES)) {
      if (canonical === c.networkId && !out.has(alt)) out.set(alt, meta)
    }
  }
  cachedChainMetaByCaip2 = out
  return out
}

/** Discovery chains.json — keyed by CAIP-2, covers ~700 chains including
 *  encoding-mismatched TRON forms (both tron:27Lqcw base58 and tron:0x2b6653dc
 *  hex resolve to "TRON"). Used as a fallback when vault's CHAINS table doesn't
 *  know the chain — drives human-readable reason text in the asset picker. */
const discoveryChains = discoveryChainsJson as Record<string, { name?: string; namespace?: string; nativeCurrency?: { symbol: string } }>

/** Human-readable display name for a CAIP-2 network id, even when vault
 *  doesn't have a ChainDef for it. Falls through: vault CHAINS → discovery
 *  chains.json → raw CAIP-2 string. */
export function networkDisplayName(caip2: string): string {
  const meta = getChainMetaMap().get(caip2)
  if (meta) return meta.displayName
  const discovery = discoveryChains[caip2]
  if (discovery?.name) return discovery.name
  return caip2
}

/** Get chain metadata for a CAIP-2 network id. Returns null if vault doesn't
 *  know the chain (e.g. Pioneer-discovery has it but we have no ChainDef).
 *  Use `networkDisplayName` instead when you only need a friendly chain name. */
export function chainMetaForCaip2(caip2: string): ChainMeta | null {
  return getChainMetaMap().get(caip2) || null
}

/** Construct a SwapAsset shape from an AssetEntry. Used when the user picks a
 *  row Pioneer didn't pre-list (matrix-swappable or unknown) — downstream
 *  quote/execute code still expects the SwapAsset interface, but we only have
 *  AssetEntry data. The synthesized SwapAsset round-trips through Pioneer; if
 *  Pioneer rejects it the existing quote-error UX surfaces the reason. */
export function synthesizeSwapAsset(entry: AssetEntry): {
  asset: string
  chainId: string
  symbol: string
  name: string
  chainFamily: string
  decimals: number
  caip: string
  icon?: string
  contractAddress?: string
} | null {
  const meta = chainMetaForCaip2(entry.chainId)
  if (!meta) return null  // unknown chain — caller should refuse the selection

  // Single parser, namespace-aware. Was previously homemade and missed `/bep20:`
  // entirely — BSC tokens lost their contract address during synthesis and the
  // SwapDialog rendered native BNB pricing for them.
  const { isToken, contractAddress } = parseCaip(entry.caip)

  // Pioneer's `asset` field (THORChain-style "CHAIN.SYMBOL-CONTRACT") is
  // load-bearing for the `assetToCaip` reconstruct path, which splits on `.`
  // and looks up the chain prefix in THOR_TO_CHAIN. Using the displayName
  // ("OPTIMISM") instead of the canonical short prefix ("OP") would throw
  // "Unsupported THORChain chain: OPTIMISM" the moment the user picks a
  // VELO-class long-tail token. Look up the canonical THORChain prefix per
  // vault chain id; fall back to displayName-uppercase for chains we haven't
  // mapped (defensive, paired with long-form aliases in THOR_TO_CHAIN).
  const chainShort = VAULT_CHAIN_TO_THOR[meta.vaultChainId]
    ?? meta.displayName.split(/\s+/)[0].toUpperCase()
  const asset = isToken && contractAddress
    ? `${chainShort}.${entry.symbol}-${contractAddress.toUpperCase()}`
    : `${chainShort}.${entry.symbol}`

  return {
    asset,
    chainId: meta.vaultChainId,
    symbol: entry.symbol,
    name: entry.name,
    chainFamily: meta.chainFamily,
    decimals: entry.decimals,
    caip: entry.caip,
    icon: entry.iconUrl,
    contractAddress,
  }
}

// ── Public API ──────────────────────────────────────────────────────────

export interface BuildEntriesInput {
  /** Pioneer GetAvailableAssets cached result (the swappable subset). */
  swappable: SwapAsset[]
  /** Connected wallet's per-chain balances (with optional token sub-arrays). */
  balances: ChainBalance[]
}

/** Build the unified, sorted asset list. Async to allow lazy import of
 *  pioneer-discovery's 30k JSON. */
export async function buildAssetEntries(input: BuildEntriesInput): Promise<AssetEntry[]> {
  const discovery = await getDiscoveryMap()
  const swappableByCaip = new Map<string, SwapAsset>()
  for (const s of input.swappable) {
    if (s.caip) swappableByCaip.set(s.caip, s)
  }

  // Index user balances by CAIP for O(1) lookup. Tokens carry their own CAIP;
  // the native chain CAIP is resolved via the static CHAINS table since
  // ChainBalance only carries the internal chainId (e.g. 'bitcoin').
  const chainIdToCaip = new Map<string, string>()
  for (const c of CHAINS) {
    if (c.caip) chainIdToCaip.set(c.id, c.caip)
  }
  const balanceByCaip = new Map<string, { amount: string; usd: number }>()
  for (const cb of input.balances) {
    const nativeCaip = chainIdToCaip.get(cb.chainId)
    if (nativeCaip) {
      balanceByCaip.set(nativeCaip, {
        amount: cb.balance,
        usd: cb.nativeBalanceUsd ?? 0,
      })
    }
    if (cb.tokens) {
      for (const tok of cb.tokens) {
        if (tok.caip) balanceByCaip.set(tok.caip, { amount: tok.balance, usd: tok.balanceUsd || 0 })
      }
    }
  }

  // Canonicalize keys so duplicate chain encodings collapse. pioneer-discovery
  // has 3 TRX entries (tron:27Lqcw, tron:27lqcw, tron:0x2b6653dc); without
  // this dedupe the picker rendered all three.
  const seen = new Set<string>()
  const entries: AssetEntry[] = []
  // Walk the discovery universe — every CAIP becomes a row (after canonicalization).
  for (const [rawCaip, raw] of discovery) {
    const caip = canonicalizeCaip(rawCaip)
    if (seen.has(caip)) continue
    seen.add(caip)
    const swappable = swappableByCaip.get(caip) ?? swappableByCaip.get(rawCaip)
    const balance = balanceByCaip.get(caip) ?? balanceByCaip.get(rawCaip)
    const availability = assessAvailability(caip)
    // CAIP namespace is the source of truth — `/slip44:` is native, anything
    // under `/erc20:` `/bep20:` or `/token:` is a token. Discovery's own
    // isNative/type fields can disagree (saw it lie about BEP-20s).
    const { isToken } = parseCaip(caip)
    const isNative = !isToken
    entries.push({
      caip,
      symbol: raw.symbol,
      name: raw.name || raw.symbol,
      chainId: canonicalizeChainCaip2(raw.chainId),
      decimals: raw.decimals,
      iconUrl: raw.icon,
      isNative,
      balance,
      swappable,
      swappableAsset: swappable?.asset,
      availability,
    })
  }

  // Pioneer can return a swappable asset that isn't in our discovery JSON
  // (rare — usually new tokens). Backfill so the picker still surfaces them.
  // SwapAsset.chainId is vault's internal id (e.g. 'tron'), not CAIP-2 — so
  // we extract the CAIP-2 chain prefix from caip itself for AssetEntry.chainId
  // (which downstream consumers expect to be CAIP-2).
  for (const [rawCaip, s] of swappableByCaip) {
    const caip = canonicalizeCaip(rawCaip)
    if (seen.has(caip)) continue
    seen.add(caip)
    const slash = caip.indexOf('/')
    const chainCaip2 = slash >= 0 ? caip.slice(0, slash) : caip
    entries.push({
      caip,
      symbol: s.symbol,
      name: s.name,
      chainId: chainCaip2,
      decimals: s.decimals,
      iconUrl: s.icon,
      isNative: !s.contractAddress,
      balance: balanceByCaip.get(caip),
      swappable: s,
      swappableAsset: s.asset,
      availability: assessAvailability(caip),
    })
  }

  entries.sort(compareEntries)
  return entries
}

/** Pre-computed lowercase fields for ranked substring search. */
export interface SearchIndex {
  entries: AssetEntry[]
  symbols: string[]
  names: string[]
  caips: string[]
}

export function buildSearchIndex(entries: AssetEntry[]): SearchIndex {
  const symbols = new Array<string>(entries.length)
  const names = new Array<string>(entries.length)
  const caips = new Array<string>(entries.length)
  for (let i = 0; i < entries.length; i++) {
    symbols[i] = entries[i].symbol.toLowerCase()
    names[i] = entries[i].name.toLowerCase()
    caips[i] = entries[i].caip.toLowerCase()
  }
  return { entries, symbols, names, caips }
}

/** Match rank: 0 exact, 1 prefix, 2 contains, -1 no match. Symbol and name
 *  collapse into the same rank so "name exact" ties with "symbol exact" — the
 *  bucket then disambiguates based on actual user holdings/swap support. */
function rankMatch(symbol: string, name: string, caip: string, q: string): number {
  if (symbol === q || name === q) return 0
  if (symbol.startsWith(q) || name.startsWith(q)) return 1
  if (symbol.includes(q) || name.includes(q) || caip.includes(q)) return 2
  return -1
}

/** Ranked filter. Empty query returns input unchanged (already bucket-sorted).
 *
 *  Composite score: `matchRank * 10 + bucket`. Match rank weighted higher so:
 *    - "bitcoin" finds BTC (rank 0 + bucket 4 = 4) before "BITCOIN" memecoins
 *      (rank 0 + bucket 6 = 6) ✓
 *    - "tron" finds TRX even at bucket 7 unsupported (rank 0 + bucket 7 = 7)
 *      before unknown EVM tokens with "tron" in the name (rank 1 + bucket 6 = 16) ✓
 *    - "btc" still surfaces actual BTC (rank 0 + bucket 4 = 4) before
 *      tokens that contain "BTC" as a substring (rank 2 + bucket 4+ ≥ 24) ✓ */
export function searchEntries(index: SearchIndex, query: string): AssetEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return index.entries

  const matched: Array<{ score: number; idx: number }> = []
  for (let i = 0; i < index.entries.length; i++) {
    const r = rankMatch(index.symbols[i], index.names[i], index.caips[i], q)
    if (r < 0) continue
    const score = r * 10 + bucketFor(index.entries[i])
    matched.push({ score, idx: i })
  }
  matched.sort((a, b) => (a.score - b.score) || (a.idx - b.idx))
  return matched.map(m => index.entries[m.idx])
}
