import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { VaultAddressBook, certifiableAddressBookEntries } from './vault-addressbook'
import {
  assertVaultDestination,
  BASE_ETH_CAIP,
  BASE_NETWORK,
  BASE_USDC_CAIP,
  BITCOIN_CAIP,
  BITCOIN_NETWORK,
  bitcoinVaultIdentity,
  safeVaultIdentity,
} from '../shared/vault-identity'
import {
  buildCertificationRequest,
  buildContactProof,
  contactsFromEntries,
  CONTACT_DESTINATION,
} from './addressbook-clearsign'
import type { SafeAccount } from '../shared/safe-multisig'
import { CHAINS } from '../shared/chains'
const safe: SafeAccount = {
  address: '0x1111111111111111111111111111111111111111',
  name: 'Shared treasury',
  owners: ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'],
  threshold: 2,
  nonce: '0',
  deployed: true,
}
const scope = { walletId: 'device:seed', deviceId: 'device' }
describe('Vault identities and address book projection', () => {
  test('Safe identity binds Base chain, CAIP-10, native ETH and exact native USDC contract', () => {
    const v = safeVaultIdentity(safe, false)
    expect(v.networkId).toBe('eip155:8453')
    expect(v.accountId).toBe(`${BASE_NETWORK}:${safe.address}`)
    expect(v.supportedAssets.map((a) => a.caip)).toEqual([BASE_ETH_CAIP, BASE_USDC_CAIP])
    expect(v.cosigners.map((c) => c.address)).toEqual(safe.owners)
    expect(v.certificationLabel).toBe('Base Safe Shared treasur')
    expect(CHAINS.find((c) => c.id === 'base')?.networkId).toBe(BASE_NETWORK)
    expect(CHAINS.find((c) => c.id === 'base')?.caip).toBe(BASE_ETH_CAIP)
    expect(CHAINS.find((c) => c.id === 'bitcoin')?.caip).toBe(BITCOIN_CAIP)
  })
  test('same hexadecimal Safe address on Ethereum or another rollup is rejected', () => {
    const v = safeVaultIdentity(safe, false)
    for (const network of ['eip155:1', 'eip155:10', 'eip155:42161', 'eip155:84532']) {
      expect(() => assertVaultDestination([v], network, safe.address, `${network}/slip44:60`)).toThrow(
        'Wrong network'
      )
    }
    expect(() => assertVaultDestination([v], BASE_NETWORK, safe.address, BASE_ETH_CAIP)).not.toThrow()
    expect(() =>
      assertVaultDestination(
        [v],
        BASE_NETWORK,
        safe.address.toUpperCase().replace('0X', '0x'),
        BASE_USDC_CAIP
      )
    ).not.toThrow()
  })
  test('symbols never substitute for exact token identity, including bridged USDC and wrong-chain CAIPs', () => {
    const v = safeVaultIdentity(safe, false)
    for (const asset of [
      'USDC',
      `${BASE_NETWORK}/erc20:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca`,
      'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      `${BASE_NETWORK}/erc20:0x0000000000000000000000000000000000000000`,
    ]) {
      expect(() => assertVaultDestination([v], BASE_NETWORK, safe.address, asset)).toThrow('not supported')
    }
  })
  test('unconfirmed deployment never becomes a funding target or certificate entry', () => {
    const v = safeVaultIdentity({ ...safe, deployed: false }, false)
    expect(v.receiveEnabled).toBe(false)
    expect(() => assertVaultDestination([v], BASE_NETWORK, safe.address, BASE_ETH_CAIP)).toThrow(
      'not confirmed deployed'
    )
    const db = new Database(':memory:'),
      book = new VaultAddressBook(db)
    book.sync(scope, 'safe', [v])
    const entry = book.list()[0]
    const alias = { ...entry, id: 'old-contact', vault: undefined, label: 'Old saved label' }
    expect(certifiableAddressBookEntries([entry], [alias])).toHaveLength(0)
    db.close()
  })
  test('Bitcoin-only vault binds mainnet genesis, receive address and cosigner xpubs', () => {
    const v = bitcoinVaultIdentity({
      id: 'policy-hash',
      name: 'BTC treasury',
      descriptor: 'wsh(sortedmulti(...))',
      scriptType: 'p2wsh',
      threshold: 2,
      address: 'bc1qexample',
      saved: true,
      sessionOnly: false,
      cosigners: [
        { fingerprint: '12345678', path: "m/48'/0'/0'/2'", xpub: 'public-key-1', ours: true },
        { fingerprint: '87654321', path: "m/48'/0'/0'/2'", xpub: 'public-key-2', ours: false },
      ],
    })
    expect(v.networkId).toBe(BITCOIN_NETWORK)
    expect(v.supportedAssets.map((a) => a.caip)).toEqual([BITCOIN_CAIP])
    expect(v.cosigners[1].xpub).toBe('public-key-2')
    expect(v.certificationLabel).toBeUndefined()
    expect(() =>
      assertVaultDestination([v], 'bip122:000000000933ea01ad0ee984209779ba', v.address, BITCOIN_CAIP)
    ).toThrow('Wrong network')
  })
  test('projection preserves old contact table and idempotence; owner changes invalidate the projection', () => {
    const db = new Database(':memory:')
    db.exec(
      "CREATE TABLE addressbook (id TEXT,kind TEXT CHECK(kind IN ('own','external'))); INSERT INTO addressbook VALUES ('contact','external')"
    )
    const book = new VaultAddressBook(db),
      v = safeVaultIdentity(safe, false)
    expect(book.sync(scope, 'safe', [v])).toBe(true)
    expect(book.sync(scope, 'safe', [v])).toBe(false)
    expect(book.list()[0].vault?.threshold).toBe(2)
    expect(book.list('eip155:1')).toHaveLength(0)
    expect(book.list(BASE_NETWORK, 'other-wallet')).toHaveLength(0)
    expect(db.query('SELECT * FROM addressbook').all()).toEqual([{ id: 'contact', kind: 'external' }])
    expect(book.sync(scope, 'safe', [{ ...v, threshold: 1 }])).toBe(true)
    expect(book.list()[0].vault?.threshold).toBe(1)
    expect(book.sync(scope, 'safe', [])).toBe(true)
    expect(book.list()).toHaveLength(0)
    db.close()
  })
  test('hidden identities cannot be persisted', () => {
    const db = new Database(':memory:'),
      book = new VaultAddressBook(db)
    expect(() => book.sync(scope, 'safe', [safeVaultIdentity(safe, true)])).toThrow('cannot be persisted')
    expect(book.list()).toHaveLength(0)
    db.close()
  })
  test('cross-device copies resolve to one latest reviewed vault identity and do not produce duplicate certificates', () => {
    const db = new Database(':memory:'),
      book = new VaultAddressBook(db),
      v = safeVaultIdentity(safe, false)
    book.sync(scope, 'safe', [v])
    book.sync({ walletId: 'second-seed', deviceId: 'second-device' }, 'safe', [
      { ...v, name: 'Same shared account', threshold: 1 },
    ])
    expect(book.list()).toHaveLength(1)
    expect(book.list()[0].vault?.threshold).toBe(1)
    book.sync(scope, 'safe', [{ ...v, name: 'Reviewed again' }])
    expect(book.list()).toHaveLength(1)
    expect(book.list()[0].vault?.threshold).toBe(2)
    expect(certifiableAddressBookEntries(book.list(), [])).toHaveLength(1)
    db.close()
  })
  test('destination certification binds exact network and address but does not include owner claims', () => {
    const db = new Database(':memory:'),
      book = new VaultAddressBook(db)
    const v = safeVaultIdentity(safe, false)
    book.sync(scope, 'safe', [v])
    const contacts = contactsFromEntries(
      book.list().map((e) => ({ ...e, label: e.vault!.certificationLabel }))
    )
    const built = buildCertificationRequest(contacts, 1)
    // Serialization fixture only; no attestation signature is claimed verified here.
    const cert = {
      version: 1 as const,
      revision: 1,
      contacts,
      root: built.root.toString('hex'),
      signature: '22'.repeat(64),
      publicKey: '02' + '11'.repeat(32),
      certifiedAt: Date.now(),
    }
    expect(contacts[0].label).toStartWith('Base Safe ')
    expect(buildContactProof(cert, BASE_NETWORK, CONTACT_DESTINATION.EVM_ADDRESS, safe.address)).toBeDefined()
    expect(buildContactProof(cert, 'eip155:1', CONTACT_DESTINATION.EVM_ADDRESS, safe.address)).toBeUndefined()
    expect(
      buildContactProof(cert, BASE_NETWORK, CONTACT_DESTINATION.EVM_ADDRESS, safe.owners[0])
    ).toBeUndefined()
    expect(Object.keys(contacts[0]).sort()).toEqual(['destination', 'destinationType', 'label', 'network'])
    db.close()
  })
})
