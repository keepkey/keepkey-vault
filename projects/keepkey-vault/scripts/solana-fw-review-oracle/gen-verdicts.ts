/**
 * Writes __tests__/fixtures/solana/advanced-mode-firmware-verdicts.json: wire
 * transactions, each with the review verdict of every firmware build given to
 * gen-verdicts.sh (harness.c). Run through gen-verdicts.sh, never alone.
 *
 * usage: bun gen-verdicts.ts <command> (<rev> <sha> <version> <subject> <harness>)...
 */
import { spawnSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import bs58 from 'bs58'

import { parseSolanaTx, solanaMessageSlice } from '../../src/bun/solana-tx'
import relayNoAlt from '../../__tests__/fixtures/solana/relay-deposit-native-no-alt.json'
import relayAlt from '../../__tests__/fixtures/solana/relay-deposit-native-alt.json'

const [command, ...rest] = process.argv.slice(2)
if (!command || rest.length === 0 || rest.length % 5 !== 0) {
  throw new Error('usage: gen-verdicts.ts <command> (<rev> <sha> <version> <subject> <harness>)...')
}
const builds = Array.from({ length: rest.length / 5 }, (_, i) => {
  const [rev, sha, version, subject, harness] = rest.slice(i * 5, i * 5 + 5)
  return { rev, sha, version, subject, harness }
})

const pk = (s: string) => Buffer.from(bs58.decode(s))
const SYSTEM = pk('11111111111111111111111111111111')
const TOKEN = pk('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022 = pk('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA = pk('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const STAKE = pk('Stake11111111111111111111111111111111111111')
const COMPUTE_BUDGET = pk('ComputeBudget111111111111111111111111111111')
const MEMO = pk('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const CLOCK = pk('SysvarC1ock11111111111111111111111111111111')
const RECENT_BLOCKHASHES = pk('SysvarRecentB1ockHashes11111111111111111111')
const key = (byte: number) => Buffer.alloc(32, byte)
const SIGNER = key(0x11)

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b }
const compact = (n: number) => {
  const out: number[] = []
  for (;;) {
    const b = n & 0x7f
    n >>= 7
    if (n === 0) { out.push(b); return Buffer.from(out) }
    out.push(b | 0x80)
  }
}

type Ix = { program: Buffer; accounts: Buffer[]; data: Buffer }
type Alt = { key: Buffer; writable: number[]; readonly: number[] }

/**
 * Serialize an unsigned wire transaction (one empty signature slot). Static
 * accounts are the signer, then every other account in first-use order; the
 * review reads no read-only flags, so the header marks none. `external` maps
 * instruction accounts to lookup-table indices instead.
 */
function tx(ixs: Ix[], opts: { v0?: boolean; alts?: Alt[]; external?: Map<Buffer, number> } = {}): string {
  const keys: Buffer[] = [SIGNER]
  const index = (k: Buffer) => {
    const ext = opts.external?.get(k)
    if (ext !== undefined) return ext
    let i = keys.findIndex((x) => x.equals(k))
    if (i < 0) { keys.push(k); i = keys.length - 1 }
    return i
  }
  const compiled = ixs.map((ix) => ({
    accounts: ix.accounts.map(index),
    program: index(ix.program),
    data: ix.data,
  }))
  const parts: Buffer[] = []
  if (opts.v0) parts.push(Buffer.from([0x80]))
  parts.push(Buffer.from([1, 0, 0]), compact(keys.length), ...keys, key(0xbb), compact(compiled.length))
  for (const c of compiled) {
    parts.push(Buffer.from([c.program]), compact(c.accounts.length), Buffer.from(c.accounts), compact(c.data.length), c.data)
  }
  if (opts.v0) {
    const alts = opts.alts ?? []
    parts.push(compact(alts.length))
    for (const a of alts) {
      parts.push(a.key, compact(a.writable.length), Buffer.from(a.writable), compact(a.readonly.length), Buffer.from(a.readonly))
    }
  }
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), ...parts]).toString('base64')
}

