/**
 * Solana instruction decoder — reads the program registry from
 * `@pioneer-platform/pioneer-discovery` and turns raw instruction bytes
 * into a human-readable form for the signing-approval UI.
 *
 * Decoding flow for each instruction:
 *
 *   1. Resolve `programIdIndex` to a base58 program id via the expanded
 *      account list (static keys followed by ALT-resolved writable then
 *      readonly accounts, matching Solana's runtime resolution order).
 *   2. Look up the program in the registry. If absent, return an
 *      `unknown-program` descriptor — the UI still shows the id (truncated)
 *      and the account/data byte counts so the user knows what they're
 *      signing even without a rich schema.
 *   3. Extract the discriminator from `instruction.data` per the program's
 *      declared encoding (`u8`, `u32-le`, `anchor` 8-byte sighash, or
 *      `none`) and look up the instruction schema.
 *   4. Walk the declared args over the remaining data bytes and render
 *      typed values (u64 as decimal, pubkey as base58, string as UTF-8,
 *      bytes as hex tail).
 *   5. Map each schema account label to the resolved base58 key from the
 *      instruction's `accountIndices`.
 *
 * Nothing here talks to firmware. The output feeds the Vault-side approval
 * dialog, and (in a future PR) the signed-metadata blob sent over
 * `SolanaTxMetadata` when firmware ships native v0 support.
 */

import bs58 from 'bs58'
import { solanaPrograms as solanaProgramsData } from '@pioneer-platform/pioneer-discovery'
import localPrograms from './solana-programs-local.json'

// ── Registry shape ────────────────────────────────────────────────────

export type SolanaArgType = 'u8' | 'u16' | 'u32' | 'u64' | 'bool' | 'pubkey' | 'string' | 'bytes'

export interface SolanaArgSchema {
  name: string
  type: SolanaArgType
}

export interface SolanaInstructionSchema {
  name: string
  description?: string
  accounts?: string[]
  args?: SolanaArgSchema[]
}

export type DiscriminatorEncoding = 'u8' | 'u32-le' | 'anchor' | 'none'

export interface SolanaProgramEntry {
  name: string
  category: string
  website?: string
  description?: string
  discriminator?: {
    encoding: DiscriminatorEncoding
    offset?: number
    length?: number
  }
  instructions?: Record<string, SolanaInstructionSchema>
}

export interface SolanaProgramRegistry {
  programs: Record<string, SolanaProgramEntry>
}

// The JSON is imported as `any`; narrow it so callers get completion.
// Local entries win over the published pioneer-discovery registry so a newly
// decoded program (e.g. a bridge router) reaches the review UI without waiting
// on a package release. Contribute the same entry upstream and drop it here
// once a published version carries it.
export const PROGRAM_REGISTRY: SolanaProgramRegistry = {
  programs: {
    ...(solanaProgramsData as unknown as SolanaProgramRegistry).programs,
    ...(localPrograms as unknown as SolanaProgramRegistry).programs,
  },
}

// ── Decoded-output types ──────────────────────────────────────────────

export interface DecodedArg {
  name: string
  type: SolanaArgType
  /** Human-readable value: decimal for numbers, base58 for pubkeys, UTF-8 for strings, hex for bytes. */
  value: string
  /** Raw byte range for diagnostics / UI detail panels. */
  rawHex: string
}

export interface DecodedInstructionAccount {
  /** Schema-declared label (e.g. "source", "destination") if available. */
  label?: string
  /** base58-encoded pubkey from the expanded account list. */
  pubkey: string
  /** Original index into the expanded account list (useful for ALT-origin flags). */
  index: number
}

export type DecodedInstructionStatus = 'known' | 'known-program-unknown-ix' | 'unknown-program'

export interface DecodedInstruction {
  status: DecodedInstructionStatus
  /** base58 program id from the instruction. */
  programId: string
  /** Human-readable program name if in the registry; otherwise a truncated program id. */
  programName: string
  /** Category from the registry, e.g. "core" / "token" / "nft". Undefined when unknown. */
  programCategory?: string
  /** Human-readable instruction name (e.g. "transfer"). Undefined when unknown. */
  instructionName?: string
  /** Decoded argument list (empty when not in registry or args can't be decoded). */
  args: DecodedArg[]
  /** Account references in the order the program expects them. */
  accounts: DecodedInstructionAccount[]
  /** Hex of the discriminator bytes used for lookup (diagnostics). */
  discriminatorHex?: string
  /** Any non-fatal note about the decode (e.g. "truncated args after <n> bytes"). */
  note?: string
}

