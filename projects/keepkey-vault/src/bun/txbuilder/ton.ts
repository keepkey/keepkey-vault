/**
 * Minimal TON BOC builder for v4r2 wallet transfers.
 *
 * Constructs the cell tree, computes representation hashes, serializes to BOC,
 * and handles signing + broadcast via TON Center API.
 *
 * TON wallets are smart contracts. The first outgoing tx must include StateInit
 * (contract code + initial data with public key) to deploy the wallet on-chain.
 */
import { createHash } from 'crypto'

// ── v4r2 wallet contract code (well-known constant) ──────────────────
// Source: https://github.com/ton-blockchain/wallet-contract
const V4R2_CODE_BOC_B64 = 'te6cckECFAEAAtQAART/APSkE/S88sgLAQIBIAIPAgFIAwYC5tAB0NMDIXGwkl8E4CLXScEgkl8E4ALTHyGCEHBsdWe9IoIQZHN0cr2wkl8F4AP6QDAg+kQByMoHy//J0O1E0IEBQNch9AQwXIEBCPQKb6Exs5JfB+AF0z/IJYIQcGx1Z7qSODDjDQOCEGRzdHK6kl8G4w0EBQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAHDgIBIAgNAgFYCQoAPbKd+1E0IEBQNch9AQwAsjKB8v/ydABgQEI9ApvoTGACASALDAAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwAARuMl+1E0NcLH4AFm9JCtvaiaECAoGuQ+gIYRw1AgIR6STfSmRDOaQPp/5g3gSgBt4EBSJhxWfMYQE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVAj45Sg='

// ── v4r2 address derivation (matches firmware's ton_get_address) ──────

const V4R2_CODE_HASH = Buffer.from('feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0', 'hex')
const V4R2_CODE_DEPTH = 7
const V4R2_WALLET_ID_CONST = 698983191 // 0x29A9A317

/** Compute the correct v4r2 wallet address from a raw 32-byte ed25519 public key */
export function tonV4R2Address(publicKeyHex: string, workchain = 0, bounceable = false): string {
  const pubkey = Buffer.from(publicKeyHex, 'hex')
  if (pubkey.length !== 32) throw new Error(`Expected 32-byte pubkey, got ${pubkey.length}`)

  // Data cell repr: d1(0x00) + d2(0x51) + seqno(4B=0) + walletId(4B) + pubkey(32B) + 0x40 (plugin=0 + completion)
  const dataRepr = Buffer.alloc(43)
  dataRepr[0] = 0x00; dataRepr[1] = 0x51
  dataRepr.writeUInt32BE(V4R2_WALLET_ID_CONST, 6)
  pubkey.copy(dataRepr, 10)
  dataRepr[42] = 0x40
  const dataHash = createHash('sha256').update(dataRepr).digest()

  // StateInit repr: d1(0x02) + d2(0x01) + 0x34 + codeDepth(2B) + dataDepth(2B) + codeHash(32B) + dataHash(32B)
  const siRepr = Buffer.alloc(71)
  siRepr[0] = 0x02; siRepr[1] = 0x01; siRepr[2] = 0x34
  siRepr.writeUInt16BE(V4R2_CODE_DEPTH, 3)
  siRepr.writeUInt16BE(0, 5) // data depth = 0
  V4R2_CODE_HASH.copy(siRepr, 7)
  dataHash.copy(siRepr, 39)
  const addrHash = createHash('sha256').update(siRepr).digest()

  // Encode as user-friendly address: tag(1) + wc(1) + hash(32) + crc16(2) → base64url
  const tag = bounceable ? 0x11 : 0x51
  const raw = Buffer.alloc(36)
  raw[0] = tag
  raw[1] = workchain === -1 ? 0xFF : workchain & 0xFF
  addrHash.copy(raw, 2)
  const crc = tonCrc16(raw.subarray(0, 34))
  raw[34] = (crc >> 8) & 0xFF
  raw[35] = crc & 0xFF
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function tonCrc16(data: Buffer): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
    crc &= 0xFFFF
  }
  return crc
}

