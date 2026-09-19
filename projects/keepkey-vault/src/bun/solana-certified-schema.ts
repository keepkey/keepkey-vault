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
 *
 * The version byte selects the rules. Version 1 is the original layout (at
 * most 4 args, types 1..5) and is still emitted for every schema that fits
 * it, so existing signatures and fixtures stay byte-identical. Version 2 is
 * emitted only when a schema needs it (more than 4 args, or TOKEN_AMOUNT /
 * DURATION): up to 8 args, types 1..7, and a TOKEN_AMOUNT arg entry carries
 * one extra byte, the index into the instruction's account list of its mint.
 * The SDK offline fixture only knows version 1.
 */

const MAGIC = Buffer.from('KKSOLSC1', 'ascii')
const SCHEMA_VERSION_V1 = 1
const SCHEMA_VERSION_V2 = 2

const NAME_MAX = 20
const LABEL_MAX = 16
const MAX_ARGS_V1 = 4
const MAX_ARGS_V2 = 8
const MAX_ACCOUNTS = 4
const DISC_MAX = 8
const MAX_PAYLOAD_BYTES = 256 // SolanaSignTx.schema_payload max_size

export const ARG_U64 = 1
export const ARG_U8 = 2
export const ARG_PUBKEY = 3
export const ARG_OPAQUE32 = 4
export const ARG_LAMPORTS = 5
/** v2: u64 LE raw token amount; `mintAccount` names the instruction account
 * holding its mint. Firmware shows decimals and symbol only for a trusted
 * token definition of that exact mint, else the raw amount and full mint. */
export const ARG_TOKEN_AMOUNT = 6
/** v2: u64 LE seconds, shown in exact d / h / min / s units. */
export const ARG_DURATION = 7

const ARG_WIDTH: Record<number, number> = {
  [ARG_U64]: 8,
  [ARG_U8]: 1,
  [ARG_PUBKEY]: 32,
  [ARG_OPAQUE32]: 32,
  [ARG_LAMPORTS]: 8,
  [ARG_TOKEN_AMOUNT]: 8,
  [ARG_DURATION]: 8,
}

export interface SolanaSchemaArg {
  type: number
  label: string
  /** TOKEN_AMOUNT only: index into the instruction's account list. */
  mintAccount?: number
}

export interface SolanaSchemaAccount {
  index: number
  label: string
}

export interface SolanaSchemaSpec {
  protocol?: string
  action?: string
  provenance?: { protocol: string }
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
  if (args.length > MAX_ARGS_V2) throw new Error(`at most ${MAX_ARGS_V2} args`)
  if (accounts.length > MAX_ACCOUNTS) throw new Error(`at most ${MAX_ACCOUNTS} accounts`)
  const version = args.length > MAX_ARGS_V1
    || args.some((arg) => arg.type === ARG_TOKEN_AMOUNT || arg.type === ARG_DURATION)
    ? SCHEMA_VERSION_V2
    : SCHEMA_VERSION_V1

