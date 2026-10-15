import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assetData from '../src/shared/assetData.json'
import { syncSkips } from '../src/shared/asset-sync-policy'

// isKnownAsset() reads assetData.json and is the symbol-squatter guard's only
// escape hatch, so a discovery-listed asset missing from the bundle renders as
// "NOT THE REAL X". That hit the real TRON USDT ("Tether (TRON)") and every
// Solana LST / wrapped BTC. Fix drift with `make sync-asset-data`.
test('assetData.json covers every pioneer-discovery asset', () => {
  const discovery = JSON.parse(readFileSync(
    join(import.meta.dir, '../node_modules/@pioneer-platform/pioneer-discovery/lib/generatedAssetData.json'), 'utf8'))
  const missing = Object.keys(discovery).filter(caip => !(caip in assetData) && !syncSkips(caip, discovery[caip].symbol))
  expect(missing).toEqual([])
})

// Memecoins named after a chain ticker must never be whitelisted by the sync.
test('the sync never adds a token whose symbol is a chain ticker', () => {
  expect(syncSkips('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:2kaRSuDcpump', 'ETH')).toBe(true)
  expect(syncSkips('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:x', ' btc ')).toBe(true)
  expect(syncSkips('eip155:1/slip44:60', 'ETH')).toBe(false)
  expect(syncSkips('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:So11111111111111111111111111111111111111112', 'SOL')).toBe(false)
  expect(syncSkips('cosmos:thorchain-mainnet-v1/denom:btc-btc', 'BTC')).toBe(false)
  expect(syncSkips('cosmos:thorchain-mainnet-v1/denom:x/fakebtc', 'BTC')).toBe(true)
  expect(syncSkips('tron:27Lqcw/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'USDT')).toBe(false)
})
