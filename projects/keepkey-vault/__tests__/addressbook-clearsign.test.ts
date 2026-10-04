import { describe, expect, test } from 'bun:test'
import { buildCertificationRequest, buildContactProof, CONTACT_DESTINATION, evmRecipient, type AddressBookCertification } from '../src/bun/addressbook-clearsign'

const contacts = [
  { network: 'eip155:1', destinationType: CONTACT_DESTINATION.EVM_ADDRESS, destination: '11'.repeat(20), label: 'Alice' },
  { network: 'eip155:137', destinationType: CONTACT_DESTINATION.EVM_ADDRESS, destination: '22'.repeat(20), label: 'Bob' },
  { network: 'eip155:1', destinationType: CONTACT_DESTINATION.EVM_ADDRESS, destination: '33'.repeat(20), label: 'Carol' },
]

describe('address-book ClearSign', () => {
  test('builds deterministic bulk request and compact inclusion proof', () => {
    const built = buildCertificationRequest(contacts, 7)
    expect(built.payload.subarray(0, 8).toString()).toBe('KKABREQ1')
    expect(built.root.toString('hex')).toHaveLength(64)
    const cert: AddressBookCertification = {
      version: 1, revision: 7, contacts, root: built.root.toString('hex'),
      publicKey: `02${'44'.repeat(32)}`, signature: '55'.repeat(64), certifiedAt: 1,
    }
    const proof = buildContactProof(cert, contacts[1].network, contacts[1].destinationType, contacts[1].destination)!
    expect(Buffer.from(proof, 'hex').subarray(0, 8).toString()).toBe('KKABPRF1')
    expect(buildContactProof(cert, 'eip155:1', CONTACT_DESTINATION.EVM_ADDRESS, '99'.repeat(20))).toBeUndefined()
  })

  test('extracts native and canonical ERC-20 recipients', () => {
    const first = `0x${contacts[0].destination}`
    const second = `0x${contacts[1].destination}`
    expect(evmRecipient({ chainId: 1, to: first })).toEqual({ chainId: 1, address: first })
    const data = `0xa9059cbb${'0'.repeat(24)}${contacts[1].destination}${'0'.repeat(63)}1`
    expect(evmRecipient({ chainId: 137, to: first, data })).toEqual({ chainId: 137, address: second })
  })

  test('rejects unsafe labels', () => {
    expect(() => buildCertificationRequest([{ ...contacts[0], label: 'Bob\nConfirm' }], 1)).toThrow()
    expect(() => buildCertificationRequest([{ ...contacts[0], label: 'Bøb' }], 1)).toThrow()
  })

  test('uses the same manifest for non-EVM destination types', () => {
    const mixed = [...contacts, {
      network: 'bip122:000000000019d6689c085ae165831e93',
      destinationType: CONTACT_DESTINATION.UTXO_SCRIPT,
      destination: '0014' + '44'.repeat(20),
      label: 'Bob BTC',
    }]
    const built = buildCertificationRequest(mixed, 8)
    expect(built.payload.subarray(0, 8).toString()).toBe('KKABREQ1')
    expect(built.root.toString('hex')).toHaveLength(64)
  })
})