const transfer = (to: Buffer, lamports = 1_000_000n): Ix =>
  ({ program: SYSTEM, accounts: [SIGNER, to], data: Buffer.concat([u32(2), u64(lamports)]) })
const ataCreate = (data: number[], tokenProgram = TOKEN): Ix => ({
  program: ATA,
  accounts: [SIGNER, key(0x21), key(0x22), key(0x23), SYSTEM, tokenProgram],
  data: Buffer.from(data),
})
const transferChecked = (program = TOKEN): Ix => ({
  program,
  accounts: [key(0x24), key(0x23), key(0x21), SIGNER],
  data: Buffer.concat([Buffer.from([12]), u64(1_000n), Buffer.from([6])]),
})

const RECIPIENT = key(0x12)
const cases: { name: string; rawTx: string }[] = [
  { name: 'plain SOL transfer', rawTx: tx([transfer(RECIPIENT)]) },
  {
    name: 'SPL send: ATA createIdempotent + transferChecked (@solana/spl-token default)',
    rawTx: tx([ataCreate([1]), transferChecked()]),
  },
  { name: 'SPL send: ATA create + transferChecked', rawTx: tx([ataCreate([0]), transferChecked()]) },
  {
    name: 'wrap SOL: ATA createIdempotent + transfer + SyncNative',
    rawTx: tx([
      ataCreate([1]),
      transfer(key(0x21)),
      { program: TOKEN, accounts: [key(0x21)], data: Buffer.from([17]) },
    ]),
  },
  {
    name: 'native stake Deactivate',
    rawTx: tx([{ program: STAKE, accounts: [key(0x31), CLOCK, SIGNER], data: u32(5) }]),
  },
  {
    name: 'durable nonce: AdvanceNonceAccount + transfer',
    rawTx: tx([
      { program: SYSTEM, accounts: [key(0x32), RECENT_BLOCKHASHES, SIGNER], data: u32(4) },
      transfer(RECIPIENT),
    ]),
  },
  {
    name: 'priority fee: SetComputeUnitLimit + SetComputeUnitPrice + transfer + memo',
    rawTx: tx([
      { program: COMPUTE_BUDGET, accounts: [], data: Buffer.concat([Buffer.from([2]), u32(200_000)]) },
      { program: COMPUTE_BUDGET, accounts: [], data: Buffer.concat([Buffer.from([3]), u64(10_000n)]) },
      transfer(RECIPIENT),
      { program: MEMO, accounts: [], data: Buffer.from('invoice 42') },
    ]),
  },
  {
    name: 'unchecked SPL Transfer',
    rawTx: tx([{
      program: TOKEN,
      accounts: [key(0x24), key(0x21), SIGNER],
      data: Buffer.concat([Buffer.from([3]), u64(1_000n)]),
    }]),
  },
  {
    name: 'SPL Approve (unchecked)',
    rawTx: tx([{
      program: TOKEN,
      accounts: [key(0x24), key(0x25), SIGNER],
      data: Buffer.concat([Buffer.from([4]), u64(1_000n)]),
    }]),
  },
  {
    name: 'SPL MintTo',
    rawTx: tx([{
      program: TOKEN,
      accounts: [key(0x23), key(0x24), SIGNER],
      data: Buffer.concat([Buffer.from([7]), u64(1_000n)]),
    }]),
  },
  { name: 'Token-2022 transferChecked', rawTx: tx([transferChecked(TOKEN_2022)]) },
  {
    name: 'Token-2022 CloseAccount',
    rawTx: tx([{ program: TOKEN_2022, accounts: [key(0x24), SIGNER, SIGNER], data: Buffer.from([9]) }]),
  },
  { name: 'ATA create for a Token-2022 mint', rawTx: tx([ataCreate([0], TOKEN_2022)]) },
  {
    name: 'System CreateAccount (full 52-byte encoding)',
    rawTx: tx([{
      program: SYSTEM,
      accounts: [SIGNER, key(0x33)],
      data: Buffer.concat([u32(0), u64(2_039_280n), u64(165n), TOKEN]),
    }]),
  },
  {
    name: 'unknown program',
    rawTx: tx([{ program: key(0x77), accounts: [SIGNER], data: Buffer.from([9, 9, 9]) }]),
  },
  {
    name: 'nine SOL transfers (over the eight-instruction review limit)',
    rawTx: tx(Array.from({ length: 9 }, () => transfer(RECIPIENT))),
  },
  {
    name: 'SOL transfer with 33 static accounts',
    rawTx: tx([{ ...transfer(RECIPIENT), accounts: [SIGNER, RECIPIENT, ...Array.from({ length: 30 }, (_, i) => key(0x50 + i))] }]),
  },
  { name: 'v0 transfer, no lookup table', rawTx: tx([transfer(RECIPIENT)], { v0: true }) },
  { name: 'v0, nine SOL transfers', rawTx: tx(Array.from({ length: 9 }, () => transfer(RECIPIENT)), { v0: true }) },
  {
    name: 'v0 transfer to a lookup-table account',
    rawTx: tx([transfer(RECIPIENT)], {
      v0: true,
      alts: [{ key: key(0x42), writable: [0], readonly: [] }],
      external: new Map([[RECIPIENT, 2]]), // static accounts: signer, System; index 2 = first ALT entry
    }),
  },
  {
    name: 'v0 transfer with an unused lookup table',
    rawTx: tx([transfer(RECIPIENT)], { v0: true, alts: [{ key: key(0x42), writable: [], readonly: [5] }] }),
  },
  { name: 'Relay depositNative, v0 without lookup tables (mainnet)', rawTx: relayNoAlt.rawTxBase64 },
  { name: 'Relay depositNative, v0 with one lookup table (mainnet)', rawTx: relayAlt.rawTxBase64 },
]

