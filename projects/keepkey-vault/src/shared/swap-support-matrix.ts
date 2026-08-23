/**
 * Static client-side swap-provider support matrix.
 *
 * Phase 1: every assessment is a pure function of (caip → known-provider-sets).
 * No Pioneer round-trip, no quote probes. Returns an honest `unknown` when the
 * chain is supported by some provider but the specific token isn't in our
 * static list — UI uses that to say "try a quote" instead of falsely
 * green-lighting or red-flagging.
 *
 * The matrix encodes well-known coverage as of 2026-05. It is NOT exhaustive:
 *   - native chain support is well-documented and stable enough to hardcode
 *   - well-known stablecoins (USDC/USDT/DAI) on each EVM chain are hardcoded
 *   - long-tail tokens fall through to `unknown` on supported chains
 *
 * Stale-risk: pool composition changes. If the matrix says "swappable" and
 * Pioneer rejects the quote, the existing quote-error UX still applies — this
 * is purely a *predictive* hint, not a contract.
 */

import { versionCompare } from './firmware-versions'

export type SwapProvider =
  | 'thorchain'
  | 'mayachain'
  | 'relay'
  | 'zeroex'      // 0x — single-chain EVM
  | 'chainflip'
  | 'shapeshift'  // ShapeShift Swapper — aggregates LiFi/Squid/Across over EVMs

export type AvailabilityStatus =
  | 'swappable'           // covered by ≥1 provider's hardcoded set
  | 'unknown'             // chain is supported but this token isn't in our static list — try a quote
  | 'unsupported_token'   // chain is supported but token namespace doesn't match any provider's token universe (rare)
  | 'unsupported_chain'   // no provider routes this chain at all
  | 'unsupported_firmware'// a provider routes this chain, but the connected device's firmware can't sign/derive it yet

export interface AvailabilityAssessment {
  status: AvailabilityStatus
  /** Providers that support this asset directly. Empty for unknown/unsupported. */
  providers: SwapProvider[]
  /** Short user-facing reason. Present for non-`swappable` statuses. */
  reason?: string
}

// ── CAIP-2 chain IDs supported by each provider (native swaps) ──────────
// Source: pioneer-server's ENABLED_ASSETS_V1 whitelist + provider docs as of
// 2026-05. Encodings match what pioneer-server emits (canonical CAIP-2);
// normalizeChainCaip2 below remaps pioneer-discovery's alternate encodings
// (notably TRON's base58 vs hex genesis hash) so both sides agree.

/** Canonical chain CAIP-2 → alternate encoding(s) emitted by other tools.
 *
 *  Pioneer-discovery emits TRON in three encodings (`tron:27Lqcw`,
 *  `tron:27lqcw`, `tron:0x2b6653dc`); pioneer-server and Relay use the hex
 *  genesis hash. Matrix is keyed on the canonical form Relay/pioneer-server
 *  use; alternates hit normalizeChainCaip2 first.
 *
 *  Exported so swap-discovery.ts can use the same table — keeps the alias list
 *  single-source. Adding to this map both fixes matrix lookups AND the picker's
 *  duplicate-row dedupe in one edit.
 *
 *  Note on Hyperliquid: pioneer-discovery and vault's CHAINS table agree on
 *  `eip155:2868` but the actual Hyperliquid mainnet chainId per chainID.network
 *  is 999. Relay routes 999. We previously aliased 2868→999 here, but vault's
 *  ChainDef doesn't have a 999 entry, so any picker click would silently fail
 *  (synthesizeSwapAsset returned null). Until vault's CHAINS table is
 *  reconciled, Hyperliquid is intentionally absent from RELAY_CHAINS /
 *  SHAPESHIFT_CHAINS — picker shows it as unsupported_chain with a clear
 *  reason rather than letting it look swappable and break on click. */
export const CHAIN_CAIP2_ALIASES: Record<string, string> = {
  // alternate → canonical
  'tron:27Lqcw': 'tron:0x2b6653dc',
  'tron:27lqcw': 'tron:0x2b6653dc',  // case-insensitive defensive
}

