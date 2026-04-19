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
