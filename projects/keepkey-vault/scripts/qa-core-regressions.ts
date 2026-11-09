/** Existing core-flow tests, isolated from one another and from a running Vault. */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const manifest = JSON.parse(readFileSync(join(root, '__tests__/fixtures/core-regression/unit-manifest.json'), 'utf8')) as { groups: Record<string, string[]>; assertionScripts?: string[] }
const files = Object.entries(manifest.groups).flatMap(([group, paths]) => paths.map(file => ({ group, file })))
const assertionScripts = new Set(manifest.assertionScripts || [])
if ([...assertionScripts].some(file => !files.some(entry => entry.file === file))) throw new Error('Assertion scripts must also appear in a manifest group')
if (!files.length || new Set(files.map(f => f.file)).size !== files.length) throw new Error('Core QA manifest must contain unique test files')
for (const { file } of files) {
  if (!/^(?:__tests__|src)\/[\w./-]+\.test\.tsx?$/.test(file) || file.split('/').includes('..')) throw new Error(`Invalid core QA test path: ${file}`)
  const source = readFileSync(join(root, file), 'utf8')
  if (/VAULT_API_URL|(?:localhost|127\.0\.0\.1|\[::1\]):1646\b/.test(source)) throw new Error(`Live Vault API test excluded from core QA: ${file}`)
}
const evidence = process.env.CORE_QA_EVIDENCE
  ? resolve(process.env.CORE_QA_EVIDENCE)
  : mkdtempSync(join(tmpdir(), 'keepkey-core-qa-'))
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const logs = join(evidence, 'logs')
mkdirSync(logs, { recursive: true, mode: 0o700 })
type Result = { group: string; file: string; log: string; exitCode: number; seconds: number; pass: number; fail: number; skip: number; todo: number; assertions: number; assertionFailures: number; timedOut: boolean; valid: boolean }
const results: Result[] = []
let cursor = 0
async function run(group: string, file: string): Promise<Result> {
  const started = Date.now(), log = file.replaceAll('/', '__') + '.log'
  const script = assertionScripts.has(file)
  const fd = openSync(join(logs, log), 'w', 0o600)
  let timedOut = false, exitCode = 1
  try {
    // A future indirect live-test import must not fall back to the owner's :1646.
    const child = Bun.spawn(script ? [process.execPath, file] : [process.execPath, 'test', file], { cwd: root, env: { ...process.env, VAULT_API_URL: 'http://127.0.0.1:9' }, stdout: fd, stderr: fd })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 65_000)
    try { exitCode = await child.exited } finally { clearTimeout(timer) }
  } finally { closeSync(fd) }
  const output = readFileSync(join(logs, log), 'utf8')
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0 }
  let summary = false
  for (const match of output.matchAll(/^\s*(\d+) (pass|fail|skip|todo)\s*$/gm)) {
    counts[match[2] as keyof typeof counts] = Number(match[1]); summary = true
  }
  const scriptSummary = script ? output.match(/Result: (\d+) passed, (\d+) failed/) : null
  const assertions = script ? Number(output.match(/(\d+) assertions passed\b/)?.[1] || scriptSummary?.[1] || 0) : 0
  const assertionFailures = Number(scriptSummary?.[2] || 0)
  const valid = !timedOut && exitCode === 0 && counts.fail === 0 && assertionFailures === 0 && (script ? assertions > 0 : summary && counts.pass + counts.skip + counts.todo > 0)
  if (!valid) console.error(`FAIL ${file} (exit ${exitCode}${timedOut ? ', timed out' : ''}; see ${join(logs, log)})`)
  return { group, file, log: `logs/${log}`, exitCode, seconds: Math.round((Date.now() - started) / 10) / 100, ...counts, assertions, assertionFailures, timedOut, valid }
}
await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
  while (cursor < files.length) {
    const { group, file } = files[cursor++]
    results.push(await run(group, file))
  }
}))
results.sort((a, b) => a.file.localeCompare(b.file))
const groups = Object.keys(manifest.groups).map(group => {
  const selected = results.filter(r => r.group === group)
  return { group, files: selected.length, passed: selected.reduce((n, r) => n + r.pass, 0), failed: selected.reduce((n, r) => n + r.fail, 0), assertions: selected.reduce((n, r) => n + r.assertions, 0), assertionFailures: selected.reduce((n, r) => n + r.assertionFailures, 0), invalidFiles: selected.filter(r => !r.valid).map(r => r.file) }
})
const summary = { runtime: Bun.version, evidence, files: results.length, unitFiles: files.filter(f => !assertionScripts.has(f.file)).length, assertionScriptFiles: assertionScripts.size, passed: results.reduce((n, r) => n + r.pass, 0), failed: results.reduce((n, r) => n + r.fail, 0), skipped: results.reduce((n, r) => n + r.skip, 0), assertions: results.reduce((n, r) => n + r.assertions, 0), assertionFailures: results.reduce((n, r) => n + r.assertionFailures, 0), invalidFiles: results.filter(r => !r.valid).map(r => r.file), groups, results }
writeFileSync(join(evidence, 'results.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 })
for (const group of groups) console.log(`${group.group}: ${group.passed} passed, ${group.failed} failed, ${group.assertions} script assertions, ${group.invalidFiles.length} invalid files`)
console.log(`${summary.passed} passed; ${summary.failed} failed; ${summary.skipped} skipped; ${summary.assertions} script assertions (${summary.assertionFailures} failed); ${summary.invalidFiles.length} invalid files. Evidence: ${evidence}`)
process.exitCode = summary.invalidFiles.length ? 1 : 0
