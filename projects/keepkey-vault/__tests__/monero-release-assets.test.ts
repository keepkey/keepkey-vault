import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { moneroReleaseAssetProblems } from '../scripts/monero-release-assets'
import { checkRawMoneroCoreVerifier } from '../src/bun/monero-core-verifier-artifact'
import { verifiedHostAdapterIn } from '../monero-cli/src/host-adapter'
import { ARCHIVE_HASHES } from '../monero-cli/src/tools'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const adapterBytes = Buffer.from('PUBLIC SYNTHETIC MONERO DECODER'), verifierBytes = Buffer.from('PUBLIC SYNTHETIC CORE VERIFIER')
const adapterManifest = { protocol: 'keepkey-monero-wallet-export-v1', moneroVersion: '0.18.5.4', files: {
  'darwin-arm64': { filename: 'monero-host-adapter', sha256: sha(adapterBytes), size: adapterBytes.length },
  'win32-x64': { filename: 'monero-host-adapter.exe', sha256: sha(adapterBytes), size: adapterBytes.length },
} }
const verifierManifest = { files: {
  'darwin-arm64': { filename: 'libmonero_core_verify.dylib', sha256: sha(verifierBytes), size: verifierBytes.length, minimumMacosVersion: '13.0', minimumDarwinMajor: 22 },
  'win32-x64': { filename: 'monero_core_verify.dll', sha256: sha(verifierBytes), size: verifierBytes.length },
} }
const directories: string[] = []
const moduleRoot = realpathSync(mkdtempSync(join(tmpdir(), 'monero-release-check-module-')))
let check: typeof moneroReleaseAssetProblems
beforeAll(async () => {
  const entry = join(moduleRoot, 'entry.ts')
  writeFileSync(entry, `export * from ${JSON.stringify(resolve(import.meta.dir, '../scripts/monero-release-assets.ts'))}`)
  const built = await Bun.build({ entrypoints: [entry], target: 'bun', outdir: moduleRoot, naming: 'fixture.mjs', plugins: [{
    name: 'public-native-review-pins', setup(build) {
      build.onLoad({ filter: /host-adapter-manifest\.json$/ }, () => ({ loader: 'json', contents: JSON.stringify(adapterManifest) }))
      build.onLoad({ filter: /core-verifier-manifest\.json$/ }, () => ({ loader: 'json', contents: JSON.stringify(verifierManifest) }))
    },
  }] })
  if (!built.success) throw new Error(built.logs.join('\n'))
  const modulePath = built.outputs[0].path
  check = (await import('file://' + modulePath)).moneroReleaseAssetProblems
})
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
afterAll(() => rmSync(moduleRoot, { recursive: true, force: true }))

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monero-release-bundle-'))); directories.push(root)
  const app = join(root, 'KeepKey.app/Contents/Resources/app'), tools = join(app, 'monero-tools'), native = join(app, 'monero-device')
  const write = (path: string, bytes: string | Buffer) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes, { mode: 0o755 }) }
  const bun = join(app, '../../MacOS/bun'), adapter = join(tools, 'monero-host-adapter'), verifier = join(native, 'libmonero_core_verify.dylib')
  write(bun, 'PUBLIC SYNTHETIC PACKAGED BUN'); write(join(app, 'monero-cli'), 'PUBLIC SYNTHETIC WORKER')
  write(join(tools, 'monero-wallet-rpc'), 'PUBLIC SYNTHETIC RPC'); write(join(tools, 'monerod'), 'PUBLIC SYNTHETIC NODE')
  write(adapter, adapterBytes); write(verifier, verifierBytes)
  write(join(tools, 'HOST-ADAPTER-LICENSES.txt'), 'public decoder notices'); write(join(native, 'LICENSES.txt'), 'public verifier notices')
  const metadata = { version: '0.18.5.4', platform: 'darwin-arm64', archiveSha256: 'd457de7c8a1ad42e3232fdea6d9f9003be9652143fb8f719c1fc906aa6b4917b',
    signerFingerprint: '81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92', walletRpcSha256: sha('PUBLIC SYNTHETIC RPC'), daemonSha256: sha('PUBLIC SYNTHETIC NODE'),
    hostAdapterSha256: sha(adapterBytes), hostAdapterRawSha256: sha(adapterBytes) }
  const metadataPath = join(tools, 'monero-tools.json')
  const updateMetadata = () => write(metadataPath, JSON.stringify(metadata))
  updateMetadata()
  return { app, tools, native, bun, adapter, verifier, write, metadata, metadataPath, updateMetadata }
}
const ready = () => ({ code: 0, output: '{"moneroCorePlanSize":7544}' })