// ── TON user-friendly address parsing ─────────────────────────────────

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const BASE64STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Parse a TON user-friendly or raw address → { workchain, hash } */
export function parseTonAddress(addr: string): { workchain: number; hash: Buffer } {
  // Raw format: "workchain:hex" e.g. "0:abcdef..."
  const rawMatch = addr.match(/^(-?\d+):([0-9a-fA-F]{64})$/)
  if (rawMatch) {
    return { workchain: parseInt(rawMatch[1], 10), hash: Buffer.from(rawMatch[2], 'hex') }
  }

  // User-friendly: base64url or base64 encoded, 48 chars → 36 bytes
  let b64 = addr
  if (b64.includes('-') || b64.includes('_')) {
    // Convert base64url → standard base64
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/')
  }
  // Add padding if needed
  while (b64.length % 4 !== 0) b64 += '='

  const raw = Buffer.from(b64, 'base64')
  if (raw.length !== 36) throw new Error(`Invalid TON address length: ${raw.length}`)

  // Byte 0: tag (0x11=bounceable, 0x51=non-bounceable, +0x80 for testnet)
  // Byte 1: workchain (0x00=basechain, 0xFF=masterchain)
  // Bytes 2-33: 256-bit hash
  // Bytes 34-35: CRC16-XMODEM
  const wc = raw[1] === 0xFF ? -1 : raw[1]
  const hash = raw.subarray(2, 34)

  return { workchain: wc, hash: Buffer.from(hash) }
}

// ── Bit-level writer ──────────────────────────────────────────────────

class BitWriter {
  private buf: Buffer
  private len = 0

  constructor(capacity = 1023) {
    this.buf = Buffer.alloc(Math.ceil(capacity / 8))
  }

  get bitLength(): number { return this.len }

  writeBit(v: boolean): this {
    if (v) this.buf[this.len >> 3] |= (0x80 >> (this.len & 7))
    this.len++
    return this
  }

  writeUint(value: bigint | number, bits: number): this {
    const v = BigInt(value)
    for (let i = bits - 1; i >= 0; i--) {
      this.writeBit(((v >> BigInt(i)) & 1n) === 1n)
    }
    return this
  }

  writeInt(value: number, bits: number): this {
    if (value < 0) return this.writeUint(BigInt(value) + (1n << BigInt(bits)), bits)
    return this.writeUint(value, bits)
  }

  writeBytes(b: Buffer | Uint8Array): this {
    for (const byte of b) this.writeUint(byte, 8)
    return this
  }

  /** Write addr_none$00 */
  writeAddressNone(): this {
    return this.writeUint(0, 2)
  }

  /** Write addr_std$10 anycast:nothing workchain:int8 address:bits256 */
  writeAddress(workchain: number, hash: Buffer): this {
    this.writeUint(2, 2) // addr_std tag = 0b10
    this.writeBit(false)  // no anycast
    this.writeInt(workchain, 8)
    this.writeBytes(hash)
    return this
  }

  /** Write Grams (VarUInteger 16) */
  writeCoins(amount: bigint): this {
    if (amount === 0n) return this.writeUint(0, 4)
    let byteLen = 0
    let v = amount
    while (v > 0n) { byteLen++; v >>= 8n }
    this.writeUint(byteLen, 4)
    for (let i = byteLen - 1; i >= 0; i--) {
      this.writeUint(Number((amount >> BigInt(i * 8)) & 0xFFn), 8)
    }
    return this
  }

  /** Get data bytes with augmented padding (1-bit + trailing zeros) */
  toAugmentedBytes(): Buffer {
    const byteLen = Math.ceil(this.len / 8)
    const result = Buffer.alloc(byteLen)
    this.buf.copy(result, 0, 0, byteLen)
    if (this.len % 8 !== 0) {
      result[byteLen - 1] |= (0x80 >> (this.len & 7))
    }
    return result
  }
}

// ── Cell representation ───────────────────────────────────────────────

interface Cell {
  bits: BitWriter
  refs: Cell[]
}

function newCell(): { cell: Cell; bits: BitWriter } {
  const bits = new BitWriter()
  const cell: Cell = { bits, refs: [] }
  return { cell, bits }
}

/** SHA-256 representation hash of a standard cell */
function cellHash(cell: Cell): Buffer {
  const bitsLen = cell.bits.bitLength
  const d1 = cell.refs.length                                          // refs descriptor
  const d2 = Math.ceil(bitsLen / 8) + Math.floor(bitsLen / 8)         // bits descriptor
  const data = cell.bits.toAugmentedBytes()

  const h = createHash('sha256')
  h.update(Buffer.from([d1, d2]))
  h.update(data)
  for (const ref of cell.refs) {
    const d = cellDepth(ref)
    h.update(Buffer.from([d >> 8, d & 0xFF]))
  }
  for (const ref of cell.refs) {
    h.update(cellHash(ref))
  }
  return h.digest()
}

