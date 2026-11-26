import { createHash } from 'crypto'
import type { AddressBookEntry, AddressBookCertificationPreview } from '../shared/types'
import { isEnsName } from '../shared/ens'
import { firmwareClearSigns } from './calldata-decoder'

const REQUEST_MAGIC = Buffer.from('KKABREQ1', 'ascii')
const ROOT_MAGIC = Buffer.from('KKABRT01', 'ascii')
const PROOF_MAGIC = Buffer.from('KKABPRF1', 'ascii')
const LEAF_MAGIC = Buffer.from('KKABLEAF', 'ascii')
export const ADDRESS_BOOK_CLEARSIGN_VERSION = 1
export const ADDRESS_BOOK_CLEARSIGN_MAX_ENTRIES = 16
export const ADDRESS_BOOK_CLEARSIGN_LABEL_MAX = 24
export const CONTACT_DESTINATION = { EVM_ADDRESS: 1, UTXO_SCRIPT: 2, ACCOUNT_BYTES: 3, ADDRESS_TEXT: 4 } as const
export const ALL_CHAIN_CONTACT_CAPABILITY = 32

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
  /** The KeepKey that signed it. Older certificates lack it. */
  deviceId?: string
}

/** A certificate only works on the KeepKey that signed it. On another device
 *  the contact is sent as an ordinary, uncertified one until re-certified. */
