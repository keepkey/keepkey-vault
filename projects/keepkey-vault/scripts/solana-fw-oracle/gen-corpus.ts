/**
 * Writes __tests__/fixtures/solana/certified-firmware-verdicts.json: messages
 * at the limits of the certified Solana rule, each with the verdict of the
 * firmware's own solana.c (harness.c). Run through gen-corpus.sh, never alone.
 *
 * usage: bun gen-corpus.ts <harness binary> <firmware description> <command>
 */
import { spawnSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import bs58 from 'bs58'

import { CERTIFIED_SOLANA_CATALOG, serializeSolanaSchema } from '../../src/bun/solana-certified-schema'
import { parseSolanaTx, solanaMessageSlice } from '../../src/bun/solana-tx'
import { editSolanaTx, parseSolanaWireMessage, type EditableSolanaMessage } from '../fixtures/solana-message'
import joinFixture from '../../__tests__/fixtures/solana/soltoshidice-blackjack-join.json'
import ceeloFixture from '../../__tests__/fixtures/solana/soltoshidice-ceelo-bet.json'
import relayFixture from '../../__tests__/fixtures/solana/relay-deposit-native-no-alt.json'
import relayAltFixture from '../../__tests__/fixtures/solana/relay-deposit-native-alt.json'

const [harness, firmware, command] = process.argv.slice(2)
if (!harness || !firmware || !command) throw new Error('usage: gen-corpus.ts <harness> <firmware> <command>')

const JOIN = joinFixture.rawTxBase64
const JOIN_IX = joinFixture.expected.instructionIndex // 2
const CEELO = ceeloFixture.rawTxBase64
const CEELO_IX = 1 // the bet, beside its own SetComputeUnitLimit
const RELAY = relayFixture.rawTxBase64
const U64_MAX = 0xffff_ffff_ffff_ffffn
const SYSTEM_INDEX = 7 // static accounts of the real join
const COMPUTE_BUDGET_INDEX = 10

const addStatic = (m: EditableSolanaMessage, key: Uint8Array) => {
  m.staticAccounts.push(Buffer.from(key))
  m.header[2]++
  return m.staticAccounts.length - 1
}
const fillStatic = (m: EditableSolanaMessage, total: number) => {
  for (let i = m.staticAccounts.length; i < total; i++) addStatic(m, Buffer.alloc(32, i))
}
const oneLut = (m: EditableSolanaMessage, writable: number[], readonly: number[] = []) => {
  m.version = 'v0'
  m.altEntries = [{ accountKey: Buffer.alloc(32, 0x42), writableIndices: writable, readonlyIndices: readonly }]
}
/** The join without its own SetComputeUnitLimit, plus the given fee fields. */
const joinWithFee = (price: bigint, limit?: number) => editSolanaTx(JOIN, (m) => {
  m.instructions.splice(0, 1)
  if (limit !== undefined) {
    const d = Buffer.alloc(5); d[0] = 2; d.writeUInt32LE(limit, 1)
    m.instructions.push({ programIdIndex: COMPUTE_BUDGET_INDEX, accountIndices: [], data: d })
  }
  const d = Buffer.alloc(9); d[0] = 3; d.writeBigUInt64LE(price, 1)
  m.instructions.push({ programIdIndex: COMPUTE_BUDGET_INDEX, accountIndices: [], data: d })
})
const transfer = (accounts: number[]) =>
  ({ programIdIndex: SYSTEM_INDEX, accountIndices: accounts, data: Buffer.from('0200000080841e0000000000', 'hex') })

// Smallest limit above 1,000,000 where ceil and floor of price x limit / 1e6
// disagree about fitting a u64: price 18446725626983924632, limit 1000001.
const CEIL_PRICE = 18446725626983924632n
const CEIL_LIMIT = 1_000_001
// Largest price whose fee fits at the 1,400,000 default limit.
const DEFAULT_LIMIT_MAX_PRICE = (U64_MAX * 1_000_000n) / 1_400_000n

type Case = { name: string; catalogKey: keyof typeof CERTIFIED_SOLANA_CATALOG; rawTx: string; lutKeys?: number }
const cases: Case[] = [
  { name: 'join: real fixture', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: JOIN },
  { name: 'relay depositNative: real fixture', catalogKey: 'relayDepositNative', rawTx: RELAY },
  { name: 'ceelo: real fixture', catalogKey: 'soltoshidiceCeeloBet', rawTx: CEELO },

  // LUT proof must have exactly one key per serialized LUT index.
  ...[1, 0, 2].map((lutKeys) => ({
    name: `join with 1 LUT index, ${lutKeys === 0 ? 'no lutProof' : `${lutKeys} LUT proof key(s)`}`,
    catalogKey: 'soltoshidiceBlackjackJoin' as const,
    rawTx: editSolanaTx(JOIN, (m) => oneLut(m, [3])),
    lutKeys,
  })),
  { name: 'relay depositNative with a lookup table (3 indices): real fixture, 3 LUT proof keys', catalogKey: 'relayDepositNative', rawTx: relayAltFixture.rawTxBase64 },
  { name: 'relay depositNative with a lookup table (3 indices): real fixture, no lutProof', catalogKey: 'relayDepositNative', rawTx: relayAltFixture.rawTxBase64, lutKeys: 0 },
  { name: 'join without lookup tables, 1 LUT proof key', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: JOIN, lutKeys: 1 },

  // Priority fee: ceil(price x limit / 1e6) must fit a u64; limit 1,400,000 when unset.
  { name: 'fee: price u64 max, no limit', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: joinWithFee(U64_MAX) },
  { name: 'fee: largest price that fits the default limit, no limit', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: joinWithFee(DEFAULT_LIMIT_MAX_PRICE) },
  { name: 'fee: one above the largest price for the default limit, no limit', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: joinWithFee(DEFAULT_LIMIT_MAX_PRICE + 1n) },
  { name: 'fee: ceil edge, price 18446725626983924632, limit 1000001', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: joinWithFee(CEIL_PRICE, CEIL_LIMIT) },
  { name: 'fee: ceil edge minus one, price 18446725626983924631, limit 1000001', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: joinWithFee(CEIL_PRICE - 1n, CEIL_LIMIT) },

  // SOL_MAX_ACCOUNTS: static plus trusted LUT keys.
  { name: 'accounts: 32 static', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => fillStatic(m, 32)) },
  { name: 'accounts: 33 static', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => fillStatic(m, 33)) },
  { name: 'accounts: 24 static + 8 LUT = 32', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => { fillStatic(m, 24); oneLut(m, [1, 2, 3, 4], [5, 6, 7, 8]) }) },
  { name: 'accounts: 25 static + 8 LUT = 33', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => { fillStatic(m, 25); oneLut(m, [1, 2, 3, 4], [5, 6, 7, 8]) }) },

  // Every displayed account and TOKEN_AMOUNT mint account must be in the instruction.
  { name: 'relay: displayed account #3 with 4 instruction accounts', catalogKey: 'relayDepositNative', rawTx: editSolanaTx(RELAY, (m) => { const ix = m.instructions.find((i) => i.data.length === 48)!; ix.accountIndices = ix.accountIndices.slice(0, 4) }) },
  { name: 'relay: displayed account #3 with 3 instruction accounts', catalogKey: 'relayDepositNative', rawTx: editSolanaTx(RELAY, (m) => { const ix = m.instructions.find((i) => i.data.length === 48)!; ix.accountIndices = ix.accountIndices.slice(0, 3) }) },
  { name: 'join: mint account #3 with 4 instruction accounts', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => { m.instructions[JOIN_IX].accountIndices = m.instructions[JOIN_IX].accountIndices.slice(0, 4) }) },
  { name: 'join: mint account #3 with 3 instruction accounts', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => { m.instructions[JOIN_IX].accountIndices = m.instructions[JOIN_IX].accountIndices.slice(0, 3) }) },
  // Cee-lo's mint is further along the list than any other entry's: account 5.
  { name: 'ceelo: mint account #5 with 6 instruction accounts', catalogKey: 'soltoshidiceCeeloBet', rawTx: editSolanaTx(CEELO, (m) => { m.instructions[CEELO_IX].accountIndices = m.instructions[CEELO_IX].accountIndices.slice(0, 6) }) },
  { name: 'ceelo: mint account #5 with 5 instruction accounts', catalogKey: 'soltoshidiceCeeloBet', rawTx: editSolanaTx(CEELO, (m) => { m.instructions[CEELO_IX].accountIndices = m.instructions[CEELO_IX].accountIndices.slice(0, 5) }) },

  // Memo companions: only the SPL Memo program the firmware knows (MemoSq4...).
  { name: 'companion: Memo (MemoSq4)', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => { m.instructions.push({ programIdIndex: addStatic(m, bs58.decode('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')), accountIndices: [], data: Buffer.from('hi') }) }) },
  { name: 'companion: Memo v1 (Memo1Uhk)', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => { m.instructions.push({ programIdIndex: addStatic(m, bs58.decode('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo')), accountIndices: [], data: Buffer.from('hi') }) }) },

  // System Transfer companions: exactly 2 static accounts (firmware 0a71eea67).
  { name: 'companion: System Transfer with 2 static accounts', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => { m.instructions[1] = transfer([0, 5]) }) },
  { name: 'companion: System Transfer with 3 static accounts', catalogKey: 'soltoshidiceBlackjackJoin', rawTx: editSolanaTx(JOIN, (m) => { m.instructions[1] = transfer([0, 5, 1]) }) },
]

