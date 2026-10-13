import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assetData from '../src/shared/assetData.json'

// isKnownAsset() reads assetData.json and is the symbol-squatter guard's only
// escape hatch, so a discovery-listed asset missing from the bundle renders as
// "NOT THE REAL X". That hit the real TRON USDT ("Tether (TRON)") and every
// Solana LST / wrapped BTC. Fix drift with `make sync-asset-data`.
test('assetData.json covers every pioneer-discovery asset', () => {
  const discovery = JSON.parse(readFileSync(
    join(import.meta.dir, '../node_modules/@pioneer-platform/pioneer-discovery/lib/generatedAssetData.json'), 'utf8'))
  const missing = Object.keys(discovery).filter(caip => !(caip in assetData))
  expect(missing).toEqual([])
})
