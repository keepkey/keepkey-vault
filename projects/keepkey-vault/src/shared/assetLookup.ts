/**
 * Asset data lookup by CAIP identifier.
 *
 * The JSON stores a slim representation:
 *   - `assetId` omitted (== the key)
 *   - `chainId` omitted (== key.split('/')[0])
 *   - `icon` omitted when derivable from CAIP via keepkey.info convention
 *
 * This module lazy-loads the 4.6MB asset data on first use to avoid
 * blocking initial render.
 */
import offlineAssetIconsJson from './offlineAssetIcons.json'
import { CHAINS, isStaleHyperliquidMetadata } from './chains'
import { ARBITRUM_SVG, BASE_SVG, DOGECOIN_SVG, ETHEREUM_SVG, OPTIMISM_SVG, POLYGON_SVG, THORCHAIN_SVG } from './chainLogos'

interface SlimAssetEntry {
  symbol: string
  name: string
  color?: string
  decimals?: number
  icon?: string        // only present when NOT derivable
  isNative?: boolean
  type?: string
  explorer?: string
  explorerAddressLink?: string
  explorerTxLink?: string
  denom?: string
}

export interface AssetEntry {
  assetId: string
  chainId: string
  symbol: string
  name: string
  icon: string
  color: string
  decimals?: number
  isNative?: boolean
  type?: string
  explorer?: string
  explorerAddressLink?: string
  explorerTxLink?: string
  denom?: string
}

let assetMap: Record<string, SlimAssetEntry> | null = null
let loadPromise: Promise<Record<string, SlimAssetEntry>> | null = null

function getAssetMap(): Record<string, SlimAssetEntry> | null {
  if (assetMap) return assetMap
  // Kick off lazy load if not started yet
  if (!loadPromise) {
    loadPromise = import('./assetData.json').then((m) => {
      assetMap = { ...(m.default || m) } as Record<string, SlimAssetEntry>
      // Correct only curated native metadata. Never reinterpret the old 2868
      // HYPE entries as mainnet, and leave custom registrations independent.
      for (const [caip, entry] of Object.entries(assetMap)) {
        if (isStaleHyperliquidMetadata(caip, entry.symbol, entry.name)) delete assetMap[caip]
      }
      for (const chain of CHAINS.filter(c => ['hyperliquid', 'monad', 'polygon', 'base'].includes(c.id))) {
        assetMap[chain.caip] = {
          ...assetMap[chain.caip], symbol: chain.symbol, name: chain.coin,
          decimals: chain.decimals, color: chain.color, isNative: true, type: 'native',
          explorerAddressLink: chain.explorerAddressUrl,
          explorerTxLink: chain.explorerTxUrl,
        }
      }
      return assetMap
    }).catch((err) => {
      console.warn('[assetLookup] Failed to load asset data:', err)
      assetMap = {}
      return assetMap
    })
  }
  return null // not loaded yet
}

// Start loading immediately (non-blocking)
getAssetMap()

/** Bundled (offline-safe) icons for primary assets whose logo must never break —
 *  the remote CDN is unreachable in offline/airplane mode. Inline SVG data URIs
 *  so there's no asset-file/bundler coupling and no network fetch.
 *  Bitcoin first (btc-only wallets live and die on this one). Its mark is the
 *  official public-domain Bitcoin logo (bitcoin.org / Wikimedia "Bitcoin.svg"),
 *  not a hand-drawn approximation. */
