/** Local Bitcoin QR transport. Decoding never signs, broadcasts or fetches data. */
import './bitcoin-qr-runtime'
import { Buffer } from 'buffer'
import { UR, UREncoder, URDecoder } from '@ngraveio/bc-ur'
import Bytewords from '@ngraveio/bc-ur/dist/bytewords'
import { base32nopad, base64, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { Inflate } from 'fflate'

export const MAX_QR_BYTES = 1024 * 1024
const MAX_FRAME = 8192
const MAX_PARTS = 4096
const B43 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:'
export type BitcoinQrFormat = 'ur' | 'bbqr' | 'electrum'
export type BitcoinQrPayload = { bytes: Uint8Array; kind: 'psbt' | 'transaction' | 'wallet' }
export type BitcoinQrProgress = { progress: number; received: number; total: number; result?: BitcoinQrPayload }
const magic = (b: Uint8Array) => b.length >= 5 && hex.encode(b.subarray(0, 5)) === '70736274ff'
function classify(bytes: Uint8Array): BitcoinQrPayload {
  if (!bytes.length || bytes.length > MAX_QR_BYTES) throw new Error('QR payload must be between 1 byte and 1 MB')
  if (magic(bytes)) return { bytes, kind: 'psbt' }
  const text = new TextDecoder().decode(bytes).trim()
  if (text.startsWith('{') || /^[xyz]pub/.test(text) || /^(?:wsh|sh)\(/.test(text)) return { bytes, kind: 'wallet' }
  if (bytes.length >= 10 && (bytes[0] === 1 || bytes[0] === 2) && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0) return { bytes, kind: 'transaction' }
  throw new Error('QR does not contain a supported Bitcoin PSBT, transaction or public wallet')
}
function join(chunks: Uint8Array[]) {
  const length = chunks.reduce((n, c) => n + c.length, 0)
  if (length > MAX_QR_BYTES + 16) throw new Error('QR payload exceeds 1 MB')
  const out = new Uint8Array(length)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}
function cborBytes(bytes: Uint8Array) {
  const n = bytes.length
  const header = n < 24 ? [0x40 + n] : n < 256 ? [0x58, n] : n < 65536 ? [0x59, n >> 8, n & 255] : [0x5a, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  return join([new Uint8Array(header), bytes])
}
function unCborBytes(bytes: Uint8Array) {
  let offset = 1, length = bytes[0] - 0x40
  if (bytes[0] === 0x58) { offset = 2; length = bytes[1] }
  else if (bytes[0] === 0x59) { offset = 3; length = bytes[1] * 256 + bytes[2] }
  else if (bytes[0] === 0x5a) { offset = 5; length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1) }
  else if (length < 0 || length >= 24) throw new Error('UR must contain a definite CBOR byte string')
  if (length > MAX_QR_BYTES || length !== bytes.length - offset) throw new Error('Invalid UR byte-string length')
  return bytes.slice(offset)
}
/** Preflight the exact fountain tuple before the library's general CBOR reader.
 * That reader allocates declared byte-string lengths before checking remaining
 * input. Reject nesting, indefinite lengths and oversized declarations here. */
function fountainPart(encoded: string) {
  const bytes = hex.decode(encoded)
  let offset = 0
  const read = (major: number) => {
    if (offset >= bytes.length) throw new Error('Truncated UR CBOR')
    const tag = bytes[offset++]
    if (tag >> 5 !== major) throw new Error('Invalid UR fountain CBOR type')
    const size = tag & 31
    if (size < 24) return size
    const width = size === 24 ? 1 : size === 25 ? 2 : size === 26 ? 4 : 0
    if (!width || offset + width > bytes.length) throw new Error('Invalid UR fountain CBOR length')
    let value = 0
    for (let i = 0; i < width; i++) value = value * 256 + bytes[offset++]
    return value
  }
  if (read(4) !== 5) throw new Error('UR fountain tuple must have five fields')
  const seqNum = read(0), seqLength = read(0), messageLength = read(0), checksum = read(0)
  const length = read(2)
  if (!length || length > 3000 || length !== bytes.length - offset) throw new Error('Invalid UR fragment length')
  return { seqNum, seqLength, messageLength, checksum, fragment: bytes.subarray(offset) }
}
export function encodeBase43(bytes: Uint8Array): string {
  if (bytes.length > 3000) throw new Error('Too large for an Electrum static QR; choose animated UR or BBQr')
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let text = ''
  while (n) { text = B43[Number(n % 43n)] + text; n /= 43n }
  for (const b of bytes) { if (b !== 0) break; text = B43[0] + text }
  return text
}
export function decodeBase43(text: string): Uint8Array {
  if (!text.length || text.length > MAX_FRAME) throw new Error('Invalid Electrum QR length')
  let n = 0n
  for (const c of text) { const i = B43.indexOf(c); if (i < 0) throw new Error('Invalid Electrum base43 character'); n = n * 43n + BigInt(i) }
  const bytes: number[] = []
  while (n) { bytes.push(Number(n % 256n)); n /= 256n }
  for (const c of text) { if (c !== B43[0]) break; bytes.push(0) }
  return new Uint8Array(bytes.reverse())
}

/** Initial fountain fragments cycle indefinitely; the receiver accepts mixed
 * fountain frames from other wallets as well. All formats encode public data. */
export function bitcoinQrFrames(bytes: Uint8Array, format: BitcoinQrFormat, fragmentBytes = 200): string[] {
  const { kind } = classify(bytes)
  if (format === 'electrum') {
    if (kind === 'wallet') throw new Error('Electrum transaction QR requires a PSBT or transaction')
    const frame = encodeBase43(bytes)
    if (frame.length > 3391) throw new Error('Too large for an Electrum static QR; choose animated UR or BBQr')
    return [frame]
  }
  const size = Math.max(40, Math.min(1400, Math.max(fragmentBytes, Math.ceil((bytes.length + 5) / 1024))))
  if (format === 'ur') {
    const ur = new UR(Buffer.from(cborBytes(bytes)), kind === 'psbt' ? 'crypto-psbt' : 'bytes')
    return new UREncoder(ur, size).encodeWhole().map(s => s.toUpperCase())
  }
  const encoded = base32nopad.encode(bytes)
  const width = Math.max(8, Math.floor(size * 8 / 5 / 8) * 8)
  const total = Math.ceil(encoded.length / width)
  if (total > 1295) throw new Error('Too many BBQr frames')
  const type = kind === 'psbt' ? 'P' : kind === 'wallet' ? (new TextDecoder().decode(bytes).trim().startsWith('{') ? 'J' : 'U') : 'T'
  return Array.from({ length: total }, (_, i) => `B$2${type}${total.toString(36).toUpperCase().padStart(2, '0')}${i.toString(36).toUpperCase().padStart(2, '0')}${encoded.slice(i * width, (i + 1) * width)}`)
}

export class BitcoinQrDecoder {
  private ur = new URDecoder()
  private identity = ''
  private mode = ''
  private seen = new Set<string>()
  private bb = new Map<number, string>()
  private encodedLength = 0
  private finish(bytes: Uint8Array, expected?: string): BitcoinQrProgress {
    const result = classify(bytes)
    if ((expected === 'psbt' && result.kind !== 'psbt') || (expected === 'transaction' && result.kind !== 'transaction') || (expected === 'wallet' && result.kind !== 'wallet')) throw new Error('QR type does not match its contents')
    return { progress: 1, received: 1, total: 1, result }
  }
  receive(input: string): BitcoinQrProgress {
    const text = input.trim()
    if (!text.length || text.length > MAX_FRAME) throw new Error('QR frame is empty or too large')
    const mode = /^ur:/i.test(text) ? 'ur' : text.startsWith('B$') ? 'bbqr' : 'static'
    if (this.mode && mode !== this.mode) throw new Error('Different QR format detected. Reset the scan before switching.')
    this.mode = mode
    if (mode === 'ur') {
      const match = /^ur:(crypto-psbt|psbt|bytes)\/(?:(\d+)-(\d+)\/)?([a-z]+)$/i.exec(text)
      if (!match) throw new Error('Unsupported UR type; import only public wallet or transaction data')
      const type = match[1].toLowerCase()
      let identity = `${type}:single`
      let total = 1
      if (match[2]) {
        const part = fountainPart(Bytewords.decode(match[4].toLowerCase(), Bytewords.STYLES.MINIMAL))
        total = Number(match[3])
        if (!Number.isSafeInteger(part.seqNum) || part.seqNum < 1 || part.seqNum > 0xffffffff || part.seqNum !== Number(match[2]) || part.seqLength !== total || total < 1 || total > MAX_PARTS || !Number.isSafeInteger(part.checksum) || part.checksum < 0 || part.checksum > 0xffffffff || !Number.isSafeInteger(part.messageLength) || part.messageLength < 1 || part.messageLength > MAX_QR_BYTES + 5 || !part.fragment.length || part.fragment.length > 3000 || part.messageLength > total * part.fragment.length || part.messageLength <= (total - 1) * part.fragment.length) throw new Error('Invalid or oversized UR sequence')
        identity = `${type}:${total}:${part.messageLength}:${part.checksum}:${part.fragment.length}`
      }
      if (this.identity && identity !== this.identity) throw new Error('A different transaction QR was detected. Reset the scan.')
      this.identity = identity
      const hash = hex.encode(sha256(new TextEncoder().encode(text.toLowerCase())))
      if (!this.seen.has(hash)) {
        if (this.seen.size >= Math.min(16384, total * 4 + 16)) throw new Error('QR scan limit reached; reset and retry')
        if (!this.ur.receivePart(text.toLowerCase())) throw new Error('Invalid UR frame')
        this.seen.add(hash)
      }
      if (this.ur.isError()) throw new Error(this.ur.resultError())
      if (this.ur.isComplete()) return this.finish(unCborBytes(new Uint8Array(this.ur.resultUR().cbor)), type === 'bytes' ? undefined : 'psbt')
      return { progress: Math.min(0.99, this.ur.estimatedPercentComplete()), received: this.ur.receivedPartIndexes().length, total }
    }
    if (mode === 'bbqr') {
      const match = /^B\$([H2Z])([PTJU])([0-9A-Z]{2})([0-9A-Z]{2})([0-9A-Z]+)$/.exec(text)
      if (!match) throw new Error('Unsupported or invalid BBQr header')
      const total = parseInt(match[3], 36), index = parseInt(match[4], 36)
      const identity = text.slice(0, 6)
      if (total < 1 || index >= total || (this.identity && identity !== this.identity)) throw new Error('Conflicting BBQr sequence; reset the scan')
      this.identity = identity
      const previous = this.bb.get(index)
      if (previous && previous !== match[5]) throw new Error('Conflicting duplicate BBQr frame')
      if (!previous) { this.encodedLength += match[5].length; this.bb.set(index, match[5]) }
      if (this.encodedLength > MAX_QR_BYTES * 2) throw new Error('BBQr exceeds 1 MB')
      if (this.bb.size !== total) return { progress: this.bb.size / total, received: this.bb.size, total }
      const pieces = Array.from({ length: total }, (_, i) => this.bb.get(i)!)
      const width = pieces[0].length
      if (pieces.some((p, i) => i < total - 1 ? p.length !== width : p.length > width) || pieces.some((p, i) => match[1] === 'H' ? p.length % 2 !== 0 : i < total - 1 && p.length % 8 !== 0)) throw new Error('Invalid BBQr fragment lengths')
      const combined = pieces.join('')
      let bytes = match[1] === 'H' ? hex.decode(combined.toLowerCase()) : base32nopad.decode(combined)
      if (match[1] === 'Z') {
        const chunks: Uint8Array[] = []; let length = 0
        const inflate = new Inflate(chunk => { length += chunk.length; if (length > MAX_QR_BYTES) throw new Error('Compressed BBQr exceeds 1 MB'); chunks.push(chunk.slice()) })
        for (let i = 0; i < bytes.length; i += 256) inflate.push(bytes.subarray(i, i + 256), i + 256 >= bytes.length)
        bytes = join(chunks)
      }
      return this.finish(bytes, match[2] === 'P' ? 'psbt' : match[2] === 'T' ? 'transaction' : 'wallet')
    }
    if (this.identity) throw new Error('Reset before importing another QR')
    if (/^(\{|[xyz]pub|(?:wsh|sh)\()/.test(text)) return this.finish(new TextEncoder().encode(text), 'wallet')
    if (/^cHNidP/.test(text)) return this.finish(base64.decode(text), 'psbt')
    if (/^(70736274ff|0[12]000000)/i.test(text) && /^(?:[0-9a-f]{2})+$/i.test(text)) return this.finish(hex.decode(text.toLowerCase()))
    return this.finish(decodeBase43(text))
  }
}
