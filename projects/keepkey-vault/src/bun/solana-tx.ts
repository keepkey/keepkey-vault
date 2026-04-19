/**
 * Solana wire-transaction parsing for the Vault signing path.
 *
 * Wire layout per Solana's `VersionedTransaction::serialize()`:
 *
 *     [compact-u16 sigCount][sigCount * 64 bytes sigs][message]
 *
 * where `message` is either:
 *   - a legacy message (`header || static_keys || recent_blockhash || instructions`) — no prefix, OR
 *   - a versioned message (`0x80 || header || ... || address_lookup_tables`) — starts with 0x80.
 *
 * Firmware parses the message portion only; we strip sigs and hand it over.
 *
 * Misconceptions this module defends against:
 *   1. Treating the v0 `0x80` prefix as a wrapper byte *before* sigCount. Per
 *      spec it lives inside the message, after sigs. A transaction whose
 *      first byte is `>= 0x80` is either this malformed layout or a legacy
 *      tx with an implausible sigCount ≥ 128 — both refuse explicitly.
 *   2. Hand-parsed compact-u16 silently no-op'ing on impossible offsets. The
 *      original parser would fall through and ship the full buffer to
 *      firmware, producing a generic "malformed" error far from the cause.
 */

export interface ParsedSolanaTx {
  /** Offset of the first signature byte (end of compact-u16 sigCount). */
  sigStart: number
  /** Number of signatures declared by the compact-u16 header. */
  sigCount: number
  /** Offset where the message portion starts (after `sigCount * 64` sig bytes). */
  messageStart: number
  /** True when the message begins with the v0 prefix (0x80). */
  isVersioned: boolean
}

/** Real-world Solana transactions have ≤20 signers; keep modest headroom. */
export const MAX_SIGNATURES = 32

export class SolanaTxParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolanaTxParseError'
  }
}

/** Parse the wire layout. Throws {@link SolanaTxParseError} on malformed input. */
export function parseSolanaTx(fullTx: Uint8Array): ParsedSolanaTx {
  if (fullTx.length === 0) {
    throw new SolanaTxParseError('Empty Solana transaction')
  }

  // Reject the `[0x80][sigCount][sigs][msg]` layout some clients incorrectly
  // produce. Real wire format puts the version prefix *inside* the message.
  // A legitimate legacy tx cannot have `fullTx[0] >= 0x80` either — that
  // would imply sigCount ≥ 128, which Solana has no physical path to.
  if ((fullTx[0] & 0x80) !== 0) {
    throw new SolanaTxParseError(
      'Malformed Solana transaction: first byte has high bit set. ' +
      'Expected compact-u16 signature count; got a value that looks like a ' +
      'versioned-message prefix placed before signatures.',
    )
  }

  // Parse LEB128-style compact-u16. In practice always 1 byte (sigCount < 128).
  let pos = 0
  let sigCount = 0
  if (fullTx[0] < 0x80) {
    sigCount = fullTx[0]
    pos = 1
  } else if (fullTx.length >= 2 && fullTx[1] < 0x80) {
    sigCount = (fullTx[0] & 0x7f) | (fullTx[1] << 7)
    pos = 2
  } else if (fullTx.length >= 3) {
    sigCount = (fullTx[0] & 0x7f) | ((fullTx[1] & 0x7f) << 7) | (fullTx[2] << 14)
    pos = 3
  } else {
    throw new SolanaTxParseError('Malformed Solana transaction: truncated signature count')
  }

  if (sigCount < 1 || sigCount > MAX_SIGNATURES) {
    throw new SolanaTxParseError(
      `Malformed Solana transaction: unreasonable signature count (${sigCount})`,
    )
  }

  const messageStart = pos + sigCount * 64
  if (messageStart >= fullTx.length) {
    throw new SolanaTxParseError(
      'Malformed Solana transaction: signature section exceeds buffer length',
    )
  }

  const isVersioned = (fullTx[messageStart] & 0x80) !== 0

  return { sigStart: pos, sigCount, messageStart, isVersioned }
}

/**
 * Return the serialized message portion (bytes starting at `messageStart`).
 * For legacy messages this is `[header | accounts | blockhash | instructions]`;
 * for v0 messages the slice begins with the `0x80` prefix per Solana spec.
 *
 * These are the exact bytes a signer must sign — Ed25519 is computed over the
 * message payload, not the full tx wrapper. The returned slice references the
 * input buffer; copy if the caller needs an independent lifetime.
 */
