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
      assetMap = (m.default || m) as Record<string, SlimAssetEntry>
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

/** Derive the keepkey.info icon URL from a CAIP identifier */
export function caipToIcon(caip: string): string {
  return `https://api.keepkey.info/coins/${btoa(caip).replace(/=+$/, '')}.png`
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

/** Bundled (offline-safe) icons for primary assets whose logo must never break —
 *  the remote CDN (caipToIcon) is unreachable in offline/airplane mode. Inline
 *  SVG data URIs so there's no asset-file/bundler coupling and no network fetch.
 *  Bitcoin first (btc-only wallets live and die on this one). */
const BITCOIN_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#f7931a"/><path fill="#fff" d="M46.1 27.9c.6-4.2-2.6-6.5-7-8l1.4-5.7-3.5-.9-1.4 5.6c-.9-.2-1.9-.4-2.8-.6l1.4-5.7-3.5-.9-1.4 5.7c-.7-.2-1.4-.3-2.1-.5l-4.8-1.2-.9 3.7s2.6.6 2.5.6c1.4.4 1.7 1.3 1.6 2l-3.8 15.2c-.2.4-.6 1-1.5.8 0 .1-2.6-.6-2.6-.6l-1.7 4 4.5 1.1c.8.2 1.7.4 2.5.7l-1.4 5.7 3.5.9 1.4-5.7c.9.3 1.9.5 2.8.7l-1.4 5.7 3.5.9 1.4-5.7c5.9 1.1 10.4.7 12.2-4.7 1.5-4.3-.1-6.8-3.2-8.4 2.3-.5 4-2 4.5-5.1zM38.3 43c-1 4.3-8.2 2-10.6 1.4l1.9-7.6c2.3.6 9.8 1.7 8.7 6.2zm1-15.3c-1 3.9-6.9 1.9-8.9 1.4l1.7-6.9c2 .5 8.1 1.4 7.2 5.5z"/></svg>`
const LOCAL_ICONS: Record<string, string> = {
  'bip122:000000000019d6689c085ae165831e93/slip44:0': `data:image/svg+xml,${encodeURIComponent(BITCOIN_SVG)}`,
}

/** Look up just the icon URL for a CAIP */
export function getAssetIcon(caip: string): string {
  if (LOCAL_ICONS[caip]) return LOCAL_ICONS[caip]
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