/** Windows layout: <root>/Resources/app beside <root>/bin/bun.exe, every helper with .exe/.dll. */
function windowsFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'monero-release-win-'))); directories.push(root)
  const app = join(root, 'keepkey-vault/Resources/app'), tools = join(app, 'monero-tools'), native = join(app, 'monero-device')
  const write = (path: string, bytes: string | Buffer) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes, { mode: 0o755 }) }
  const bun = join(root, 'keepkey-vault/bin/bun.exe'), adapter = join(tools, 'monero-host-adapter.exe'), verifier = join(native, 'monero_core_verify.dll')
  write(bun, 'PUBLIC SYNTHETIC PACKAGED BUN'); write(join(app, 'monero-cli.exe'), 'PUBLIC SYNTHETIC WORKER')
  write(join(tools, 'monero-wallet-rpc.exe'), 'PUBLIC SYNTHETIC RPC'); write(join(tools, 'monerod.exe'), 'PUBLIC SYNTHETIC NODE')
  write(adapter, adapterBytes); write(verifier, verifierBytes)
  write(join(tools, 'HOST-ADAPTER-LICENSES.txt'), 'public decoder notices'); write(join(native, 'LICENSES.txt'), 'public verifier notices')
  write(join(tools, 'monero-tools.json'), JSON.stringify({ version: '0.18.5.4', platform: 'win32-x64', archiveSha256: ARCHIVE_HASHES['win32-x64'],
    signerFingerprint: '81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92', walletRpcSha256: sha('PUBLIC SYNTHETIC RPC'), daemonSha256: sha('PUBLIC SYNTHETIC NODE'),
    hostAdapterSha256: sha(adapterBytes), hostAdapterRawSha256: sha(adapterBytes) }))
  return { app, tools, bun, adapter, verifier, write }
}

test('a Windows bundle uses .exe/.dll names and probes bin/bun.exe', () => {
  const f = windowsFixture(), calls: string[][] = []
  expect(check(f.app, 'win32-x64', false, (...args) => { calls.push(args); return ready() })).toEqual([])
  expect(calls).toEqual([[f.bun, f.verifier, f.app]])
})

test('a Windows bundle missing its .exe tools or carrying a signed helper fails before any probe', () => {
  const f = windowsFixture(); let probes = 0
  const probe = () => { probes++; return ready() }
  rmSync(join(f.tools, 'monerod.exe'))
  expect(check(f.app, 'win32-x64', false, probe).join()).toContain('monerod.exe')
  f.write(join(f.tools, 'monerod.exe'), 'PUBLIC SYNTHETIC NODE')
  // Signing a raw-pinned helper changes its bytes; Windows has no app seal to vouch for them.
  f.write(f.verifier, Buffer.concat([verifierBytes, Buffer.from(' AUTHENTICODE')]))
  expect(check(f.app, 'win32-x64', false, probe).join()).toContain('Core verifier')
  expect(probes).toBe(0)
})

test('a complete raw bundle qualifies and probes only its packaged Bun and reviewed verifier', () => {
  const f = fixture(), calls: string[][] = []
  expect(check(f.app, 'darwin-arm64', false, (...args) => { calls.push(args); return ready() })).toEqual([])
  expect(calls).toEqual([[f.bun, f.verifier, f.app]])
})

