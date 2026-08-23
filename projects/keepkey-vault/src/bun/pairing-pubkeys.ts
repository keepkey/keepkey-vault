/**
 * Mobile-pairing payload assembly (pure — no device, db or network).
 *
 * The pairing relay payload used to be re-derived from account-0 defaults, so a
 * wallet with funds in BTC account 1 or ETH account 2 paired a phone that
 * silently under-reported the portfolio (keepkey/keepkey-vault#406). The vault
 * already knows those accounts: BtcAccountManager, EvmAddressManager and the
 * device-scoped cached_pubkeys rows written by addUtxoAccount. This module turns
 * that known set into relay entries; index.ts does the I/O and passes it in.
 */
import { btcScriptTypeConfig, evmAddressPath } from '../shared/chains'
import type { BtcScriptType } from '../shared/types'
import { pathToBip32 } from './chain-scan'

export interface PairingEntry {
  type: string
  pubkey: string
  master: string
  address: string
  path: string
  pathMaster: string
  scriptType?: string
  available_scripts_types?: string[]
  note: string
  context: string
  networks: string[]
  addressNList: number[]
  addressNListMaster: number[]
}

/** One xpub from BtcAccountManager.getAllXpubMeta(). */
export interface BtcXpubMeta {
  xpub: string
  scriptType: BtcScriptType
  accountIndex: number
  path: number[]
}

/** One account-level xpub for a non-BTC UTXO chain (derived or cached). */
export interface UtxoXpub {
  chainId: string
  xpub: string
  scriptType?: string
  path: number[]
}

export interface UtxoChainInfo {
  id: string
  symbol: string
  networkId: string
  scriptType?: string
}

/** One tracked EVM address from EvmAddressManager.toAddressSet(). */
export interface EvmAddressMeta {
  address: string
  addressIndex: number
}

const masterOf = (accountPath: number[]) => [...accountPath, 0, 0]

/** BTC: one entry per (account, script type) the manager knows about. */
export function btcPairingEntries(
  xpubs: BtcXpubMeta[],
  networkId: string,
  context: string,
): PairingEntry[] {
  // The device-supported script set is whatever the manager derived.
  const available = [...new Set(xpubs.map(x => x.scriptType as string)), 'p2sh']
  const out: PairingEntry[] = []
  for (const x of xpubs) {
    if (!x.xpub || x.path.length < 3) continue
    const addressNList = x.path.slice(0, 3)
    const addressNListMaster = masterOf(addressNList)
    const cfg = btcScriptTypeConfig(x.scriptType)
    const label = cfg?.label || x.scriptType
    out.push({
      type: cfg?.xpubPrefix || 'xpub',
      pubkey: x.xpub,
      master: x.xpub,
      address: x.xpub, // SDK expects address field
      path: pathToBip32(addressNList),
      pathMaster: pathToBip32(addressNListMaster),
      scriptType: x.scriptType,
      available_scripts_types: available,
      note: x.accountIndex === 0 ? `Bitcoin ${label}` : `Bitcoin ${label} account ${x.accountIndex}`,
      context,
      networks: [networkId],
      addressNList,
      addressNListMaster,
    })
  }
  return out
}

/** Non-BTC UTXO: one entry per known account xpub, deduped by xpub. */
export function utxoPairingEntries(
  xpubs: UtxoXpub[],
  chains: UtxoChainInfo[],
  context: string,
): PairingEntry[] {
  const byId = new Map(chains.map(c => [c.id, c]))
  const seen = new Set<string>()
  const out: PairingEntry[] = []
  for (const x of xpubs) {
    const chain = byId.get(x.chainId)
    if (!chain || !x.xpub || seen.has(x.xpub) || x.path.length < 3) continue
    seen.add(x.xpub)
    const addressNList = x.path.slice(0, 3)
    const addressNListMaster = masterOf(addressNList)
    // Account index is the hardened element [2] — 0x80000000 for account 0.
    const accountIndex = addressNList[2] - 0x80000000
    const scriptType = x.scriptType || chain.scriptType
    out.push({
      type: 'xpub',
      pubkey: x.xpub,
      master: x.xpub,
      address: x.xpub,
      path: pathToBip32(addressNList),
      pathMaster: pathToBip32(addressNListMaster),
      scriptType,
      available_scripts_types: [scriptType || 'p2pkh'],
      note: accountIndex === 0 ? `${chain.symbol} Default path` : `${chain.symbol} account ${accountIndex}`,
      context,
      networks: [chain.networkId],
      addressNList,
      addressNListMaster,
    })
  }
  return out
}

/** EVM: one entry per tracked address index — every EVM chain shares the key. */
export function evmPairingEntries(
  addresses: EvmAddressMeta[],
  networks: string[],
  context: string,
): PairingEntry[] {
  const out: PairingEntry[] = []
  const seen = new Set<string>()
  for (const a of addresses) {
    if (!a.address || seen.has(a.address.toLowerCase())) continue
    seen.add(a.address.toLowerCase())
    const addressNListMaster = evmAddressPath(a.addressIndex)
    const addressNList = addressNListMaster.slice(0, 3)
    out.push({
      type: 'address',
      pubkey: a.address,
      master: a.address,
      address: a.address,
      path: pathToBip32(addressNList),
      pathMaster: pathToBip32(addressNListMaster),
      note: a.addressIndex === 0 ? 'ETH primary (default)' : `ETH account ${a.addressIndex}`,
      context,
      networks,
      addressNList,
      addressNListMaster,
    })
  }
  return out
}
