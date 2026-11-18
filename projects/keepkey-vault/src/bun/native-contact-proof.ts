import { AsyncLocalStorage } from 'node:async_hooks'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import { EthereumTxMetadata } from '@keepkey/device-protocol/lib/messages-ethereum_pb'
import bs58 from 'bs58'
import bs58check from 'bs58check'
import { Address as TonAddress } from '@ton/core'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from './solana-tx'
import { decodeTronTransfer } from './tron-preview'
import { decodeTexAddress, p2pkhScript } from './txbuilder/zcash-tex'
import { ALL_CHAIN_CONTACT_CAPABILITY, buildContactProof, canonicalContactAddress, CONTACT_DESTINATION, type AddressBookCertification } from './addressbook-clearsign'

const starts = new Set([
  'SIGNTX', 'COSMOSSIGNTX', 'OSMOSISSIGNTX', 'THORCHAINSIGNTX', 'MAYACHAINSIGNTX',
  'RIPPLESIGNTX', 'EOSSIGNTX', 'NANOSIGNTX', 'SOLANASIGNTX', 'TRONSIGNTX',
  'TONSIGNTX', 'HIVESIGNTX', 'HIVESIGNOPERATIONS', 'ZCASHSIGNPCZT', 'MONEROTXINITREQUEST',
].map(name => (Messages.MessageType as any)[`MESSAGETYPE_${name}`]).filter(Number.isInteger))
const methods = ['btcSignTx', 'cosmosSignTx', 'osmosisSignTx', 'thorchainSignTx', 'mayachainSignTx',
  'rippleSignTx', 'eosSignTx', 'nanoSignTx', 'solanaSignTx', 'tronSignTx', 'tonSignTx',
  'hiveSignTx', 'hiveSignOperations', 'zcashSignPczt']
const context = new AsyncLocalStorage<{ proof?: string; sent?: boolean }>()
const installed = new WeakSet<object>()
const transports = new WeakSet<object>()
type ContactState = { enabled: boolean; passphrase: boolean; capabilities?: number[]; certificate?: AddressBookCertification }
const states = new WeakMap<object, () => ContactState>()

const rawBytes = (value: unknown): Buffer | undefined => value instanceof Uint8Array ? Buffer.from(value)
  : typeof value === 'string' ? Buffer.from(value.replace(/^0x/, ''), /^(?:0x)?(?:[0-9a-fA-F]{2})+$/.test(value) ? 'hex' : 'base64') : undefined

function tonSignerParams(params: any): any {
  if (typeof params?.toAddress !== 'string') return params
  try {
    const raw = canonicalContactAddress('ton:-239', params.toAddress)
    const workchain = raw.startsWith('-1:') ? -1 : 0
    // The wire contract expects a friendly address. Desktop also accepts raw
    // addresses; changing presentation leaves the exact signed account/hash
    // intact. Keep an explicit workchain claim for the device to verify.
    return { ...params,
      toAddress: /^(0|-1):/.test(params.toAddress)
        ? TonAddress.parseRaw(raw).toString({ bounceable: params.bounce !== false, testOnly: false }) : params.toAddress,
      ...(params.workchain === undefined ? { workchain } : {}),
    }
  } catch { return params } // malformed/testnet inputs must still be refused
}

