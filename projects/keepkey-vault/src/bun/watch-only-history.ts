import type { ChainDef } from '../shared/chains'
import type { ChainBalance } from '../shared/types'
import { utxoDiscoveryKey } from './btc-backend/types'
import { createHash } from 'node:crypto'

export function watchOnlyWalletScope(deviceId: string, storedSeed: string | null | undefined) {
  if (!deviceId || !storedSeed || !/^0x[0-9a-f]{40}$/i.test(storedSeed)) return null
  return { deviceId, walletId: `${deviceId}:${storedSeed.toLowerCase()}` }
}

/** Bitcoin-only firmware has no ETH seed address. Its saved account xpubs
 * provide a stable, device-bound scope without exposing an xpub in the ID. */
export function watchOnlyBitcoinScope(deviceId: string, pubkeys: Array<{ chainId: string; xpub: string }>) {
  const xpubs = [...new Set(pubkeys.filter(p => p.chainId === 'bitcoin' && p.xpub).map(p => p.xpub))].sort()
  if (!deviceId || !xpubs.length) return null
  const fingerprint = createHash('sha256').update(xpubs.join('\0')).digest('hex')
  return { deviceId, walletId: `${deviceId}:btc:${fingerprint}` }
}

/** Uses only the selected snapshot's public data. Never derive from a live
 * device, which may belong to another wallet or a hidden session. */
export function cachedHistoryQueries(chain: ChainDef, balances: ChainBalance[], pubkeys: Array<{
  chainId: string; address: string; xpub: string; path: string; scriptType: string
}>) {
  const cached = pubkeys.filter(p => p.chainId === chain.id)
  const queries = chain.chainFamily === 'utxo'
    ? cached.filter(p => p.xpub).map(p => ({ caip: chain.caip, pubkey: utxoDiscoveryKey(p.xpub, p.scriptType || chain.scriptType || 'p2pkh'), label: 'cached account', path: p.path, scriptType: p.scriptType }))
    : [...cached.map(p => p.address), ...balances.filter(b => b.chainId === chain.id).map(b => b.address)]
      .filter((address): address is string => !!address)
      .map(address => ({ caip: chain.caip, pubkey: address, label: 'cached address' }))
  return queries.filter((q, i) => queries.findIndex(other => other.pubkey === q.pubkey) === i)
}
