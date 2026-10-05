import { describe, expect, test } from 'bun:test'
import { EventEmitter2 } from 'eventemitter2'
import { buildCertificationRequest, buildContactProof, CONTACT_DESTINATION, evmRecipient, isAddressBookCertifyUnsupported, signWithContactProofAck, type AddressBookCertification } from '../src/bun/addressbook-clearsign'

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

// hdwallet-keepkey's Transport is an EventEmitter2 that emits every device
// message under its type number (readResponse: emit(String(msgTypeEnum), event)).
const ack = (classification: number, displaySummary: string) =>
  ({ message_type: 'EthereumMetadataAck', message_enum: 116, message: { classification, displaySummary }, from_wallet: true })

describe('address-book ClearSign device answers (firmware #951)', () => {
  test('a contact is certified only when the device answers "Contact verified"', async () => {
    const transport = new EventEmitter2()
    const signed = await signWithContactProofAck(transport, async () => {
      transport.emit('116', ack(1, 'Contact verified'))
      return { v: 1 }
    })
    expect(signed).toEqual({ result: { v: 1 }, contactVerified: true })
    expect(transport.listenerCount('116')).toBe(0)
  })

  test('an invalid proof, a contract-metadata ack, a swallowed Failure or no transport is not a certified contact', async () => {
    for (const answer of [ack(2, 'Invalid contact'), ack(1, 'Verified'), ack(0, 'Unverified')]) {
      const transport = new EventEmitter2()
      const signed = await signWithContactProofAck(transport, async () => { transport.emit('116', answer); return 'sig' })
      expect(signed.contactVerified).toBe(false)
    }
    // A 7.16 build without #951 answers with a Failure, which hdwallet swallows: no ack.
    const silent = new EventEmitter2()
    expect((await signWithContactProofAck(silent, async () => 'sig')).contactVerified).toBe(false)
    expect((await signWithContactProofAck(undefined, async () => 'sig')).contactVerified).toBe(false)
  })

  test('the listener is removed when signing fails', async () => {
    const transport = new EventEmitter2()
    await expect(signWithContactProofAck(transport, async () => { throw new Error('Signing cancelled by user') })).rejects.toThrow('cancelled')
    expect(transport.listenerCount('116')).toBe(0)
  })

  test('certification is unsupported only on the answers a build without #951 gives', () => {
    // Pre-#951 fsm_msgClearsignAttestorSign: the Solana schema attestor.
    expect(isAddressBookCertifyUnsupported('AdvancedMode required for schema attestation')).toBe(true)
    expect(isAddressBookCertifyUnsupported('Invalid schema')).toBe(true)
    expect(isAddressBookCertifyUnsupported('Attestor cannot review this schema version')).toBe(true)
    // #951's own answers, and the user's decision, are not "unsupported".
    expect(isAddressBookCertifyUnsupported('Invalid address book')).toBe(false)
    expect(isAddressBookCertifyUnsupported('Action cancelled by user')).toBe(false)
  })
})
