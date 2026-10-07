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

/** v3 roles: the device words its Limits screen from these (SRS-7.16 R-7.3). */
export const ROLE_SPEND_MAX = 1
export const ROLE_RECEIVE_MIN = 2
export const ROLE_SPEND_EXACT = 3
export const ROLE_RECEIVE_EXACT = 4
/** A per-use maximum (each bet), not an outflow. */
export const ROLE_CAP = 5
const TEMPLATE_MAX = 96
const isAmount = (type: number) => type === ARG_LAMPORTS || type === ARG_TOKEN_AMOUNT

export const ARG_WIDTH: Record<number, number> = {
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
  /** v3: required on amount args (ROLE_*), absent elsewhere. */
  role?: number
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
  /** v3: the delegate-authored sentence; "{n}" is arg n, "{aN}" account N.
   * Every amount arg must appear (SRS-7.16 R-7.1/R-7.2). Its presence makes
   * the payload version 3. */
  intent?: string
  /** Not serialized. When the program fixes the token its TOKEN_AMOUNT args
   * are in, the clearsign Worker certifies only this identity, and only when
   * the chain reports exactly these values. */
  token?: { mint: string; tokenProgram: string; decimals: number; symbol: string }
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
  const version = spec.intent !== undefined
    ? 3
    : args.length > MAX_ARGS_V1
      || args.some((arg) => arg.type === ARG_TOKEN_AMOUNT || arg.type === ARG_DURATION)
      ? SCHEMA_VERSION_V2
      : SCHEMA_VERSION_V1
  if (version === 3) validateIntent(spec.intent!, args, accounts.length)
  else if (args.some((arg) => arg.role !== undefined)) throw new Error('roles require an intent (v3)')

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
    if (version === 3) parts.push(Buffer.from([arg.role ?? 0]))
  }
  parts.push(Buffer.from([accounts.length]))
  for (const acct of accounts) {
    if (!Number.isInteger(acct.index) || acct.index < 0 || acct.index > 255) {
      throw new Error('account index must be a byte')
    }
    parts.push(Buffer.from([acct.index]), lenPrefixedText(acct.label, LABEL_MAX, 'account label'))
  }
  if (version === 3) parts.push(lenPrefixedText(spec.intent!, TEMPLATE_MAX, 'intent'))
  const payload = Buffer.concat(parts)
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`payload ${payload.length}B exceeds the ${MAX_PAYLOAD_BYTES}B proto cap`)
  return payload
}

/** Firmware intent_width(): widest text per placeholder (SOL_INTENT_TEXT_MAX). */
const SOL_INTENT_TEXT_MAX = 280
const INTENT_WIDTH: Record<number, number> = {
  [ARG_LAMPORTS]: 34, [ARG_TOKEN_AMOUNT]: 34, [ARG_U64]: 20, [ARG_DURATION]: 24, [ARG_U8]: 3, [ARG_PUBKEY]: 11,
}

/** Firmware solana_intentTemplateValid + the v3 role rules, so the service
 * never signs a schema the device refuses. */