const messageHex = (rawTx: string) => {
  const full = Buffer.from(rawTx, 'base64')
  return Buffer.from(solanaMessageSlice(full, parseSolanaTx(full))).toString('hex')
}
const lutIndices = (rawTx: string) => parseSolanaWireMessage(rawTx).altEntries
  .reduce((n, e) => n + e.writableIndices.length + e.readonlyIndices.length, 0)

const rows = cases.map((c) => ({
  name: c.name,
  catalogKey: c.catalogKey,
  lutKeys: c.lutKeys ?? lutIndices(c.rawTx),
  messageHex: messageHex(c.rawTx),
}))
const input = rows.map((r) =>
  `${serializeSolanaSchema(CERTIFIED_SOLANA_CATALOG[r.catalogKey]).toString('hex')} ${r.messageHex} ${r.lutKeys}`).join('\n') + '\n'
const run = spawnSync(harness, { input })
if (run.status !== 0) throw new Error(`harness failed: ${run.stderr}`)
const verdicts = run.stdout.toString().trim().split('\n')
if (verdicts.length !== rows.length) throw new Error(`harness returned ${verdicts.length} verdicts for ${rows.length} cases`)

const corpus = {
  _comment: [
    'Certified Solana limit cases with the FIRMWARE\'s verdict. Generated, do not edit:',
    'each verdict is the output of scripts/solana-fw-oracle/harness.c, which links the',
    'firmware\'s real lib/firmware/solana.c and replays fsm_msgSolanaSignTx\'s certified',
    'branch (inspect, LUT shape, schema_applies(certified), solana_validatePriorityFee).',
    'Vault\'s certifiedSolanaSchemaApplies must agree with every verdict',
    '(__tests__/solana-certified-match.test.ts).',
  ].join(' '),
  firmware,
  command,
  cases: rows.map((r, i) => ({ ...r, firmwareVerdict: verdicts[i] })),
}
const out = join(import.meta.dir, '../../__tests__/fixtures/solana/certified-firmware-verdicts.json')
writeFileSync(out, JSON.stringify(corpus, null, 2) + '\n')
for (const r of corpus.cases) console.log(`${r.firmwareVerdict.padEnd(18)} ${r.name}`)
