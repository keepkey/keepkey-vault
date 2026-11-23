import { describe, expect, test } from 'bun:test'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import { buildCertificationRequest, contactAddress, contactsFromEntries, CONTACT_DESTINATION, type AddressBookCertification } from './addressbook-clearsign'
import { installNativeContactProof, nativeContactProof } from './native-contact-proof'
import bs58 from 'bs58'
import { decodeTexAddress, p2pkhScript } from './txbuilder/zcash-tex'
import { rippleSignTx as sdkRippleSignTx } from '@keepkey/hdwallet-keepkey/dist/ripple'
import { Address as TonAddress } from '@ton/core'

function certificate(network = 'cosmos:cosmoshub-4', address = 'cosmos1CaseSensitive', label = 'Alice'): AddressBookCertification {
  const contacts = [{ network, destinationType: CONTACT_DESTINATION.ADDRESS_TEXT,
    destination: Buffer.from(address).toString('hex'), label }]
  return { version: 1, revision: 1, contacts, root: buildCertificationRequest(contacts, 1).root.toString('hex'),
    signature: '55'.repeat(64), publicKey: '02' + '44'.repeat(32), certifiedAt: 1 }
}

describe('all-chain contact encoding', () => {
  test('preserves exact non-EVM address case and gates older firmware to EVM', () => {
    const entry = { kind: 'external', label: 'Alice', networkId: 'cosmos:cosmoshub-4', address: 'cosmos1CaseSensitive' } as any
    expect(contactsFromEntries([entry])).toEqual([])
    const contacts = contactsFromEntries([entry], true, true)
    expect(contacts[0].destinationType).toBe(4)
    expect(contactAddress(contacts[0])).toBe(entry.address)
  })
  test('reaches the full 5550-byte envelope and rejects an oversized destination', () => {
    const contacts = Array.from({ length: 16 }, (_, i) => ({ network: 'bip122:' + '1'.repeat(56), destinationType: 4,
      destination: Buffer.from('A'.repeat(254) + i.toString(16)).toString('hex'), label: 'L'.repeat(22) + i.toString().padStart(2, '0') }))
    expect(buildCertificationRequest(contacts, 1).payload.length).toBe(5550)
    expect(() => buildCertificationRequest([{ ...contacts[0], destination: '41'.repeat(256) }], 1)).toThrow()
    expect(() => buildCertificationRequest([{ ...contacts[0], destination: '410042' }], 1)).toThrow()
    expect(() => buildCertificationRequest([{ ...contacts[0], label: 'Alice  Smith' }], 1)).toThrow()
  })
  test('binds chain and address and never uses EVM proofs in native signers', () => {
    const cert = certificate()
    expect(nativeContactProof(cert, [{ tx: { chain_id: 'cosmoshub-4', to_address: 'cosmos1CaseSensitive' } }], 'cosmosSignTx')).toBeDefined()
    expect(nativeContactProof(cert, [{ tx: { chain_id: 'cosmoshub-wrong', to_address: 'cosmos1CaseSensitive' } }], 'cosmosSignTx')).toBeUndefined()
    expect(nativeContactProof(cert, [{ to_address: 'cosmos1casesensitive' }], 'cosmosSignTx')).toBeUndefined()
    expect(nativeContactProof(cert, [{ toAddress: 'cosmos1CaseSensitive' }], 'tonSignTx')).toBeUndefined()
  })
  test('uses hdwallet string XRP tags, distinguishes zero from absence, and prefers the routed recipient', () => {
    const network = 'ripple:4109c6f2045fc7eff4cde8f9905d19c2', address = 'rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws'
    const bare = certificate(network, address, 'Bare'), routed = certificate(network, `${address}?dt=42`, 'Routed')
    const contacts = [...bare.contacts, ...routed.contacts]
    const cert = { ...bare, contacts, root: buildCertificationRequest(contacts, 1).root.toString('hex') }
    const proof = nativeContactProof(cert, [{ payment: { destination: address, destinationTag: '42' } }], 'rippleSignTx')
    expect(proof).toBeDefined()
    expect(Buffer.from(proof!, 'hex').includes(Buffer.from(`${address}?dt=42`))).toBe(true)
    expect(nativeContactProof(bare, [{ payment: { destination: address, destinationTag: '42' } }], 'rippleSignTx')).toBeUndefined()
    expect(nativeContactProof(routed, [{ payment: { destination: address, destinationTag: '43' } }], 'rippleSignTx')).toBeUndefined()
    const zero = certificate(network, `${address}?dt=0`)
    for (const tag of ['0', '000', 0]) expect(nativeContactProof(zero, [{ payment: { destination: address, destinationTag: tag } }], 'rippleSignTx')).toBeDefined()
    expect(nativeContactProof(zero, [{ payment: { destination: address } }], 'rippleSignTx')).toBeUndefined()
    for (const tag of ['42junk', '-1', '4294967296', -1]) expect(nativeContactProof(cert, [{ payment: { destination: address, destinationTag: tag } }], 'rippleSignTx')).toBeUndefined()
    expect(nativeContactProof(bare, [{ payment: { destination: address } }], 'rippleSignTx')).toBeDefined()
  })
  test('selects the signed Solana recipient rather than a certified payer or arbitrary raw key', () => {
    const payer = Buffer.alloc(32, 0x11), recipient = Buffer.alloc(32, 0x22)
    const network = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    const first = certificate(network, bs58.encode(payer), 'Payer')
    const second = certificate(network, bs58.encode(recipient), 'Payee')
    const contacts = [...first.contacts, ...second.contacts]
    const cert = { ...first, contacts, root: buildCertificationRequest(contacts, 1).root.toString('hex') }
    const data = Buffer.alloc(12); data.writeUInt32LE(2); data.writeBigUInt64LE(1000n, 4)
    const raw = Buffer.concat([Buffer.from([0, 1, 0, 1, 3]), payer, recipient, Buffer.alloc(32),
      Buffer.alloc(32, 0xbb), Buffer.from([1, 2, 2, 0, 1, 12]), data])
    const proof = nativeContactProof(cert, [{ rawTx: raw.toString('base64') }], 'solanaSignTx')
    expect(proof).toBeDefined()
    expect(Buffer.from(proof!, 'hex').includes(Buffer.from(bs58.encode(recipient)))).toBe(true)
    expect(nativeContactProof(first, [{ rawTx: raw }], 'solanaSignTx')).toBeUndefined()
  })
  test('unproven Solana lookup destinations produce no host proof', () => {
    const payer = Buffer.alloc(32, 0x11), destination = Buffer.alloc(32, 0x22)
    const data = Buffer.alloc(12); data.writeUInt32LE(2); data.writeBigUInt64LE(1000n, 4)
    const raw = Buffer.concat([Buffer.from([0x80, 1, 0, 1, 2]), payer, Buffer.alloc(32),
      Buffer.alloc(32, 0xbb), Buffer.from([1, 1, 2, 0, 2, 12]), data,
      Buffer.from([1]), Buffer.alloc(32, 0x44), Buffer.from([1, 0, 0])])
    const cert = certificate('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', bs58.encode(destination))
    expect(nativeContactProof(cert, [{ rawTx: raw, lutAccounts: [destination] }], 'solanaSignTx')).toBeUndefined()
  })
  test('accepts both SDK public-key forms for a Solana owner hint without trusting it as a device match', () => {
    const payer = Buffer.alloc(32, 0x11), owner = Buffer.alloc(32, 0x22)
    const data = Buffer.alloc(12); data.writeUInt32LE(2); data.writeBigUInt64LE(1000n, 4)
    const raw = Buffer.concat([Buffer.from([0, 1, 0, 1, 3]), payer, owner, Buffer.alloc(32),
      Buffer.alloc(32, 0xbb), Buffer.from([1, 2, 2, 0, 1, 12]), data])
    const cert = certificate('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', bs58.encode(owner))
    for (const key of [owner, bs58.encode(owner), owner.toString('hex'), owner.toString('base64')]) {
      expect(nativeContactProof(cert, [{ rawTx: raw, tokenRecipientOwners: [key] }], 'solanaSignTx')).toBeDefined()
    }
    expect(nativeContactProof(cert, [{ rawTx: raw, tokenRecipientOwners: [Buffer.alloc(32, 0x33)] }], 'solanaSignTx')).toBeUndefined()
  })
  test('matches transparent PCZT scripts while preserving TEX routing semantics', () => {
    const address = 'tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte'
    const cert = certificate('bip122:00040fe8ec8471911baa1db1266ea15d', address)
    const output = { script_pubkey: p2pkhScript(decodeTexAddress(address)), is_tex: true }
    expect(nativeContactProof(cert, [{ transparent_outputs: [output] }], 'zcashSignPczt')).toBeDefined()
    expect(nativeContactProof(cert, [{ transparent_outputs: [{ ...output, is_tex: false }] }], 'zcashSignPczt')).toBeUndefined()
    expect(nativeContactProof(cert, [{ transparent_outputs: [{ ...output, script_pubkey: '76a914' + '00'.repeat(20) + '88ac' }] }], 'zcashSignPczt')).toBeUndefined()
  })
  test('finds a Hive account inside the bounded serialized operation, with device matching still required', () => {
    const cert = certificate('hive:beeab0de', 'kkfriend')
    expect(nativeContactProof(cert, [{ serializedTx: Buffer.from('wire kkfriend operation').toString('hex') }], 'hiveSignOperations')).toBeDefined()
  })
})

