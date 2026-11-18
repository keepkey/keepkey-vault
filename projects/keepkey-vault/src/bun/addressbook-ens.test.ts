import { describe, expect, test } from 'bun:test'
import { createEnsAddressLookup, resolveEnsContact, repairLegacyEnsContacts } from './addressbook-ens'
import { encodeAbiParameters, toHex } from 'viem'
import { mainnet } from 'viem/chains'
import { previewCertificationEntries, contactsFromEntries, buildCertificationRequest } from './addressbook-clearsign'
import type { AddressBookEntry } from '../shared/types'

const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const entry = (id: string, destination = 'alice.eth'): AddressBookEntry => ({
  id, walletId: id, deviceId: 'device', kind: 'external', networkId: 'eip155:8453',
  chainId: 'base', address: destination, label: 'Old label', savedAt: 1, createdAt: 1, updatedAt: 1,
})

describe('ENS address-book resolution', () => {
  test('uses the mainnet Universal Resolver over the configured RPC adapter for a Base record', async () => {
    const calls: any[] = []
    const lookup = createEnsAddressLookup(async (network, method, params) => {
      calls.push({ network, method, params })
      return encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [
        encodeAbiParameters([{ type: 'bytes' }], [address]), '0x' + '1'.repeat(40) as `0x${string}`,
      ])
    })
    expect(await resolveEnsContact('alice.eth', 'eip155:8453', lookup)).toEqual({ ensName: 'alice.eth', address })
    expect(calls).toHaveLength(1)
    expect(calls[0].network).toBe('eip155:1')
    expect(calls[0].method).toBe('eth_call')
    expect(calls[0].params[0].to).toBe(mainnet.contracts.ensUniversalResolver.address)
    expect(calls[0].params[0].data).toContain(toHex(2147492101n, { size: 32 }).slice(2))
  })

  test('normalizes the name and requests the selected chain record', async () => {
    const calls: unknown[] = []
    const lookup = async (name: string, coinType: bigint) => { calls.push([name, coinType]); return address }
    expect(await resolveEnsContact(' Alice.ETH ', 'eip155:1', lookup)).toEqual({ ensName: 'alice.eth', address })
    expect(await resolveEnsContact('Alice.eth', 'eip155:8453', lookup)).toEqual({ ensName: 'alice.eth', address })
    expect(calls).toEqual([['alice.eth', 60n], ['alice.eth', 2147492101n]])
    expect(await resolveEnsContact('Alice.xyz', 'eip155:1', lookup)).toEqual({ ensName: 'alice.xyz', address })
  })

  test('rejects missing, zero and malformed records, and propagates lookup failures', async () => {
    for (const result of [null, '', '0x' + '0'.repeat(40), 'alice.eth', '0x1234']) {
      await expect(resolveEnsContact('alice.eth', 'eip155:1', async () => result)).rejects.toThrow('No address is set')
    }
    await expect(resolveEnsContact('alice.eth', 'eip155:1', async () => { throw new Error('RPC unavailable') })).rejects.toThrow('RPC unavailable')
  })

  test('invalid names and non-EVM networks never reach lookup', async () => {
    const lookup = async () => { throw new Error('lookup must not run') }
    for (const [name, network] of [['alice.eth', 'bip122:123'], ['alice.eth', 'eip155:0'], ['alice.eth', 'eip155:2147483648'], ['alice..eth', 'eip155:1'], ['alice_name.eth', 'eip155:1']]) {
      await expect(resolveEnsContact(name, network, lookup)).rejects.not.toThrow('lookup must not run')
    }
  })

  test('repairs legacy names across wallets with one lookup, leaving pinned destinations alone', async () => {
    let lookups = 0
    const persisted: unknown[] = []
    expect(await repairLegacyEnsContacts([entry('a'), entry('b'), entry('canonical', address)],
      async () => { lookups++; return { ensName: 'alice.eth', address } },
      (e, result) => { persisted.push([e.id, result]); return true })).toBe(true)
    expect(lookups).toBe(1)
    expect(persisted).toEqual(['a', 'b'].map(id => [id, { ensName: 'alice.eth', address }]))
  })

  test('failed resolution never overwrites a legacy contact', async () => {
    let writes = 0
    expect(await repairLegacyEnsContacts([entry('a')], async () => { throw new Error('no record') }, () => { writes++; return true })).toBe(false)
    expect(writes).toBe(0)
  })

  test('unresolved names and invalid labels cannot poison certification preview', () => {
    const valid = { ...entry('valid', address), label: 'alice.eth', ensName: 'alice.eth', isEns: true }
    const preview = previewCertificationEntries([valid, entry('legacy'), { ...entry('long', address), label: 'a'.repeat(25) }, { ...entry('spaces', address), label: 'Alice  ETH' }])
    expect(preview.contacts).toEqual([{ label: 'alice.eth', network: 'eip155:8453', address: address.toLowerCase() }])
    expect(preview.excluded).toHaveLength(3)
    expect(preview.excluded[0].reason).toContain('ENS name has not resolved')
    expect(buildCertificationRequest(contactsFromEntries([valid]), 1).root).toHaveLength(32)
  })

  test('native account names remain native while unresolved EVM names stay excluded', () => {
    const hive = { ...entry('hive', 'alice.eth'), networkId: 'hive:beeab0de', label: 'Hive friend' }
    const solana = { ...entry('sol', 'So11111111111111111111111111111111111111112'), networkId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', label: 'Sol friend' }
    const preview = previewCertificationEntries([hive, solana, entry('unresolved')], true)
    expect(preview.contacts).toEqual([
      { label: 'Hive friend', network: hive.networkId, address: 'alice.eth' },
      { label: 'Sol friend', network: solana.networkId, address: solana.address },
    ])
    expect(preview.excluded).toHaveLength(1)
    expect(preview.excluded[0].network).toBe('eip155:8453')
    expect(previewCertificationEntries([hive, solana]).contacts).toEqual([])
    expect(() => buildCertificationRequest(contactsFromEntries([hive, solana], true, true), 1)).not.toThrow()
  })
})