/** Normalize a chain CAIP-2 to the canonical encoding the matrix uses.
 *  No-op for already-canonical values. Exported alongside the alias table. */
export function normalizeChainCaip2(chainCaip2: string): string {
  return CHAIN_CAIP2_ALIASES[chainCaip2] || chainCaip2
}

/** Fold BSC's `/bep20:` namespace into the standard `/erc20:` form so matrix
 *  lookups (and downstream Pioneer Quote calls) only have to know one
 *  encoding. pioneer-server's quote endpoint returns "No quotes available"
 *  for `/bep20:` BSC USDT but routes the same asset cleanly under `/erc20:`
 *  (verified live 2026-05). Pure string op — no I/O. */
function normalizeTokenNamespace(caip: string): string {
  return caip.replace(/^eip155:56\/bep20:/, 'eip155:56/erc20:')
}

/** UTXO + EVM + Cosmos + Solana + TRON chains routable by THORChain pools.
 *  Verified against pioneer-server's ENABLED_ASSETS_V1 (2026-05). */
const THORCHAIN_CHAINS = new Set<string>([
  'bip122:000000000019d6689c085ae165831e93',           // BTC
  'bip122:12a765e31ffd4059bada1e25190f6e98',           // LTC
  'bip122:000000000000000000651ef99cb9fcbe',           // BCH
  'bip122:00000000001a91e3dace36e2be3bf030',           // DOGE (was wrong hash before — pioneer-server is source of truth)
  'bip122:000007d91d1254d60e2dd1ae58038307',           // DASH (Maya routes too)
  'eip155:1',                                          // ETH
  'eip155:43114',                                      // AVAX C-chain
  'eip155:56',                                         // BSC
  'eip155:8453',                                       // BASE
  'eip155:42161',                                      // ARB
  'eip155:10',                                         // OP
  // Polygon (eip155:137) historically had a THORChain pool but it was
  // deprecated; Pioneer-server lists it but matrix omits to avoid false-
  // positive "swappable" hints. Aggregators (Relay/0x) still route MATIC.
  'cosmos:thorchain-mainnet-v1',                       // RUNE
  'cosmos:cosmoshub-4',                                // ATOM (GAIA)
  'tron:0x2b6653dc',                                   // TRX — verified live via pioneer-server
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',           // SOL — added 2026-05 per pioneer-server comment
])

/** Mayachain native pools. */
const MAYACHAIN_CHAINS = new Set<string>([
  'bip122:000000000019d6689c085ae165831e93',           // BTC
  'eip155:1',                                          // ETH
  'eip155:42161',                                      // ARB
  'cosmos:mayachain-mainnet-v1',                       // CACAO
  'cosmos:thorchain-mainnet-v1',                       // RUNE
  'cosmos:kaiyo-1',                                    // KUJI
  'bip122:000007d91d1254d60e2dd1ae58038307',           // DASH
  // ZEC pool on Maya — verified live 2026-05-09. Transparent (t1...) inbound only;
  // shielded deposits are not accepted by the protocol vault.
  'bip122:00040fe8ec8471911baa1db1266ea15d',           // ZEC
])

/** Relay (Reservoir solver network) — EVM cross-chain. Coverage list verified
 *  2026-05 by probing pioneer-server's /quote endpoint with ETH source against
 *  each chain's native asset. Anything that returns a quote stays in this set;
 *  chains that returned "no quotes" (e.g. Hyperliquid, Fantom, Sei,
 *  PolygonZkEVM, Moonbeam from ETH) remain off the list — UI will mark them
 *  unsupported_chain unless a different provider picks them up. */
const RELAY_CHAINS = new Set<string>([
  // Tier-1 verified against pioneer-server live (2026-05-08)
  'eip155:1',          // Ethereum
  'eip155:10',         // Optimism
  'eip155:56',         // BSC
  'eip155:100',        // Gnosis
  'eip155:137',        // Polygon
  'eip155:143',        // Monad
  'eip155:146',        // Sonic
  'eip155:4663',       // Robinhood Chain — live in Relay's public chain list (api.relay.link/chains, 2026-08)
  'eip155:169',        // Manta Pacific
  'eip155:324',        // zkSync Era
  'eip155:5000',       // Mantle
  'eip155:8453',       // Base
  'eip155:34443',      // Mode
  'eip155:42161',      // Arbitrum
  'eip155:42220',      // Celo
  'eip155:43114',      // Avalanche
  'eip155:59144',      // Linea
  'eip155:80094',      // Berachain
  'eip155:81457',      // Blast
  'eip155:534352',     // Scroll
  // Hyperliquid (eip155:999) is omitted — see CHAIN_CAIP2_ALIASES note above.
])

