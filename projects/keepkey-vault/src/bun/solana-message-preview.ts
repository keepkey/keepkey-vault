import bs58 from 'bs58'
import type { SolanaMessageDecodedInfo } from '../shared/types'
import { parseSolanaMessage, parseSolanaTx, solanaMessageSlice } from './solana-tx'

type SolanaMessageInputEncoding = 'base58' | 'base64' | 'hex' | 'utf8' | 'auto'

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function isMostlyReadableText(text: string): boolean {
  if (!text) return false
  let readable = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (ch === '\n' || ch === '\r' || ch === '\t' || (code >= 0x20 && code !== 0x7f)) {
      readable += 1
    }
  }
  return readable / text.length > 0.85
}

function isCanonicalBase64(value: string): boolean {
  const compact = value.trim().replace(/\s+/g, '')
  if (!compact || compact.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return false
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length === 0) return false
  return bytes.toString('base64') === compact
}

function decodeHexString(value: string): Buffer {
  const stripped = value.replace(/^0x/i, '')
  const pairs = stripped.match(/.{1,2}/g) || []
  return Buffer.from(pairs.map((byte) => parseInt(byte, 16)))
}

function decodeMessageBytes(message: string, encoding: SolanaMessageInputEncoding): {
  bytes: Buffer
  encoding: Exclude<SolanaMessageInputEncoding, 'auto'>
} {
  if (encoding === 'base58') return { bytes: Buffer.from(bs58.decode(message)), encoding }
  if (encoding === 'base64') return { bytes: Buffer.from(message, 'base64'), encoding }
  if (encoding === 'hex') return { bytes: decodeHexString(message), encoding }
  if (encoding === 'utf8') return { bytes: Buffer.from(message, 'utf8'), encoding }

  const compact = message.trim()
  const hexBody = compact.replace(/^0x/i, '')
  if (/^(?:0x)?[0-9a-fA-F]+$/.test(compact)) {
    return { bytes: decodeHexString(hexBody), encoding: 'hex' }
  }
  if (isCanonicalBase64(message)) {
    return { bytes: Buffer.from(message.trim(), 'base64'), encoding: 'base64' }
  }
  return { bytes: Buffer.from(message, 'utf8'), encoding: 'utf8' }
}

function classifySolanaPayload(bytes: Uint8Array): Pick<SolanaMessageDecodedInfo, 'classification' | 'sanityCheck'> {
  try {
    const parsedTx = parseSolanaTx(bytes)
    const message = parseSolanaMessage(solanaMessageSlice(bytes, parsedTx))
    return {
      classification: 'solana-transaction',
      sanityCheck: `Looks like a serialized Solana ${message.version} transaction with ${message.instructions.length} instruction(s).`,
    }
  } catch {
    // Fall through to raw-message check.
  }

  try {
    const message = parseSolanaMessage(bytes)
    return {
      classification: 'solana-transaction-message',
      sanityCheck: `Looks like a raw Solana ${message.version} transaction message with ${message.instructions.length} instruction(s).`,
    }
  } catch {
    // Fall through to text/binary classification.
  }

  const text = decodeUtf8(bytes)
  if (text !== undefined && isMostlyReadableText(text)) {
    return { classification: 'text-message' }
  }
  return { classification: 'binary-message' }
}

export function buildSolanaMessageDecodedInfo(
  message: string,
  options: { encoding?: SolanaMessageInputEncoding; signer?: string } = {},
): SolanaMessageDecodedInfo {
  const decoded = decodeMessageBytes(message, options.encoding ?? 'auto')
  const text = decodeUtf8(decoded.bytes)
  const shape = classifySolanaPayload(decoded.bytes)
  return {
    signer: options.signer,
    messageRaw: message,
    encoding: decoded.encoding,
    messageText: text !== undefined && isMostlyReadableText(text) ? text : undefined,
    messageHex: decoded.bytes.toString('hex'),
    byteLength: decoded.bytes.length,
    ...shape,
  }
}