const BITCOIN_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#f7931a" d="M63.04 39.741c-4.274 17.143-21.638 27.575-38.783 23.301C7.12 58.768-3.313 41.404.962 24.262 5.234 7.117 22.597-3.317 39.737.957c17.144 4.274 27.576 21.64 23.302 38.784z"/><path fill="#fff" d="M46.11 27.441c.636-4.258-2.606-6.547-7.039-8.074l1.438-5.768-3.512-.875-1.4 5.616c-.922-.23-1.87-.447-2.812-.662l1.41-5.653-3.509-.875-1.439 5.766c-.764-.174-1.514-.346-2.242-.527l.004-.018-4.842-1.209-.934 3.75s2.605.597 2.55.634c1.422.355 1.68 1.296 1.636 2.042l-1.638 6.571c.098.025.225.061.365.117l-.37-.092-2.297 9.205c-.174.432-.615 1.08-1.609.834.035.051-2.552-.637-2.552-.637l-1.743 4.019 4.569 1.139c.85.213 1.683.436 2.503.646l-1.453 5.834 3.507.875 1.439-5.772c.958.26 1.888.5 2.798.726l-1.434 5.745 3.511.875 1.453-5.823c5.987 1.133 10.489.676 12.384-4.739 1.527-4.36-.076-6.875-3.226-8.515 2.294-.529 4.022-2.038 4.483-5.155zM38.087 38.69c-1.085 4.36-8.426 2.003-10.806 1.412l1.928-7.729c2.38.594 10.012 1.77 8.878 6.317zm1.086-11.312c-.99 3.966-7.1 1.951-9.082 1.457l1.748-7.01c1.982.494 8.315 1.416 7.334 5.553z"/></svg>`
/** Shielded ZEC (zZEC) — synthetic asset, never in the CDN catalog: gold shield + Zcash Z. */
const ZCASH_SHIELDED_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#f4b728" d="M32 4l24 9v17c0 15.5-10.2 25.7-24 30C18.2 55.7 8 45.5 8 30V13z"/><path fill="#fff" d="M21 20h22v6L31 38h12v6H21v-6l12-12H21z"/><rect x="29" y="14" width="6" height="6" fill="#fff"/><rect x="29" y="44" width="6" height="6" fill="#fff"/></svg>`
/** Monero (XMR) — not in the CDN catalog under our CAIP: orange disc, white M over the grey band. */
const MONERO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#ff6600"/><path fill="#4c4c4c" d="M6.5 42h11V26l14.5 14.5L46.5 26v16h11a30 30 0 0 1-51 0z"/><path fill="#fff" d="M32 6a26 26 0 0 0-25.5 30.9h7.9V18.3L32 35.9l17.6-17.6v18.6h7.9A26 26 0 0 0 32 6z"/></svg>`
/** Base (eip155:8453) native ETH — the CDN serves Ethereum's diamond for this
 *  CAIP, so Base read as a second Ethereum; BASE_SVG (chainLogos.ts) is Base's own square. */
export const BASE_NATIVE_CAIP = 'eip155:8453/slip44:60'
const LOCAL_ICONS: Record<string, string> = {
  'bip122:000000000019d6689c085ae165831e93/slip44:0': `data:image/svg+xml,${encodeURIComponent(BITCOIN_SVG)}`,
  [BASE_NATIVE_CAIP]: `data:image/svg+xml,${encodeURIComponent(BASE_SVG)}`,
  // Official vectors for the dashboard chains whose CDN/bundled PNGs were blurry or cropped (see chainLogos.ts).
  'eip155:1/slip44:60': `data:image/svg+xml,${encodeURIComponent(ETHEREUM_SVG)}`,
  'eip155:42161/slip44:60': `data:image/svg+xml,${encodeURIComponent(ARBITRUM_SVG)}`,
  'eip155:10/slip44:60': `data:image/svg+xml,${encodeURIComponent(OPTIMISM_SVG)}`,
  'eip155:137/slip44:60': `data:image/svg+xml,${encodeURIComponent(POLYGON_SVG)}`,
  'cosmos:thorchain-mainnet-v1/slip44:931': `data:image/svg+xml,${encodeURIComponent(THORCHAIN_SVG)}`,
  'bip122:00000000001a91e3dace36e2be3bf030/slip44:3': `data:image/svg+xml,${encodeURIComponent(DOGECOIN_SVG)}`,
  'bip122:00040fe8ec8471911baa1db1266ea15d/orchard:shielded': `data:image/svg+xml,${encodeURIComponent(ZCASH_SHIELDED_SVG)}`,
  'monero:418015bb9ae982a1975da7d79277c270/slip44:128': `data:image/svg+xml,${encodeURIComponent(MONERO_SVG)}`,
}
const OFFLINE_ASSET_ICONS = offlineAssetIconsJson as Record<string, string>

