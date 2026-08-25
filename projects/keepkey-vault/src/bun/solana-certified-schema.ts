import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'
import bs58 from 'bs58'

import {
  ALPHA_DELEGATE_PUBLIC_KEY,
  ALPHA_DELEGATE_FINGERPRINT,
  CLEARSIGN_SCOPE_SOLANA,
  inspectAlphaCertificate,
} from './clearsign-alpha-ceremony'

/**
 * Certified KKSOLSC1 instruction-schema builder + signer.
 *
 * A schema describes how to read ONE program instruction — program id,
 * discriminator, and labelled args/accounts to display. It carries no
 * amounts and no transaction hash, so a signer attests it ONCE per
 * program+instruction and every later transaction reuses it.
 *
 * Wire layout mirrors keepkey-firmware lib/firmware/solana.c
 * (solana_parseInstrSchema) byte-for-byte, and matches the offline gate at
 * keepkey-sdk/tests/fixtures/solana-schema.js — keep all three in sync.
 */

const MAGIC = Buffer.from('KKSOLSC1', 'ascii')
const SCHEMA_VERSION = 1

const NAME_MAX = 20
const LABEL_MAX = 16
const MAX_ARGS = 4
const MAX_ACCOUNTS = 4
const DISC_MAX = 8
const MAX_PAYLOAD_BYTES = 256 // SolanaSignTx.schema_payload max_size

export const ARG_U64 = 1
export const ARG_U8 = 2
export const ARG_PUBKEY = 3
export const ARG_OPAQUE32 = 4

const ARG_WIDTH: Record<number, number> = { [ARG_U64]: 8, [ARG_U8]: 1, [ARG_PUBKEY]: 32, [ARG_OPAQUE32]: 32 }

export interface SolanaSchemaArg {
  type: number
  label: string
}

export interface SolanaSchemaAccount {
  index: number
  label: string
}

export interface SolanaSchemaSpec {
  programId: string // base58
  discriminator: Buffer
  programName: string
  instructionName: string
  args?: SolanaSchemaArg[]
  accounts?: SolanaSchemaAccount[]
}