function walletFixture(classification = 1) {
  const calls: number[] = []
  let held = false
  const transport: any = {
    lockDuring: async (action: () => Promise<any>) => {
      if (held) throw new Error('nested lock')
      held = true
      try { return await action() } finally { held = false }
    },
    call: async (type: number, _message: unknown, options: any) => {
      expect(held).toBe(true)
      expect(options.omitLock).toBe(true)
      calls.push(type)
      if (type === Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA) return {
        message_enum: Messages.MessageType.MESSAGETYPE_ETHEREUMMETADATAACK,
        message: { classification, displaySummary: classification === 1 ? 'Contact verified' : 'Invalid contact' },
      }
      return { signature: 'unchanged' }
    },
  }
  const wallet = { transport, cosmosSignTx: async (_params: unknown) => wallet.transport.lockDuring(async () => {
    await wallet.transport.call(Messages.MessageType.MESSAGETYPE_GETFEATURES, {}, { omitLock: true })
    return wallet.transport.call(Messages.MessageType.MESSAGETYPE_COSMOSSIGNTX, {}, { omitLock: true })
  }) }
  return { wallet, calls }
}

describe('proof delivery shares the signer lock', () => {
  test('adapts raw TON destinations and omitted workchains without changing signed data or caller objects', async () => {
    const transport = { call: async () => undefined }
    const wallet = { transport, tonSignTx: async (params: any) => params }
    installNativeContactProof(wallet, () => ({ enabled: false, passphrase: false, capabilities: [32] }))
    for (const workchain of [0, -1]) {
      const raw = `${workchain}:${'AA'.repeat(32)}`
      const input = { toAddress: raw, rawTx: '11'.repeat(32), amount: '1000000000', bounce: false, memo: 'rent' }
      const output = await wallet.tonSignTx(input)
      expect(TonAddress.parseFriendly(output.toAddress).address.toRawString()).toBe(raw.toLowerCase())
      expect(TonAddress.parseFriendly(output.toAddress).isTestOnly).toBe(false)
      expect(output.workchain).toBe(workchain)
      expect(output.rawTx).toBe(input.rawTx)
      expect(output.amount).toBe(input.amount)
      expect(output.memo).toBe(input.memo)
      expect(input.toAddress).toBe(raw)
      expect('workchain' in input).toBe(false)
      const claimed = await wallet.tonSignTx({ ...input, workchain: workchain === 0 ? -1 : 0 })
      expect(claimed.workchain).toBe(workchain === 0 ? -1 : 0)
    }
    const testnet = TonAddress.parseRaw(`0:${'aa'.repeat(32)}`).toString({ testOnly: true })
    const invalid = { toAddress: testnet, rawTx: '11'.repeat(32) }
    expect(await wallet.tonSignTx(invalid)).toBe(invalid)
  })
  test('delivers a string-tag proof through the real hdwallet Ripple adapter', async () => {
    const address = 'rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws', calls: number[] = []
    let held = false
    const transport: any = {
      lockDuring: async (action: () => Promise<any>) => {
        expect(held).toBe(false); held = true
        try { return await action() } finally { held = false }
      },
      call: async (type: number, message: any, options: any) => {
        expect(held).toBe(true); expect(options.omitLock).toBe(true); calls.push(type)
        if (type === Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA) {
          expect(Buffer.from(message.getSignedPayload_asU8()).includes(Buffer.from(`${address}?dt=42`))).toBe(true)
          return { message_enum: Messages.MessageType.MESSAGETYPE_ETHEREUMMETADATAACK,
            message: { classification: 1, displaySummary: 'Contact verified' } }
        }
        expect(message.getPayment().getDestination()).toBe(address)
        expect(message.getPayment().hasDestinationTag()).toBe(true)
        expect(message.getPayment().getDestinationTag()).toBe(42)
        return { message_enum: Messages.MessageType.MESSAGETYPE_RIPPLESIGNEDTX,
          proto: { getSerializedTx_asB64: () => 'AA==', getSignature_asB64: () => 'AQ==' } }
      },
    }
    const wallet = { transport, rippleSignTx: (params: any) => sdkRippleSignTx(transport, params) }
    installNativeContactProof(wallet, () => ({ enabled: true, passphrase: false, capabilities: [32],
      certificate: certificate('ripple:4109c6f2045fc7eff4cde8f9905d19c2', `${address}?dt=42`) }))
    await wallet.rippleSignTx({ addressNList: [], sequence: '1', lastLedgerSequence: '2',
      payment: { amount: '1000', destination: address, destinationTag: '42' },
      tx: { value: { fee: { amount: [{ amount: '12' }] }, msg: [] } } })
    expect(calls).toEqual([Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA, Messages.MessageType.MESSAGETYPE_RIPPLESIGNTX])
  })
  for (const eligible of [true, false]) test(eligible ? 'injects directly before signing inside the existing lock' : 'keeps old firmware working without a preload', async () => {
    const { wallet, calls } = walletFixture()
    installNativeContactProof(wallet, () => ({ enabled: true, passphrase: false, capabilities: eligible ? [32] : [27], certificate: certificate() }))
    expect(await wallet.cosmosSignTx({ tx: { chain_id: 'cosmoshub-4', to_address: 'cosmos1CaseSensitive' } })).toEqual({ signature: 'unchanged' })
    expect(calls).toEqual([Messages.MessageType.MESSAGETYPE_GETFEATURES,
      ...(eligible ? [Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA] : []), Messages.MessageType.MESSAGETYPE_COSMOSSIGNTX])
  })
  test('a rejected certificate aborts before sending the signing request', async () => {
    const { wallet, calls } = walletFixture(2)
    installNativeContactProof(wallet, () => ({ enabled: true, passphrase: false, capabilities: [32], certificate: certificate() }))
    await expect(wallet.cosmosSignTx({ to_address: 'cosmos1CaseSensitive' })).rejects.toThrow('Device rejected')
    expect(calls).not.toContain(Messages.MessageType.MESSAGETYPE_COSMOSSIGNTX)
  })
  test('hidden sessions do not preload saved contacts', async () => {
    const { wallet, calls } = walletFixture()
    installNativeContactProof(wallet, () => ({ enabled: true, passphrase: true, capabilities: [32], certificate: certificate() }))
    await wallet.cosmosSignTx({ to_address: 'cosmos1CaseSensitive' })
    expect(calls).not.toContain(Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA)
  })
  test('a replacement transport gets one preload and uses the current wallet state', async () => {
    const first = walletFixture(), next = walletFixture()
    const state = () => ({ enabled: true, passphrase: false, capabilities: [32], certificate: certificate() })
    installNativeContactProof(first.wallet, state)
    first.wallet.transport = next.wallet.transport
    installNativeContactProof(first.wallet, state)
    installNativeContactProof(first.wallet, state)
    await first.wallet.cosmosSignTx({ to_address: 'cosmos1CaseSensitive' })
    expect(first.calls).toEqual([])
    expect(next.calls.filter(n => n === Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA)).toHaveLength(1)
    installNativeContactProof(first.wallet, () => ({ ...state(), passphrase: true }))
    await first.wallet.cosmosSignTx({ to_address: 'cosmos1CaseSensitive' })
    expect(next.calls.filter(n => n === Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA)).toHaveLength(1)
  })
})
