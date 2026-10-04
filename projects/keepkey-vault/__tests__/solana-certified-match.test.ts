import { describe, expect, test } from 'bun:test'
import bs58 from 'bs58'

import { certifiedSolanaSchemaApplies, findLocalCertifiedSolanaMatch, solanaInstructionMatchesSchema } from '../src/bun/solana-certified-match'
import { CERTIFIED_SOLANA_CATALOG } from '../src/bun/solana-certified-schema'
import { editSolanaTx, parseSolanaWireMessage, type EditableSolanaMessage } from '../scripts/fixtures/solana-message'
import { syntheticPumpBuy } from '../scripts/fixtures/solana-pump'
import { parseSolanaMessage } from '../src/bun/solana-tx'
import firmwareCorpus from './fixtures/solana/certified-firmware-verdicts.json'
import joinFixture from './fixtures/solana/soltoshidice-blackjack-join.json'
import ceeloFixture from './fixtures/solana/soltoshidice-ceelo-bet.json'
import pokerRegistrationFixture from './fixtures/solana/soltoshidice-register-poker-tournament.json'
import livePokerFixture from './fixtures/solana/soltoshidice-live-poker-session.json'

const JOIN = CERTIFIED_SOLANA_CATALOG.soltoshidiceBlackjackJoin
const PUMP = CERTIFIED_SOLANA_CATALOG.pumpAmmBuy
const CEELO = CERTIFIED_SOLANA_CATALOG.soltoshidiceCeeloBet
const JOIN_INDEX = joinFixture.expected.instructionIndex
const applies = (rawTx: string, spec = JOIN) => certifiedSolanaSchemaApplies(parseSolanaWireMessage(rawTx), spec)
const editJoin = (edit: (m: EditableSolanaMessage) => void) => editSolanaTx(joinFixture.rawTxBase64, edit)

/** Append a readonly, unsigned static account; returns its index. */
function addStaticAccount(m: EditableSolanaMessage, key: string): number {
  m.staticAccounts.push(Buffer.from(bs58.decode(key)))
  m.header[2]++
  return m.staticAccounts.length - 1
}
const COMPUTE_BUDGET_INDEX = 10 // static account of the real join
const SYSTEM_INDEX = 7
const transfer = (accounts: number[], data = Buffer.from('0200000080841e0000000000', 'hex')) =>
  ({ programIdIndex: SYSTEM_INDEX, accountIndices: accounts, data })
const computeBudget = (hex: string) => ({ programIdIndex: COMPUTE_BUDGET_INDEX, accountIndices: [], data: Buffer.from(hex, 'hex') })

