import type { ChainDef } from '../shared/chains'
import type { ChainBalance } from '../shared/types'
import { utxoDiscoveryKey } from './btc-backend/types'
import { pathToBip32, utxoAccountScriptPaths } from './chain-scan'
import type { BtcBackend } from './btc-backend/types'

export interface SavedPublicKey {
  chainId: string; xpub: string; address: string; path: string; scriptType: string
}
export interface PortfolioKey {
  caip: string; pubkey: string; sourcePubkey?: string; chainId: string; symbol: string
  networkId: string; path: string; scriptType: string
}

/** Optional fiat pricing must never decide whether an own-node UTXO refresh
 * succeeds. Fetch all accounts atomically: a failed account cannot zero another. */
export async function watchOnlyNodeBalances(backend: BtcBackend, keys: PortfolioKey[], quote: () => Promise<number>, cachedPrice = 0) {
  const validPrice = (value: number) => Number.isFinite(value * 21_000_000) && value > 0
  const [price, accounts] = await Promise.all([
    Promise.resolve().then(quote).then(value => {
      if (!validPrice(value)) throw new Error('No valid fiat quote')
      return { value, state: undefined as ChainBalance['fiatValueState'] }
    }).catch(() => ({ value: validPrice(cachedPrice) ? cachedPrice : 0, state: validPrice(cachedPrice) ? 'stale' as const : 'unavailable' as const })),
    (async () => {
      const accounts: Array<{ p: PortfolioKey; sats: bigint }> = []
      // Core permits one scantxoutset scan at a time.
      for (const p of keys) {
        const utxos = await backend.listUnspent({ network: p.networkId, xpub: p.sourcePubkey || p.pubkey, scriptType: p.scriptType })
        let sats = 0n
        for (const u of utxos) {
          if (!Number.isSafeInteger(u.value) || u.value < 0) throw new Error('Node returned an invalid UTXO amount')
          sats += BigInt(u.value)
        }
        if (sats > 2_100_000_000_000_000n) throw new Error('Node returned an invalid total balance')
        accounts.push({ p, sats })
      }
      return accounts
    })(),
  ])
  return {
    fiatValueState: price.state,
    entries: accounts.map(({ p, sats }) => ({
      caip: p.caip, pubkey: p.pubkey, networkId: p.networkId,
      balance: `${sats / 100_000_000n}.${(sats % 100_000_000n).toString().padStart(8, '0')}`,
      valueUsd: Number(sats) / 1e8 * price.value,
    })),
  }
}

/** Public-key inventory, never a receive address in place of an account xpub. */
export function watchOnlyPortfolioKeys(chains: ChainDef[], balances: ChainBalance[], saved: SavedPublicKey[]) {
  const pubkeys: PortfolioKey[] = []
  const incomplete = new Set<string>()
  for (const chain of chains) {
    if (!chain.caip || chain.chainFamily === 'zcash-shielded') continue
    const balance = balances.find(b => b.chainId === chain.id)
    const rows = saved.filter(p => p.chainId === chain.id)
    if (chain.chainFamily === 'utxo') {
      for (const b of balance?.breakdown || []) {
        if (b.xpub) rows.push({ ...b, chainId: chain.id, address: '' })
      }
      // Legacy installs only saved extra accounts. Do not overwrite the old
      // aggregate until reconnect has filled every account-0 script/path.
      if (chain.id !== 'bitcoin' && (balance || rows.length)) {
        const accounts = new Set([0, ...rows.map(p => Number(/\/(\d+)'$/.exec(p.path)?.[1] || 0))])
        for (const account of accounts) {
          if (utxoAccountScriptPaths(chain, account).some(sp => !rows.some(p => p.xpub && p.path === pathToBip32(sp.path) && p.scriptType === sp.scriptType))) incomplete.add(chain.id)
        }
      }
      if (balance && !rows.some(p => p.xpub)) incomplete.add(chain.id)
      for (const p of rows.filter(p => p.xpub)) pubkeys.push({
        caip: chain.caip, pubkey: utxoDiscoveryKey(p.xpub, p.scriptType || chain.scriptType), sourcePubkey: p.xpub,
        chainId: chain.id, symbol: chain.symbol, networkId: chain.networkId, path: p.path, scriptType: p.scriptType,
      })
    } else {
      for (const address of [...rows.map(p => p.address), balance?.address].filter((p): p is string => !!p)) {
        pubkeys.push({ caip: chain.caip, pubkey: address, chainId: chain.id, symbol: chain.symbol, networkId: chain.networkId, path: '', scriptType: '' })
      }
    }
  }
  const seen = new Set<string>()
  return { incomplete, pubkeys: pubkeys.filter(p => {
    const key = `${p.chainId}:${p.caip.startsWith('eip155:') ? p.pubkey.toLowerCase() : p.pubkey}`
    if (seen.has(key)) return false
    seen.add(key); return true
  }) }
}

/** Match BOTH network and owner; only EVM addresses are case insensitive. */
export function portfolioNativeMatch(entries: any[], key: PortfolioKey) {
  const normalize = (s: unknown) => typeof s === 'string' ? (key.caip.startsWith('eip155:') ? s.toLowerCase() : s) : ''
  const owners = [key.pubkey, key.sourcePubkey].filter(Boolean).map(normalize)
  return entries.find(d => {
    const network = String(d.caip || '').split('/')[0].toLowerCase() || String(d.networkId || '').toLowerCase()
    return network === key.caip.split('/')[0].toLowerCase()
      && (owners.includes(normalize(d.pubkey)) || owners.includes(normalize(d.address)))
  })
}

export function watchOnlyNativeBalances(pubkeys: PortfolioKey[], entries: any[], failed: Set<string>) {
  const totals = new Map<string, ChainBalance>()
  for (const p of pubkeys) {
    const match = portfolioNativeMatch(entries, p)
    const amount = Number(match?.balance), usd = Number(match?.valueUsd ?? 0)
    if (!match || match.balance == null || String(match.balance).trim() === '' || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(usd)) { failed.add(p.chainId); continue }
    const row: ChainBalance = totals.get(p.chainId) || { chainId: p.chainId, symbol: p.symbol, balance: '0', balanceUsd: 0, nativeBalanceUsd: 0, address: match.address || p.pubkey }
    row.balance = String(Number(row.balance) + amount)
    row.balanceUsd += usd
    row.nativeBalanceUsd = row.balanceUsd
    if (p.sourcePubkey) (row.breakdown ||= []).push({ xpub: p.sourcePubkey, path: p.path, scriptType: p.scriptType, balance: String(match.balance), balanceUsd: usd })
    totals.set(p.chainId, row)
  }
  return [...totals.values()]
}

/** Re-derive tracked accounts too: old path-only rows may have lost a script. */
export function trackedUtxoScriptPaths(chain: ChainDef, saved: SavedPublicKey[], includeDgbTaproot = false) {
  const accounts = new Set([0])
  for (const p of saved.filter(p => p.chainId === chain.id)) {
    const match = /^m\/\d+'\/\d+'\/(\d+)'$/.exec(p.path)
    if (match && Number(match[1]) < 0x80000000) accounts.add(Number(match[1]))
  }
  return [...accounts].sort((a, b) => a - b).flatMap(account => utxoAccountScriptPaths(chain, account, false, includeDgbTaproot))
}