// ── Discriminator extraction ──────────────────────────────────────────

function extractDiscriminator(data: Uint8Array, encoding: DiscriminatorEncoding): string | null {
  switch (encoding) {
    case 'none': return null
    case 'u8':
      if (data.length < 1) return null
      return data[0].toString(16).padStart(2, '0')
    case 'u32-le':
      if (data.length < 4) return null
      return Array.from(data.subarray(0, 4)).map((b) => b.toString(16).padStart(2, '0')).join('')
    case 'anchor':
      if (data.length < 8) return null
      return Array.from(data.subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }
}

function discriminatorLength(encoding: DiscriminatorEncoding): number {
  switch (encoding) {
    case 'none': return 0
    case 'u8': return 1
    case 'u32-le': return 4
    case 'anchor': return 8
  }
}

// ── Arg decoding ──────────────────────────────────────────────────────

interface ReadResult {
  arg: DecodedArg
  nextOffset: number
}

function readU8(data: Uint8Array, offset: number, name: string): ReadResult {
  const v = data[offset]
  return {
    arg: { name, type: 'u8', value: v.toString(10), rawHex: v.toString(16).padStart(2, '0') },
    nextOffset: offset + 1,
  }
}

function readLe(data: Uint8Array, offset: number, byteCount: number): bigint {
  let n = 0n
  for (let i = 0; i < byteCount; i++) {
    n |= BigInt(data[offset + i]) << BigInt(8 * i)
  }
  return n
}

function readU16(data: Uint8Array, offset: number, name: string): ReadResult {
  const n = readLe(data, offset, 2)
  return {
    arg: { name, type: 'u16', value: n.toString(), rawHex: bufToHex(data.subarray(offset, offset + 2)) },
    nextOffset: offset + 2,
  }
}

function readU32(data: Uint8Array, offset: number, name: string): ReadResult {
  const n = readLe(data, offset, 4)
  return {
    arg: { name, type: 'u32', value: n.toString(), rawHex: bufToHex(data.subarray(offset, offset + 4)) },
    nextOffset: offset + 4,
  }
}

function readU64(data: Uint8Array, offset: number, name: string): ReadResult {
  const n = readLe(data, offset, 8)
  return {
    arg: { name, type: 'u64', value: n.toString(), rawHex: bufToHex(data.subarray(offset, offset + 8)) },
    nextOffset: offset + 8,
  }
}

function readBool(data: Uint8Array, offset: number, name: string): ReadResult {
  const v = data[offset]
  return {
    arg: { name, type: 'bool', value: v === 0 ? 'false' : 'true', rawHex: v.toString(16).padStart(2, '0') },
    nextOffset: offset + 1,
  }
}

function readPubkey(data: Uint8Array, offset: number, name: string): ReadResult {
  const bytes = data.subarray(offset, offset + 32)
  return {
    arg: { name, type: 'pubkey', value: bs58.encode(bytes), rawHex: bufToHex(bytes) },
    nextOffset: offset + 32,
  }
}

function readBytesRemaining(data: Uint8Array, offset: number, name: string, type: SolanaArgType): ReadResult {
  const bytes = data.subarray(offset)
  const value = type === 'string'
    ? new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    : bufToHex(bytes)
  return {
    arg: { name, type, value, rawHex: bufToHex(bytes) },
    nextOffset: data.length,
  }
}

function bufToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

function requiredBytes(type: SolanaArgType): number {
  switch (type) {
    case 'u8': case 'bool': return 1
    case 'u16': return 2
    case 'u32': return 4
    case 'u64': return 8
    case 'pubkey': return 32
    case 'string': case 'bytes': return 0 // consume remaining
  }
}

function decodeArgs(data: Uint8Array, start: number, schema: SolanaArgSchema[]): { args: DecodedArg[]; note?: string } {
  const args: DecodedArg[] = []
  let offset = start
  for (const arg of schema) {
    const need = requiredBytes(arg.type)
    if (need > 0 && offset + need > data.length) {
      return { args, note: `truncated at arg "${arg.name}" (need ${need}B, have ${data.length - offset}B)` }
    }
    let res: ReadResult
    switch (arg.type) {
      case 'u8':     res = readU8(data, offset, arg.name); break
      case 'u16':    res = readU16(data, offset, arg.name); break
      case 'u32':    res = readU32(data, offset, arg.name); break
      case 'u64':    res = readU64(data, offset, arg.name); break
      case 'bool':   res = readBool(data, offset, arg.name); break
      case 'pubkey': res = readPubkey(data, offset, arg.name); break
      case 'string': res = readBytesRemaining(data, offset, arg.name, 'string'); break
      case 'bytes':  res = readBytesRemaining(data, offset, arg.name, 'bytes'); break
    }
    args.push(res.arg)
    offset = res.nextOffset
  }
  return { args }
}

// ── Main entry point ──────────────────────────────────────────────────

export interface DecodeInstructionInput {
  programIdIndex: number
  accountIndices: number[]
  data: Uint8Array
  /** Expanded account list: static accounts first, then ALT writable, then ALT readonly. */
  expandedAccounts: string[]
  /** Optional registry override for tests. Defaults to {@link PROGRAM_REGISTRY}. */
  registry?: SolanaProgramRegistry
}

export function decodeInstruction(input: DecodeInstructionInput): DecodedInstruction {
  const registry = input.registry ?? PROGRAM_REGISTRY
  const programId = input.expandedAccounts[input.programIdIndex] ?? '<oob>'
  const program = registry.programs[programId]

  // Labels are attached below once we know the matching instruction schema.
  const accounts: DecodedInstructionAccount[] = input.accountIndices.map((idx) => ({
    pubkey: input.expandedAccounts[idx] ?? '<oob>',
    index: idx,
  }))

  if (!program) {
    return {
      status: 'unknown-program',
      programId,
      programName: programId.slice(0, 6) + '…' + programId.slice(-4),
      args: [],
      accounts,
    }
  }

  const encoding: DiscriminatorEncoding = program.discriminator?.encoding ?? 'none'
  const discHex = extractDiscriminator(input.data, encoding)
  const schema = discHex ? program.instructions?.[discHex] : undefined

  if (!schema) {
    return {
      status: 'known-program-unknown-ix',
      programId,
      programName: program.name,
      programCategory: program.category,
      args: [],
      accounts,
      discriminatorHex: discHex ?? undefined,
      note: discHex ? `no schema for discriminator ${discHex}` : 'program has no discriminator encoding',
    }
  }

  // Label accounts using the schema's ordered labels.
  if (schema.accounts) {
    for (let i = 0; i < accounts.length && i < schema.accounts.length; i++) {
      accounts[i].label = schema.accounts[i]
    }
  }

  const argStart = discriminatorLength(encoding)
  const { args, note } = decodeArgs(input.data, argStart, schema.args ?? [])

  return {
    status: 'known',
    programId,
    programName: program.name,
    programCategory: program.category,
    instructionName: schema.name,
    args,
    accounts,
    discriminatorHex: discHex ?? undefined,
    note,
  }
}

/**
 * Build the expanded account list in Solana's canonical v0 resolution
 * order: static accounts, then ALT-writable accounts (in ALT order, then
 * index order within each), then ALT-readonly accounts. This is the same
 * ordering the Solana runtime applies when executing a v0 tx.
 */
export function buildExpandedAccounts(
  staticAccountsBase58: string[],
  altEntries: Array<{ accountKey: string; writableIndices: number[]; readonlyIndices: number[] }>,
  altContents: Map<string, string[]>,
): { expanded: string[]; altOrigins: Array<{ from: 'static' | 'alt-writable' | 'alt-readonly'; altPubkey?: string; altIndex?: number }> } {
  const expanded = [...staticAccountsBase58]
  const altOrigins: Array<{ from: 'static' | 'alt-writable' | 'alt-readonly'; altPubkey?: string; altIndex?: number }> =
    staticAccountsBase58.map(() => ({ from: 'static' as const }))

  // ALT writables first (Solana runtime order)
  for (const alt of altEntries) {
    const contents = altContents.get(alt.accountKey)
    for (const idx of alt.writableIndices) {
      expanded.push(contents?.[idx] ?? `<alt:${alt.accountKey.slice(0, 4)}…[${idx}]>`)
      altOrigins.push({ from: 'alt-writable', altPubkey: alt.accountKey, altIndex: idx })
    }
  }
  // ALT readonlies after all writables
  for (const alt of altEntries) {
    const contents = altContents.get(alt.accountKey)
    for (const idx of alt.readonlyIndices) {
      expanded.push(contents?.[idx] ?? `<alt:${alt.accountKey.slice(0, 4)}…[${idx}]>`)
      altOrigins.push({ from: 'alt-readonly', altPubkey: alt.accountKey, altIndex: idx })
    }
  }
  return { expanded, altOrigins }
}
