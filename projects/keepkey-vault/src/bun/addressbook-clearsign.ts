import { createHash } from 'crypto'
import type { AddressBookEntry } from '../shared/types'

const REQUEST_MAGIC = Buffer.from('KKABREQ1', 'ascii')
const ROOT_MAGIC = Buffer.from('KKABRT01', 'ascii')
const PROOF_MAGIC = Buffer.from('KKABPRF1', 'ascii')
const LEAF_MAGIC = Buffer.from('KKABLEAF', 'ascii')
export const ADDRESS_BOOK_CLEARSIGN_VERSION = 1
export const ADDRESS_BOOK_CLEARSIGN_MAX_ENTRIES = 16
export const ADDRESS_BOOK_CLEARSIGN_LABEL_MAX = 24
export const CONTACT_DESTINATION = { EVM_ADDRESS: 1, UTXO_SCRIPT: 2, ACCOUNT_BYTES: 3 } as const

export interface CertifiedContact {
  network: string
  destinationType: number
  destination: string
  label: string
}

export interface AddressBookCertification {
  version: 1
  revision: number
  contacts: CertifiedContact[]
  root: string
  signature: string
  publicKey: string
  certifiedAt: number
}

const u32 = (value: number) => {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value >>> 0)
  return out
}

function normalizeContact(contact: CertifiedContact): CertifiedContact {
  const network = contact.network.trim()
  if (!/^[A-Za-z0-9-]+:[A-Za-z0-9-]+$/.test(network) || Buffer.byteLength(network) > 63) throw new Error(`Invalid CAIP-2 network: ${contact.network}`)
  if (!Number.isInteger(contact.destinationType) || contact.destinationType <= 0 || contact.destinationType > 255) throw new Error('Invalid destination type')
  const destination = contact.destination.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]+$/.test(destination) || destination.length % 2 || destination.length > 128) throw new Error('Invalid canonical destination bytes')
  if (contact.destinationType === CONTACT_DESTINATION.EVM_ADDRESS && (!network.startsWith('eip155:') || destination.length !== 40)) throw new Error('Invalid EVM destination')
  const label = contact.label.trim()
  const encoded = Buffer.from(label, 'ascii')
  if (!label || encoded.length > ADDRESS_BOOK_CLEARSIGN_LABEL_MAX || encoded.toString('ascii') !== label ||
      /[%\x00-\x1f\x7f-\xff]/.test(label)) {
    throw new Error(`Contact label must be 1-${ADDRESS_BOOK_CLEARSIGN_LABEL_MAX} printable ASCII characters without %`)
  }
  return { network, destinationType: contact.destinationType, destination, label }
}

function entryBytes(contact: CertifiedContact): Buffer {
  const c = normalizeContact(contact)
  const network = Buffer.from(c.network, 'ascii')
  const destination = Buffer.from(c.destination, 'hex')
  const label = Buffer.from(c.label, 'ascii')
  return Buffer.concat([Buffer.from([network.length]), network, Buffer.from([c.destinationType, destination.length]), destination, Buffer.from([label.length]), label])
}

function hash(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest()
}

function leaf(contact: CertifiedContact): Buffer {
  return hash(Buffer.concat([LEAF_MAGIC, entryBytes(contact)]))
}

function tree(contacts: CertifiedContact[]): Buffer[][] {
  if (!contacts.length || contacts.length > ADDRESS_BOOK_CLEARSIGN_MAX_ENTRIES) {
    throw new Error(`Address Book certification requires 1-${ADDRESS_BOOK_CLEARSIGN_MAX_ENTRIES} contacts`)
  }
  const first = contacts.map(leaf)
  let width = 1
  while (width < first.length) width <<= 1
  while (first.length < width) first.push(Buffer.from(first[first.length - 1]))
  const levels = [first]
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1]
    const next: Buffer[] = []
    for (let i = 0; i < current.length; i += 2) next.push(hash(Buffer.concat([current[i], current[i + 1]])))
    levels.push(next)
  }
  return levels
}

