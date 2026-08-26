/**
 * Canonical KKSOLSC1 instruction-schema builder for the KeepKey SDK tests.
 *
 * A schema says how to READ one Solana instruction — program id,
 * discriminator, and the labelled args/accounts to display. It carries no
 * amounts and no transaction hash, so ONE signature covers every future
 * transaction to that program+instruction; the device decodes the values out
 * of the bytes it is about to sign.
 *
 * Mirrors the firmware parser byte-for-byte (keepkey-firmware
 * lib/firmware/solana.c: solana_parseInstrSchema / solana_schemaApplies,
 * declared in include/keepkey/firmware/solana.h). Keep the two in sync — the
 * offline gate exists to catch drift before it reaches a device.
 *
 * Lives in tests/fixtures so run-all.js does not execute it as a suite.
 */
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')
const { TEST_PRIV, TEST_KEY_ID, CI_TEST_PUBKEY, CI_SIGNER_ALIAS } = require('../_clearsign')

const MAGIC = Buffer.from('KKSOLSC1', 'ascii')
const SCHEMA_VERSION = 1

/* Caps from solana.h — the firmware rejects anything larger. */
const NAME_MAX = 20
const LABEL_MAX = 16
const MAX_ARGS = 4
const MAX_ACCOUNTS = 4
const DISC_MAX = 8
/* SolanaSignTx.schema_payload max_size in messages-solana.options */
const MAX_PAYLOAD_BYTES = 256

/* SolanaSchemaArgType */
const ARG_U64 = 1
const ARG_U8 = 2
const ARG_PUBKEY = 3
const ARG_OPAQUE32 = 4
const ARG_LAMPORTS = 5

/** Byte width each arg consumes in the instruction data (solana_schemaArgWidth). */
const ARG_WIDTH = { [ARG_U64]: 8, [ARG_U8]: 1, [ARG_PUBKEY]: 32, [ARG_OPAQUE32]: 32, [ARG_LAMPORTS]: 8 }

/**
 * REAL Relay bridge instructions, captured from api.relay.link on 2026-07-27.
 * Both are 48 bytes: 8-byte discriminator + u64 amount (LE) + 32-byte order id.
 * The amount word was verified to track the requested input exactly across
 * several quotes, which is what makes a fixed-width schema legitimate here.
 */
const RELAY_PROGRAM_B58 = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'
const RELAY_NATIVE_DISC = Buffer.from('0d9e0ddf5fd51c06', 'hex') // SOL source, 5 accounts
const RELAY_TOKEN_DISC = Buffer.from('0b9c60da27a3b413', 'hex') // SPL source, 10 accounts

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(str) {
  let num = 0n
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error(`invalid base58 character "${ch}"`)
    num = num * 58n + BigInt(idx)
  }
  const bytes = []
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn))
    num >>= 8n
  }
  for (const ch of str) {
    if (ch !== '1') break
    bytes.unshift(0)
  }
  return Buffer.from(bytes)
}

/** Display text must be printable ASCII with no '%' (schema_text_ok). */
function lenPrefixedText(value, maxLength, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} chars`)
  for (const ch of value) {
    const cp = ch.codePointAt(0)
    if (cp < 0x20 || cp > 0x7e || ch === '%') {
      throw new Error(`${name} contains a character the device will not display`)
    }
  }
  const bytes = Buffer.from(value, 'ascii')
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

/**
 * Serialize a KKSOLSC1 payload.
 * @param {{programId: Buffer|string, discriminator: Buffer, programName: string,
 *          instructionName: string, args?: {type:number,label:string}[],
 *          accounts?: {index:number,label:string}[]}} spec
 */
function serializeSchema(spec) {
  const programId =
    typeof spec.programId === 'string' ? base58Decode(spec.programId) : Buffer.from(spec.programId)
  if (programId.length !== 32) throw new Error('programId must be 32 bytes')
  const disc = Buffer.from(spec.discriminator)
  if (disc.length < 1 || disc.length > DISC_MAX) {
    throw new Error(`discriminator must be 1..${DISC_MAX} bytes`)
  }
  const args = spec.args || []
  const accounts = spec.accounts || []
  if (args.length > MAX_ARGS) throw new Error(`at most ${MAX_ARGS} args`)
  if (accounts.length > MAX_ACCOUNTS) throw new Error(`at most ${MAX_ACCOUNTS} accounts`)

  const parts = [
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
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload ${payload.length}B exceeds the ${MAX_PAYLOAD_BYTES}B proto cap`)
  }
  return payload
}

