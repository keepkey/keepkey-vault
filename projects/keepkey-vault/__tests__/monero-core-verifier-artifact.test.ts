import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directories: string[] = []
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }) })
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monero-core-artifact-'))); directories.push(root)
  const bytes = Buffer.from('PUBLIC SYNTHETIC CORE VERIFIER'), source = join(root, 'raw.dylib')
  writeFileSync(source, bytes, { mode: 0o755 })
  // win32-x64 carries no macOS floor fields, exactly as its real manifest entry will.
  const manifest = { files: { 'darwin-arm64': { filename: 'libmonero_core_verify.dylib', sha256: sha(bytes), size: bytes.length, minimumMacosVersion: '13.0', minimumDarwinMajor: 22 },
    'win32-x64': { filename: 'monero_core_verify.dll', sha256: sha(bytes), size: bytes.length } } }
  const entry = join(root, 'entry.ts')
  writeFileSync(entry, ['../src/bun/monero-core-verifier-artifact.ts', '../scripts/stage-monero-core-verifier.ts', '../scripts/sign-monero-core-verifier.ts']
    .map(p => `export * from ${JSON.stringify(resolve(import.meta.dir, p))};`).join('\n'))
  const built = await Bun.build({ entrypoints: [entry], target: 'bun', outdir: root, naming: 'fixture.mjs',
    plugins: [{ name: 'public-core-pin', setup(build) {
      build.onLoad({ filter: /core-verifier-manifest\.json$/ }, () => ({ loader: 'json', contents: JSON.stringify(manifest) }))
    } }] })
  if (!built.success) throw new Error(built.logs.join('\n'))
  const modulePath = built.outputs[0].path
  return { root, source, bytes, api: await import('file://' + modulePath), platform: 'darwin-arm64' }
}

test('staging requires exact bytes, regular files, safe permissions and an approved platform', async () => {
  const f = await fixture(), output = join(f.root, 'staged')
  const staged = f.api.stageMoneroCoreVerifier({ source: f.source, directory: output, platform: f.platform })
  expect(readFileSync(staged)).toEqual(f.bytes)
  const link = join(f.root, 'link'); symlinkSync(f.source, link)
  expect(() => f.api.stageMoneroCoreVerifier({ source: link, directory: output, platform: f.platform })).toThrow('reviewed bytes')
  chmodSync(f.source, 0o777)
  expect(f.api.checkRawMoneroCoreVerifier(f.source, f.platform)).toBe(false)
  chmodSync(f.source, 0o755); writeFileSync(f.source, 'TAMPERED')
  expect(() => f.api.stageMoneroCoreVerifier({ source: f.source, directory: output, platform: f.platform })).toThrow('reviewed bytes')
  expect(() => f.api.stageMoneroCoreVerifier({ source: f.source, directory: output, platform: 'linux-x64' })).toThrow('No reviewed')
})

test('signed copies preserve pristine input and receipts never qualify unsealed bytes', async () => {
  const f = await fixture(), output = join(f.root, 'signed')
  const staged = f.api.stageSignedMoneroCoreVerifier({ source: f.source, directory: output, platform: f.platform, identity: 'PUBLIC FIXTURE',
    sign(path: string) { writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(' PUBLIC SYNTHETIC SIGNATURE')])) } })
  expect(readFileSync(f.source)).toEqual(f.bytes)
  expect(f.api.checkMoneroCoreVerifierDirectory(output, f.platform)).toBeNull()
  expect(f.api.checkMoneroCoreVerifierDirectory(output, f.platform, true)).toBe(staged.library)
  // An adjacent developer receipt never becomes an authenticated app seal.
  expect(f.api.verifiedMoneroCoreVerifierFile(output)).toBeNull()
  const good = readFileSync(staged.receipt, 'utf8')
  for (const patch of [{ sourceSha256: '0'.repeat(64) }, { platform: 'win32-x64' }, { signedSha256: 'a'.repeat(64) }, { extra: true }]) {
    writeFileSync(staged.receipt, JSON.stringify({ ...JSON.parse(good), ...patch }))
    expect(f.api.checkMoneroCoreVerifierDirectory(output, f.platform, true)).toBeNull()
  }
  writeFileSync(staged.receipt, good); writeFileSync(staged.library, 'TAMPERED AFTER SIGNING')
  expect(f.api.checkMoneroCoreVerifierDirectory(output, f.platform, true)).toBeNull()
})

test('preflight checks the real native floor and refuses unsupported hosts', async () => {
  const f = await fixture()
  expect(f.api.moneroCoreVerifierHostSupported(f.platform, '22.0.0')).toBe(true)
  expect(f.api.moneroCoreVerifierHostSupported(f.platform, '21.6.0')).toBe(false)
  expect(f.api.moneroCoreVerifierHostSupported('darwin-x64', '26.0.0')).toBe(false)
  // os.release() is 10.0.x on Windows; it is not a Darwin major and must not gate Windows.
  expect(f.api.moneroCoreVerifierHostSupported('win32-x64', '10.0.22631')).toBe(true)
  expect(f.api.moneroCoreVerifierHostSupported('win32-x64', '10.0.19045')).toBe(true)
  expect(f.api.moneroCoreVerifierHostSupported('linux-x64', '6.8.0-45-generic')).toBe(false)
  expect(f.api.moneroCoreVerifierHostSupported(f.platform, 'not a version')).toBe(false)
})

test('corrupt raw input fails before any signing operation', async () => {
  const f = await fixture(); let calls = 0
  writeFileSync(f.source, 'TAMPERED')
  expect(() => f.api.stageSignedMoneroCoreVerifier({ source: f.source, directory: join(f.root, 'signed'), platform: f.platform,
    identity: 'PUBLIC FIXTURE', sign() { calls++ } })).toThrow('reviewed raw')
  expect(calls).toBe(0)
})

test('Windows stages the reviewed DLL under its manifest name and never accepts a signed-copy receipt', async () => {
  const f = await fixture(), output = join(f.root, 'win')
  const staged = f.api.stageMoneroCoreVerifier({ source: f.source, directory: output, platform: 'win32-x64' })
  expect(staged).toBe(join(output, 'monero_core_verify.dll'))
  expect(f.api.checkMoneroCoreVerifierDirectory(output, 'win32-x64')).toBe(staged)
  expect(f.api.checkMoneroCoreVerifierDirectory(output, 'darwin-arm64')).toBeNull()
  writeFileSync(staged, Buffer.concat([f.bytes, Buffer.from(' AUTHENTICODE')]))
  writeFileSync(join(output, 'core-verifier-receipt.json'), JSON.stringify(f.api.moneroCoreVerifierReceipt(sha(readFileSync(staged)), 'win32-x64')))
  // Raw-hash policy: changed bytes fail unless an outer seal was verified, which Windows never has.
  expect(f.api.checkMoneroCoreVerifierDirectory(output, 'win32-x64')).toBeNull()
})
