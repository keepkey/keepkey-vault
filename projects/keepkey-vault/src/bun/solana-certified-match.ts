/**
 * Host mirror of the firmware's certified Solana schema rule.
 *
 * On the certified path the device has no blind-sign fallback: an envelope
 * whose schema does not apply fails with "Certified Solana schema does not
 * match transaction", even when the opaque path (one-shot consent plus
 * AdvancedMode) could have signed the same bytes. Vault and the ClearSign
 * Worker therefore certify a transaction only when this rule holds, and
 * otherwise leave it on the opaque path.
 *
 * Mirrors keepkey-firmware lib/firmware/solana.c (feat/solana-schema-v2):
 * parse_instruction_section, schema_applies(certified = true),
 * solana_schemaCompanionIsInert, the account bounds solana_parseLegacyTx and
 * solana_parseVersionedTx enforce under a trusted LUT, and the priority-fee
 * check fsm_msg_solana.h runs on certified reviews. Keep them in sync.
 * schema_applies also skips instructions the firmware decodes natively; no
 * catalog program is one of those (System, SPL Token, Token-2022, Stake,
 * Vote, ATA, ComputeBudget, Memo).
 */
import bs58 from 'bs58'

import {
  ARG_TOKEN_AMOUNT,
  CERTIFIED_SOLANA_CATALOG,
  solanaSchemaCoverage,
  type SolanaSchemaSpec,
} from './solana-certified-schema'
import type { ParsedSolanaMessage, SolanaInstruction } from './solana-tx'

/** SOL_MAX_INSTRUCTIONS: a longer message parses with no instructions at all. */
const SOL_MAX_INSTRUCTIONS = 12
/** SOL_MAX_ACCOUNTS (static plus trusted LUT keys) and SOL_MAX_LUT_ACCOUNTS. */
const SOL_MAX_ACCOUNTS = 32
const SOL_MAX_LUT_ACCOUNTS = 8