function cellDepth(cell: Cell): number {
  if (cell.refs.length === 0) return 0
  return 1 + Math.max(...cell.refs.map(cellDepth))
}

// ── BOC serialization ─────────────────────────────────────────────────

/** Serialize a cell tree to BOC (Bag of Cells) → base64 string */
function serializeBoc(root: Cell): string {
  // Collect all unique cells (topological order: root first, leaves last)
  const allCells: Cell[] = []
  const hashToIdx = new Map<string, number>()

  function collect(cell: Cell) {
    const h = cellHash(cell).toString('hex')
    if (hashToIdx.has(h)) return
    const idx = allCells.length
    hashToIdx.set(h, idx)
    allCells.push(cell)
    for (const ref of cell.refs) collect(ref)
  }
  collect(root)

  const cellCount = allCells.length
  const refSize = cellCount <= 0xFF ? 1 : cellCount <= 0xFFFF ? 2 : 3

  // Serialize each cell: d1 + d2 + augmented_data + ref_indices
  const serializedCells: Buffer[] = []
  let totalDataSize = 0
  for (const cell of allCells) {
    const bitsLen = cell.bits.bitLength
    const d1 = cell.refs.length
    const d2 = Math.ceil(bitsLen / 8) + Math.floor(bitsLen / 8)
    const data = cell.bits.toAugmentedBytes()

    const cellBuf = Buffer.alloc(2 + data.length + cell.refs.length * refSize)
    cellBuf[0] = d1
    cellBuf[1] = d2
    data.copy(cellBuf, 2)

    let off = 2 + data.length
    for (const ref of cell.refs) {
      const idx = hashToIdx.get(cellHash(ref).toString('hex'))!
      for (let i = refSize - 1; i >= 0; i--) {
        cellBuf[off++] = (idx >> (i * 8)) & 0xFF
      }
    }
    serializedCells.push(cellBuf)
    totalDataSize += cellBuf.length
  }

  const offsetSize = totalDataSize <= 0xFF ? 1 : totalDataSize <= 0xFFFF ? 2 : 3

  // BOC header: magic + flags_byte + offset_size + cell_count + roots + absent + data_len + root_idx + cells
  const headerBuf = Buffer.alloc(4 + 1 + 1 + refSize * 3 + offsetSize + refSize)
  let p = 0
  // Magic: b5ee9c72
  headerBuf[p++] = 0xB5; headerBuf[p++] = 0xEE; headerBuf[p++] = 0x9C; headerBuf[p++] = 0x72
  // Flags: has_idx=0, has_crc32=0, has_cache_bits=0, flags=0, ref_size
  headerBuf[p++] = refSize
  // Offset size
  headerBuf[p++] = offsetSize
  // Cell count (refSize bytes BE)
  for (let i = refSize - 1; i >= 0; i--) headerBuf[p++] = (cellCount >> (i * 8)) & 0xFF
  // Root count = 1
  for (let i = refSize - 1; i >= 0; i--) headerBuf[p++] = (i === 0 ? 1 : 0)
  // Absent count = 0
  for (let i = 0; i < refSize; i++) headerBuf[p++] = 0
  // Data size (offsetSize bytes BE)
  for (let i = offsetSize - 1; i >= 0; i--) headerBuf[p++] = (totalDataSize >> (i * 8)) & 0xFF
  // Root index = 0
  for (let i = 0; i < refSize; i++) headerBuf[p++] = 0

  return Buffer.concat([headerBuf, ...serializedCells]).toString('base64')
}

// ── Transfer message construction ─────────────────────────────────────

const V4R2_WALLET_ID = 698983191 // 0x29A9A317

