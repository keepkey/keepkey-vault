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

// key [base n off:byte...] <model line>
const cases = readFileSync(fw('uniswap_ur_expected.txt'), 'utf8').trim().split('\n').map((line) => {
  const t = line.split(' ')
  if (!t[0].startsWith('mut')) return { key: t[0], model: t.slice(1).join(' ') }
  const n = Number(t[2])
  const edits = t.slice(3, 3 + n).map((e) => e.split(':').map(Number) as [number, number])
  return { key: t[0], base: t[1], edits, model: t.slice(3 + n).join(' ') }
})
const calldata = (c: (typeof cases)[number]) => {
  const call = calls[c.base ?? c.key]
  if (!call) throw new Error(`no calldata for ${c.key}`)
  if (!c.edits) return call
  const b = Buffer.from(call[2], 'hex')
  for (const [at, v] of c.edits) b[at] = v
  return [call[0], call[1], b.toString('hex')]
}
const run = spawnSync(join(dir, 'harness'), { input: cases.map((c) => calldata(c).join(' ')).join('\n') + '\n', maxBuffer: 1 << 28 })
if (run.status !== 0) throw new Error(`harness exited ${run.status}: ${run.stderr}`)
const device = run.stdout.toString().trim().split('\n')
if (device.length !== cases.length) throw new Error(`harness answered ${device.length} of ${cases.length} calls`)

let stricter = 0
cases.forEach((c, i) => {
  const line = device[i].replace(/ R \d+( [0-9a-f]{40})*$/, '')
  if (line === c.model) return
  if (c.edits && line === 'D 0') { stricter++; return }
  throw new Error(`${c.key}: the device reads "${line.slice(0, 80)}…", the Python model "${c.model.slice(0, 80)}…"`)
})
const reviewed = device.filter((l) => / S 1 /.test(l)).length
const fixture = {
  source: `BitHighlander/keepkey-firmware ${sha}: lib/firmware/uniswap_ur.c (scripts/uniswap-fw-oracle/harness.c) on unittests/firmware/uniswap_ur_{sample.bin,vectors.h,expected.txt}`,
  summary: { cases: cases.length, reviewed, mutantsRefusedOnlyByDevice: stricter },
  calls,
  cases: cases.map((c, i) => [c.key, c.base ?? null, c.edits ?? null, device[i]]),
}
writeFileSync(out, Bun.gzipSync(Buffer.from(JSON.stringify(fixture)), { level: 9 }))
console.log(`${out}: ${cases.length} calls, ${reviewed} reviewed by the device, ${stricter} mutants refused only by the device; every other line equals the Python model`)
