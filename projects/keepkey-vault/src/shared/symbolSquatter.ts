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
export const NATIVE_IDENTITIES = new Set([
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

// Chain NAMES long enough to be unambiguous inside a longer string. Short
// tickers are excluded on purpose: "SOL" lives inside SOLEND, "TON" inside
// BUTTON, "ADA" inside ADAPT — substring-matching those would flag everything.
const UNAMBIGUOUS_NAMES = [...NATIVE_IDENTITIES].filter(n => n.length >= 5)

/**
 * True if `text` is (case-insensitively) a major chain's ticker or name, or
 * wears one inside a longer string.
 *
 * Exact match alone is not enough: the squatters that get through call
 * themselves "Barbie Solana", not "SOLANA". Two passes:
 *  - word match — any whitespace/punctuation-delimited word is an identity
 *    ("Barbie Solana" → BARBIE | SOLANA → hit). Safe for short tickers.
 *  - substring match — an unambiguous chain NAME anywhere in the squashed
 *    string ("BarbieSolana" → hit). Long names only, see above.
 */
export function impersonatesNativeIdentity(text: string | undefined): boolean {
  if (!text) return false
  const upper = text.trim().toUpperCase()
  if (NATIVE_IDENTITIES.has(upper)) return true
  for (const word of upper.split(/[^A-Z0-9]+/)) {
    if (word && NATIVE_IDENTITIES.has(word)) return true
  }
  const squashed = upper.replace(/[^A-Z]/g, '')
  return UNAMBIGUOUS_NAMES.some(n => squashed.includes(n))
}

/** Pure decision with dependencies injected (unit-testable without the catalog). */
export function decideSquatter(o: {
  isToken: boolean
  catalogReady: boolean
  knownAsset: boolean
  symbol?: string
  name?: string
}): boolean {
  if (!o.catalogReady) return false   // can't verify yet → don't cry wolf
  if (!o.isToken) return false        // native asset (CAIP /slip44:) is legit by definition
  if (o.knownAsset) return false      // curated/known token (e.g. MATIC's ERC-20)
  // Both fields: the display name is squatted as often as the ticker, and a
  // token showing symbol "BARBIE" with name "Solana" reads as Solana in any
  // list that renders the name.
  return impersonatesNativeIdentity(o.symbol) || impersonatesNativeIdentity(o.name)
}

/**
 * True when `caip` is a non-native asset that borrows a major chain's
 * ticker/name while NOT being the catalogued/known asset for that CAIP — i.e.
 * an unverified token impersonating a native coin. Fails open (false) while the
 * asset catalog is still loading.
 */
export function isSymbolSquatter(
  caip: string | undefined,
  symbol: string | undefined,
  name?: string,
): boolean {
  if (!caip) return false
  return decideSquatter({
    isToken: parseCaip(caip).isToken,
    catalogReady: isAssetMapReady(),
    knownAsset: isKnownAsset(caip),
    symbol,
    name,
  })
}