/** Build the internal message cell (transfer to recipient) */
function buildInternalMessage(
  destWorkchain: number,
  destHash: Buffer,
  amountNano: bigint,
  bounce: boolean,
  memo?: string,
): Cell {
  const { cell, bits } = newCell()

  // int_msg_info$0
  bits.writeBit(false) // tag = 0
  bits.writeBit(true)  // ihr_disabled
  bits.writeBit(bounce) // bounce
  bits.writeBit(false) // bounced
  bits.writeAddressNone() // src = addr_none
  bits.writeAddress(destWorkchain, destHash) // dest
  bits.writeCoins(amountNano) // value
  bits.writeBit(false) // extra_currencies = empty
  bits.writeCoins(0n) // ihr_fee
  bits.writeCoins(0n) // fwd_fee
  bits.writeUint(0, 64) // created_lt
  bits.writeUint(0, 32) // created_at
  bits.writeBit(false) // no StateInit

  if (memo && memo.length > 0) {
    // Body as reference cell with text comment (op=0x00000000 + utf8)
    bits.writeBit(true) // body is ref
    const { cell: bodyCell, bits: bodyBits } = newCell()
    bodyBits.writeUint(0, 32) // op = 0 (text comment)
    bodyBits.writeBytes(Buffer.from(memo, 'utf8'))
    cell.refs.push(bodyCell)
  } else {
    bits.writeBit(false) // no body
  }

  return cell
}

/** Build the unsigned body cell (what gets hashed → signed) */
function buildUnsignedBody(
  seqno: number,
  expireAt: number,
  internalMsg: Cell,
): Cell {
  const { cell, bits } = newCell()

  bits.writeUint(V4R2_WALLET_ID, 32) // wallet_id
  bits.writeUint(expireAt, 32) // valid_until
  bits.writeUint(seqno, 32) // seqno
  bits.writeUint(0, 8) // op = 0 (simple send for v4r2)
  bits.writeUint(3, 8) // send_mode = 3 (pay fees separately + ignore errors)
  cell.refs.push(internalMsg)

  return cell
}

/** Build the signed body cell (signature prepended to unsigned body) */
function buildSignedBody(
  signature: Buffer,
  seqno: number,
  expireAt: number,
  internalMsg: Cell,
): Cell {
  const { cell, bits } = newCell()

  bits.writeBytes(signature) // 512 bits = 64 bytes
  bits.writeUint(V4R2_WALLET_ID, 32)
  bits.writeUint(expireAt, 32)
  bits.writeUint(seqno, 32)
  bits.writeUint(0, 8) // op
  bits.writeUint(3, 8) // send_mode
  cell.refs.push(internalMsg)

  return cell
}

// ── StateInit for wallet deployment ───────────────────────────────────

/** Deserialize a BOC base64 string into its root cell (minimal parser for single-root BOCs) */
function deserializeBocToCell(bocB64: string): Cell {
  const buf = Buffer.from(bocB64, 'base64')
  // Parse BOC header: magic(4) + flags_byte(1) + offset_size(1) + ...
  // We trust the well-known v4r2 code BOC — just extract the root cell
  const magic = buf.readUInt32BE(0)
  if (magic !== 0xB5EE9C72) throw new Error('Invalid BOC magic')
  const flagsByte = buf[4]
  const refSize = flagsByte & 0x07
  const hasCrc = (flagsByte >> 6) & 1
  const offsetSize = buf[5]
  const p = 6
  const cellCount = readBE(buf, p, refSize)
  const rootCount = readBE(buf, p + refSize, refSize)
  const absentCount = readBE(buf, p + refSize * 2, refSize)
  const dataSize = readBE(buf, p + refSize * 3, offsetSize)
  const rootIdx = readBE(buf, p + refSize * 3 + offsetSize, refSize)

  const cellDataStart = p + refSize * 3 + offsetSize + refSize * rootCount

  // Parse cells sequentially (each: d1 + d2 + data + ref_indices)
  const cells: Cell[] = []
  let offset = cellDataStart
  for (let i = 0; i < cellCount; i++) {
    const d1 = buf[offset++]
    const d2 = buf[offset++]
    const refsCount = d1 & 0x07
    const dataByteLen = Math.ceil(d2 / 2)
    const dataBits = new BitWriter(dataByteLen * 8)
    const rawData = buf.subarray(offset, offset + dataByteLen)
    // Compute actual bit length: if d2 is odd, last byte has completion tag
    let bitLen = dataByteLen * 8
    if (d2 % 2 === 1 && dataByteLen > 0) {
      // Find the completion tag (last 1-bit)
      const lastByte = rawData[dataByteLen - 1]
      let trailing = 0
      for (let b = 0; b < 8; b++) {
        if ((lastByte >> b) & 1) { trailing = b; break }
      }
      bitLen = (dataByteLen - 1) * 8 + (7 - trailing)
    }
    for (let b = 0; b < bitLen; b++) {
      dataBits.writeBit(!!(rawData[b >> 3] & (0x80 >> (b & 7))))
    }
    offset += dataByteLen

    const refIndices: number[] = []
    for (let r = 0; r < refsCount; r++) {
      refIndices.push(readBE(buf, offset, refSize))
      offset += refSize
    }
    cells.push({ bits: dataBits, refs: [], _refIndices: refIndices } as any)
  }

  // Resolve references
  for (const c of cells) {
    const indices = (c as any)._refIndices as number[]
    c.refs = indices.map(idx => cells[idx])
    delete (c as any)._refIndices
  }

  return cells[rootIdx]
}