/** 0x — single-chain EVM aggregator. */
const ZEROEX_CHAINS = new Set<string>([
  'eip155:1', 'eip155:10', 'eip155:56', 'eip155:137',
  'eip155:8453', 'eip155:42161', 'eip155:43114',
])

/** ChainFlip native cross-chain swaps. */
const CHAINFLIP_CHAINS = new Set<string>([
  'bip122:000000000019d6689c085ae165831e93',           // BTC
  'eip155:1',                                          // ETH
  'eip155:42161',                                      // ARB
  'polkadot:91b171bb158e2d3848fa23a9f1c25182',         // DOT
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',           // SOL
])

/** ShapeShift Swapper — pioneer-server's `shapeshiftSwap` integration which
 *  aggregates LiFi/Squid/Across solvers. LiFi covers Solana (thousands of SPL
 *  tokens), confirmed 2026-05. Kept separate from RELAY_CHAINS so non-EVM
 *  coverage can grow independently. */
const SHAPESHIFT_CHAINS = new Set<string>([
  'eip155:1', 'eip155:10', 'eip155:56', 'eip155:100',
  'eip155:137', 'eip155:143', 'eip155:146', 'eip155:169',
  'eip155:324', 'eip155:4663', 'eip155:5000', 'eip155:8453',
  'eip155:34443', 'eip155:42161', 'eip155:42220', 'eip155:43114',
  'eip155:59144', 'eip155:80094', 'eip155:81457', 'eip155:534352',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',               // SOL — LiFi
])

// ── Well-known stablecoins per chain (CAIP-19 token IDs) ────────────────
// Hardcoded so we can confidently say "USDT-on-Ethereum is swappable" without
// a quote round-trip. Anything else on these chains falls through to `unknown`.
//
// Token namespace convention: BSC tokens are keyed as `/erc20:` here to match
// what pioneer-server's quote endpoint accepts. Pioneer-discovery emits
// `/bep20:` for the same assets — the canonicalize() step below folds bep20
// into erc20 before the lookup hits this set.

const STABLECOIN_TOKENS = new Set<string>([
  // USDT
  'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7',     // ETH
  'eip155:56/erc20:0x55d398326f99059ff775485246999027b3197955',    // BSC
  'eip155:137/erc20:0xc2132d05d31c914a87c6611c10748aeb04b58e8f',   // POLYGON
  'eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // ARB
  'eip155:10/erc20:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',    // OP
  'eip155:43114/erc20:0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', // AVAX
  'eip155:8453/erc20:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',  // BASE (USDT)
  // USDC
  'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',     // ETH
  'eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',    // BSC
  'eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',   // POLYGON (native)
  'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831', // ARB (native)
  'eip155:10/erc20:0x0b2c639c533813f4aa9d7837caf62653d097ff85',    // OP (native)
  'eip155:43114/erc20:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', // AVAX (native)
  'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',  // BASE (native)
  // DAI
  'eip155:1/erc20:0x6b175474e89094c44da98b954eedeac495271d0f',     // ETH
  // TRON USDT — verified live in pioneer-server's ENABLED_ASSETS_V1 (THORChain)
  'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
])

/** Subset of stablecoins that THORChain explicitly pools. Keeps the matrix
 *  honest — Mayachain/Relay/0x have wider stablecoin coverage. TRON USDT
 *  routes via THORChain. */
const THORCHAIN_TOKEN_PREFIXES = [
  'eip155:1/erc20:',
  'eip155:43114/erc20:',
  'eip155:56/erc20:',
  'tron:0x2b6653dc/token:',
]

