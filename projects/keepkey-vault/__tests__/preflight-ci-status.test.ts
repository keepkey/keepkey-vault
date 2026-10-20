/**
 * `make preflight` section 4 (CI STATUS), run as written in the Makefile
 * against a stand-in `gh`: the hdwallet pin is a keepkey/hdwallet commit, and
 * a repo without the commit falls back to the fork. Missing or incomplete
 * evidence must never be reported as green.
 */
import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url).pathname
const makefile = readFileSync(join(ROOT, 'Makefile'), 'utf8')
const section = makefile.slice(makefile.indexOf('\techo "4. CI STATUS'), makefile.indexOf('\techo "5. LOCAL BUILD ARTIFACTS"'))
  .split('\n').map((line) => line.replace(/\\$/, '')).join('\n').replaceAll('$$', '$')

// The fork has no copy of the pinned commit: gh prints the 422 body and exits 1.
const FAKE_GH = `#!/bin/sh
case "$2" in
  repos/BitHighlander/hdwallet/*) echo '{"message":"No commit found for SHA","status":"422"}'; exit 1;;
  repos/keepkey/hdwallet/*) printf "3\\t0\\t3\\n";;
  *) printf "1\\t0\\t1\\n";;
esac
`

test('preflight CI status checks the hdwallet pin on keepkey/hdwallet', () => {
  expect(section).toContain('echo "4. CI STATUS')
  const bin = mkdtempSync(join(tmpdir(), 'preflight-gh-'))
  try {
    writeFileSync(join(bin, 'gh'), FAKE_GH)
    chmodSync(join(bin, 'gh'), 0o755)
    const run = Bun.spawnSync(['bash', '-c', `fail=0\n${section}\necho "FAIL=$fail"`], {
      cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    const out = run.stdout.toString()
    expect(out).toContain('✅ modules/hdwallet: 3/3 green')
    expect(out).not.toContain('FAILED')
    expect(out).toContain('FAIL=0')
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

function runCi(fakeGh: string, extraEnv: Record<string, string> = {}): string {
  const bin = mkdtempSync(join(tmpdir(), 'preflight-gh-'))
  try {
    writeFileSync(join(bin, 'gh'), fakeGh)
    chmodSync(join(bin, 'gh'), 0o755)
    const run = Bun.spawnSync(['bash', '-c', `fail=0\n${section}\necho "FAIL=$fail"`], {
      cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
    })
    expect(run.exitCode).toBe(0)
    return run.stdout.toString()
  } finally { rmSync(bin, { recursive: true, force: true }) }
}

test.each([
  ['queued', null, 1], ['in_progress', null, 1],
  ['completed', 'failure', 1], ['completed', 'cancelled', 1],
  ['completed', 'timed_out', 1], ['completed', 'action_required', 1],
  ['completed', 'success', 0], ['completed', 'neutral', 0], ['completed', 'skipped', 0],
])('preflight evaluates the actual check JSON (%s / %s)', (status, conclusion, expectedFail) => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-checks-'))
  try {
    const fixture = join(dir, 'checks.json')
    writeFileSync(fixture, JSON.stringify({ total_count: 1, check_runs: [{ status, conclusion }] }))
    const out = runCi('#!/bin/sh\nshift 2\nexec jq -r "$2" "$TEST_CHECKS_FILE"\n', { TEST_CHECKS_FILE: fixture })
    expect(out).toContain(`FAIL=${expectedFail}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test.each([
  ['pending, cancelled, timed out or failed', '3 1 3'],
  ['no checks', '0 0 0'],
  ['truncated check list', '101 0 100'],
])('preflight rejects %s CI evidence', (_, counts) => {
  const out = runCi(`#!/bin/sh\necho "${counts}"\n`)
  expect(out).toContain('FAIL=1')
  expect(out).not.toContain('green')
})

test('GitHub API failures cannot become all green', () => {
  const out = runCi(`#!/bin/sh\necho '{"message":"rate limit exceeded"}'\nexit 1\n`)
  expect(out).toContain('CI unavailable')
  expect(out).toContain('FAIL=1')
  expect(out).not.toContain('green')
})

test('a commit with no canonical checks can use its fork checks', () => {
  const out = runCi(`#!/bin/sh
case "$2" in
  repos/keepkey/hdwallet/*) printf "0\\t0\\t0\\n";;
  *) printf "3\\t0\\t3\\n";;
esac
`)
  expect(out).toContain('✅ modules/hdwallet: 3/3 green')
  expect(out).toContain('FAIL=0')
})

const typecheckSection = makefile.slice(makefile.indexOf('\techo "7. VAULT TYPECHECK'), makefile.indexOf('\techo "════════', makefile.indexOf('\techo "7. VAULT TYPECHECK')))
  .split('\n').map(line => line.replace(/\\$/, '')).join('\n').replaceAll('$$', '$')

test.each([
  ['clean compiler run', '', 0, 0],
  ['existing file diagnostics', 'src/old.ts(1,1): error TS2322: Existing error', 2, 0],
  ['global missing minimatch types', "error TS2688: Cannot find type definition file for 'minimatch'.", 2, 1],
  ['missing compiler', 'tsc: command not found', 127, 1],
  ['compiler crash', 'internal compiler error', 1, 1],
  ['new diagnostics above baseline', 'src/a.ts(1,1): error TS2322: One\nsrc/b.ts(1,1): error TS2322: Two', 2, 1],
])('preflight typecheck handles %s', (_, output, status, expectedFail) => {
  const bin = mkdtempSync(join(tmpdir(), 'preflight-tsc-'))
  try {
    writeFileSync(join(bin, '.typecheck-baseline'), '1')
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$TEST_TSC_OUTPUT"\nexit "$TEST_TSC_STATUS"\n')
    chmodSync(join(bin, 'npx'), 0o755)
    const script = typecheckSection.replaceAll('$(PROJECT_DIR)', bin)
    const run = Bun.spawnSync(['bash', '-c', `fail=0\n${script}\necho "FAIL=$fail"`], {
      cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_TSC_OUTPUT: output, TEST_TSC_STATUS: String(status) },
    })
    const out = run.stdout.toString()
    expect(run.exitCode).toBe(0)
    expect(out).toContain(`FAIL=${expectedFail}`)
    if (status !== 0) expect(out).not.toContain('✅ clean')
  } finally { rmSync(bin, { recursive: true, force: true }) }
})