function bundledIconForCaip(caip: string): string | undefined {
  const normalized = caip.startsWith('eip155:') ? caip.toLowerCase() : caip
  const filename = OFFLINE_ASSET_ICONS[normalized]
    || OFFLINE_ASSET_ICONS[normalized.replace('/spl:', '/token:')]
  return filename ? `./assets/token-icons/${filename}` : undefined
}

/** True when an icon resolves to data packaged inside the desktop build. */
export function isBundledAssetIcon(url: string | undefined): boolean {
  return !!url && (url.startsWith('data:') || url.startsWith('./assets/token-icons/'))
}

/** Derive the keepkey.info icon URL from a CAIP identifier.
 *  Bundled LOCAL_ICONS win — several components call this directly rather
 *  than through getAssetIcon, and synthetic CAIPs (shielded ZEC) plus
 *  offline-critical ones (BTC) must resolve at every call site. */
/** CAIPs whose CDN image is still stored under an older id. HyperEVM moved from
 *  the pinned catalog's wrong chain 2868 to 999 (see chains.ts), but the CDN only
 *  has the HYPE logo under 2868, so 999 returned 403 and the alt text showed. */
export const ICON_CAIP_ALIASES: Record<string, string> = {
  'eip155:999/slip44:60': 'eip155:2868/slip44:60',
}

export function caipToIcon(caip: string): string {
  if (LOCAL_ICONS[caip]) return LOCAL_ICONS[caip]
  const bundled = bundledIconForCaip(caip)
  if (bundled) return bundled
  const cdnCaip = ICON_CAIP_ALIASES[caip] || caip
  return `https://api.keepkey.info/coins/${btoa(cdnCaip).replace(/=+$/, '')}.png`
}

/** Look up a full asset entry by CAIP */
export function getAsset(caip: string): AssetEntry | undefined {
  const map = getAssetMap()
  if (!map) return undefined
  const entry = map[caip]
  if (!entry) return undefined
  return {
    ...entry,
    assetId: caip,
    chainId: caip.split('/')[0],
    icon: entry.icon || caipToIcon(caip),
    color: entry.color || '#888',
  }
}

/** True once the async asset catalog has finished loading — lets best-effort
 *  checks (e.g. symbol-squatter detection) fail open until data is available. */
export function isAssetMapReady(): boolean {
  return assetMap !== null
}

/** True if this exact CAIP is a curated/known asset in the catalog. Distinguishes
 *  a legit token (e.g. MATIC's Ethereum ERC-20, which IS catalogued) from an
 *  unknown/unverified token wearing a well-known ticker. */
export function isKnownAsset(caip: string): boolean {
  return !!assetMap && caip in assetMap
}

/** Look up just the icon URL for a CAIP */
export function getAssetIcon(caip: string): string {
  if (LOCAL_ICONS[caip]) return LOCAL_ICONS[caip]
  const bundled = bundledIconForCaip(caip)
  if (bundled) return bundled
  const map = getAssetMap()
  if (!map) return caipToIcon(caip)
  const entry = map[caip]
  return entry?.icon || caipToIcon(caip)
}

/** Register a custom chain so getAsset() can return its explorer links. */
export function registerCustomAsset(caip: string, entry: { symbol: string; name: string; explorer?: string; explorerAddressLink?: string; explorerTxLink?: string }): void {
  const map = getAssetMap()
  if (!map) {
    // Map not loaded yet — queue for when it loads
    if (loadPromise) {
      loadPromise.then((m) => { m[caip] = { ...entry, isNative: true, type: 'native' } })
    }
    return
  }
  map[caip] = { ...entry, isNative: true, type: 'native' }
}

/** Remove a custom chain entry from the asset map. */
export function unregisterCustomAsset(caip: string): void {
  const map = getAssetMap()
  if (map) delete map[caip]
}