function readBE(buf: Buffer, offset: number, size: number): number {
  let val = 0
  for (let i = 0; i < size; i++) val = (val << 8) | buf[offset + i]
  return val
}

/** Cached v4r2 code cell (parsed once) */
let _v4r2CodeCell: Cell | null = null
function getV4R2CodeCell(): Cell {
  if (!_v4r2CodeCell) _v4r2CodeCell = deserializeBocToCell(V4R2_CODE_BOC_B64)
  return _v4r2CodeCell
}

/** Build the initial data cell for a v4r2 wallet: seqno(32) + wallet_id(32) + pubkey(256) */
function buildV4R2DataCell(publicKey: Buffer): Cell {
  const { cell, bits } = newCell()
  bits.writeUint(0, 32) // seqno = 0
  bits.writeUint(V4R2_WALLET_ID, 32) // wallet_id
  bits.writeBytes(publicKey) // 256-bit public key
  bits.writeBit(false) // plugins dict = empty
  return cell
}

/** Build a StateInit cell: split_depth:nothing + special:nothing + code:just + data:just + library:nothing */
function buildStateInit(code: Cell, data: Cell): Cell {
  const { cell, bits } = newCell()
  bits.writeBit(false) // split_depth = nothing
  bits.writeBit(false) // special = nothing
  bits.writeBit(true)  // code = just (ref)
  bits.writeBit(true)  // data = just (ref)
  bits.writeBit(false) // library = nothing
  cell.refs.push(code)
  cell.refs.push(data)
  return cell
}

/** Build the external message cell wrapping the signed body, with optional StateInit */
function buildExternalMessage(
  destWorkchain: number,
  destHash: Buffer,
  signedBody: Cell,
  stateInit?: Cell,
): Cell {
  const { cell, bits } = newCell()

  // ext_in_msg_info$10
  bits.writeUint(2, 2) // tag = 0b10
  bits.writeAddressNone() // src = addr_none
  bits.writeAddress(destWorkchain, destHash) // dest = wallet address
  bits.writeCoins(0n) // import_fee = 0

  if (stateInit) {
    bits.writeBit(true)  // Maybe(Either StateInit ^StateInit) = just
    bits.writeBit(true)  // Either = right (StateInit as ref)
    cell.refs.push(stateInit)
  } else {
    bits.writeBit(false) // no StateInit
  }

  bits.writeBit(true) // body is ref
  cell.refs.push(signedBody)

  return cell
}

// ── Public API ────────────────────────────────────────────────────────

export interface TonBuildResult {
  /** Hex-encoded hash of the unsigned body cell — firmware signs this */
  bodyHash: string
  /** Serialized unsigned body cell bytes (hex) — passed as rawTx to firmware */
  rawTx: string
  /** Parameters for display on device */
  seqno: number
  expireAt: number
  toAddress: string
  amountNano: string
  /** Whether the wallet needs deployment (first tx includes StateInit) */
  needsDeploy: boolean
  /** Public key hex (needed for StateInit if deploying) */
  publicKeyHex?: string
  /** Internal state needed to build signed BOC after signing */
  _internal: {
    destWorkchain: number
    destHash: string  // hex — survives JSON serialization (Buffer doesn't)
    fromWorkchain: number
    fromHash: string  // hex
    amountNano: string // string — BigInt can't be JSON.stringified
    bounce: boolean
    memo?: string
  }
}