export function contactsFromEntries(entries: AddressBookEntry[]): CertifiedContact[] {
  const contacts = entries
    .filter(entry => entry.kind === 'external' && !!entry.label && entry.networkId.startsWith('eip155:'))
    .map(entry => normalizeContact({ network: entry.networkId, destinationType: CONTACT_DESTINATION.EVM_ADDRESS, destination: entry.address, label: entry.label! }))
    .sort((a, b) => a.network.localeCompare(b.network) || a.destinationType - b.destinationType || a.destination.localeCompare(b.destination) || a.label.localeCompare(b.label))
  if (contacts.length > ADDRESS_BOOK_CLEARSIGN_MAX_ENTRIES) {
    throw new Error(`Alpha firmware supports at most ${ADDRESS_BOOK_CLEARSIGN_MAX_ENTRIES} certified contacts`)
  }
  return contacts
}

export function buildCertificationRequest(contacts: CertifiedContact[], revision: number): { payload: Buffer; root: Buffer } {
  if (!Number.isSafeInteger(revision) || revision <= 0 || revision > 0xffffffff) throw new Error('Invalid certification revision')
  const normalized = contacts.map(normalizeContact)
  const levels = tree(normalized)
  const root = levels[levels.length - 1][0]
  return {
    payload: Buffer.concat([REQUEST_MAGIC, Buffer.from([ADDRESS_BOOK_CLEARSIGN_VERSION]), u32(revision), Buffer.from([normalized.length]), ...normalized.map(entryBytes)]),
    root,
  }
}

export function manifestBytes(cert: Pick<AddressBookCertification, 'version' | 'revision' | 'contacts' | 'root'>): Buffer {
  const root = Buffer.from(cert.root, 'hex')
  if (cert.version !== 1 || root.length !== 32) throw new Error('Invalid address-book manifest')
  return Buffer.concat([ROOT_MAGIC, Buffer.from([cert.version]), u32(cert.revision), Buffer.from([cert.contacts.length]), root])
}

export function buildContactProof(cert: AddressBookCertification, network: string, destinationType: number, destination: string): string | undefined {
  const normalizedDestination = destination.toLowerCase().replace(/^0x/, '')
  const index = cert.contacts.findIndex(c => c.network === network && c.destinationType === destinationType && c.destination === normalizedDestination)
  if (index < 0) return undefined
  const levels = tree(cert.contacts)
  if (levels[levels.length - 1][0].toString('hex') !== cert.root.toLowerCase()) throw new Error('Stored address-book root does not match contacts')
  const siblings: Buffer[] = []
  let cursor = index
  for (let level = 0; level < levels.length - 1; level++) {
    siblings.push(levels[level][cursor ^ 1])
    cursor >>= 1
  }
  const publicKey = Buffer.from(cert.publicKey, 'hex')
  const signature = Buffer.from(cert.signature, 'hex')
  if (publicKey.length !== 33 || signature.length !== 64) throw new Error('Invalid stored address-book attestation')
  const payload = Buffer.concat([
    PROOF_MAGIC,
    Buffer.from([cert.version]), u32(cert.revision), Buffer.from([cert.contacts.length]), Buffer.from(cert.root, 'hex'),
    publicKey, signature, entryBytes(cert.contacts[index]), Buffer.from([index, siblings.length]), ...siblings,
  ])
  if (payload.length > 1024) throw new Error('Address-book proof exceeds firmware metadata limit')
  return payload.toString('hex')
}

export function evmRecipient(params: any): { chainId: number; address: string } | undefined {
  const chainId = Number(params?.chainId)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return undefined
  const data = typeof params?.data === 'string' ? params.data.toLowerCase().replace(/^0x/, '') : ''
  if (data.startsWith('a9059cbb') && data.length === 8 + 64 + 64) {
    return { chainId, address: `0x${data.slice(8 + 24, 8 + 64)}` }
  }
  const to = String(params?.to || '').toLowerCase()
  return /^0x[0-9a-f]{40}$/.test(to) ? { chainId, address: to } : undefined
}
