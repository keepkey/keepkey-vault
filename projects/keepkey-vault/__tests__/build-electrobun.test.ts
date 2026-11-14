import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

test.skipIf(process.platform === 'win32')('requires fresh app or release outputs with the expected version', () => {
  const root = mkdtempSync(join(tmpdir(), 'keepkey-build-test-'))
  try {
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'keepkey-vault', version: '1.6.11' }))
    copyFileSync(join(import.meta.dir, '../scripts/build-electrobun.ts'), join(root, 'scripts/build-electrobun.ts'))
    writeFileSync(join(root, 'bin/hutch'), `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const os = process.platform === 'darwin' ? 'macos' : process.platform
const channel = process.argv[4].split('=')[1]
const prefix = channel + '-' + os + '-' + process.arch
const mode = process.env.KEEPKEY_BUILD_FIXTURE
const write = (path, contents) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents) }
if (mode === 'noop') process.exit(0)
const version = mode === 'wrong-version' ? '1.4.11' : '1.6.11'
if (channel === 'dev') {
  const app = join('_build', prefix, os === 'macos' ? 'keepkey-vault-dev.app/Contents' : 'keepkey-vault-dev')
  write(join(app, 'Resources/version.json'), JSON.stringify({ version, channel, identifier: 'com.keepkey.vault' }))
  write(join(app, 'Resources/app/bun/index.js'), 'fixture backend')
  write(join(app, os === 'macos' ? 'MacOS/launcher' : 'bin/launcher'), 'fixture launcher')
} else {
  write(join('artifacts', prefix + '-update.json'), JSON.stringify({ version, hash: 'test', platform: os, arch: process.arch }))
  if (mode !== 'missing-v2') write(join('artifacts', prefix + '-update-v2.json'), JSON.stringify({ version, hash: 'test', platform: os, arch: process.arch }))
  if (mode !== 'missing-archive') {
    write(join('artifacts', prefix + '-keepkey-vault' + (os === 'macos' ? '.app' : '') + '.tar.zst'), 'fixture archive')
  }
}
`, { mode: 0o755 })
    const run = (channel: string, mode: string) => Bun.spawnSync(
      [process.execPath, join(root, 'scripts/build-electrobun.ts'), channel],
      { cwd: root, env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:${process.env.PATH || ''}`,
        KEEPKEY_BUILD_FIXTURE: mode,
      } },
    )
    expect(run('dev', 'valid').exitCode).toBe(0)
    const stale = run('dev', 'noop')
    expect(stale.exitCode).not.toBe(0)
    expect(stale.stderr.toString()).toContain('did not write a fresh build output')
    const wrong = run('dev', 'wrong-version')
    expect(wrong.exitCode).not.toBe(0)
    expect(wrong.stderr.toString()).toContain('unexpected bundle metadata')
    expect(run('stable', 'valid').exitCode).toBe(0)
    const incomplete = run('stable', 'missing-archive')
    expect(incomplete.exitCode).not.toBe(0)
    expect(incomplete.stderr.toString()).toContain('.tar.zst')
    const noV2 = run('stable', 'missing-v2')
    expect(noV2.exitCode).not.toBe(0)
    expect(noV2.stderr.toString()).toContain('-update-v2.json')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