function solanaRecipients(p: any): string[] {
  const raw = rawBytes(p?.rawTx)
  if (!raw) return []
  let parsed: ReturnType<typeof parseSolanaMessage> | undefined
  for (const message of [raw, ...(raw[0] === 0 ? [raw.subarray(1)] : [])]) {
    try { parsed = parseSolanaMessage(message); break } catch { /* try the transaction envelope */ }
  }
  if (!parsed) try { parsed = parseSolanaMessage(solanaMessageSlice(raw, parseSolanaTx(raw))) } catch { return [] }
  const owners = p?.tokenRecipientOwners ?? p?.tokenRecipientOwner ?? []
  if (Array.isArray(owners) && owners.length) return owners.map((owner: unknown) => {
    if (typeof owner === 'string') {
      try { const key = Buffer.from(bs58.decode(owner)); if (key.length === 32) return key } catch { /* hex/base64 below */ }
    }
    return rawBytes(owner)
  }).filter((b: Buffer | undefined) => b?.length === 32).map((b: Buffer) => bs58.encode(b))
  const keys = parsed.staticAccounts, recipients: string[] = []
  for (const ix of parsed.instructions) {
    const program = keys[ix.programIdIndex]
    if (!program) continue // an unproven lookup-table program
    const name = bs58.encode(program), data = Buffer.from(ix.data)
    let target: number | undefined
    if (name === '11111111111111111111111111111111' && data.length === 12 && [2, 5].includes(data.readUInt32LE(0))) target = ix.accountIndices[1]
    if (['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(name)) {
      if (data[0] === 12 || data[0] === 26) target = ix.accountIndices[2]
      else if (data[0] === 9) target = ix.accountIndices[1]
    }
    if (target !== undefined && keys[target]) recipients.push(bs58.encode(keys[target]))
  }
  return recipients
}

function namespaceFor(method: string, params: any): string | undefined {
  const p = Array.isArray(params) ? params[0] : params
  if (method === 'zcashSignPczt') return 'bip122:00040fe8ec8471911baa1db1266ea15d'
  if (method === 'btcSignTx') return ({ Bitcoin: 'bip122:000000000019d6689c085ae165831e93',
    Testnet: 'bip122:000000000933ea01ad0ee984209779ba',
    BitcoinCash: 'bip122:000000000000000000651ef99cb9fcbe', Litecoin: 'bip122:12a765e31ffd4059bada1e25190f6e98',
    Dogecoin: 'bip122:00000000001a91e3dace36e2be3bf030', Dash: 'bip122:000007d91d1254d60e2dd1ae58038307',
    DigiByte: 'bip122:4da631f2ac1bed857bd968c67c913978', Zcash: 'bip122:00040fe8ec8471911baa1db1266ea15d' } as Record<string, string>)[p?.coin] ||
      (typeof p?.coin === 'string' ? `keepkey:${Buffer.from(p.coin).toString('hex')}` : 'bip122:')
  if (/^(cosmos|osmosis|thorchain|mayachain)/.test(method)) {
    const chain = p?.tx?.chain_id ?? p?.tx?.chainId ?? p?.chain_id ?? p?.chainId
    return chain ? `cosmos:${chain}` : 'cosmos:'
  }
  if (method === 'eosSignTx') {
    const chain = p?.chainId ?? p?.chain_id
    return typeof chain === 'string' && /^[0-9a-fA-F]{64}$/.test(chain) ? `eos:${chain.slice(0, 32).toLowerCase()}` : 'eos:'
  }
  if (method === 'nanoSignTx') return p?.coin === 'Banano' ? 'banano:mainnet' : 'nano:mainnet'
  return ({ rippleSignTx: 'ripple:4109c6f2045fc7eff4cde8f9905d19c2',
    solanaSignTx: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    tronSignTx: 'tron:0x2b6653dc', tonSignTx: 'ton:-239', hiveSignTx: 'hive:beeab0de',
    hiveSignOperations: 'hive:beeab0de', monero: 'monero:418015bb9ae982a1975da7d79277c270' } as Record<string, string>)[method]
}

/** Select a candidate only. The device authenticates it, matches its exact
 * signed destination/network, and decides whether to show a name. This does
 * not return a UI assertion that a name was shown. */
export function nativeContactProof(cert: AddressBookCertification | undefined, params: unknown, method?: string): string | undefined {
  if (!cert) return
  const strings = new Set<string>()
  const bytes: Buffer[] = []
  const p: any = Array.isArray(params) ? params[0] : params
  let recipients: string[] | undefined
  if (method === 'rippleSignTx') {
    const payment = p?.payment
    const tag = payment?.destinationTag ?? payment?.destination_tag
    const number = typeof tag === 'string' && /^[0-9]{1,10}$/.test(tag) ? Number(tag) : tag
    // hdwallet supplies decimal strings. A tag belongs to the recipient:
    // never choose a bare-address proof ahead of a matching routed contact.
    recipients = typeof payment?.destination !== 'string' ? [] : tag === undefined
      ? [payment.destination]
      : Number.isInteger(number) && number >= 0 && number <= 0xffffffff
        ? [`${payment.destination}?dt=${number}`] : []
  }
  if (method === 'solanaSignTx') recipients = solanaRecipients(p)
  if (method === 'tronSignTx') {
    try { recipients = [decodeTronTransfer(rawBytes(p?.rawTx)?.toString('hex') || '').to] } catch { recipients = [] }
  }
  const visit = (value: unknown, depth = 0) => {
    if (depth > 16) return
    if (typeof value === 'string') {
      strings.add(value)
      if (value.length <= 65536) {
        if (/^(?:[0-9a-fA-F]{2})+$/.test(value)) bytes.push(Buffer.from(value, 'hex'))
        if (/^[A-Za-z0-9+/=_-]+$/.test(value)) bytes.push(Buffer.from(value, 'base64'))
      }
    } else if (value instanceof Uint8Array) bytes.push(Buffer.from(value))
    else if (value && typeof value === 'object') {
      const v: any = value
      const tag = v.destinationTag ?? v.destination_tag
      if (typeof v.destination === 'string' && Number.isInteger(tag) && tag >= 0 && tag <= 0xffffffff) strings.add(`${v.destination}?dt=${tag}`)
      for (const field of Object.values(value)) visit(field, depth + 1)
    }
  }
  visit(params)
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  // Prefer an explicit recipient over an account merely present in raw bytes.
  for (const binary of [false, true]) for (const contact of cert.contacts) {
    if (contact.destinationType !== CONTACT_DESTINATION.ADDRESS_TEXT) continue
    const namespace = method && namespaceFor(method, params)
    if (namespace && (namespace.endsWith(':') ? !contact.network.startsWith(namespace) : contact.network !== namespace)) continue
    const address = Buffer.from(contact.destination, 'hex').toString('ascii')
    let matches = recipients ? recipients.includes(address) : strings.has(address)
    if (recipients && !matches) continue
    if (!matches && method === 'zcashSignPczt') {
      const outputs = p?.transparent_outputs ?? p?.transparentOutputs ?? []
      try {
        const tex = address.toLowerCase().startsWith('tex1')
        const payload = tex ? undefined : Buffer.from(bs58check.decode(address))
        const hash = payload?.subarray(2).toString('hex')
        const script = tex ? p2pkhScript(decodeTexAddress(address))
          : payload?.length === 22 && payload[0] === 0x1c && payload[1] === 0xb8 ? `76a914${hash}88ac`
          : payload?.length === 22 && payload[0] === 0x1c && payload[1] === 0xbd ? `a914${hash}87` : undefined
        matches = !!script && outputs.some((o: any) => (o.script_pubkey ?? o.scriptPubkey)?.toLowerCase() === script && Boolean(o.is_tex ?? o.isTex) === tex)
      } catch { /* a shielded address is matched by its verified user_address */ }
    }
    if (binary && !matches && contact.network === 'hive:beeab0de') matches = bytes.some(b => b.includes(Buffer.from(address, 'ascii')))
    if (!matches && contact.network.startsWith('ton:')) {
      matches = [...strings].some(s => { try { return canonicalContactAddress(contact.network, s) === address } catch { return false } })
    }
    if (binary && !matches && /^(solana|tron):/.test(contact.network) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      let n = 0n
      for (const c of address) n = n * 58n + BigInt(alphabet.indexOf(c))
      const raw = Buffer.from(n.toString(16).padStart(contact.network.startsWith('solana:') ? 64 : 50, '0'), 'hex')
      const key = contact.network.startsWith('tron:') ? raw.subarray(0, 21) : raw
      matches = key.length === (contact.network.startsWith('tron:') ? 21 : 32) && bytes.some(b => b.includes(key))
    }
    if (matches) return buildContactProof(cert, contact.network, contact.destinationType, contact.destination)
  }
}

async function loadProof(call: (...args: any[]) => Promise<any>, proof: string) {
  const metadata = new EthereumTxMetadata()
  metadata.setSignedPayload(Buffer.from(proof, 'hex'))
  const ack = await call(Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA, metadata, { omitLock: true })
  if (ack?.message_enum !== Messages.MessageType.MESSAGETYPE_ETHEREUMMETADATAACK ||
      ack?.message?.classification !== 1 || ack?.message?.displaySummary !== 'Contact verified') throw new Error('Device rejected the certified contact proof; certify the address book again')
}

/** For the Monero delegate stream, which already holds the transport lock and
 * bypasses hdwallet.call. Must run inside that same locked signing operation. */
export async function preloadNativeContactProof(wallet: any, params: unknown, method: string) {
  const state = states.get(wallet)?.()
  if (!state?.enabled || state.passphrase || !state.capabilities?.includes(ALL_CHAIN_CONTACT_CAPABILITY)) return
  const proof = nativeContactProof(state.certificate, params, method)
  if (proof) await loadProof(wallet.transport.call.bind(wallet.transport), proof)
}

/** hdwallet acquires its lock before it writes a signing start. Inject there,
 * using omitLock only while that same lock is held. Earlier GetAddress or
 * GetFeatures calls cannot consume a pending proof. Every entry point using
 * this wallet (Desktop, RPC, swaps and PCZT) follows the same rule. */
export function installNativeContactProof(wallet: any, state: () => ContactState) {
  if (!wallet?.transport) return
  states.set(wallet, state)
  const transport = wallet.transport
  const call = transport.call.bind(transport)
  if (!transports.has(transport)) {
    transports.add(transport)
    transport.call = async (type: number, message: any, options?: any) => {
      const pending = context.getStore()
      if (!pending?.proof || pending.sent || !starts.has(type)) return call(type, message, options)
      pending.sent = true
      const sign = async () => {
        await loadProof(call, pending.proof!)
        return call(type, message, { ...options, omitLock: true })
      }
      return options?.omitLock ? sign() : transport.lockDuring(sign)
    }
  }
  if (installed.has(wallet)) return
  installed.add(wallet)
  for (const name of methods) {
    if (typeof wallet[name] !== 'function') continue
    const original = wallet[name].bind(wallet)
    wallet[name] = (...args: unknown[]) => {
      const current = states.get(wallet)!()
      const proof = current.enabled && !current.passphrase && current.capabilities?.includes(ALL_CHAIN_CONTACT_CAPABILITY)
        ? nativeContactProof(current.certificate, args, name) : undefined
      const signingArgs = name === 'tonSignTx' && current.capabilities?.includes(ALL_CHAIN_CONTACT_CAPABILITY)
        ? [tonSignerParams(args[0]), ...args.slice(1)] : args
      return context.run({ proof }, () => original(...signingArgs))
    }
  }
}
