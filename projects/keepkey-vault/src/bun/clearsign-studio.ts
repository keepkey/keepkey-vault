import bs58 from 'bs58'

import type {
  ClearSignSolanaArgType,
  ClearSignSolanaSchemaArtifact,
  ClearSignSolanaSchemaDraft,
} from '../shared/types'

export const KKSOL_SCHEMA_MAGIC = Buffer.from('KKSOLSC1', 'ascii')
export const KKSOL_SCHEMA_VERSION = 1
export const KKSOL_NAME_MAX = 20
export const KKSOL_LABEL_MAX = 16
export const KKSOL_MAX_ARGS = 4
export const KKSOL_MAX_ACCOUNTS = 4
export const KKSOL_DISC_MAX = 8
export const KKSOL_MAX_PAYLOAD_BYTES = 256

const ARG_TYPE_TO_BYTE: Record<ClearSignSolanaArgType, number> = {
  u64: 1,
  u8: 2,
  pubkey: 3,
  opaque32: 4,
}

const ARG_BYTE_TO_TYPE = new Map<number, ClearSignSolanaArgType>(
  Object.entries(ARG_TYPE_TO_BYTE).map(([type, byte]) => [byte, type as ClearSignSolanaArgType]),
)

const ARG_WIDTH: Record<ClearSignSolanaArgType, number> = {
  u64: 8,
  u8: 1,
  pubkey: 32,
  opaque32: 32,
}

function parseHex(value: string, field: string, minBytes?: number, maxBytes?: number): Buffer {
  const normalized = String(value || '').trim().replace(/^0x/i, '').replace(/\s+/g, '')
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error(`${field} must be even-length hexadecimal`)
  }
  const bytes = Buffer.from(normalized, 'hex')
  if (minBytes !== undefined && bytes.length < minBytes) {
    throw new Error(`${field} must be at least ${minBytes} byte${minBytes === 1 ? '' : 's'}`)
  }
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    throw new Error(`${field} must be at most ${maxBytes} bytes`)
  }
  return bytes
}

function parseProgramId(value: string): Buffer {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error('Program ID is required')
  let bytes: Uint8Array
  if (/^(?:0x)?[0-9a-f]{64}$/i.test(normalized)) {
    bytes = Buffer.from(normalized.replace(/^0x/i, ''), 'hex')
  } else {
    try {
      bytes = bs58.decode(normalized)
    } catch {
      throw new Error('Program ID must be a 32-byte base58 address or 64 hex characters')
    }
  }
  if (bytes.length !== 32) throw new Error(`Program ID must decode to 32 bytes (got ${bytes.length})`)
  return Buffer.from(bytes)
}

