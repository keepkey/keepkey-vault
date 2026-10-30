/**
 * Writes __tests__/fixtures/uniswap/ur-firmware-parity.json.gz: every call the
 * firmware's Universal Router model test reads (the 1,000-call D-021 sample,
 * the 250 vectors, the 10 V4 vectors and 2,048 mutated V4 calls), each with
 * the plan and review of the firmware's own uniswap_ur.c (harness.c). Run
 * through gen-fixture.sh, never alone.
 *
 * Before writing, every device line is checked against the firmware's
 * independent Python model (uniswap_ur_expected.txt): equal on every real
 * call; on a mutant the device may refuse more (it reads forward only), never
 * read differently. The fixture holds the device's lines, so the Desktop test
 * agrees with the device itself, including those extra refusals.
 *
 * 7.17 (UR_DECODE_ROUTER=1, ur_decode reads V4_SWAP by router): also the rw
 * calls (other wallets' public calls, uniswap_ur_realworld.h) and v4o (the v4r
 * calls to Base UR 2.0). The v4x / v4y lines and their mutants are left out:
 * uniswap_ur_v4_routers.h is one wallet's own swaps. In their place, every
 * sample call that decodes a V4 swap is also sent to each other V4_ROUTERS
 * router and to UR 1.2 (case [key, base, null, device, router]); those lines
 * have no Python model line and are the device's alone.
 *
 * usage: bun gen-fixture.ts <archive dir> <firmware sha> <out.json.gz>
 */
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const [dir, sha, out] = process.argv.slice(2)
if (!dir || !sha || !out) throw new Error('usage: bun gen-fixture.ts <archive dir> <firmware sha> <out.json.gz>')
const fw = (p: string) => join(dir, 'unittests/firmware', p)
// gen_ur_vectors.py expect(): sample calls and V4 vectors are read as calls to UR 2.1.2 on Base.
const UR_212 = 'd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40'
const BASE_UR20 = '6ff5693b99212da76ad316178a184ab56d299b43'
const by717 = process.env.UR_DECODE_ROUTER === '1'
// Firmware 7.17 V4_ROUTERS, and UR 1.2 (no V4).
const RETARGET = ['66a9893cc07d91d95644aedd05d03f95e1dba8af', BASE_UR20, 'a51afafe0263b40edaef0df8781ea9aa03e381a3',
  '4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca', '23617e59a5925b2a4bf75d73ff6711cd0b29de85',
  '2d01411773c8c24805306e89a41f7855c3c4fe65', '3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad']

