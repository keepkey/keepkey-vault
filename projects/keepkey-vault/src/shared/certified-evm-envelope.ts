/**
 * Whether stock 7.16.0 shows an EVM call from a KeepKey-certified envelope.
 * One host-side mirror of the device check, shared by the signing gate
 * (needsBlindSigning, evmCallRequiresAdvancedMode) and the risk verdict.
 */
import { versionCompare } from './firmware-versions'

/** The delegate key id of a KeepKey-certified envelope (METADATA_KEYID_DELEGATE). */
export const CERTIFIED_ENVELOPE_KEY_ID = 0x80

/** Body versions stock 7.16.0 shows a transaction from (signed_metadata.h):
 *  0x02 schema, 0x05 schema with intent, 0x07 decoder. It refuses 0x04, and
 *  0x06 is a name record that describes no call. */
const SHOWN_BODY_VERSIONS = new Set([0x02, 0x05, 0x07])

/** The chain id the REST sign handler signs: a missing or 0 id is signed as 1. */
export function evmSignedChainId(v: unknown): number {
  const n = typeof v === 'string' ? Number(v.startsWith('0x') ? parseInt(v, 16) : v) : Number(v)
  return n > 0 ? n : 1
}

/** A metadata payload as bytes: raw bytes, or a hex string with or without 0x. */
export function metadataPayloadBytes(payload: unknown): Uint8Array | undefined {
  if (payload instanceof Uint8Array) return payload
  if (typeof payload !== 'string') return undefined
  const clean = payload.replace(/^0x/i, '')
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return undefined
  return Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16))
}

/** A base64 blob (the calldataDecoded.signedInsightBlob encoding) as bytes. */
export function base64PayloadBytes(blob: string): Uint8Array | undefined {
  try { return Uint8Array.from(atob(blob), (c) => c.charCodeAt(0)) } catch { return undefined }
}

/**
 * True only for a 0x03 envelope under key id 0x80, on firmware 7.16.0 or
 * later, whose inner body is one the device shows (0x02/0x05/0x07) and names
 * this exact chain, contract and selector. Shape only: the device checks the
 * certificate and signature, and refuses a failed certified claim outright
 * rather than signing blind (ethereum.c, SRS R-1.4).
 */
export function certifiedEnvelopeShown(
  payload: Uint8Array | undefined,
  keyId: unknown,
  firmwareVersion: string | undefined,
  tx: { chainId?: unknown; to?: string; data?: unknown },
): boolean {
  if (!payload || keyId !== CERTIFIED_ENVELOPE_KEY_ID) return false
  if (!firmwareVersion || versionCompare(firmwareVersion, '7.16.0') < 0) return false
  // 0x03, a 139-byte certificate, then the body: version, chain id, contract, selector.
  if (payload.length < 169 || payload[0] !== 0x03 || !SHOWN_BODY_VERSIONS.has(payload[140])) return false
  const hex = (from: number, end: number) => Array.from(payload.slice(from, end), (x) => x.toString(16).padStart(2, '0')).join('')
  const data = typeof tx.data === 'string' ? tx.data.toLowerCase() : ''
  return parseInt(hex(141, 145), 16) === evmSignedChainId(tx.chainId)
    && `0x${hex(145, 165)}` === (tx.to ?? '').toLowerCase() && `0x${hex(165, 169)}` === data.slice(0, 10)
}