// THORChain bank-module tokens with live THORChain pools (THOR.TCY, THOR.RUJI).
// They route via THORChain like any pooled asset but carry a `/denom:` caip, so
// they don't match the token prefixes above. Other thorchain `/denom:` assets
// (random x/ pool/vault tokens) are NOT pooled, so allowlist explicitly.
const THORCHAIN_DENOM_ASSETS = new Set<string>([
  'cosmos:thorchain-mainnet-v1/denom:tcy',
  'cosmos:thorchain-mainnet-v1/denom:x/ruji',
])

// ── Firmware gate for THORChain/Maya bank tokens (TCY, RUJI) ──────────────
//
// Sending a bank token is a MsgSend whose `denom` field the firmware honors
// only from 7.15.0. On older firmware that field is ignored and the tx signs
// as RUNE — the user thinks they're moving TCY but they'd move RUNE (or it
// fails). That's a fund-safety gap, so the whole TCY/RUJI feature (send +
// swap) is gated to 7.15+. Single source of truth used by the swap matrix and
// the backend build/sign path.
export const THORCHAIN_BANK_TOKEN_MIN_FW = '7.15.0'

/** A THORChain/Maya bank-module token (TCY, RUJI, secured assets) — `/denom:` caip. */
export function isThorchainBankToken(caip: string): boolean {
  return (caip.startsWith('cosmos:thorchain-') || caip.startsWith('cosmos:mayachain-'))
    && caip.includes('/denom:')
}

/** True if the connected firmware can safely sign this asset. Non-bank-tokens
 *  are always OK; bank tokens require firmware ≥ 7.15.0 (unknown fw → not OK). */
export function thorchainBankTokenFirmwareOK(caip: string, firmwareVersion?: string): boolean {
  if (!isThorchainBankToken(caip)) return true
  return !!firmwareVersion && versionCompare(firmwareVersion, THORCHAIN_BANK_TOKEN_MIN_FW) >= 0
}

// ── Public API ──────────────────────────────────────────────────────────

/** Given a CAIP-19 asset id, decide which providers route it (if any) and
 *  return a user-friendly assessment. Pure — no I/O. */
export function assessAvailability(caip: string): AvailabilityAssessment {
  if (!caip) {
    return { status: 'unsupported_chain', providers: [], reason: 'No asset id' }
  }

  const slash = caip.indexOf('/')
  const rawChainId = slash >= 0 ? caip.slice(0, slash) : caip
  // Normalize alternate encodings before set lookup so pioneer-discovery and
  // pioneer-server agree on identity:
  //   - chain-prefix aliases (TRON base58 ↔ hex)
  //   - token namespace fold (BSC `/bep20:` → `/erc20:`)
  // The full CAIP gets both treatments so STABLECOIN_TOKENS lookups hit.
  const chainId = normalizeChainCaip2(rawChainId)
  const chainSwapped = chainId !== rawChainId
    ? `${chainId}${caip.slice(rawChainId.length)}`
    : caip
  const normalizedCaip = normalizeTokenNamespace(chainSwapped)
  const isToken = slash >= 0 && !caip.includes('/slip44:')

  const providers: SwapProvider[] = []

  if (!isToken) {
    // Native asset: whole-chain support sets apply.
    if (has('thorchain',  chainId)) providers.push('thorchain')
    if (has('mayachain',  chainId)) providers.push('mayachain')
    if (has('relay',      chainId)) providers.push('relay')
    if (has('zeroex',     chainId)) providers.push('zeroex')
    if (has('chainflip',  chainId)) providers.push('chainflip')
    if (has('shapeshift', chainId)) providers.push('shapeshift')

    if (providers.length > 0) return { status: 'swappable', providers }
    return {
      status: 'unsupported_chain',
      providers: [],
      reason: `${chainId} is not currently supported by any swap provider`,
    }
  }

  // THORChain bank tokens (TCY, RUJI) — pooled, routable via THORChain.
  if (THORCHAIN_DENOM_ASSETS.has(normalizedCaip) && has('thorchain', chainId)) {
    return { status: 'swappable', providers: ['thorchain'] }
  }

  // Token path. Token-specific providers first, then fall through. Use the
  // chain-normalized CAIP for the well-known stablecoin lookup so TRON USDT
  // matches whether the input encoded TRON as base58 or hex.
  if (STABLECOIN_TOKENS.has(normalizedCaip)) {
    if (has('relay',  chainId)) providers.push('relay')
    if (has('zeroex', chainId)) providers.push('zeroex')
    if (THORCHAIN_TOKEN_PREFIXES.some(p => normalizedCaip.startsWith(p))) providers.push('thorchain')
    if (providers.length > 0) return { status: 'swappable', providers }
  }

  // Token on a chain Relay/0x/ShapeShift cover → unknown (try a quote — most
  // ERC-20s on these chains route fine through the aggregator solvers).
  if (has('relay', chainId) || has('zeroex', chainId) || has('shapeshift', chainId)) {
    return {
      status: 'unknown',
      providers: [],
      reason: 'Token may be swappable via aggregators — try a quote to confirm',
    }
  }

  // Token on a chain we route natives for, but no aggregator presence.
  if (has('thorchain', chainId) || has('mayachain', chainId) || has('chainflip', chainId)) {
    return {
      status: 'unsupported_token',
      providers: [],
      reason: 'Native chain is supported but this specific token is not currently routable',
    }
  }

  return {
    status: 'unsupported_chain',
    providers: [],
    reason: `${chainId} is not currently supported by any swap provider`,
  }
}