export function solanaMessageSlice(fullTx: Uint8Array, parsed: ParsedSolanaTx): Uint8Array {
  return fullTx.subarray(parsed.messageStart)
}

// ── Structured message parsing ───────────────────────────────────────
//
// These types + `parseSolanaMessage` walk the message bytes produced by
// `solanaMessageSlice`, turning them into the structured form that the
// clear-signing decoder, UI, and (future) firmware Insight metadata path
// all consume.
//
// Wire layouts are lifted from the Solana SDK's `Message`/`MessageV0`
// serialization (see `solana-sdk/sdk/src/message`).
//
//     Legacy message = header(3) || accounts(compact-u16 + N*32) ||
//                      recent_blockhash(32) ||
//                      instructions(compact-u16 + N * Instruction)
//
//     V0 message     = 0x80 || header(3) || accounts(...) ||
//                      recent_blockhash(32) || instructions(...) ||
//                      alt_entries(compact-u16 + N * AltEntry)
//
//     Instruction = program_id_index(u8) ||
//                   account_indices(compact-u16 + N * u8) ||
//                   data(compact-u16 + N * u8)
//
//     AltEntry    = account_key(32) ||
//                   writable_indices(compact-u16 + N * u8) ||
//                   readonly_indices(compact-u16 + N * u8)

export interface SolanaMessageHeader {
  /** Total number of signers required by the tx. */
  numRequiredSignatures: number
  /** Of those signers, how many are readonly (cannot write state). */
  numReadonlySignedAccounts: number
  /** Of the non-signer accounts, how many are readonly. */
  numReadonlyUnsignedAccounts: number
}

export interface SolanaInstruction {
  /** Index into the expanded account list (static + ALT). */
  programIdIndex: number
  /** Per-instruction account indices; each indexes into the expanded account list. */
  accountIndices: number[]
  /** Raw instruction data bytes (caller decodes per program). */
  data: Uint8Array
}

export interface SolanaAltEntry {
  /** 32-byte Address Lookup Table account pubkey (raw bytes — caller base58-encodes for display). */
  accountKey: Uint8Array
  /** Indices into the ALT's address array that should be loaded as writable non-signers. */
  writableIndices: number[]
  /** Indices into the ALT's address array that should be loaded as readonly non-signers. */
  readonlyIndices: number[]
}

export interface ParsedSolanaMessage {
  /** Wire version — `legacy` (no prefix) or `v0` (0x80 prefix). */
  version: 'legacy' | 'v0'
  header: SolanaMessageHeader
  /** Raw 32-byte pubkeys of the *static* accounts listed inline in the message. */
  staticAccounts: Uint8Array[]
  /** 32-byte recent blockhash. */
  recentBlockhash: Uint8Array
  instructions: SolanaInstruction[]
  /** ALT entries (empty for legacy). */
  altEntries: SolanaAltEntry[]
}

/**
 * Read a Solana compact-u16 (LEB128-style) at `offset`. Returns `[value,
 * nextOffset]`. Real messages almost always use 1 byte per count, but the
 * spec allows up to 3 bytes — we handle all three.
 */
function readCompactU16(bytes: Uint8Array, offset: number): [number, number] {
  const b0 = bytes[offset]
  if (b0 === undefined) throw new SolanaTxParseError('Truncated compact-u16: expected byte 0')
  if (b0 < 0x80) return [b0, offset + 1]
  const b1 = bytes[offset + 1]
  if (b1 === undefined) throw new SolanaTxParseError('Truncated compact-u16: expected byte 1')
  if (b1 < 0x80) return [(b0 & 0x7f) | (b1 << 7), offset + 2]
  const b2 = bytes[offset + 2]
  if (b2 === undefined) throw new SolanaTxParseError('Truncated compact-u16: expected byte 2')
  return [(b0 & 0x7f) | ((b1 & 0x7f) << 7) | (b2 << 14), offset + 3]
}

/**
 * Parse a Solana message (the output of {@link solanaMessageSlice}, or any
 * standalone message payload) into its structural pieces. Throws
 * {@link SolanaTxParseError} on any layout inconsistency.
 */