test('missing or tampered tools are rejected before any native probe', () => {
  const f = fixture(); let probes = 0
  const probe = () => { probes++; return ready() }
  f.write(join(f.tools, 'monero-wallet-rpc'), 'TAMPERED RPC')
  expect(check(f.app, 'darwin-arm64', false, probe).join()).toContain('metadata does not authenticate')
  f.write(join(f.tools, 'monero-wallet-rpc'), 'PUBLIC SYNTHETIC RPC')
  rmSync(f.verifier)
  symlinkSync(f.adapter, f.verifier)
  expect(check(f.app, 'darwin-arm64', false, probe).join()).toContain('Core verifier')
  expect(probes).toBe(0)
})

test('both signed artifact receipts require the verified outer app seal and retain raw provenance', () => {
  const f = fixture(), signedAdapter = Buffer.concat([adapterBytes, Buffer.from(' PUBLIC MOCK SIGNATURE')]), signedVerifier = Buffer.concat([verifierBytes, Buffer.from(' PUBLIC MOCK SIGNATURE')])
  f.write(f.adapter, signedAdapter); f.metadata.hostAdapterSha256 = sha(signedAdapter); f.updateMetadata()
  f.write(f.verifier, signedVerifier)
  const receipt = { schemaVersion: 1, platform: 'darwin-arm64', filename: 'libmonero_core_verify.dylib', sourceSha256: sha(verifierBytes), signedSha256: sha(signedVerifier) }
  f.write(join(f.native, 'core-verifier-receipt.json'), JSON.stringify(receipt))
  expect(check(f.app, 'darwin-arm64', false, ready).join()).toContain('verified outer app seal')
  expect(check(f.app, 'darwin-arm64', true, ready)).toEqual([])
  f.metadata.hostAdapterRawSha256 = '0'.repeat(64); f.updateMetadata()
  expect(check(f.app, 'darwin-arm64', true, ready).join()).toContain('Monero decoder')
  f.metadata.hostAdapterRawSha256 = sha(adapterBytes); f.updateMetadata()
  f.write(join(f.native, 'core-verifier-receipt.json'), JSON.stringify({ ...receipt, sourceSha256: '0'.repeat(64) }))
  expect(check(f.app, 'darwin-arm64', true, ready).join()).toContain('Core verifier')
})

test('a failed load, wrong ABI or malformed result rejects an otherwise authenticated bundle', () => {
  const f = fixture()
  for (const result of [{ code: 1, output: '' }, { code: 0, output: '{"moneroCorePlanSize":7536}' }, { code: 0, output: 'not a verifier response' }]) {
    expect(check(f.app, 'darwin-arm64', false, () => result).join()).toContain('required 7544-byte ABI')
  }
})

test('platforms without qualified native pins do not run a Monero probe or require optional artifacts', () => {
  for (const platform of ['darwin-x64', 'linux-x64']) {
    expect(check('/does/not/exist', platform, false, () => { throw new Error('Must not probe unsupported hosts') })).toEqual([])
  }
})

const project = resolve(import.meta.dir, '..'), realTools = join(project, 'monero-cli/vendor/darwin-arm64')
const realAdapter = verifiedHostAdapterIn(realTools, 'darwin-arm64'), realVerifier = join(project, 'monero-device-bundle/libmonero_core_verify.dylib')
test.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64' || !realAdapter || !checkRawMoneroCoreVerifier(realVerifier))('real reviewed native verifier loads through an isolated packaged Bun -e probe', () => {
  const f = fixture()
  copyFileSync(process.execPath, f.bun)
  copyFileSync(realAdapter!, f.adapter); copyFileSync(realVerifier, f.verifier)
  const realMetadata = JSON.parse(readFileSync(join(realTools, 'monero-tools.json'), 'utf8'))
  f.metadata.hostAdapterSha256 = realMetadata.hostAdapterSha256; f.metadata.hostAdapterRawSha256 = realMetadata.hostAdapterRawSha256; f.updateMetadata()
  expect(moneroReleaseAssetProblems(f.app, 'darwin-arm64')).toEqual([])
})