const calls: Record<string, [string, string, string]> = {} // key -> [router, value, calldata], hex
const sample = readFileSync(fw('uniswap_ur_sample.bin'))
for (let i = 0; i < sample.length;) {
  const n = sample.readUInt32BE(i + 65)
  calls[`0x${sample.subarray(i, i + 32).toString('hex')}`] =
    [UR_212, sample.subarray(i + 33, i + 65).toString('hex'), sample.subarray(i + 69, i + 69 + n).toString('hex')]
  i += 69 + n
}
const hdr = readFileSync(fw('uniswap_ur_vectors.h'), 'utf8')
let k = 0
for (const m of hdr.matchAll(/\{"(0x[0-9a-f]{64})", "([0-9a-f]{40})", "([0-9a-f]{64})", "([0-9a-f]+)"/g)) calls[`acc${k++}`] = [m[2], m[3], m[4]]
k = 0
for (const m of hdr.slice(hdr.indexOf('v4_rejected()')).matchAll(/"([0-9a-f]{100,})"/g)) calls[`v4r${k++}`] = [UR_212, '0'.repeat(64), m[1]]
if (by717) {
  for (const key of Object.keys(calls).filter((x) => x.startsWith('v4r'))) calls[key.replace('v4r', 'v4o')] = [BASE_UR20, ...calls[key].slice(1)] as [string, string, string]
  k = 0
  for (const m of readFileSync(fw('uniswap_ur_realworld.h'), 'utf8').matchAll(/\{"(0x[0-9a-f]{64})", (\d+), "([0-9a-f]{40})", "([0-9a-f]{64})", (true|false), "([0-9a-f]+)"\}/g)) {
    calls[`rw${k++}`] = [m[3], m[4], m[6]]
  }
}

type Case = { key: string; base?: string; edits?: [number, number][]; model?: string; router?: string }
// key [base n off:byte...] <model line>
const cases: Case[] = readFileSync(fw('uniswap_ur_expected.txt'), 'utf8').trim().split('\n').map((line) => {
  const t = line.split(' ')
  if (!t[0].startsWith('mut')) return { key: t[0], model: t.slice(1).join(' ') }
  const n = Number(t[2])
  const edits = t.slice(3, 3 + n).map((e) => e.split(':').map(Number) as [number, number])
  return { key: t[0], base: t[1], edits, model: t.slice(3 + n).join(' ') }
}).filter((c) => !/^v4[xy]/.test(c.base ?? c.key))
const calldata = (c: Case) => {
  const call = calls[c.base ?? c.key]
  if (!call) throw new Error(`no calldata for ${c.key}`)
  const router = c.router ?? call[0]
  if (!c.edits) return [router, call[1], call[2]]
  const b = Buffer.from(call[2], 'hex')
  for (const [at, v] of c.edits) b[at] = v
  return [router, call[1], b.toString('hex')]
}
const harness = (cs: Case[]) => {
  const run = spawnSync(join(dir, 'harness'), { input: cs.map((c) => calldata(c).join(' ')).join('\n') + '\n', maxBuffer: 1 << 28 })
  if (run.status !== 0) throw new Error(`harness exited ${run.status}: ${run.stderr}`)
  const lines = run.stdout.toString().trim().split('\n')
  if (lines.length !== cs.length) throw new Error(`harness answered ${lines.length} of ${cs.length} calls`)
  return lines
}
const device = harness(cases)
if (by717) {
  // Sample calls whose plan has a V4 swap (kind 10 or 11), sent to every other router.
  // A step's kind is the only field followed by a 40-hex address.
  const v4 = cases.filter((c, i) => c.key.startsWith('0x') && device[i].startsWith('D 1 ') && / 1[01] [0-9a-f]{40} /.test(device[i]))
  const extra = v4.flatMap((c) => RETARGET.map((router, j) => ({ key: `rt${j}:${c.key}`, base: c.key, router })))
  cases.push(...extra)
  device.push(...harness(extra))
}

let stricter = 0
cases.forEach((c, i) => {
  if (c.model === undefined) return // a retargeted call: the device's line only
  const line = device[i].replace(/ R \d+( [0-9a-f]{40})*$/, '')
  if (line === c.model) return
  if (c.edits && line === 'D 0') { stricter++; return }
  throw new Error(`${c.key}: the device reads "${line.slice(0, 80)}…", the Python model "${c.model.slice(0, 80)}…"`)
})
const reviewed = device.filter((l) => / S 1 /.test(l)).length
const fixture = {
  source: `BitHighlander/keepkey-firmware ${sha}: lib/firmware/uniswap_ur.c (scripts/uniswap-fw-oracle/harness.c) on unittests/firmware/uniswap_ur_{sample.bin,vectors.h,expected.txt}`,
  summary: { cases: cases.length, reviewed, mutantsRefusedOnlyByDevice: stricter, retargeted: cases.filter((c) => c.router).length },
  calls,
  cases: cases.map((c, i) => [c.key, c.base ?? null, c.edits ?? null, device[i], ...(c.router ? [c.router] : [])]),
}
writeFileSync(out, Bun.gzipSync(Buffer.from(JSON.stringify(fixture)), { level: 9 }))
console.log(`${out}: ${cases.length} calls, ${reviewed} reviewed by the device, ${stricter} mutants refused only by the device; every other line equals the Python model`)