/** Provider → display label, used by AssetPickerDialog tooltips. */
export const PROVIDER_LABEL: Record<SwapProvider, string> = {
  thorchain:  'THORChain',
  mayachain:  'Mayachain',
  relay:      'Relay',
  zeroex:     '0x',
  chainflip:  'ChainFlip',
  shapeshift: 'ShapeShift',
}

// ── Dynamic chain coverage (loaded from Pioneer at startup) ─────────────────

type DynamicChains = Record<SwapProvider, Set<string>>
let dynamicChains: DynamicChains | null = null
let dynamicChainsBase = ''

/** Fetch provider chain coverage from Pioneer and cache for the session.
 *  Re-fetches if pioneerBase changed (e.g. user switches Pioneer host in settings).
 *  Falls back silently to the static sets if Pioneer is unreachable. */
export async function loadSupportedChains(pioneerBase: string): Promise<void> {
  if (dynamicChains && pioneerBase === dynamicChainsBase) return
  dynamicChains = null
  try {
    const res = await fetch(`${pioneerBase}/api/v1/swappers/supported-chains`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as Record<string, string[]>
    dynamicChains = {
      thorchain:  new Set(data.thorchain  || []),
      mayachain:  new Set(data.mayachain  || []),
      relay:      new Set(data.relay      || []),
      zeroex:     new Set(data.zeroex     || []),
      chainflip:  new Set(data.chainflip  || []),
      shapeshift: new Set(data.shapeshift || []),
    }
    dynamicChainsBase = pioneerBase
    console.log('[swap-matrix] Dynamic chain coverage loaded from Pioneer')
  } catch (e: any) {
    console.warn('[swap-matrix] Pioneer unreachable — using static fallback:', e.message)
  }
}

/** Exposed for tests only. */
export function _resetDynamicChains(): void { dynamicChains = null; dynamicChainsBase = '' }
export function _setDynamicChains(chains: Record<SwapProvider, string[]>): void {
  dynamicChains = Object.fromEntries(
    Object.entries(chains).map(([k, v]) => [k, new Set(v as string[])])
  ) as DynamicChains
}

function has(provider: SwapProvider, chainId: string): boolean {
  if (dynamicChains) return dynamicChains[provider].has(chainId)
  switch (provider) {
    case 'thorchain':  return THORCHAIN_CHAINS.has(chainId)
    case 'mayachain':  return MAYACHAIN_CHAINS.has(chainId)
    case 'relay':      return RELAY_CHAINS.has(chainId)
    case 'zeroex':     return ZEROEX_CHAINS.has(chainId)
    case 'chainflip':  return CHAINFLIP_CHAINS.has(chainId)
    case 'shapeshift': return SHAPESHIFT_CHAINS.has(chainId)
  }
}
