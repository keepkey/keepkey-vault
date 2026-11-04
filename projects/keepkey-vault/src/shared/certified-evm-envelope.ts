/**
 * Whether stock 7.16.0 shows an EVM call from a KeepKey-certified envelope.
 * One host-side mirror of the device check, shared by the signing gate
 * (needsBlindSigning, evmCallRequiresAdvancedMode) and the risk verdict.
 */
import { versionCompare } from './firmware-versions'

let productionRootTrusted: () => boolean = () => true
let emulatorTestRoot: () => string | undefined = () => undefined

/** The connected device trusts the production ClearSign root. The emulator
 *  library compiles in only the alpha root and refuses every certificate
 *  Desktop attaches, so it counts as having no certified support (the device
 *  shows its normal review). An emulator started with a ClearSign TEST root
 *  (QA only) is trusted when `trusted` says so, and `testRoot` names that
 *  root; it is undefined for a real device. index.ts registers this once. */
export function configureProductionRootTrust(trusted: () => boolean, testRoot: () => string | undefined = () => undefined): void {
  productionRootTrusted = trusted
  emulatorTestRoot = testRoot
}

export function deviceTrustsProductionRoot(): boolean {
  return productionRootTrusted()
}

/** The emulator's ClearSign TEST root, only while the device is trusted for
 *  certified descriptions; undefined for a real device. */
export function deviceClearSignTestRoot(): string | undefined {
  return productionRootTrusted() ? emulatorTestRoot() : undefined
}

/** The delegate key id of a KeepKey-certified envelope (METADATA_KEYID_DELEGATE). */
export const CERTIFIED_ENVELOPE_KEY_ID = 0x80

/** Body versions stock 7.16.0 shows a transaction from (signed_metadata.h):
 *  0x02 schema, 0x05 schema with intent, 0x07 decoder. It refuses 0x04, and
 *  0x06 is a name record that describes no call. */
const SHOWN_BODY_VERSIONS = new Set([0x02, 0x05, 0x07])

/** The first firmware that shows a certified 0x04 dynamic schema
 *  (METADATA_VERSION_DYNAMIC_SCHEMA in signed_metadata.c). Stock 7.16.0
 *  refuses 0x04 inside the certified envelope. */
export const CERTIFIED_DYNAMIC_SCHEMA_MIN_FW = '7.17.0'

function bodyShown(version: number, firmwareVersion: string): boolean {
  return SHOWN_BODY_VERSIONS.has(version)
    || (version === 0x04 && versionCompare(firmwareVersion, CERTIFIED_DYNAMIC_SCHEMA_MIN_FW) >= 0)
}

/** A certified envelope whose body this firmware refuses: a 0x04 dynamic
 *  schema before 7.17.0 (unknown firmware counts as refusing). Desktop never
 *  resolves or attaches one, so neither the REST nor the swap gate relies on
 *  it, and the device never refuses a certified claim it was sent. */
export function certifiedBodyRefused(payload: unknown, firmwareVersion: string | undefined): boolean {
  const bytes = metadataPayloadBytes(payload)
  if (!bytes || bytes.length < 141 || bytes[0] !== 0x03 || bytes[140] !== 0x04) return false
  return !firmwareVersion || !bodyShown(0x04, firmwareVersion)
}

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
 * later, whose inner body is one the device shows (0x02/0x05/0x07, and 0x04
 * from 7.17.0) and names
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
  if (!payload || keyId !== CERTIFIED_ENVELOPE_KEY_ID || !productionRootTrusted()) return false
  if (!firmwareVersion || versionCompare(firmwareVersion, '7.16.0') < 0) return false
  // 0x03, a 139-byte certificate, then the body: version, chain id, contract, selector.
  if (payload.length < 169 || payload[0] !== 0x03 || !bodyShown(payload[140], firmwareVersion)) return false
  const hex = (from: number, end: number) => Array.from(payload.slice(from, end), (x) => x.toString(16).padStart(2, '0')).join('')
  const data = typeof tx.data === 'string' ? tx.data.toLowerCase() : ''
  return parseInt(hex(141, 145), 16) === evmSignedChainId(tx.chainId)
    && `0x${hex(145, 165)}` === (tx.to ?? '').toLowerCase() && `0x${hex(165, 169)}` === data.slice(0, 10)
}