export function parseSolanaMessage(bytes: Uint8Array): ParsedSolanaMessage {
  if (bytes.length < 3) {
    throw new SolanaTxParseError('Solana message too short for a header')
  }

  let offset = 0
  let version: 'legacy' | 'v0' = 'legacy'
  if ((bytes[0] & 0x80) !== 0) {
    const ver = bytes[0] & 0x7f
    if (ver !== 0) {
      throw new SolanaTxParseError(`Unsupported Solana message version: ${ver}`)
    }
    version = 'v0'
    offset = 1
  }

  if (bytes.length < offset + 3) {
    throw new SolanaTxParseError('Solana message truncated before header')
  }
  const header: SolanaMessageHeader = {
    numRequiredSignatures: bytes[offset],
    numReadonlySignedAccounts: bytes[offset + 1],
    numReadonlyUnsignedAccounts: bytes[offset + 2],
  }
  offset += 3

  // Static accounts
  let staticCount: number
  ;[staticCount, offset] = readCompactU16(bytes, offset)
  if (staticCount < 1 || staticCount > 256) {
    // Solana's account_keys cap is 256 (accounts indexed by u8).
    throw new SolanaTxParseError(`Unreasonable static account count: ${staticCount}`)
  }
  if (offset + staticCount * 32 > bytes.length) {
    throw new SolanaTxParseError('Static accounts section exceeds message length')
  }
  const staticAccounts: Uint8Array[] = []
  for (let i = 0; i < staticCount; i++) {
    staticAccounts.push(bytes.subarray(offset, offset + 32))
    offset += 32
  }

  // Recent blockhash (32 bytes)
  if (offset + 32 > bytes.length) {
    throw new SolanaTxParseError('Message truncated before recent blockhash')
  }
  const recentBlockhash = bytes.subarray(offset, offset + 32)
  offset += 32

  // Instructions
  let ixCount: number
  ;[ixCount, offset] = readCompactU16(bytes, offset)
  if (ixCount > 64) {
    throw new SolanaTxParseError(`Unreasonable instruction count: ${ixCount}`)
  }
  const instructions: SolanaInstruction[] = []
  for (let i = 0; i < ixCount; i++) {
    if (offset + 1 > bytes.length) throw new SolanaTxParseError(`Instruction ${i}: truncated before program_id_index`)
    const programIdIndex = bytes[offset]
    offset += 1
    let acctCount: number
    ;[acctCount, offset] = readCompactU16(bytes, offset)
    if (offset + acctCount > bytes.length) throw new SolanaTxParseError(`Instruction ${i}: truncated account indices`)
    const accountIndices = Array.from(bytes.subarray(offset, offset + acctCount))
    offset += acctCount
    let dataLen: number
    ;[dataLen, offset] = readCompactU16(bytes, offset)
    if (offset + dataLen > bytes.length) throw new SolanaTxParseError(`Instruction ${i}: truncated data`)
    const data = bytes.subarray(offset, offset + dataLen)
    offset += dataLen
    instructions.push({ programIdIndex, accountIndices, data })
  }

  // ALT entries (v0 only)
  const altEntries: SolanaAltEntry[] = []
  if (version === 'v0') {
    let altCount: number
    ;[altCount, offset] = readCompactU16(bytes, offset)
    if (altCount > 32) {
      throw new SolanaTxParseError(`Unreasonable ALT count: ${altCount}`)
    }
    for (let i = 0; i < altCount; i++) {
      if (offset + 32 > bytes.length) throw new SolanaTxParseError(`ALT ${i}: truncated account_key`)
      const accountKey = bytes.subarray(offset, offset + 32)
      offset += 32
      let wCount: number
      ;[wCount, offset] = readCompactU16(bytes, offset)
      if (offset + wCount > bytes.length) throw new SolanaTxParseError(`ALT ${i}: truncated writable indices`)
      const writableIndices = Array.from(bytes.subarray(offset, offset + wCount))
      offset += wCount
      let rCount: number
      ;[rCount, offset] = readCompactU16(bytes, offset)
      if (offset + rCount > bytes.length) throw new SolanaTxParseError(`ALT ${i}: truncated readonly indices`)
      const readonlyIndices = Array.from(bytes.subarray(offset, offset + rCount))
      offset += rCount
      altEntries.push({ accountKey, writableIndices, readonlyIndices })
    }
  }

  if (offset !== bytes.length) {
    throw new SolanaTxParseError(
      `Trailing ${bytes.length - offset} unparsed byte(s) in Solana message`,
    )
  }

  return { version, header, staticAccounts, recentBlockhash, instructions, altEntries }
}

