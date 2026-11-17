import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const project = resolve(import.meta.dir, '..')
const root = resolve(project, '../..')
const workflow = parse(readFileSync(join(root, '.github/workflows/build.yml'), 'utf8'))
interface Step { uses?: string; run?: string; with?: Record<string, string> }
interface Job { steps?: Step[] }
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

test('macOS updater manifests pass the full Python archive regression suite', () => {
  if (!Bun.which('zstd')) throw new Error('zstd is required to run the macOS updater manifest regressions without skips')
  const result = Bun.spawnSync(['python3', '-m', 'unittest', 'scripts/test_regenerate_macos_update_manifests.py', '-v'], {
    cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdout: 'pipe', stderr: 'pipe', timeout: 60_000, maxBuffer: 1024 * 1024,
  })
  const output = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0) throw new Error(output || 'The Python macOS updater manifest regressions failed')
  expect(Number(output.match(/Ran (\d+) tests?/)?.[1])).toBeGreaterThanOrEqual(8)
  expect(output).not.toMatch(/\bskipped\b/)
}, 65_000)

test('the actual release download selectors exclude every unsigned Windows CI upload', () => {
  const jobs = Object.values(workflow.jobs) as Job[]
  const unsigned = jobs.filter(job => job.steps?.some(step => step.run?.includes('scripts/build-windows-production.ps1 -SkipSign')))
  const release = jobs.filter(job => job.steps?.some(step => step.uses?.startsWith('softprops/action-gh-release@')))
  expect(unsigned).toHaveLength(1)
  expect(release).toHaveLength(1)
  const uploads = unsigned[0].steps!.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  const downloads = release[0].steps!.filter(step => step.uses?.startsWith('actions/download-artifact@'))
  expect(uploads.length).toBeGreaterThan(0)
  expect(downloads.length).toBeGreaterThan(0)
  for (const upload of uploads) {
    const artifact = upload.with?.name
    expect(typeof artifact).toBe('string')
    for (const download of downloads) {
      const selection = download.with ?? {}
      // An unqualified download fetches every artifact and would publish the
      // unsigned installer because the release upload uses artifacts/**/*.
      expect(!!selection.name || !!selection.pattern).toBe(true)
      if (selection.name) expect(selection.name).not.toBe(artifact)
      else expect(new Bun.Glob(selection.pattern).match(artifact!)).toBe(false)
    }
  }
})

test('Windows packaging always uses pristine verification; forged adjacent receipts cannot bypass it', async () => {
  const windows = readFileSync(join(root, 'scripts/build-windows-production.ps1'), 'utf8')
  const gate = windows.match(/^\$EmulatorReviewedSourceSha = bun \(Join-Path \$ProjectDir "scripts\\write-emulator-signing-receipt\.ts"\) (\S+) \$BundledEmulatorDll\s*$/m)
  expect(gate).not.toBeNull()
  expect(gate![1]).toBe('--verify')
  // Neither -SkipBuild nor -SkipSign may select --verify-sealed: a DLL's
  // Authenticode signature cannot authenticate an adjacent JSON receipt.
  expect(windows).not.toContain('--verify-sealed')
  const block = windows.slice(windows.indexOf('Write-Success "Verified bundled Windows emulator:'), windows.indexOf('# Hutch supplies bin'))
  expect(block).not.toMatch(/^\s*if\s*\(\$Skip(?:Build|Sign)/m)
  expect(windows.indexOf(gate![0])).toBeLessThan(windows.indexOf('foreach ($file in $filesToSign)'))

  const directory = mkdtempSync(join(tmpdir(), 'windows-emulator-pristine-test-')); directories.push(directory)
  const source = 'PUBLIC SYNTHETIC CERTIFIED WINDOWS EMULATOR'
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const sourceSha = digest(source)
  // Compile the real CLI against a public synthetic certified manifest. No
  // real DLL executes, and no native signing command is reachable here.
  const output = join(directory, 'cli'); mkdirSync(output)
  const built = await Bun.build({ entrypoints: [join(project, 'scripts/write-emulator-signing-receipt.ts')], target: 'bun', outdir: output, naming: 'verify.mjs',
    plugins: [{ name: 'public-certified-windows-fixture', setup(build) {
      build.onLoad({ filter: /emulator-bundle\/manifest\.json$/ }, () => ({ loader: 'json', contents: JSON.stringify({ version: '7.17.0', files: {
        'libkkemu.dll': { sha256: sourceSha }, 'libkkemu.dylib': { sha256: sourceSha },
      } }) }))
    } }] })
  expect(built.success).toBe(true)
  const library = join(directory, 'libkkemu.dll')
  const run = (mode: string) => Bun.spawnSync([process.execPath, join(output, 'verify.mjs'), mode, library])
  writeFileSync(library, source)
  const certified = run(gate![1])
  expect(certified.exitCode).toBe(0)
  expect(certified.stdout.toString().trim()).toBe(sourceSha)
  const substituted = 'PUBLIC SYNTHETIC DIFFERENT DLL WITH A CLAIMED SIGNATURE'
  writeFileSync(library, substituted)
  writeFileSync(join(directory, 'nu7-emulator-receipt.json'), JSON.stringify({ schemaVersion: 1, version: '7.17.0', filename: 'libkkemu.dll', certifiedSourceSha256: sourceSha, signedSha256: digest(substituted) }))
  const rejected = run(gate![1])
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr.toString()).toContain('does not match the certified artifact')
  // Positive control: the weaker mode would accept this exact unsealed pair.
  expect(run('--verify-sealed').exitCode).toBe(0)
})