function validateIntent(intent: string, args: SolanaSchemaArg[], accountCount: number): void {
  for (const [i, arg] of args.entries()) {
    const ok = isAmount(arg.type)
      ? arg.role !== undefined && arg.role >= ROLE_SPEND_MAX && arg.role <= ROLE_CAP
      : arg.role === undefined || arg.role === 0
    if (!ok) throw new Error(`arg ${i} (${arg.label}): ${isAmount(arg.type) ? 'amount needs a role' : 'only amounts carry a role'}`)
  }
  const used = new Set<number>()
  let width = 0
  const stripped = intent.replace(/\{(a?)([0-9])\}/g, (_, account: string, digit: string) => {
    const index = Number(digit)
    if (account) {
      if (index >= accountCount) throw new Error(`intent {a${index}} is out of range`)
      width += 11
    } else {
      width += INTENT_WIDTH[args[index]?.type] ?? 11
      if (index >= args.length) throw new Error(`intent {${index}} is out of range`)
      if (args[index].type === ARG_OPAQUE32) throw new Error('OPAQUE32 cannot appear in the intent')
      used.add(index)
    }
    return ''
  })
  if (/[{}]/.test(stripped)) throw new Error('intent has a malformed placeholder or stray brace')
  // Firmware refuses digits outside placeholders: numbers come only from signed bytes.
  if (/[0-9]/.test(stripped)) throw new Error('intent states a number of its own; values must come from placeholders')
  width += stripped.length
  if (width > SOL_INTENT_TEXT_MAX) throw new Error(`intent can expand to ${width} chars; firmware limit is ${SOL_INTENT_TEXT_MAX}`)
  for (const [i, arg] of args.entries()) {
    if (isAmount(arg.type) && !used.has(i)) throw new Error(`intent omits amount arg ${i} (${arg.label})`)
  }
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
/*
 * SoltoshiDICE poker ("riverproof"): one first-party Anchor IDL, three
 * deployments. Evidence, fetched from https://soltoshidice.fun on 2026-10-01
 * (cite the sha256, never the filename):
 * - ProductionHoldem-FtKDBnVq.js (sha256 e0a2951e007d69df5b2e9aacd7f8fbfb
 *   f347a5291115139e97e6318cabb3ef73) embeds the IDL riverproof 0.1.0 (41
 *   instructions) whose own address is 3EB6JJ2k...3FmWQ, and defaults its PDA
 *   helper and table/session readers to psDvYR...BB6a. Game-DhxUG0cz.js
 *   (sha256 ccb5e0112c850bb13a04334911f1c097dd02244e0ccb98bddebe7e516a70b944)
 *   configures holdem on 3EB6JJ2k...3FmWQ. CBuVrP...Ypkt is the earlier
 *   deployment cited by the entries above (bundles 2b7e7377.../ebfba07e...).
 * - Every discriminator equals the IDL entry and sha256("global:<name>")[:8];
 *   args and account order are the IDL's. Captured CBuVrP and psDvYR
 *   transactions carry exactly these discriminators and lengths; 3EB6JJ2k has
 *   no captured transaction yet, so its entries rest on the IDL address and
 *   the Game bundle config.
 * - Joining moves a buy-in fixed by the table (no amount in the data), as
 *   enter_poker_tournament does; vault and mint are shown so the destination
 *   and token are on screen.
 */
const RIVERPROOF_POKER = {
  protocol: 'SoltoshiDICE',
  provenance: { protocol: 'https://soltoshidice.fun/' },
  programName: 'SoltoshiDICE Poker',
}
const RIVERPROOF_INSTRUCTIONS: Record<string, Omit<SolanaSchemaSpec, 'programId'>> = {
  // register_poker_tournament(); player(s), arena, tournament(w).
  RegisterPokerTournament: {
    ...RIVERPROOF_POKER,
    action: 'Register the connected wallet for a SoltoshiDICE poker tournament',
    discriminator: Buffer.from('915cd08e461ea126', 'hex'),
    instructionName: 'Register tournament',
    accounts: [{ index: 0, label: 'Player' }, { index: 1, label: 'Arena' }, { index: 2, label: 'Tournament' }],
    intent: 'Register for SoltoshiDICE poker tournament {a2}',
  },
  // enter_poker_tournament(seat_index: u8).
  EnterPokerTournament: {
    ...RIVERPROOF_POKER,
    action: 'Enter a SoltoshiDICE poker tournament at the selected seat',
    discriminator: Buffer.from('b24ebae40f2d0404', 'hex'),
    instructionName: 'Enter tournament',
    args: [{ type: ARG_U8, label: 'Seat' }],
    accounts: [{ index: 2, label: 'Tournament' }, { index: 4, label: 'Table state' }, { index: 6, label: 'Vault' }, { index: 8, label: 'Token mint' }],
    intent: 'Enter tournament {a0} at seat {0}; the entry is set by the tournament',
  },
  // exit_poker_tournament(seat_index: u8); actor, arena, tournament, config,
  // table_state, hand_state, settlement, vault, owner, owner_tokens, mint, ...
  ExitPokerTournament: {
    ...RIVERPROOF_POKER,
    action: 'Leave a SoltoshiDICE poker tournament seat, settling to the seat owner',
    discriminator: Buffer.from('f66a6b93a639f6c1', 'hex'),
    instructionName: 'Exit tournament',
    args: [{ type: ARG_U8, label: 'Seat' }],
    accounts: [{ index: 2, label: 'Tournament' }, { index: 7, label: 'Vault' }, { index: 8, label: 'Payout owner' }, { index: 10, label: 'Token mint' }],
    intent: 'Leave tournament {a0} seat {0}; the seat balance is paid to {a2}',
  },
  // authorize_session(session_key: pubkey, expiry: i64): positive Unix time
  // has the u64 LE bytes; the label says Unix, never a duration.
  AuthorizePokerSession: {
    ...RIVERPROOF_POKER,
    action: 'Authorize an ephemeral session key to act for this wallet at one poker table until the shown Unix time',
    discriminator: Buffer.from('bbdafba163282222', 'hex'),
    instructionName: 'Authorize session',
    args: [{ type: ARG_PUBKEY, label: 'Session key' }, { type: ARG_U64, label: 'Expires Unix' }],
    accounts: [{ index: 0, label: 'Wallet' }, { index: 1, label: 'Table config' }, { index: 2, label: 'Session account' }],
    intent: 'Let session key {0} act for you at table {a1} until Unix time {1}',
  },
  // set_ready(ready: bool).
  SetPokerReady: {
    ...RIVERPROOF_POKER,
    action: 'Opt into or out of the next SoltoshiDICE poker hand',
    discriminator: Buffer.from('694e07a2b5a7ba2b', 'hex'),
    instructionName: 'Set ready',
    args: [{ type: ARG_U8, label: 'Ready' }],
    accounts: [{ index: 1, label: 'Table config' }, { index: 2, label: 'Table state' }, { index: 3, label: 'Hand state' }],
    intent: 'Set ready to {0} for the next hand at table {a0}',
  },
  // join_table(seat_index: u8); wallet, config, table_state, hand_state,
  // vault, player_tokens, mint, gate, token/ATA/system programs.
  JoinPokerTable: {
    ...RIVERPROOF_POKER,
    action: 'Sit at a SoltoshiDICE poker table, paying the table buy-in into its vault',
    discriminator: Buffer.from('0e7554335f92ab46', 'hex'),
    instructionName: 'Join table',
    args: [{ type: ARG_U8, label: 'Seat' }],
    accounts: [{ index: 1, label: 'Table config' }, { index: 2, label: 'Table state' }, { index: 4, label: 'Vault' }, { index: 6, label: 'Token mint' }],
    intent: 'Sit at poker table {a0} seat {0}; the buy-in is set by the table',
  },
  // leave_table(); same eleven accounts as join_table.
  LeavePokerTable: {
    ...RIVERPROOF_POKER,
    action: 'Leave a SoltoshiDICE poker table, cashing out the seat from its vault',
    discriminator: Buffer.from('a3995ec2136a7120', 'hex'),
    instructionName: 'Leave table',
    accounts: [{ index: 1, label: 'Table config' }, { index: 2, label: 'Table state' }, { index: 4, label: 'Vault' }, { index: 6, label: 'Token mint' }],
    intent: 'Leave poker table {a0}; your seat balance comes back from vault {a2}',
  },
}
/** CBuVrP keeps its original keys (above) for the instructions they cover. */
const RIVERPROOF_DEPLOYMENTS: Array<[suffix: string, programId: string, skip: string[]]> = [
  ['', 'CBuVrPT34qFWJ7vdTNK2cKzpnKkmnc9ZQwuS2oiFYpkt', []],
  ['V2', 'psDvYRCi8C1JuinSmVjNicZmqzE5XAi41x6U8CnBB6a', []],
  ['V3', '3EB6JJ2k1yPdg9qokViBdSWq4jaEVG4wiKbS8Pw3FmWQ', []],
]
const RIVERPROOF_CATALOG: Record<string, SolanaSchemaSpec> = Object.fromEntries(
  RIVERPROOF_DEPLOYMENTS.flatMap(([suffix, programId, skip]) =>
    Object.entries(RIVERPROOF_INSTRUCTIONS)
      .filter(([name]) => !skip.includes(name))
      .map(([name, spec]) => [`soltoshidice${name}${suffix}`, { ...spec, programId }])))

export const CERTIFIED_SOLANA_CATALOG: Record<string, SolanaSchemaSpec> = {
  pumpAmmBuy: {
    protocol: 'Pump',
    action: 'Buy tokens through Pump AMM with a maximum quote-token input',
    provenance: { protocol: 'https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json' },
    programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    discriminator: Buffer.from('66063d1201daebea', 'hex'),
    programName: 'Pump.fun',
    instructionName: 'Buy tokens',
    // Exact official IDL: u64 base_amount_out, u64 max_quote_amount_in,
    // OptionBool (a one-byte bool). Amounts are raw token units; the two
    // signed mint accounts identify their units without trusting a ticker.
    args: [
      { type: ARG_TOKEN_AMOUNT, label: 'You get', mintAccount: 3, role: ROLE_RECEIVE_EXACT },
      { type: ARG_TOKEN_AMOUNT, label: 'Pay at most', mintAccount: 4, role: ROLE_SPEND_MAX },
      { type: ARG_U8, label: 'Track volume' },
    ],
    // base_amount_out is exact; max_quote_amount_in caps the spend. Mints: accounts 3 and 4 (a native quote mint shows as SOL by firmware rule).
    intent: 'Buy {0} for at most {1}',
  },
  pumpAmmSell: {
    protocol: 'Pump',
    action: 'Sell tokens through Pump AMM with a minimum quote-token output',
    // Same official IDL as pumpAmmBuy: `sell` is sha256("global:sell")[:8]
    // with u64 base_amount_in then u64 min_quote_amount_out, 24 bytes and no
    // trailing option byte. Accounts as for buy minus the two volume
    // accumulators, so the fee program sits at 20. Verified against a real
    // PumpSwap sell signed through Vault on 2026-10-01 (6 instructions:
    // compute x2, transfer, WSOL create, sell, WSOL close). Amounts are raw
    // units; the signed mint accounts identify them.
    provenance: { protocol: 'https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json' },
    programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    discriminator: Buffer.from('33e685a4017f83ad', 'hex'),
    programName: 'Pump.fun',
    instructionName: 'Sell tokens',
    args: [
      { type: ARG_TOKEN_AMOUNT, label: 'You sell', mintAccount: 3, role: ROLE_SPEND_EXACT },
      { type: ARG_TOKEN_AMOUNT, label: 'Receive at least', mintAccount: 4, role: ROLE_RECEIVE_MIN },
    ],
    // base_amount_in is exact; min_quote_amount_out bounds what you receive.
    intent: 'Sell {0} for at least {1}',
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
    token: { mint: '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', decimals: 6, symbol: 'SDICE' },
    provenance: { protocol: 'https://explorer.solana.com/address/CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR' },
    programId: 'CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR',
    discriminator: Buffer.from([0x51]),
    programName: 'SoltoshiDICE',
    instructionName: 'Blackjack join',
    args: [
      { type: ARG_U64, label: 'Round' },
      { type: ARG_U64, label: 'Revision' },
      { type: ARG_U8, label: 'Seat' },
      { type: ARG_TOKEN_AMOUNT, label: 'Buy-in', mintAccount: 3, role: ROLE_SPEND_EXACT },
      { type: ARG_PUBKEY, label: 'Session key' },
      { type: ARG_DURATION, label: 'Expires in' },
      { type: ARG_TOKEN_AMOUNT, label: 'Allowance', mintAccount: 3, role: ROLE_SPEND_MAX },
      { type: ARG_TOKEN_AMOUNT, label: 'Max wager', mintAccount: 3, role: ROLE_CAP },
    ],
    // The session key bets for you: allowance is its total budget, max wager each bet's cap (encoder evidence above).
    intent: 'Join blackjack seat {2} for {3}; key {4} may bet {7} each, {6} total, for {5}',
  },
  soltoshidiceCeeloBet: {
    protocol: 'SoltoshiDICE',
    action: 'Place a Cee-lo bet against the SoltoshiDICE bank: an SDICE wager plus a refundable SOL deposit',
    // Native Rust program with no published IDL. Every byte of the 26-byte
    // bet is covered, so nothing in the data goes unshown. Evidence, read
    // from the dapp's own bundles on https://soltoshidice.wtf (fetched
    // 2026-09-19; soltoshidice.fun serves a byte-identical app). Cite the
    // sha256, never the filename: the site redeploys under new content
    // hashes, which is why the Blackjack citation above no longer resolves.
    // Minified local identifiers rot the same way; they are quoted only to
    // locate the code inside a bundle of that exact hash.
    // - Tag: Game--h6LNB56.js (sha256 e558a5b4...) `tournamentBetInstruction`
    //   takes a funded bet and overwrites byte 0: `s.data[0]=54`, then only
    //   appends keys.
    // - Layout: funding-client-ClZqlif1.js (sha256 b8d2baf7...)
    //   `fundedBetInstruction` builds
    //     Buffer.concat([Buffer.from([p?51:41]), _.data.subarray(1), i(l)])
    //   over shared-client-CR8_DChw.js (sha256 ea80a3f2...)
    //   `sharedBetInstruction(e,t,n,a,o,s=!1,c,u=3)`, whose data is
    //     Buffer.concat([Buffer.from([9]), l(n), l(a), ...u>=4?[Buffer.from([4])]:[]])
    //   with `l` the u64 LE writer of client-CGozqpeV.js (sha256 e76fdfea...).
    //   Composed: u8 tag 54 | u64 round | u64 wager | u8 4 | u64 deposit,
    //   26 bytes, and the funded hop passes u = 4 so the offset-17 byte is
    //   always emitted.
    // - The offset-17 byte is labelled `Protocol`, which is the site's own
    //   word for it, not an interpretation of the value. State exactly what
    //   the encoder proves and no more:
    //   * VALUE: a hard-coded literal. sharedBetInstruction appends
    //     `Buffer.from([4])` — the 4 is in the source, not computed from
    //     anything — so on every tag this entry covers the byte is 4. If the
    //     bank moves to v5 the shipped encoder still writes 4 here; the value
    //     does not track a version, and a schema cannot be relabelled without
    //     a new signature.
    //   * PRESENCE: gated by `u >= 4`, where `u` is sharedBetInstruction's
    //     8th parameter. `u` carries `y.bankVersion` only on the bare shared
    //     path (tag 9, not in this catalog); `fundedBetInstruction` passes the
    //     literal 4, so for tags 41/51/54 the byte is emitted unconditionally.
    //     `y.bankVersion` is the bank account's own leading version byte,
    //     which client-CGozqpeV.js validates against the set [1,2,3,4].
    //   * The name: the quote request for this exact bet sends
    //     `protocol: 4` (Game--h6LNB56.js `dm('game-quote', {... protocol:4
    //     ...})`) — the dapp's own field name for the 4 it negotiates. That
    //     is the whole basis for the label. Nothing here shows the program
    //     reading this byte as a version, a count or an amount, so the label
    //     claims only what the site calls the field.
    // - Units. Wager: raw SDICE base units, 6 dp. The call site refuses a
    //   quote unless `y.wager === String(BigInt(t)*1000000n)` for the panel's
    //   whole-SDICE input (aria-label "Wager in SDICE"), and the same bundle
    //   renders `Number(wager)/1e6` + ' SDICE'. Deposit: lamports, the
    //   constant SOL_DEPOSIT_LAMPORTS = 10000000n guarded by
    //   `if(l!==10000000n)throw`, which the dapp's own approval line calls
    //   "a refundable 0.01 SOL deposit (network and account fees extra)".
    //   Account rent and the network fee are not in this instruction data,
    //   so this schema does not show them: the SOL figure on the device is
    //   the deposit, not the total SOL leaving the wallet.
    // - First party: active-C4XJrnCn.js (sha256 e33b846b...), served from the
    //   site's own origin, is the whole config — programId CuTLp7...VWBR,
    //   mint 4nCmpw...pump, decimals 6, bankWallet 5SD2yU...oJ1Y — and its
    //   bankPda and vault re-derive under that programId to the exact
    //   accounts inside the captured bet.
    // Instruction account 5 is the SDICE mint (Token-2022, 6 decimals):
    // sharedBetInstruction puts `T(f.mint)` sixth and both later hops append.
    token: { mint: '4nCmpwne7hCoWTSpAd54uENmCgHJrHTyn4DMPCEMpump', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', decimals: 6, symbol: 'SDICE' },
    provenance: { protocol: 'https://explorer.solana.com/address/CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR' },
    programId: 'CuTLp7pDmNGkFgi4aoh8Ef1YSjc2BzECQRLzYqaoVWBR',
    discriminator: Buffer.from([0x36]),
    programName: 'SoltoshiDICE',
    instructionName: 'Cee-lo place bet',
    args: [
      { type: ARG_U64, label: 'Round' },
      { type: ARG_TOKEN_AMOUNT, label: 'Wager', mintAccount: 5, role: ROLE_SPEND_EXACT },
      { type: ARG_U8, label: 'Protocol' },
      { type: ARG_LAMPORTS, label: 'SOL deposit', role: ROLE_SPEND_EXACT },
    ],
    // 'refundable' is the dapp's own word for the deposit (evidence above).
    intent: 'Bet {1} on Cee-lo round {0}, plus a refundable {3} deposit',
  },
  relayDepositNative: {
    programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
    discriminator: Buffer.from('0d9e0ddf5fd51c06', 'hex'),
    programName: 'Relay',
    instructionName: 'Bridge deposit',
    args: [
      { type: ARG_LAMPORTS, label: 'Amount', role: ROLE_SPEND_EXACT },
      { type: ARG_OPAQUE32, label: 'Order' },
    ],
    accounts: [{ index: 3, label: 'Vault' }],
    // What arrives on the other chain is Relay's obligation, not in these bytes.
    intent: 'Deposit {0} into Relay vault {a0} to bridge; delivery is by Relay',
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
  ...RIVERPROOF_CATALOG,
}
