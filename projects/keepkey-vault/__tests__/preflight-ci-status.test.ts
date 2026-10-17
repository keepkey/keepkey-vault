/**
 * `make preflight` section 4 (CI STATUS), run as written in the Makefile
 * against a stand-in `gh`: the hdwallet pin is a keepkey/hdwallet commit, and
 * a repo without the commit (gh exits non-zero and prints the error body) is
 * "no checks", never a failure.
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
  repos/keepkey/hdwallet/*) case "$*" in *failure*) echo 0;; *) echo 3;; esac;;
  *) case "$*" in *failure*) echo 0;; *) echo 1;; esac;;
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