/** Build a TON v4r2 wallet transfer. Returns unsigned body hash + data for signing. */
export function buildTonTransfer(params: {
  fromAddress: string
  to: string
  amountNano: string
  memo?: string
  seqno: number
  expireAt: number
  needsDeploy?: boolean
  publicKeyHex?: string
}): TonBuildResult {
  const from = parseTonAddress(params.fromAddress)
  const dest = parseTonAddress(params.to)

  // Non-bounceable for uninitialised wallets, bounceable for active contracts
  // Default to bounceable (safer: funds bounce back if dest doesn't exist)
  const bounce = params.to.startsWith('EQ') || params.to.includes(':')

  const amountNano = BigInt(params.amountNano)
  const internalMsg = buildInternalMessage(dest.workchain, dest.hash, amountNano, bounce, params.memo)
  const unsignedBody = buildUnsignedBody(params.seqno, params.expireAt, internalMsg)
  const bodyHashBuf = cellHash(unsignedBody)

  return {
    bodyHash: bodyHashBuf.toString('hex'),
    rawTx: bodyHashBuf.toString('hex'), // 32 bytes — firmware signs this directly
    seqno: params.seqno,
    expireAt: params.expireAt,
    toAddress: params.to,
    amountNano: params.amountNano,
    needsDeploy: !!params.needsDeploy,
    publicKeyHex: params.publicKeyHex,
    _internal: {
      destWorkchain: dest.workchain,
      destHash: dest.hash.toString('hex'),
      fromWorkchain: from.workchain,
      fromHash: from.hash.toString('hex'),
      amountNano: amountNano.toString(),
      bounce,
      memo: params.memo,
    },
  }
}

/** Assemble the signed BOC from build result + 64-byte Ed25519 signature → base64 BOC */
export function assembleTonSignedBoc(
  buildResult: TonBuildResult,
  signature: Buffer,
): string {
  const { _internal: int } = buildResult
  // Reconstruct Buffers from hex (survives JSON round-trip through RPC)
  const destHash = Buffer.from(int.destHash, 'hex')
  const fromHash = Buffer.from(int.fromHash, 'hex')
  const internalMsg = buildInternalMessage(int.destWorkchain, destHash, BigInt(int.amountNano), int.bounce, int.memo)
  const signedBody = buildSignedBody(signature, buildResult.seqno, buildResult.expireAt, internalMsg)

  // For uninitialized wallets, include StateInit (deploys the wallet contract)
  let stateInit: Cell | undefined
  if (buildResult.needsDeploy && buildResult.publicKeyHex) {
    const pubKey = Buffer.from(buildResult.publicKeyHex, 'hex')
    const codeCell = getV4R2CodeCell()
    const dataCell = buildV4R2DataCell(pubKey)
    stateInit = buildStateInit(codeCell, dataCell)
  }

  const extMsg = buildExternalMessage(int.fromWorkchain, fromHash, signedBody, stateInit)
  return serializeBoc(extMsg)
}

/** Check if a TON wallet is initialized (has contract code deployed) */
export async function getTonWalletState(address: string): Promise<{ initialized: boolean; balance: string }> {
  const resp = await fetch(`https://toncenter.com/api/v2/getAddressInformation?address=${encodeURIComponent(address)}`)
  const data = await resp.json() as any
  if (!data?.ok) throw new Error(`Failed to get TON wallet state: ${data?.error || 'unknown'}`)
  const state = data?.result?.state
  const balance = data?.result?.balance || '0'
  return { initialized: state === 'active', balance }
}

/** Fetch the current seqno for a TON wallet address. Returns 0 for uninitialized wallets. */
export async function getTonSeqno(address: string): Promise<number> {
  const resp = await fetch('https://toncenter.com/api/v2/runGetMethod', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, method: 'seqno', stack: [] }),
  })
  const data = await resp.json() as any
  if (!data?.ok) return 0 // uninitialized wallet → seqno 0
  const exitCode = data?.result?.exit_code
  if (exitCode !== 0) return 0 // contract method failed → likely uninitialized
  const stack = data?.result?.stack
  if (!stack || !stack[0]) return 0
  // stack[0] = ["num", "0x..."]
  const val = stack[0][1] || stack[0]
  return typeof val === 'string' ? parseInt(val, 16) : Number(val)
}

/** Broadcast a signed BOC to the TON network via TON Center */
export async function broadcastTonBoc(bocBase64: string): Promise<string> {
  const resp = await fetch('https://toncenter.com/api/v2/sendBoc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boc: bocBase64 }),
  })
  const data = await resp.json() as any
  if (!data?.ok) {
    const err = data?.error || data?.description || 'unknown'
    throw new Error(`TON broadcast failed: ${err}`)
  }
  // TON doesn't return txid from sendBoc — compute from external message hash
  // Return the hash field if available, otherwise a placeholder
  return data?.result?.hash || data?.result?.msg_hash || 'pending'
}
