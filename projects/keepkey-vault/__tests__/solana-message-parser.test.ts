/**
 * Tests for parseSolanaMessage (structured v0 + legacy message parser).
 *
 * Focus: layout correctness. Every byte of the fixture is accounted for;
 * `parseSolanaMessage` throws on any trailing bytes so a miscount in the
 * fixture builder surfaces immediately.
 *
 * Run: bun test __tests__/solana-message-parser.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { parseSolanaMessage, SolanaTxParseError } from '../src/bun/solana-tx'

// ── Byte-stream builder: mirrors Solana SDK's compact-u16 + account/ix layout

function compactU16(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  if (n < 0x4000) return Buffer.from([(n & 0x7f) | 0x80, (n >> 7) & 0x7f])
  return Buffer.from([(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, (n >> 14) & 0x03])
}

function concat(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts)
}

// ── Legacy: single-instruction SOL transfer shape ────────────────────

function buildLegacyTransferMsg(): Buffer {
  // Header: 1 signer, 0 readonly signers, 1 readonly unsigned (System program)
  const header = Buffer.from([1, 0, 1])
  // 2 static accounts: [signer, System program]
  const signer = Buffer.alloc(32, 0x11)
  const systemProgram = Buffer.alloc(32, 0x00) // all-zero pubkey == 11111...111
  const staticAccounts = concat(compactU16(2), signer, systemProgram)
  // Recent blockhash
  const blockhash = Buffer.alloc(32, 0xaa)
  // One instruction: System.transfer(1_000_000 lamports), from account[0] to account[0] (dummy)
  const programIdIndex = Buffer.from([1])
  const accountIndices = concat(compactU16(2), Buffer.from([0, 0]))
  const data = Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x00]),                   // discriminator u32-le = 2 (transfer)
    Buffer.from([0x40, 0x42, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00]), // 1_000_000 LE
  ])
  const ix = concat(programIdIndex, accountIndices, compactU16(data.length), data)
  const instructions = concat(compactU16(1), ix)
  return concat(header, staticAccounts, blockhash, instructions)
}

// ── V0: same tx body + one ALT entry ────────────────────────────────

function buildV0TransferMsgWithAlt(): Buffer {
  const prefix = Buffer.from([0x80])
  const body = buildLegacyTransferMsg()
  // One ALT: pubkey + 1 writable index + 0 readonly
  const altKey = Buffer.alloc(32, 0x55)
  const altEntry = concat(
    altKey,
    compactU16(1), Buffer.from([7]), // writable indices [7]
    compactU16(0),                    // no readonly
  )
  const alts = concat(compactU16(1), altEntry)
  return concat(prefix, body, alts)
}

// ── Tests ────────────────────────────────────────────────────────────

describe('parseSolanaMessage — legacy', () => {
  test('parses System.transfer: 1 signer, 2 static accounts, 1 instruction, no ALT', () => {
    const msg = buildLegacyTransferMsg()
    const parsed = parseSolanaMessage(msg)
    expect(parsed.version).toBe('legacy')
    expect(parsed.header).toEqual({
      numRequiredSignatures: 1,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 1,
    })
    expect(parsed.staticAccounts).toHaveLength(2)
    expect(parsed.staticAccounts[0][0]).toBe(0x11)
    expect(parsed.staticAccounts[1].every((b) => b === 0)).toBe(true)
    expect(parsed.recentBlockhash[0]).toBe(0xaa)
    expect(parsed.instructions).toHaveLength(1)
    expect(parsed.instructions[0].programIdIndex).toBe(1)
    expect(parsed.instructions[0].accountIndices).toEqual([0, 0])
    expect(parsed.instructions[0].data[0]).toBe(0x02) // discriminator = transfer
    expect(parsed.altEntries).toHaveLength(0)
  })
})

describe('parseSolanaMessage — v0', () => {
  test('detects 0x80 prefix and parses ALT section', () => {
    const msg = buildV0TransferMsgWithAlt()
    const parsed = parseSolanaMessage(msg)
    expect(parsed.version).toBe('v0')
    expect(parsed.instructions).toHaveLength(1)
    expect(parsed.altEntries).toHaveLength(1)
    expect(parsed.altEntries[0].accountKey.every((b) => b === 0x55)).toBe(true)
    expect(parsed.altEntries[0].writableIndices).toEqual([7])
    expect(parsed.altEntries[0].readonlyIndices).toEqual([])
  })

  test('unsupported version number rejected', () => {
    const msg = Buffer.concat([Buffer.from([0x81]), buildLegacyTransferMsg()])
    expect(() => parseSolanaMessage(msg)).toThrow(SolanaTxParseError)
  })
})

describe('parseSolanaMessage — malformed', () => {
  test('trailing byte rejected', () => {
    const msg = Buffer.concat([buildLegacyTransferMsg(), Buffer.from([0xff])])
    expect(() => parseSolanaMessage(msg)).toThrow(/Trailing/)
  })

  test('zero static accounts rejected', () => {
    const msg = Buffer.concat([
      Buffer.from([1, 0, 0]),
      compactU16(0),        // <-- zero accounts
      Buffer.alloc(32),     // blockhash
      compactU16(0),        // no instructions
    ])
    expect(() => parseSolanaMessage(msg)).toThrow(SolanaTxParseError)
  })

  test('truncated instruction data rejected', () => {
    const header = Buffer.from([1, 0, 0])
    const accts = concat(compactU16(1), Buffer.alloc(32))
    const hash = Buffer.alloc(32)
    // Instruction claims 99-byte data but only 2 bytes follow
    const badIx = concat(Buffer.from([0]), compactU16(0), compactU16(99), Buffer.from([0, 0]))
    const ixs = concat(compactU16(1), badIx)
    expect(() => parseSolanaMessage(concat(header, accts, hash, ixs))).toThrow(/truncated data/)
  })
})

// ── Large but valid: relaxed heuristic limits ────────────────────────
//
// Earlier versions of the parser rejected any tx with more than 64
// instructions or 32 ALT entries. Those caps were *heuristics* with no
// basis in the Solana protocol: aggregator routes (Jupiter, Phoenix,
// etc.) legitimately exceed them. The parser now only rejects counts
// that cannot physically fit in the remaining buffer — valid large
// txs are parsed successfully and invalid ones still throw.

describe('parseSolanaMessage — relaxed count limits', () => {
  /** Build a legacy message with `n` no-op instructions (3 bytes each). */
  function buildManyInstructionMsg(n: number): Buffer {
    const header = Buffer.from([1, 0, 0])
    const accounts = concat(compactU16(1), Buffer.alloc(32))
    const blockhash = Buffer.alloc(32)
    // Each ix is program_id_index(0) + 0 accts + 0 data = 3 bytes.
    const oneIx = concat(Buffer.from([0]), compactU16(0), compactU16(0))
    const ixs = [compactU16(n)]
    for (let i = 0; i < n; i++) ixs.push(oneIx)
    return concat(header, accounts, blockhash, concat(...ixs))
  }

  test('accepts 128 instructions (well beyond the old 64-instruction heuristic cap)', () => {
    const msg = buildManyInstructionMsg(128)
    const parsed = parseSolanaMessage(msg)
    expect(parsed.instructions).toHaveLength(128)
  })

  test('rejects an instruction count that cannot physically fit', () => {
    // Declare 10_000 instructions in a ~15-byte instruction section.
    const header = Buffer.from([1, 0, 0])
    const accts = concat(compactU16(1), Buffer.alloc(32))
    const hash = Buffer.alloc(32)
    // compact-u16 for 10_000 = 3 bytes: 0x90, 0x4e, 0x00 — but use the helper
    const ixs = concat(compactU16(10_000), Buffer.alloc(10))
    expect(() => parseSolanaMessage(concat(header, accts, hash, ixs))).toThrow(/cannot fit/)
  })

  test('accepts v0 messages with 50 ALT entries (beyond the old 32-entry heuristic cap)', () => {
    const prefix = Buffer.from([0x80])
    const body = buildLegacyTransferMsg()
    // One-per-key ALT with no writable/readonly indices: 32 + 1 + 1 = 34 bytes each.
    const entry = concat(Buffer.alloc(32, 0x55), compactU16(0), compactU16(0))
    const entries: Buffer[] = [compactU16(50)]
    for (let i = 0; i < 50; i++) entries.push(entry)
    const msg = concat(prefix, body, concat(...entries))
    const parsed = parseSolanaMessage(msg)
    expect(parsed.version).toBe('v0')
    expect(parsed.altEntries).toHaveLength(50)
  })

  test('rejects an ALT count that cannot physically fit', () => {
    const prefix = Buffer.from([0x80])
    const body = buildLegacyTransferMsg()
    // Declare 10_000 ALT entries with almost no bytes following.
    const alts = concat(compactU16(10_000), Buffer.alloc(10))
    expect(() => parseSolanaMessage(concat(prefix, body, alts))).toThrow(/cannot fit/)
  })
})