function textPart(value: string, maxLength: number, field: string): Buffer {
  const text = String(value || '')
  if (!text) throw new Error(`${field} is required`)
  if (text.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`)
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code > 0x7e || char === '%') {
      throw new Error(`${field} must contain printable ASCII and cannot contain %`)
    }
  }
  const bytes = Buffer.from(text, 'ascii')
  return Buffer.concat([Buffer.from([bytes.length]), bytes])
}

function normalizeDraft(draft: ClearSignSolanaSchemaDraft): ClearSignSolanaSchemaDraft {
  const programId = parseProgramId(draft.programId)
  const discriminator = parseHex(draft.discriminator, 'Discriminator', 1, KKSOL_DISC_MAX)
  const args = Array.isArray(draft.args) ? draft.args : []
  const accounts = Array.isArray(draft.accounts) ? draft.accounts : []
  if (args.length > KKSOL_MAX_ARGS) throw new Error(`A schema can contain at most ${KKSOL_MAX_ARGS} arguments`)
  if (accounts.length > KKSOL_MAX_ACCOUNTS) throw new Error(`A schema can contain at most ${KKSOL_MAX_ACCOUNTS} accounts`)

  const normalizedArgs = args.map((arg, index) => {
    if (!(arg.type in ARG_TYPE_TO_BYTE)) throw new Error(`Argument ${index + 1} has an unsupported type`)
    textPart(arg.label, KKSOL_LABEL_MAX, `Argument ${index + 1} label`)
    return { type: arg.type, label: arg.label }
  })
  const normalizedAccounts = accounts.map((account, index) => {
    if (!Number.isInteger(account.index) || account.index < 0 || account.index > 255) {
      throw new Error(`Account ${index + 1} index must be an integer from 0 to 255`)
    }
    textPart(account.label, KKSOL_LABEL_MAX, `Account ${index + 1} label`)
    return { index: account.index, label: account.label }
  })

  textPart(draft.programName, KKSOL_NAME_MAX, 'Program name')
  textPart(draft.instructionName, KKSOL_NAME_MAX, 'Instruction name')
  return {
    programId: bs58.encode(programId),
    discriminator: discriminator.toString('hex'),
    programName: draft.programName,
    instructionName: draft.instructionName,
    args: normalizedArgs,
    accounts: normalizedAccounts,
  }
}

export function buildSolanaSchema(draft: ClearSignSolanaSchemaDraft): ClearSignSolanaSchemaArtifact {
  const normalized = normalizeDraft(draft)
  const programId = parseProgramId(normalized.programId)
  const discriminator = parseHex(normalized.discriminator, 'Discriminator', 1, KKSOL_DISC_MAX)
  const parts: Buffer[] = [
    KKSOL_SCHEMA_MAGIC,
    Buffer.from([KKSOL_SCHEMA_VERSION]),
    programId,
    Buffer.from([discriminator.length]),
    discriminator,
    textPart(normalized.programName, KKSOL_NAME_MAX, 'Program name'),
    textPart(normalized.instructionName, KKSOL_NAME_MAX, 'Instruction name'),
    Buffer.from([normalized.args.length]),
  ]
  for (const arg of normalized.args) {
    parts.push(Buffer.from([ARG_TYPE_TO_BYTE[arg.type]]), textPart(arg.label, KKSOL_LABEL_MAX, 'Argument label'))
  }
  parts.push(Buffer.from([normalized.accounts.length]))
  for (const account of normalized.accounts) {
    parts.push(Buffer.from([account.index]), textPart(account.label, KKSOL_LABEL_MAX, 'Account label'))
  }
  const payload = Buffer.concat(parts)
  if (payload.length > KKSOL_MAX_PAYLOAD_BYTES) {
    throw new Error(`Schema is ${payload.length} bytes; firmware accepts at most ${KKSOL_MAX_PAYLOAD_BYTES}`)
  }
  return {
    format: 'KKSOLSC1',
    payload: payload.toString('hex'),
    byteLength: payload.length,
    coverageBytes: discriminator.length + normalized.args.reduce((sum, arg) => sum + ARG_WIDTH[arg.type], 0),
    draft: normalized,
  }
}

/** Parse and fully validate raw KKSOLSC1 bytes using the firmware's limits. */
export function inspectSolanaSchema(payloadHex: string): ClearSignSolanaSchemaArtifact {
  const payload = parseHex(payloadHex, 'Schema payload', 1, KKSOL_MAX_PAYLOAD_BYTES)
  let offset = 0
  const need = (count: number) => {
    if (offset + count > payload.length) throw new Error('Schema payload is truncated')
  }
  need(KKSOL_SCHEMA_MAGIC.length)
  if (!payload.subarray(0, KKSOL_SCHEMA_MAGIC.length).equals(KKSOL_SCHEMA_MAGIC)) {
    throw new Error('The current attestor accepts KKSOLSC1 instruction schemas only')
  }
  offset = KKSOL_SCHEMA_MAGIC.length
  need(1)
  if (payload[offset++] !== KKSOL_SCHEMA_VERSION) throw new Error('Unsupported KKSOLSC1 schema version')
  need(32)
  const programId = payload.subarray(offset, offset + 32)
  offset += 32
  need(1)
  const discriminatorLength = payload[offset++]
  if (discriminatorLength < 1 || discriminatorLength > KKSOL_DISC_MAX) throw new Error('Invalid discriminator length')
  need(discriminatorLength)
  const discriminator = payload.subarray(offset, offset + discriminatorLength)
  offset += discriminatorLength

  const readText = (maxLength: number, field: string): string => {
    need(1)
    const length = payload[offset++]
    if (length < 1 || length > maxLength) throw new Error(`Invalid ${field} length`)
    need(length)
    const value = payload.subarray(offset, offset + length).toString('ascii')
    offset += length
    textPart(value, maxLength, field)
    return value
  }

  const programName = readText(KKSOL_NAME_MAX, 'program name')
  const instructionName = readText(KKSOL_NAME_MAX, 'instruction name')
  need(1)
  const argumentCount = payload[offset++]
  if (argumentCount > KKSOL_MAX_ARGS) throw new Error('Schema has too many arguments')
  const args: ClearSignSolanaSchemaDraft['args'] = []
  for (let i = 0; i < argumentCount; i++) {
    need(1)
    const type = ARG_BYTE_TO_TYPE.get(payload[offset++])
    if (!type) throw new Error(`Argument ${i + 1} has an unsupported type`)
    args.push({ type, label: readText(KKSOL_LABEL_MAX, `argument ${i + 1} label`) })
  }
  need(1)
  const accountCount = payload[offset++]
  if (accountCount > KKSOL_MAX_ACCOUNTS) throw new Error('Schema has too many accounts')
  const accounts: ClearSignSolanaSchemaDraft['accounts'] = []
  for (let i = 0; i < accountCount; i++) {
    need(1)
    const index = payload[offset++]
    accounts.push({ index, label: readText(KKSOL_LABEL_MAX, `account ${i + 1} label`) })
  }
  if (offset !== payload.length) throw new Error('Schema payload has trailing bytes')

  return {
    format: 'KKSOLSC1',
    payload: payload.toString('hex'),
    byteLength: payload.length,
    coverageBytes: discriminator.length + args.reduce((sum, arg) => sum + ARG_WIDTH[arg.type], 0),
    draft: {
      programId: bs58.encode(programId),
      discriminator: discriminator.toString('hex'),
      programName,
      instructionName,
      args,
      accounts,
    },
  }
}