  const parts: Buffer[] = [
    MAGIC,
    Buffer.from([version]),
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
    if (arg.type === ARG_TOKEN_AMOUNT) {
      const mintAccount = arg.mintAccount
      if (mintAccount === undefined || !Number.isInteger(mintAccount) || mintAccount < 0 || mintAccount > 255) {
        throw new Error('TOKEN_AMOUNT mintAccount must be a byte')
      }
      parts.push(Buffer.from([mintAccount]))
    } else if (arg.mintAccount !== undefined) {
      throw new Error('mintAccount applies only to TOKEN_AMOUNT args')
    }
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
  pumpAmmBuy: {
    protocol: 'Pump',
    action: 'Buy tokens through Pump AMM with a maximum quote-token input',
    provenance: { protocol: 'https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json' },
    programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    discriminator: Buffer.from('66063d1201daebea', 'hex'),
    programName: 'Pump AMM',
    instructionName: 'Buy',
    // Exact official IDL: u64 base_amount_out, u64 max_quote_amount_in,
    // OptionBool (a one-byte bool). Amounts are raw token units; the two
    // signed mint accounts identify their units without trusting a ticker.
    args: [
      { type: ARG_U64, label: 'Base units out' },
      { type: ARG_U64, label: 'Max quote units' },
      { type: ARG_U8, label: 'Track volume' },
    ],
    accounts: [
      { index: 3, label: 'Buy token mint' },
      { index: 4, label: 'Pay token mint' },
      { index: 5, label: 'Receive account' },
      { index: 6, label: 'Pay account' },
    ],
  },
  soltoshidiceBlackjackJoin: {
    protocol: 'SoltoshiDICE',
    action: 'Join a SoltoshiDICE blackjack table with an SDICE buy-in and a session key',
    // Native Rust program with no published IDL. Every byte of the 82-byte
    // join is covered, so nothing in the data goes unshown. Evidence, read
    // from https://soltoshidice.fun (bundles fetched 2026-09-19):
    // - Order: /_next/static/chunks/presentation-Wn_CA_1v.js (sha256
    //   e10c73a9...) function `k` (exported as `v`) builds tag 81 as
    //   E(81, table, seat, d(buyIn), D(session)), where E prepends u64
    //   round.id and u64 round.revision, D is key(32) || u64 seconds ||
    //   u64 allowance || u64 maxWager, d is u64 LE, and a number is 1 byte.
    //   Accounts: w() puts `new PublicKey(config.mint)` at index 3.
    // - Units: ProductionHoldem-Bfa95efV.js (sha256 14a1be39...) joins with
    //   dr(..., seat, amount, session), dr = that `k`. `amount` must reach
    //   the table minimum "in SDICE" and is checked against the SDICE token
    //   account. The approval dialog sets maxWager = clamp(amount, table
    //   min, table max) and allowance = max(amount, maxWager) x (1, or 10
    //   for "10x budget"), and shows both as Number(x) / 1e6 "SDICE";
    //   every bet must be <= allowance and <= maxWager in the same units.
    //   So all three are raw SDICE base units. The SOL session reserve is
    //   a separate System transfer, not part of this data.
    // - On chain (getTransaction), joins whose three amounts are equal, as
    //   the standard budget makes them for a buy-in inside the table limits:
    //   KkhHrXX5QTNk2CBTWHMcxyqvAd55ZbFB4onzBT6Phc78VNhnecphs5ocydoti2x3UwFwsYPZ3kJqQrDVNUqTUze
    //     (this fixture's message, differing only in the recent blockhash:
    //     round 86, revision 980, seat 1, 1e9 each; its inner Token-2022
    //     TransferChecked moves exactly the buy-in, 1000000000 = 1000 SDICE)
    //   4kiCfovBvGKuxxhJYwe4r7STXFTvEJcsmcgDzxWyQYtGjbgcJNSHKhbS6mMoqvWmwwR3CNnfgCySXNDFyGDBVLTw
    //     (round 87, seat 2, 1e10 each)
    //   4fQKnRhBMyQmuVU5utTPiLLRAwjTLLgCFtHMNWnmiu8wZLiLgRPUmi5X5UpoPyi5QK7FM1dozo5mQBJRkAXBoYiC
    //     (round 64, seat 6, 1e11 each)
    //   All 24 joins of this table from round 1 (4ZakxNxVaqTApQ9nAuEyPRUZwdKQ
    //   RipdMCnWBw3WesqEFY8eti8QyvR6HrfqBvoMs5DcTBXvhA37ps7XqzFRVUiF) to
    //   round 87 repeat one value, so no captured join has distinct amounts;
    //   the order and units above rest on the encoder.
    // Instruction account 3 is the SDICE mint (Token-2022, 6 decimals).
    provenance: { protocol: 'https://explorer.solana.com/address/CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR' },
    programId: 'CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR',
    discriminator: Buffer.from([0x51]),
    programName: 'SoltoshiDICE',
    instructionName: 'Blackjack join',
    args: [
      { type: ARG_U64, label: 'Round' },
      { type: ARG_U64, label: 'Revision' },
      { type: ARG_U8, label: 'Seat' },
      { type: ARG_TOKEN_AMOUNT, label: 'Buy-in', mintAccount: 3 },
      { type: ARG_PUBKEY, label: 'Session key' },
      { type: ARG_DURATION, label: 'Expires in' },
      { type: ARG_TOKEN_AMOUNT, label: 'Allowance', mintAccount: 3 },
      { type: ARG_TOKEN_AMOUNT, label: 'Max wager', mintAccount: 3 },
    ],
  },
  relayDepositNative: {
    programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
    discriminator: Buffer.from('0d9e0ddf5fd51c06', 'hex'),
    programName: 'Relay Bridge',
    instructionName: 'depositNative',
    args: [
      { type: ARG_LAMPORTS, label: 'Amount' },
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