export function certificateForDevice(cert: AddressBookCertification | undefined, deviceId: string | null | undefined): AddressBookCertification | undefined {
  return cert && (!cert.deviceId || cert.deviceId === deviceId) ? cert : undefined
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
  if (!/^[0-9a-f]+$/.test(destination) || destination.length % 2 || destination.length > 510) throw new Error('Invalid canonical destination bytes')
  if (contact.destinationType === CONTACT_DESTINATION.EVM_ADDRESS && (!network.startsWith('eip155:') || destination.length !== 40)) throw new Error('Invalid EVM destination')
  if (contact.destinationType === CONTACT_DESTINATION.ADDRESS_TEXT &&
      !/^[\x21-\x7e]+$/.test(Buffer.from(destination, 'hex').toString('latin1'))) throw new Error('Invalid canonical address text')
  const label = contact.label.trim()
  const encoded = Buffer.from(label, 'ascii')
  if (!label || encoded.length > ADDRESS_BOOK_CLEARSIGN_LABEL_MAX || encoded.toString('ascii') !== label ||
      /[%\x00-\x1f\x7f-\xff]| {2}/.test(label)) {
    throw new Error(`Contact label must be 1-${ADDRESS_BOOK_CLEARSIGN_LABEL_MAX} printable ASCII characters without % or consecutive spaces`)
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

function contactCandidate(entry: AddressBookEntry, allChains: boolean): entry is AddressBookEntry & { label: string } {
  return entry.kind === 'external' && !!entry.label && (allChains || entry.networkId.startsWith('eip155:'))
}

function contactFromEntry(entry: AddressBookEntry & { label: string }): CertifiedContact {
  const isEvm = entry.networkId.startsWith('eip155:')
  return normalizeContact({
    network: entry.networkId,
    destinationType: isEvm ? CONTACT_DESTINATION.EVM_ADDRESS : CONTACT_DESTINATION.ADDRESS_TEXT,
    destination: isEvm ? entry.address : Buffer.from(canonicalContactAddress(entry.networkId, entry.address), 'ascii').toString('hex'),
    label: entry.label,
  })
}

function compareContacts(a: CertifiedContact, b: CertifiedContact): number {
  return a.network.localeCompare(b.network) || a.destinationType - b.destinationType
    || a.destination.localeCompare(b.destination) || a.label.localeCompare(b.label)
}

export function contactsFromEntries(entries: AddressBookEntry[], enforceLimit = true, allChains = false): CertifiedContact[] {
  const contacts = entries
    .filter((entry): entry is AddressBookEntry & { label: string } => contactCandidate(entry, allChains))
    .map(contactFromEntry)
    .sort(compareContacts)
  if (enforceLimit && contacts.length > ADDRESS_BOOK_CLEARSIGN_MAX_ENTRIES) {
    throw new Error(`Alpha firmware supports at most ${ADDRESS_BOOK_CLEARSIGN_MAX_ENTRIES} certified contacts`)
  }
  return contacts
}

function reviewCertificationEntries(entries: AddressBookEntry[], allChains: boolean) {
  const contacts: CertifiedContact[] = []
  const excluded: AddressBookCertificationPreview['excluded'] = []
  for (const entry of entries) {
    if (!contactCandidate(entry, allChains)) continue
    try {
      if (entry.networkId.startsWith('eip155:') && isEnsName(entry.address)) throw new Error('ENS name has not resolved to an address')
      contacts.push(contactFromEntry(entry))
    } catch (error) {
      excluded.push({ label: entry.label, network: entry.networkId, address: entry.address,
        reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { contacts: contacts.sort(compareContacts), excluded }
}

export function previewCertificationEntries(entries: AddressBookEntry[], allChains = false): AddressBookCertificationPreview {
  const { contacts, excluded } = reviewCertificationEntries(entries, allChains)
  return { contacts: contacts.map(c => ({ label: c.label, network: c.network, address: contactAddress(c) })), excluded }
}

export function selectCertificationContacts(
  entries: AddressBookEntry[],
  allChains: boolean,
  only?: { network: string; address: string }[],
): CertifiedContact[] {
  const { contacts } = reviewCertificationEntries(entries, allChains)
  if (!only) return contacts
  const selected = new Set(only.map(({ network, address }) => `${network}|${address}`))
  return contacts.filter(c => selected.has(`${c.network}|${contactAddress(c)}`))
}

/** A TON friendly address contains presentation flags; the signed destination
 * is workchain:hash. Validate its checksum before removing those flags. */
export function canonicalContactAddress(network: string, address: string): string {
  if (!network.startsWith('ton:')) return address
  if (/^(0|-1):[0-9a-fA-F]{64}$/.test(address)) return address.toLowerCase()
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(address)) throw new Error('Invalid TON contact address')
  const raw = Buffer.from(address, 'base64url')
  let crc = 0
  for (const byte of raw.subarray(0, 34)) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff
  }
  if (raw.length !== 36 || ![0x11, 0x51].includes(raw[0]) || ![0, 255].includes(raw[1]) || crc !== raw.readUInt16BE(34)) throw new Error('Invalid mainnet TON contact address')
  return `${raw[1] === 255 ? -1 : 0}:${raw.subarray(2, 34).toString('hex')}`
}

export function contactAddress(contact: CertifiedContact): string {
  return contact.destinationType === CONTACT_DESTINATION.EVM_ADDRESS ? `0x${contact.destination}` : Buffer.from(contact.destination, 'hex').toString('ascii')
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

// ── Device answers (firmware #951) ───────────────────────────────────────────
// Legacy 7.16 builds with and without #951 share messages and version numbers.
// EVM acknowledgement still comes from the device answer. Native contact
// delivery additionally requires the explicit all-chain capability above.

const MESSAGETYPE_ETHEREUMMETADATAACK = 116
/** EthereumMetadataAck.display_summary for an accepted contact proof. */
export const CONTACT_VERIFIED_SUMMARY = 'Contact verified'

/**
 * Run `sign` and report whether the device acknowledged the contact proof
 * hdwallet sends ahead of it with "Contact verified". hdwallet only logs the
 * EthereumMetadataAck (and swallows the Failure a build without #951 returns),
 * so the transport's per-message event is where the answer is visible. Only
 * that exact answer counts: "Invalid contact", MALFORMED, a Failure or no
 * answer at all mean the device showed no certified label.
 */
export async function signWithContactProofAck<T>(
  transport: { on?: (event: string, fn: (e: any) => void) => unknown; off?: (event: string, fn: (e: any) => void) => unknown } | undefined,
  sign: () => Promise<T>,
): Promise<{ result: T; contactVerified: boolean }> {
  let ack: { classification?: number; displaySummary?: string } | undefined
  const listener = (event: any) => { if (!ack) ack = event?.message ?? {} }
  const name = String(MESSAGETYPE_ETHEREUMMETADATAACK)
  transport?.on?.(name, listener)
  try {
    const result = await sign()
    return { result, contactVerified: ack?.classification === 1 && ack?.displaySummary === CONTACT_VERIFIED_SUMMARY }
  } finally {
    transport?.off?.(name, listener)
  }
}

export const ADDRESS_BOOK_CERTIFY_UNSUPPORTED =
  'This firmware build cannot certify contacts (it has no address-book ClearSign). Nothing was certified; sends still show the full address on the device.'

/**
 * A 7.16 build without #951 routes a KKABREQ1 request into the Solana schema
 * attestor, which answers with one of these failures. A build with #951
 * answers "Invalid address book" for a bad request instead, never these.
 */
export function isAddressBookCertifyUnsupported(message: string): boolean {
  return /AdvancedMode required for schema attestation|Invalid schema|Attestor cannot review this schema version/i.test(message)
}

/** May a contact proof go with this send? One metadata message per transaction,
 *  so a proof only goes when nothing else describes the call, or when Desktop's
 *  own certified schema would just repeat what the device already shows natively
 *  (a native-coin send, or a transfer of a token in the firmware's own table).
 *  A caller's metadata or an ERC-7730 definition always wins. */
export function contactProofAllowed(p: {
  to?: string; data?: string; chainId: number; value?: unknown; firmwareVersion?: string
  callerMetadata: boolean; schemaAttached: boolean; erc7730: boolean
}): boolean {
  if (p.callerMetadata || p.erc7730) return false
  if (!p.schemaAttached) return true
  const data = String(p.data || '')
  return /^(0x)?$/.test(data)
    || (data.toLowerCase().startsWith('0xa9059cbb') && firmwareClearSigns(p.to, data, p.chainId, p.firmwareVersion, p.value))
}
