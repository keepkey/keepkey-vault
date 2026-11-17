import { createPublicClient, custom, getAddress } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize, toCoinType } from 'viem/ens'
import { isEnsName, type ResolvedEnsContact } from '../shared/ens'
import type { AddressBookEntry } from '../shared/types'
import { ethRpc } from './evm-rpc'

// ENS lives on mainnet even when the requested address belongs to an L2.
// Keep node selection with the configured Pioneer service.
export type EnsAddressLookup = (name: string, coinType: bigint) => Promise<string | null>
export function createEnsAddressLookup(rpc: typeof ethRpc = ethRpc): EnsAddressLookup {
  const client = createPublicClient({
    chain: mainnet,
    transport: custom({ request: ({ method, params }) => rpc('eip155:1', method, (params ?? []) as any[]) }, { retryCount: 0 }),
  })
  return (name, coinType) => client.getEnsAddress({ name, coinType, strict: true })
}
const lookup = createEnsAddressLookup()

export async function resolveEnsContact(
  name: string, networkId: string, resolve: EnsAddressLookup = lookup,
): Promise<ResolvedEnsContact> {
  if (!/^eip155:[1-9]\d*$/.test(networkId)) throw new Error('ENS contacts require an EVM network')
  const chainId = Number(networkId.slice(7))
  if (!Number.isSafeInteger(chainId) || chainId >= 0x80000000) throw new Error('This network has no ENS EVM coin type')
  if (!isEnsName(name)) throw new Error('Enter an ENS name')
  const ensName = normalize(name.trim())
  const coinType = toCoinType(chainId)
  const address = await resolve(ensName, coinType)
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) {
    throw new Error(`No address is set for ${ensName} on ${networkId}`)
  }
  return { ensName, address: getAddress(address) }
}

/** Retry old name-as-address contacts when the book is explicitly opened.
 * Failed lookups leave the original row intact, for correction or a later retry. */
export async function repairLegacyEnsContacts(
  entries: AddressBookEntry[],
  resolve: (name: string, networkId: string) => Promise<ResolvedEnsContact>,
  persist: (entry: AddressBookEntry, resolved: ResolvedEnsContact) => boolean,
): Promise<boolean> {
  let changed = false
  const pending = new Map<string, Promise<ResolvedEnsContact>>()
  for (const entry of entries) {
    if (entry.kind !== 'external' || !entry.networkId.startsWith('eip155:') || !isEnsName(entry.address)) continue
    const key = `${entry.networkId}:${entry.address.trim().toLowerCase()}`
    try {
      let result = pending.get(key)
      if (!result) { result = resolve(entry.address, entry.networkId); pending.set(key, result) }
      if (persist(entry, await result)) changed = true
    } catch (error) {
      console.warn(`[addressbook] ENS lookup failed for ${entry.address}:`, error instanceof Error ? error.message : error)
    }
  }
  return changed
}