const messageHex = (rawTx: string) => {
  const full = Buffer.from(rawTx, 'base64')
  return Buffer.from(solanaMessageSlice(full, parseSolanaTx(full))).toString('hex')
}
const input = cases.map((c) => messageHex(c.rawTx)).join('\n') + '\n'
const verdicts = builds.map((b) => {
  const run = spawnSync(b.harness, { input })
  if (run.status !== 0) throw new Error(`harness ${b.rev} failed: ${run.stderr}`)
  const lines = run.stdout.toString().trim().split('\n')
  if (lines.length !== cases.length) throw new Error(`${b.rev}: ${lines.length} verdicts for ${cases.length} cases`)
  return lines
})

const corpus = {
  _comment: [
    'Solana transactions with each firmware build\'s review verdict. Generated, do not edit:',
    'every verdict is the output of scripts/solana-fw-review-oracle/harness.c, which links',
    'that build\'s own lib/firmware/solana.c and calls solana_inspectTx on the exact message',
    'bytes Vault sends. fsm_msgSolanaSignTx refuses OPAQUE without AdvancedMode, signs VERIFIED',
    'without it, and refuses MALFORMED either way. solanaFirmwareRequiresAdvancedMode must',
    'agree with them (__tests__/solana-advanced-mode.test.ts).',
  ].join(' '),
  command,
  builds: builds.map(({ rev, sha, version, subject }) => ({ rev, sha, version, subject })),
  cases: cases.map((c, i) => ({
    name: c.name,
    rawTx: c.rawTx,
    verdicts: Object.fromEntries(builds.map((b, j) => [b.sha, verdicts[j][i]])),
  })),
}
const out = join(import.meta.dir, '../../__tests__/fixtures/solana/advanced-mode-firmware-verdicts.json')
writeFileSync(out, JSON.stringify(corpus, null, 2) + '\n')
for (const [i, c] of cases.entries()) {
  console.log(`${builds.map((_, j) => verdicts[j][i].padEnd(9)).join(' ')} ${c.name}`)
}
