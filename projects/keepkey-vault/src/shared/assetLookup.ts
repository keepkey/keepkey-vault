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

/** Look up just the icon URL for a CAIP */
export function getAssetIcon(caip: string): string {
  const map = getAssetMap()
  if (!map) return caipToIcon(caip)
  const entry = map[caip]
  return entry?.icon || caipToIcon(caip)
}
