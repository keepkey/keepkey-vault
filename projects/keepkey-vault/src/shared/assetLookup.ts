/**
 * Asset data lookup by CAIP identifier.
 *
 * The JSON stores a slim representation:
 *   - `assetId` omitted (== the key)
 *   - `chainId` omitted (== key.split('/')[0])
 *   - `icon` omitted when derivable from CAIP via keepkey.info convention
 *
 * This module reconstitutes the full entry at lookup time.
 */
import assetDataRaw from './assetData.json'

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

const assetMap = assetDataRaw as Record<string, SlimAssetEntry>

/** Derive the keepkey.info icon URL from a CAIP identifier */
export function caipToIcon(caip: string): string {
  return `https://api.keepkey.info/coins/${btoa(caip).replace(/=+$/, '')}.png`
}

/** Look up a full asset entry by CAIP */
export function getAsset(caip: string): AssetEntry | undefined {
  const entry = assetMap[caip]
  if (!entry) return undefined
  return {
    assetId: caip,
    chainId: caip.split('/')[0],
    icon: entry.icon || caipToIcon(caip),
    color: entry.color || '#888',
    ...entry,
  }
}

/** Look up just the icon URL for a CAIP */
export function getAssetIcon(caip: string): string {
  const entry = assetMap[caip]
  return entry?.icon || caipToIcon(caip)
}
