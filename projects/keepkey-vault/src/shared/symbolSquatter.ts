/**
 * Symbol-squatter detection.
 *
 * Scam tokens impersonate a major L1/L2 by naming an ERC-20 / BEP-20 / SPL
 * after the chain's ticker or name — e.g. an Ethereum ERC-20 that self-declares
 * the symbol "SOLANA". The swap UI trusts the token's self-declared symbol and
 * the server-supplied icon, so without a guard the squatter renders with the
 * native asset's branding and fools the user into thinking they're receiving
 * the real coin.
 *
 * The CAIP namespace is the source of truth: the genuine native asset is ALWAYS
 * a `/slip44:` CAIP, never a token. So a token CAIP wearing a native identity —
 * and NOT catalogued as a known/curated asset — is an impersonator.
 */
import { parseCaip } from './swap-discovery'
import { isAssetMapReady, isKnownAsset } from './assetLookup'

// Major chain identities (tickers + names) that get squatted. Uppercased for
// case-insensitive comparison. ponytail: curated list of the commonly-abused
// majors; extend it — or derive it from the catalog's native (slip44) symbols —
// if scammers start impersonating other chains.
const NATIVE_IDENTITIES = new Set([
  'BTC', 'BITCOIN',
  'ETH', 'ETHEREUM',
  'SOL', 'SOLANA',
  'BNB', 'BINANCE',
  'XRP', 'RIPPLE',
  'ADA', 'CARDANO',
  'DOGE', 'DOGECOIN',
  'AVAX', 'AVALANCHE',
  'DOT', 'POLKADOT',
  'TRX', 'TRON',
  'LTC', 'LITECOIN',
  'BCH', 'BITCOINCASH',
  'ATOM', 'COSMOS',
  'NEAR', 'SUI', 'TON',
  'APT', 'APTOS',
  'XLM', 'STELLAR',
  'ALGO', 'HBAR',
  'RUNE', 'THORCHAIN',
  'CACAO', 'MAYA',
  'OSMO', 'OSMOSIS',
])

/** True if `symbol` is (case-insensitively) a major chain's ticker or name. */
export function impersonatesNativeIdentity(symbol: string | undefined): boolean {
  return !!symbol && NATIVE_IDENTITIES.has(symbol.trim().toUpperCase())
}

/** Pure decision with dependencies injected (unit-testable without the catalog). */
export function decideSquatter(o: {
  isToken: boolean
  catalogReady: boolean
  knownAsset: boolean
  symbol?: string
}): boolean {
  if (!o.catalogReady) return false   // can't verify yet → don't cry wolf
  if (!o.isToken) return false        // native asset (CAIP /slip44:) is legit by definition
  if (o.knownAsset) return false      // curated/known token (e.g. MATIC's ERC-20)
  return impersonatesNativeIdentity(o.symbol)
}

/**
 * True when `caip` is a non-native asset that borrows a major chain's
 * ticker/name while NOT being the catalogued/known asset for that CAIP — i.e.
 * an unverified token impersonating a native coin. Fails open (false) while the
 * asset catalog is still loading.
 */
export function isSymbolSquatter(caip: string | undefined, symbol: string | undefined): boolean {
  if (!caip) return false
  return decideSquatter({
    isToken: parseCaip(caip).isToken,
    catalogReady: isAssetMapReady(),
    knownAsset: isKnownAsset(caip),
    symbol,
  })
}