/** Display text must be printable ASCII, no '%' (device screen safety). */
function lenPrefixedText(value: string, maxLength: number, name: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} chars`)
  for (const ch of value) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 || cp > 0x7e || ch === '%') throw new Error(`${name} contains a character the device will not display`)
  }
  const bytes = Buffer.from(value, 'ascii')
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

/** Serialize a KKSOLSC1 payload. Byte-for-byte match to the firmware parser. */
export function serializeSolanaSchema(spec: SolanaSchemaSpec): Buffer {
  const programId = Buffer.from(bs58.decode(spec.programId))
  if (programId.length !== 32) throw new Error('programId must decode to 32 bytes')
  const disc = Buffer.from(spec.discriminator)
  if (disc.length < 1 || disc.length > DISC_MAX) throw new Error(`discriminator must be 1..${DISC_MAX} bytes`)
  const args = spec.args || []
  const accounts = spec.accounts || []
  if (args.length > MAX_ARGS) throw new Error(`at most ${MAX_ARGS} args`)
  if (accounts.length > MAX_ACCOUNTS) throw new Error(`at most ${MAX_ACCOUNTS} accounts`)

  const parts: Buffer[] = [
    MAGIC,
    Buffer.from([SCHEMA_VERSION]),
    programId,
    Buffer.from([disc.length]),
    disc,
    lenPrefixedText(spec.programName, NAME_MAX, 'programName'),
    lenPrefixedText(spec.instructionName, NAME_MAX, 'instructionName'),
    Buffer.from([args.length]),
  ]
  for (const arg of args) {
    if (!ARG_WIDTH[arg.type]) throw new Error(`unknown arg type ${arg.type}`)
    parts.push(Buffer.from([arg.type]), lenPrefixedText(arg.label, LABEL_MAX, 'arg label'))
  }
  parts.push(Buffer.from([accounts.length]))
  for (const acct of accounts) {
    if (!Number.isInteger(acct.index) || acct.index < 0 || acct.index > 255) {
      throw new Error('account index must be a byte')
    }
    parts.push(Buffer.from([acct.index]), lenPrefixedText(acct.label, LABEL_MAX, 'account label'))
  }
  const payload = Buffer.concat(parts)
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`payload ${payload.length}B exceeds the ${MAX_PAYLOAD_BYTES}B proto cap`)
  return payload
}

/** Bytes the schema claims to account for: discriminator + every arg width. */
export function solanaSchemaCoverage(spec: SolanaSchemaSpec): number {
  return spec.discriminator.length + (spec.args || []).reduce((n, a) => n + ARG_WIDTH[a.type], 0)
}

function hexBytes(value: string, length: number, label: string): Buffer {
  const clean = String(value || '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== length * 2) {
    throw new Error(`${label} must be exactly ${length} bytes of hex`)
  }
  return Buffer.from(clean, 'hex')
}

export interface CertifiedSolanaSchema {
  schemaPayload: string // 0x-prefixed
  schemaSignature: string // 0x-prefixed 64-byte compact secp256k1
  keyId: number
  fingerprint: string
  alias: string
  certificateHex: string
}

/** Sign a KKSOLSC1 schema for the certified path, using the Solana-scoped
 * (501) delegate certificate and its private key. The private key never
 * leaves this process. */
export function signCertifiedSolanaSchema(
  certificateHex: string,
  delegatePrivateKeyHex: string,
  spec: SolanaSchemaSpec,
): CertifiedSolanaSchema {
  const certificate = hexBytes(certificateHex, 139, 'solana certificate')
  const certInfo = inspectAlphaCertificate(certificate.toString('hex'))
  if (certInfo.chainId !== CLEARSIGN_SCOPE_SOLANA) {
    throw new Error(`certificate is scoped to ${certInfo.chainId}, not Solana (${CLEARSIGN_SCOPE_SOLANA})`)
  }
  const privateKey = hexBytes(delegatePrivateKeyHex, 32, 'delegate private key')
  const signingKey = new ethersUtils.SigningKey(`0x${privateKey.toString('hex')}`)
  const publicKey = ethersUtils.computePublicKey(signingKey.publicKey, true).slice(2).toLowerCase()
  if (publicKey !== ALPHA_DELEGATE_PUBLIC_KEY) {
    throw new Error(`delegate private key does not match reviewed signer ${ALPHA_DELEGATE_FINGERPRINT}`)
  }

  const payload = serializeSolanaSchema(spec)
  const digest = createHash('sha256').update(payload).digest()
  const signature = signingKey.signDigest(`0x${digest.toString('hex')}`)
  const compact = Buffer.concat([
    hexBytes(signature.r, 32, 'signature r'),
    hexBytes(signature.s, 32, 'signature s'),
  ])
  return {
    schemaPayload: `0x${payload.toString('hex')}`,
    schemaSignature: `0x${compact.toString('hex')}`,
    keyId: 0x80,
    fingerprint: ALPHA_DELEGATE_FINGERPRINT,
    alias: certInfo.alias,
    certificateHex: certificate.toString('hex'),
  }
}

/**
 * Reviewed catalog. Real, captured instruction shapes from api.relay.link
 * (2026-07-27) — both 48 bytes: 8-byte discriminator + u64 amount (LE) +
 * 32-byte order id. Mirrors keepkey-sdk/tests/fixtures/solana-schema.js.
 */
export const CERTIFIED_SOLANA_CATALOG: Record<string, SolanaSchemaSpec> = {
  relayDepositNative: {
    programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
    discriminator: Buffer.from('0d9e0ddf5fd51c06', 'hex'),
    programName: 'Relay Bridge',
    instructionName: 'depositNative',
    args: [
      { type: ARG_U64, label: 'Amount' },
      { type: ARG_OPAQUE32, label: 'Order' },
    ],
    accounts: [{ index: 3, label: 'Vault' }],
  },
  relayDepositToken: {
    programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
    discriminator: Buffer.from('0b9c60da27a3b413', 'hex'),
    programName: 'Relay Bridge',
    instructionName: 'depositToken',
    args: [
      { type: ARG_U64, label: 'Amount' },
      { type: ARG_OPAQUE32, label: 'Order' },
    ],
    accounts: [{ index: 3, label: 'Vault' }],
  },
}