describe('certifiedSolanaSchemaApplies (firmware schema_applies, certified)', () => {
  test('the real SoltoshiDICE join applies beside a ComputeBudget limit and a static System transfer', () => {
    expect(applies(joinFixture.rawTxBase64)).toBe(JOIN_INDEX)
  })

  test('a SoltoshiDICE join with an ATA-create companion does not apply', () => {
    const rawTx = editJoin((m) => {
      const ata = addStaticAccount(m, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
      m.instructions.splice(JOIN_INDEX, 0, { programIdIndex: ata, accountIndices: [0, 6, 0, 8, 7, 12], data: Buffer.from([1]) })
    })
    const message = parseSolanaWireMessage(rawTx)
    // The join itself still has the reviewed shape; only the companion fails.
    expect(solanaInstructionMatchesSchema(message, message.instructions[JOIN_INDEX + 1], JOIN)).toBe(true)
    expect(certifiedSolanaSchemaApplies(message, JOIN)).toBeUndefined()
  })

  test('syntheticPumpBuy does not apply: 9 instructions with ATA create, SyncNative and closeAccount', () => {
    const { rawTx } = syntheticPumpBuy()
    const message = parseSolanaWireMessage(rawTx)
    expect(message.instructions).toHaveLength(9)
    expect(solanaInstructionMatchesSchema(message, message.instructions[7], PUMP)).toBe(true)
    expect(certifiedSolanaSchemaApplies(message, PUMP)).toBeUndefined()
    // Under the instruction cap, the companions still refuse it.
    expect(applies(editSolanaTx(rawTx, (m) => { m.instructions.splice(1, 1) }), PUMP)).toBeUndefined()
    // Control: the same buy beside ComputeBudget only applies.
    expect(applies(editSolanaTx(rawTx, (m) => { m.instructions = [m.instructions[0], m.instructions[7]] }), PUMP)).toBe(1)
  })

  test('at most 8 instructions: a longer message parses with none', () => {
    const withMemos = (count: number) => editJoin((m) => {
      const memo = addStaticAccount(m, 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
      for (let i = 0; i < count; i++) m.instructions.push({ programIdIndex: memo, accountIndices: [], data: Buffer.from('gg') })
    })
    expect(applies(withMemos(5))).toBe(JOIN_INDEX) // 8 instructions
    expect(applies(withMemos(6))).toBeUndefined() // 9 instructions
  })

  test('ComputeBudget companions only in their exact firmware encodings', () => {
    // Replaces the join's own SetComputeUnitLimit, so no field is duplicated.
    const withCompanion = (hex: string) => applies(editJoin((m) => { m.instructions[0] = computeBudget(hex) }))
    expect(withCompanion('0100800000')).toBe(JOIN_INDEX) // RequestHeapFrame
    expect(withCompanion('0240420f00')).toBe(JOIN_INDEX) // SetComputeUnitLimit
    expect(withCompanion('036400000000000000')).toBe(JOIN_INDEX) // SetComputeUnitPrice
    expect(withCompanion('0400000400')).toBe(JOIN_INDEX) // SetLoadedAccountsDataSizeLimit
    expect(withCompanion('0240420f0000')).toBeUndefined() // limit with a trailing byte
    expect(withCompanion('0364000000')).toBeUndefined() // price, too short
    expect(withCompanion('006400000000000000')).toBeUndefined() // deprecated RequestUnits
  })

  test('the priority fee must be unambiguous and fit a u64 (solana_validatePriorityFee)', () => {
    const withCompanions = (...hex: string[]) => applies(editJoin((m) => { m.instructions.push(...hex.map(computeBudget)) }))
    const price = (microLamports: bigint) => {
      const data = Buffer.alloc(9)
      data[0] = 3
      data.writeBigUInt64LE(microLamports, 1)
      return data.toString('hex')
    }
    expect(withCompanions(price(100n))).toBe(JOIN_INDEX)
    expect(withCompanions(price(100n), price(100n))).toBeUndefined() // duplicate price
    expect(withCompanions('0240420f00')).toBeUndefined() // duplicate limit: the join already sets one
    // With the largest u32 limit, the largest price whose fee still fits a u64.
    const withMaxLimit = (hex: string) => applies(editJoin((m) => {
      m.instructions[0] = computeBudget('02ffffffff')
      m.instructions.push(computeBudget(hex))
    }))
    const maxPrice = (0xffff_ffff_ffff_ffffn * 1_000_000n) / 0xffff_ffffn
    expect(withMaxLimit(price(maxPrice))).toBe(JOIN_INDEX)
    expect(withMaxLimit(price(maxPrice + 1n))).toBeUndefined()
  })

  test('a System companion must be an exact two-account transfer', () => {
    const withTransfer = (ix: ReturnType<typeof transfer>) => applies(editJoin((m) => { m.instructions[1] = ix }))
    expect(withTransfer(transfer([0, 5]))).toBe(JOIN_INDEX)
    expect(withTransfer(transfer([0, 5, 1]))).toBeUndefined()
    expect(withTransfer(transfer([0, 5], Buffer.from('0200000080841e000000000000', 'hex')))).toBeUndefined()
    expect(withTransfer(transfer([0, 5], Buffer.from('0800000080841e0000000000', 'hex')))).toBeUndefined() // Allocate
  })

  test('a transfer to a lookup-table account does not apply', () => {
    const v0 = (transferTo: number) => editJoin((m) => {
      m.version = 'v0'
      m.altEntries = [{ accountKey: Buffer.alloc(32, 0x42), writableIndices: [0], readonlyIndices: [] }]
      m.instructions[1] = transfer([0, transferTo])
    })
    expect(applies(v0(5))).toBe(JOIN_INDEX) // static destination
    expect(applies(v0(13))).toBeUndefined() // the first LUT-resolved account
  })

  test('refuses what the certified parser refuses: ambiguity and account bounds', () => {
    expect(applies(editJoin((m) => { m.instructions.push({ ...m.instructions[JOIN_INDEX] }) }))).toBeUndefined()
    expect(applies(editJoin((m) => {
      m.version = 'v0'
      m.altEntries = [{ accountKey: Buffer.alloc(32, 0x42), writableIndices: [0, 1, 2, 3, 4], readonlyIndices: [5, 6, 7, 8] }]
    }))).toBeUndefined() // 9 LUT accounts, SOL_MAX_LUT_ACCOUNTS is 8
    expect(applies(editJoin((m) => {
      m.version = 'v0'
      m.altEntries = [{ accountKey: Buffer.alloc(32, 0x42), writableIndices: [], readonlyIndices: [] }]
    }))).toBeUndefined() // a lookup table needs a nonempty LUT proof
  })
})

describe('findLocalCertifiedSolanaMatch (Vault pre-filter)', () => {
  test('names the one catalog entry the device will apply, and nothing otherwise', () => {
    expect(findLocalCertifiedSolanaMatch(parseSolanaWireMessage(joinFixture.rawTxBase64)))
      .toMatchObject({ catalogKey: 'soltoshidiceBlackjackJoin', instructionIndex: JOIN_INDEX })
    const bareBuy = editSolanaTx(syntheticPumpBuy().rawTx, (m) => { m.instructions = [m.instructions[0], m.instructions[7]] })
    expect(findLocalCertifiedSolanaMatch(parseSolanaWireMessage(bareBuy)))
      .toMatchObject({ catalogKey: 'pumpAmmBuy', instructionIndex: 1 })
    expect(findLocalCertifiedSolanaMatch(parseSolanaWireMessage(syntheticPumpBuy().rawTx))).toBeUndefined()
  })

  test('the real Cee-lo bet matches only the Cee-lo entry, though it shares a program with the join', () => {
    const message = parseSolanaWireMessage(ceeloFixture.rawTxBase64)
    // 2 instructions: ComputeBudget SetComputeUnitLimit, then the 26-byte bet.
    expect(message.instructions).toHaveLength(2)
    expect(certifiedSolanaSchemaApplies(message, CEELO)).toBe(1)
    expect(findLocalCertifiedSolanaMatch(message))
      .toMatchObject({ catalogKey: 'soltoshidiceCeeloBet', instructionIndex: 1 })
    // Same program, so only the discriminator and the exact data length keep
    // the two SoltoshiDICE entries apart. Neither may claim the other's bytes.
    expect(solanaInstructionMatchesSchema(message, message.instructions[1], JOIN)).toBe(false)
    const join = parseSolanaWireMessage(joinFixture.rawTxBase64)
    expect(solanaInstructionMatchesSchema(join, join.instructions[JOIN_INDEX], CEELO)).toBe(false)
  })

  test('the captured poker registration selects its one exact catalog entry', () => {
    const message = parseSolanaWireMessage(pokerRegistrationFixture.rawTxBase64)
    expect(message.instructions).toHaveLength(2)
    expect(findLocalCertifiedSolanaMatch(message)).toMatchObject({
      catalogKey: 'soltoshidiceRegisterPokerTournament',
      instructionIndex: pokerRegistrationFixture.expected.instructionIndex,
    })
  })

  for (const [name, fixture] of Object.entries(livePokerFixture)) {
    test(`the captured ${name} transaction selects only ${fixture.catalogKey}`, () => {
      expect(findLocalCertifiedSolanaMatch(parseSolanaWireMessage(fixture.rawTxBase64))).toMatchObject({
        catalogKey: fixture.catalogKey,
        instructionIndex: fixture.instructionIndex,
      })
    })
  }
})

// Expected results come from the FIRMWARE, not from Vault: each verdict is
// the output of the firmware's own solana.c (scripts/solana-fw-oracle), at the
// revision recorded in the fixture.
describe(`certifiedSolanaSchemaApplies agrees with firmware ${firmwareCorpus.firmware.split(' ')[1].slice(0, 9)}`, () => {
  for (const c of firmwareCorpus.cases) {
    test(`${c.name}: ${c.firmwareVerdict}`, () => {
      const accepted = /^ACCEPT (\d+)$/.exec(c.firmwareVerdict)
      const spec = CERTIFIED_SOLANA_CATALOG[c.catalogKey as keyof typeof CERTIFIED_SOLANA_CATALOG]
      expect(certifiedSolanaSchemaApplies(parseSolanaMessage(Buffer.from(c.messageHex, 'hex')), spec, c.lutKeys))
        .toBe(accepted ? Number(accepted[1]) : undefined)
    })
  }
})
