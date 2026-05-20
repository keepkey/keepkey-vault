/**
 * Tests for the Solana instruction decoder.
 *
 * These use the real pioneer-discovery registry (installed as a dep) so any
 * mismatch between the schemas we ship and the decoder would surface here.
 * Tests focus on: known programs decode correctly, unknown programs get a
 * labelled fallback, malformed data is reported gracefully, and the ALT
 * account expansion follows Solana's canonical resolution order.
 *
 * Run: bun test __tests__/solana-instruction-decoder.test.ts
 */
import { describe, test, expect } from 'bun:test'
import bs58 from 'bs58'
import { decodeInstruction, buildExpandedAccounts, PROGRAM_REGISTRY } from '../src/bun/solana-instruction-decoder'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const UNKNOWN_PROGRAM = 'Fake11111111111111111111111111111111111111X'

function u64Le(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n, 0)
  return b
}

// ── Known program, known instruction ──────────────────────────────────

describe('decodeInstruction — System.transfer', () => {
  test('decodes discriminator + lamports arg, labels accounts', () => {
    const data = Buffer.concat([Buffer.from([0x02, 0x00, 0x00, 0x00]), u64Le(1_500_000n)])
    const result = decodeInstruction({
      programIdIndex: 2,
      accountIndices: [0, 1],
      data,
      expandedAccounts: ['AliceXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'BobXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', SYSTEM_PROGRAM],
    })
    expect(result.status).toBe('known')
    expect(result.programName).toBe('System Program')
    expect(result.instructionName).toBe('transfer')
    expect(result.args).toHaveLength(1)
    expect(result.args[0]).toMatchObject({ name: 'lamports', type: 'u64', value: '1500000' })
    expect(result.accounts[0].label).toBe('source')
    expect(result.accounts[1].label).toBe('destination')
  })
})

describe('decodeInstruction — SPL Token.transfer', () => {
  test('1-byte discriminator + u64 amount', () => {
    const data = Buffer.concat([Buffer.from([0x03]), u64Le(100_000_000n)])
    const result = decodeInstruction({
      programIdIndex: 3,
      accountIndices: [0, 1, 2],
      data,
      expandedAccounts: ['SRCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'DSTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'AUTHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', SPL_TOKEN],
    })
    expect(result.status).toBe('known')
    expect(result.programName).toBe('SPL Token')
    expect(result.instructionName).toBe('transfer')
    expect(result.args[0]).toMatchObject({ name: 'amount', value: '100000000' })
    expect(result.accounts.map((a) => a.label)).toEqual(['source', 'destination', 'authority'])
  })

  test('transferChecked decodes amount + decimals', () => {
    const data = Buffer.concat([Buffer.from([0x0c]), u64Le(1_000_000n), Buffer.from([6])])
    const result = decodeInstruction({
      programIdIndex: 0,
      accountIndices: [1, 2, 3, 4],
      data,
      expandedAccounts: [SPL_TOKEN, 'src', 'mint', 'dst', 'auth'],
    })
    expect(result.instructionName).toBe('transferChecked')
    expect(result.args.map((a) => ({ name: a.name, value: a.value }))).toEqual([
      { name: 'amount', value: '1000000' },
      { name: 'decimals', value: '6' },
    ])
  })
})

describe('decodeInstruction — Memo v2 (encoding=none)', () => {
  test('labels program without decoding a discriminator', () => {
    const data = Buffer.from('hello', 'utf-8')
    const result = decodeInstruction({
      programIdIndex: 0,
      accountIndices: [],
      data,
      expandedAccounts: [MEMO_V2],
    })
    // Memo has no instructions defined — known program, unknown instruction.
    expect(result.status).toBe('known-program-unknown-ix')
    expect(result.programName).toBe('Memo v2')
    expect(result.programCategory).toBe('utility')
  })
})

// ── Unknown / malformed ───────────────────────────────────────────────

describe('decodeInstruction — fallback paths', () => {
  test('unknown program returns truncated id + no schema', () => {
    const result = decodeInstruction({
      programIdIndex: 0,
      accountIndices: [1],
      data: Buffer.from([0xff]),
      expandedAccounts: [UNKNOWN_PROGRAM, 'other'],
    })
    expect(result.status).toBe('unknown-program')
    expect(result.programName).toContain('…')
    expect(result.args).toHaveLength(0)
    expect(result.accounts[0].pubkey).toBe('other')
  })

  test('known program + unrecognized discriminator reports discriminator', () => {
    const data = Buffer.from([0xfe]) // SPL Token has no 0xfe instruction
    const result = decodeInstruction({
      programIdIndex: 0,
      accountIndices: [],
      data,
      expandedAccounts: [SPL_TOKEN],
    })
    expect(result.status).toBe('known-program-unknown-ix')
    expect(result.discriminatorHex).toBe('fe')
    expect(result.note).toContain('no schema for discriminator')
  })

  test('truncated args surface a note instead of throwing', () => {
    // SPL Token transfer needs 1 disc + 8 bytes. Give 1 + 3.
    const data = Buffer.concat([Buffer.from([0x03]), Buffer.from([0x01, 0x02, 0x03])])
    const result = decodeInstruction({
      programIdIndex: 0,
      accountIndices: [],
      data,
      expandedAccounts: [SPL_TOKEN],
    })
    expect(result.status).toBe('known')
    expect(result.args).toHaveLength(0)
    expect(result.note).toContain('truncated')
  })
})

// ── Expanded account ordering (static + ALT writable + ALT readonly) ─

describe('buildExpandedAccounts', () => {
  test('preserves Solana resolution order: static → alt-writable → alt-readonly', () => {
    const alt = bs58.encode(Buffer.alloc(32, 0xaa))
    const contents = ['w1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'w2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'r1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'r2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx']
    const altContents = new Map([[alt, contents]])
    const { expanded, altOrigins } = buildExpandedAccounts(
      ['SxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxI'],
      [{ accountKey: alt, writableIndices: [0, 1], readonlyIndices: [2, 3] }],
      altContents,
    )
    expect(expanded).toEqual([
      'SxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxI',
      contents[0], contents[1], // writables first
      contents[2], contents[3], // readonlies after
    ])
    expect(altOrigins.map((o) => o.from)).toEqual([
      'static', 'alt-writable', 'alt-writable', 'alt-readonly', 'alt-readonly',
    ])
  })

  test('missing ALT contents yields placeholder markers', () => {
    const alt = bs58.encode(Buffer.alloc(32, 0x77))
    const { expanded } = buildExpandedAccounts(
      [],
      [{ accountKey: alt, writableIndices: [0], readonlyIndices: [] }],
      new Map(), // ALT not resolved
    )
    expect(expanded[0]).toContain('<alt:')
  })
})

// ── Registry sanity (catches drift with pioneer-discovery) ────────────

describe('PROGRAM_REGISTRY', () => {
  test('System Program transfer is present with u64 lamports arg', () => {
    const p = PROGRAM_REGISTRY.programs[SYSTEM_PROGRAM]
    expect(p.instructions?.['02000000']?.args?.[0]).toEqual({ name: 'lamports', type: 'u64' })
  })
  test('SPL Token has 7 decoder-ready instructions', () => {
    const ixs = PROGRAM_REGISTRY.programs[SPL_TOKEN].instructions!
    expect(Object.keys(ixs).sort()).toEqual(['03', '04', '07', '08', '09', '0c', '0d'])
  })
})