const SYSTEM_PROGRAM = bs58.decode('11111111111111111111111111111111')
const COMPUTE_BUDGET_PROGRAM = bs58.decode('ComputeBudget111111111111111111111111111111')
const MEMO_PROGRAM = bs58.decode('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const SYS_TRANSFER = 2
const TOKEN_PROGRAM = bs58.decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM = bs58.decode('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA_PROGRAM = bs58.decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const TOKEN_CLOSE_ACCOUNT = 9
const TOKEN_SYNC_NATIVE = 17

/** Byte equality over anything indexable, so a Buffer and a Uint8Array compare. */
function sameBytes(a: ArrayLike<number> | undefined, b: ArrayLike<number>): boolean {
  if (a === undefined || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The instruction shape a schema describes: its program, discriminator, exact
 * data length (no uncovered bytes), and every displayed account and every
 * TOKEN_AMOUNT mint account present in the instruction.
 */
export function solanaInstructionMatchesSchema(
  message: ParsedSolanaMessage,
  instruction: SolanaInstruction,
  spec: SolanaSchemaSpec,
): boolean {
  const data = instruction.data
  const accounts = instruction.accountIndices.length
  return sameBytes(message.staticAccounts[instruction.programIdIndex], bs58.decode(spec.programId))
    && data.length === solanaSchemaCoverage(spec)
    && sameBytes(data.subarray(0, spec.discriminator.length), spec.discriminator)
    && (spec.accounts || []).every((account) => account.index < accounts)
    && (spec.args || []).every((arg) => arg.type !== ARG_TOKEN_AMOUNT || arg.mintAccount! < accounts)
}

/** Account slot `slot` of `instruction` is one of the message's signers. */
function isSignerSlot(message: ParsedSolanaMessage, instruction: SolanaInstruction, slot: number): boolean {
  const index = instruction.accountIndices[slot]
  return index !== undefined && index < message.header.numRequiredSignatures
}

/**
 * The signer's own SOL wrap/unwrap around a DEX trade (firmware
 * schema_signerAccountCompanion): ATA Create/CreateIdempotent funded (slot 0)
 * and owned (slot 2) by a signer, SyncNative, and CloseAccount whose
 * destination (slot 1) and owner (slot 2) are signers.
 */
function isSignerAccountCompanion(message: ParsedSolanaMessage, instruction: SolanaInstruction): boolean {
  const program = message.staticAccounts[instruction.programIdIndex]
  const data = instruction.data
  if (sameBytes(program, ATA_PROGRAM)) {
    return (data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))
      && isSignerSlot(message, instruction, 0) && isSignerSlot(message, instruction, 2)
  }
  if (sameBytes(program, TOKEN_PROGRAM) || sameBytes(program, TOKEN_2022_PROGRAM)) {
    if (data.length !== 1) return false
    if (data[0] === TOKEN_SYNC_NATIVE) return instruction.accountIndices.length >= 1
    if (data[0] === TOKEN_CLOSE_ACCOUNT) {
      return instruction.accountIndices.length >= 3
        && isSignerSlot(message, instruction, 1) && isSignerSlot(message, instruction, 2)
    }
  }
  return false
}

/**
 * An instruction the certified review allows beside the described one:
 * ComputeBudget RequestHeapFrame (1), SetComputeUnitLimit (2), or
 * SetLoadedAccountsDataSizeLimit (4) with 5 bytes, SetComputeUnitPrice (3)
 * with 9 bytes, any Memo, or an exact System Transfer (u32 tag 2, 12 bytes,
 * 2 accounts) whose accounts are static message accounts, never LUT-resolved.
 * The certified review screens that transfer in full.
 */
function isCertifiedCompanion(message: ParsedSolanaMessage, instruction: SolanaInstruction): boolean {
  const program = message.staticAccounts[instruction.programIdIndex]
  const data = Buffer.from(instruction.data)
  if (sameBytes(program, COMPUTE_BUDGET_PROGRAM)) {
    return (data.length === 5 && [1, 2, 4].includes(data[0])) || (data.length === 9 && data[0] === 3)
  }
  if (sameBytes(program, MEMO_PROGRAM)) return true
  if (sameBytes(program, SYSTEM_PROGRAM)) {
    return data.length === 12
      && data.readUInt32LE(0) === SYS_TRANSFER
      && instruction.accountIndices.length === 2
      && instruction.accountIndices.every((index) => index < message.staticAccounts.length)
  }
  return isSignerAccountCompanion(message, instruction)
}

/** Writable plus readonly lookup-table indices the message serializes. */
function serializedLutCount(message: ParsedSolanaMessage): number {
  return message.altEntries.reduce(
    (count, entry) => count + entry.writableIndices.length + entry.readonlyIndices.length, 0)
}

/**
 * The device indexes the static accounts, then the trusted LUT proof's keys,
 * and refuses a certified request unless the proof has exactly one key per
 * serialized LUT index (none without lookup tables).
 */
function withinCertifiedAccountBounds(message: ParsedSolanaMessage, trustedLutCount: number): boolean {
  const lutAccounts = serializedLutCount(message)
  if (trustedLutCount !== lutAccounts) return false
  const total = message.staticAccounts.length + lutAccounts
  if (total > SOL_MAX_ACCOUNTS || lutAccounts > SOL_MAX_LUT_ACCOUNTS) return false
  // Lookup tables require a nonempty certified LUT proof.
  if (message.altEntries.length > 0 && lutAccounts === 0) return false
  return message.instructions.every((instruction) =>
    instruction.programIdIndex < total && instruction.accountIndices.every((index) => index < total))
}

/**
 * fsm_msgSolanaSignTx runs solana_validatePriorityFee on every certified
 * review, before any screen: no duplicate SetComputeUnitPrice or
 * SetComputeUnitLimit, and a max priority fee, ceil(price x limit / 1e6)
 * with limit 1,400,000 when unset, that fits a u64.
 */
function priorityFeeValid(message: ParsedSolanaMessage): boolean {
  let price: bigint | undefined
  let limit: bigint | undefined
  for (const instruction of message.instructions) {
    if (!sameBytes(message.staticAccounts[instruction.programIdIndex], COMPUTE_BUDGET_PROGRAM)) continue
    const data = Buffer.from(instruction.data)
    if (data.length === 9 && data[0] === 3) {
      if (price !== undefined) return false
      price = data.readBigUInt64LE(1)
    } else if (data.length === 5 && data[0] === 2) {
      if (limit !== undefined) return false
      limit = BigInt(data.readUInt32LE(1))
    }
  }
  return price === undefined || (price * (limit ?? 1_400_000n) + 999_999n) / 1_000_000n <= 0xffff_ffff_ffff_ffffn
}

/**
 * Firmware's certified rule for one schema: the index of the single
 * instruction `spec` describes when the device will apply it to this message,
 * else undefined. At most 8 instructions, exactly one match, every other
 * instruction a certified companion, and a valid priority fee.
 *
 * `trustedLutCount` is the number of keys in the LUT proof sent with the
 * schema. It defaults to the exact count the ClearSign service resolves (one
 * per serialized LUT index); pass the real proof's count to check an envelope.
 */
export function certifiedSolanaSchemaApplies(
  message: ParsedSolanaMessage,
  spec: SolanaSchemaSpec,
  trustedLutCount = serializedLutCount(message),
): number | undefined {
  if (
    message.instructions.length > SOL_MAX_INSTRUCTIONS ||
    !withinCertifiedAccountBounds(message, trustedLutCount) ||
    !priorityFeeValid(message)
  ) {
    return undefined
  }
  const matches = message.instructions.flatMap((instruction, index) =>
    solanaInstructionMatchesSchema(message, instruction, spec) ? [index] : [])
  if (matches.length !== 1) return undefined
  const [match] = matches
  return message.instructions.every((instruction, index) =>
    index === match || isCertifiedCompanion(message, instruction))
    ? match
    : undefined
}

/**
 * The one reviewed catalog entry this message certifies under, or undefined.
 * Pure and local: Vault uses it to decide whether a transaction may be sent
 * to the ClearSign service at all.
 */
export function findLocalCertifiedSolanaMatch(
  message: ParsedSolanaMessage,
): { catalogKey: string; spec: SolanaSchemaSpec; instructionIndex: number } | undefined {
  const found = Object.entries(CERTIFIED_SOLANA_CATALOG).flatMap(([catalogKey, spec]) => {
    const instructionIndex = certifiedSolanaSchemaApplies(message, spec)
    return instructionIndex === undefined ? [] : [{ catalogKey, spec, instructionIndex }]
  })
  return found.length === 1 ? found[0] : undefined
}