/** Parse a payload back, applying the same validation the firmware does. */
function decodeSchema(payload) {
  let p = 0
  const need = (n) => {
    if (p + n > payload.length) throw new Error('truncated schema')
  }
  need(8)
  if (!payload.subarray(0, 8).equals(MAGIC)) throw new Error('bad magic')
  p = 8
  need(1)
  if (payload[p++] !== SCHEMA_VERSION) throw new Error('bad version')
  need(32)
  const programId = payload.subarray(p, p + 32)
  p += 32
  need(1)
  const discLen = payload[p++]
  if (discLen < 1 || discLen > DISC_MAX) throw new Error('bad disc_len')
  need(discLen)
  const discriminator = payload.subarray(p, p + discLen)
  p += discLen

  const readText = (max) => {
    need(1)
    const len = payload[p++]
    if (len < 1 || len > max) throw new Error('bad text length')
    need(len)
    const buf = payload.subarray(p, p + len)
    for (const b of buf) {
      if (b < 0x20 || b > 0x7e || b === 0x25) throw new Error('unsafe display text')
    }
    p += len
    return buf.toString('ascii')
  }

  const programName = readText(NAME_MAX)
  const instructionName = readText(NAME_MAX)
  need(1)
  const nArgs = payload[p++]
  if (nArgs > MAX_ARGS) throw new Error('too many args')
  const args = []
  for (let i = 0; i < nArgs; i++) {
    need(1)
    const type = payload[p++]
    if (!ARG_WIDTH[type]) throw new Error('unknown arg type')
    args.push({ type, label: readText(LABEL_MAX) })
  }
  need(1)
  const nAccounts = payload[p++]
  if (nAccounts > MAX_ACCOUNTS) throw new Error('too many accounts')
  const accounts = []
  for (let i = 0; i < nAccounts; i++) {
    need(1)
    const index = payload[p++]
    accounts.push({ index, label: readText(LABEL_MAX) })
  }
  if (p !== payload.length) throw new Error('trailing bytes')
  return { programId, discriminator, programName, instructionName, args, accounts }
}

/** Bytes the schema claims to account for: discriminator + every arg width. */
function schemaCoverage(schema) {
  return schema.discriminator.length + schema.args.reduce((n, a) => n + ARG_WIDTH[a.type], 0)
}

/**
 * Mirror of solana_schemaApplies() for offline testing: does this schema
 * legitimately describe `instruction`? Returns a reason string on refusal so
 * tests assert WHY, not just that it failed.
 */
function schemaApplies(schema, instruction) {
  if (instruction.external) return 'instruction uses lookup-table accounts'
  if (!Buffer.from(instruction.programId).equals(schema.programId)) return 'program mismatch'
  const data = Buffer.from(instruction.data)
  if (data.length < schema.discriminator.length) return 'data shorter than discriminator'
  if (!data.subarray(0, schema.discriminator.length).equals(schema.discriminator)) {
    return 'discriminator mismatch'
  }
  if (schemaCoverage(schema) !== data.length) {
    return `incomplete coverage: schema accounts for ${schemaCoverage(schema)} of ${data.length} bytes`
  }
  for (const acct of schema.accounts) {
    if (acct.index >= instruction.accountCount) return `account index ${acct.index} out of range`
  }
  return null
}

/** Read the labelled args out of instruction data, as the device screens do. */
function decodeArgs(schema, data) {
  const buf = Buffer.from(data)
  let off = schema.discriminator.length
  return schema.args.map((arg) => {
    let value
    switch (arg.type) {
      case ARG_U64:
      case ARG_LAMPORTS:
        value = buf.readBigUInt64LE(off)
        break
      case ARG_U8:
        value = buf[off]
        break
      case ARG_PUBKEY:
      case ARG_OPAQUE32:
        value = buf.subarray(off, off + 32).toString('hex')
        break
      default:
        throw new Error('unknown arg type')
    }
    off += ARG_WIDTH[arg.type]
    return { label: arg.label, type: arg.type, value }
  })
}

/* lowS:false — matches the rest of the SDK clearsign fixtures; the firmware
 * verifier does not require S normalization and the EVM parity gate proved
 * noble's lowS:true default diverges from the reference signer. */
function signSchema(payload, privateKey = TEST_PRIV) {
  return Buffer.from(secp256k1.sign(sha256(payload), privateKey, { lowS: false }).toCompactRawBytes())
}

/** A schema plus its signature, in the shape SolanaSignTx expects. */
function buildSignedSchema(spec) {
  const payload = serializeSchema(spec)
  const signature = signSchema(payload)
  return {
    payload,
    signature,
    schema: {
      payload: payload.toString('base64'),
      signature: signature.toString('base64'),
      signerKeyId: TEST_KEY_ID,
    },
  }
}

/**
 * The catalog. Each entry is a real, captured instruction shape — adding one
 * here is what "supporting a new program" means, and it needs no firmware
 * change once a signer is trusted.
 */
const CATALOG = {
  relayDepositNative: {
    programId: RELAY_PROGRAM_B58,
    discriminator: RELAY_NATIVE_DISC,
    programName: 'Relay Bridge',
    instructionName: 'depositNative',
    args: [
      { type: ARG_LAMPORTS, label: 'Amount' },
      { type: ARG_OPAQUE32, label: 'Order' },
    ],
    accounts: [{ index: 3, label: 'Vault' }],
  },
  relayDepositToken: {
    programId: RELAY_PROGRAM_B58,
    discriminator: RELAY_TOKEN_DISC,
    programName: 'Relay Bridge',
    instructionName: 'depositToken',
    args: [
      { type: ARG_U64, label: 'Amount' },
      { type: ARG_OPAQUE32, label: 'Order' },
    ],
    accounts: [{ index: 3, label: 'Vault' }],
  },
}

/** Instruction data as Relay actually emits it: disc + u64 LE amount + order id. */
function buildRelayInstructionData(discriminator, amount, orderId = Buffer.alloc(32, 0xab)) {
  const out = Buffer.alloc(discriminator.length + 8 + 32)
  Buffer.from(discriminator).copy(out, 0)
  out.writeBigUInt64LE(BigInt(amount), discriminator.length)
  Buffer.from(orderId).copy(out, discriminator.length + 8)
  return out
}

module.exports = {
  MAGIC,
  SCHEMA_VERSION,
  NAME_MAX,
  LABEL_MAX,
  MAX_ARGS,
  MAX_ACCOUNTS,
  DISC_MAX,
  MAX_PAYLOAD_BYTES,
  ARG_U64,
  ARG_U8,
  ARG_PUBKEY,
  ARG_OPAQUE32,
  ARG_LAMPORTS,
  ARG_WIDTH,
  RELAY_PROGRAM_B58,
  RELAY_NATIVE_DISC,
  RELAY_TOKEN_DISC,
  CATALOG,
  TEST_KEY_ID,
  CI_TEST_PUBKEY,
  CI_SIGNER_ALIAS,
  TEST_PRIV,
  base58Decode,
  serializeSchema,
  decodeSchema,
  schemaCoverage,
  schemaApplies,
  decodeArgs,
  signSchema,
  buildSignedSchema,
  buildRelayInstructionData,
}
