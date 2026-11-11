import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledMoneroEmulatorBuilds, setMoneroEmulatorEnabled, verifyMoneroEmulatorArtifact } from './monero-emulator'
import { emulatorBuildFlashName, listEmulatorBuilds, resolveEmulatorLibPath, selectEmulatorBuild } from './emulator-library'

const temporary: string[] = []
afterEach(() => {
  setMoneroEmulatorEnabled(false)
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function signingFixture(f: ReturnType<typeof fixture>) {
  const bytes = f.bytes.slice(); bytes[40] = 1
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const manifest = { ...f.manifest, label: 'Monero signing (research)', capabilities: ['address', 'watch-key', 'key-image', 'sign'],
    signingEnabled: true, files: { 'darwin-arm64': { filename: 'libkkemu-monero-signing.dylib', sha256, size: bytes.length } } }
  const path = join(f.directory, 'libkkemu-monero-signing.dylib')
  writeFileSync(path, bytes)
  writeFileSync(join(f.directory, 'signing-manifest.json'), JSON.stringify(manifest))
  return { bytes, manifest, sha256, path }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'keepkey-monero-artifact-'))
  temporary.push(root)
  const directory = join(root, 'monero-emulator-bundle')
  mkdirSync(directory)
  const bytes = new Uint8Array(64)
  new DataView(bytes.buffer).setUint32(0, 0xfeedfacf, true)
  new DataView(bytes.buffer).setUint32(4, 0x0100000c, true)
  new DataView(bytes.buffer).setUint32(12, 6, true)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const manifest = { schemaVersion: 1, label: 'Monero receive-only (research)', version: '7.17.0',
    research: true, capabilities: ['address', 'watch-key', 'key-image'], signingEnabled: false,
    files: { 'darwin-arm64': { filename: 'libkkemu-monero.dylib', sha256, size: bytes.length } } }
  const path = join(directory, 'libkkemu-monero.dylib')
  writeFileSync(path, bytes)
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { root, directory, path, bytes, manifest, sha256,
    options: { importDir: join(root, 'bun'), cwd: '/absent', platform: 'darwin', arch: 'arm64' } }
}

describe('explicit Monero research emulator build', () => {
  test('stays hidden by default and advertises receive-only metadata only after opt-in', () => {
    const f = fixture()
    expect(bundledMoneroEmulatorBuilds(f.options)).toEqual([])
    setMoneroEmulatorEnabled(true)
    expect(bundledMoneroEmulatorBuilds(f.options)).toEqual([{ id: f.sha256, path: f.path, selected: false,
      version: '7.17.0', label: 'Monero receive-only (research)', research: true, monero: true, signingEnabled: false }])
    expect(bundledMoneroEmulatorBuilds({ ...f.options, enabled: false })).toEqual([])
  })

  test('checks exact bytes, architecture, capability limits and safe filename', () => {
    const f = fixture()
    expect(verifyMoneroEmulatorArtifact(f.bytes, f.manifest, 'darwin', 'arm64').artifact.sha256).toBe(f.sha256)
    const corrupt = new Uint8Array(f.bytes); corrupt[40] ^= 1
    expect(() => verifyMoneroEmulatorArtifact(corrupt, f.manifest, 'darwin', 'arm64')).toThrow('integrity')
    expect(() => verifyMoneroEmulatorArtifact(f.bytes, { ...f.manifest, signingEnabled: true }, 'darwin', 'arm64')).toThrow('manifest')
    expect(() => verifyMoneroEmulatorArtifact(f.bytes, { ...f.manifest, capabilities: ['address', 'watch-key', 'signing'] }, 'darwin', 'arm64')).toThrow('manifest')
    const traversal = structuredClone(f.manifest); traversal.files['darwin-arm64'].filename = '../libkkemu.dylib'
    expect(() => verifyMoneroEmulatorArtifact(f.bytes, traversal, 'darwin', 'arm64')).toThrow('integrity')
    expect(() => verifyMoneroEmulatorArtifact(f.bytes, f.manifest, 'darwin', 'x64')).toThrow('unavailable')
    expect(() => verifyMoneroEmulatorArtifact(f.bytes, f.manifest, 'win32', 'arm64')).toThrow('unavailable')
  })

  test('rejects corrupt and symlinked bundled artifacts without falling back to them', () => {
    const f = fixture()
    const other = join(f.root, 'other.dylib')
    writeFileSync(other, f.bytes)
    rmSync(f.path)
    symlinkSync(other, f.path)
    expect(bundledMoneroEmulatorBuilds({ ...f.options, enabled: true })).toEqual([])
    rmSync(f.path)
    writeFileSync(f.path, new Uint8Array(64))
    expect(bundledMoneroEmulatorBuilds({ ...f.options, enabled: true })).toEqual([])
  })

  test('adds a virtual build without installing or selecting it, preserving ordinary overrides', () => {
    const f = fixture()
    const home = join(f.root, 'home')
    const normal = join(home, '.keepkey/emulator/libkkemu.dylib')
    mkdirSync(join(home, '.keepkey/emulator'), { recursive: true })
    writeFileSync(normal, 'existing user override')
    expect(listEmulatorBuilds('darwin', home, { ...f.options, moneroEnabled: false })).toEqual([])
    expect(listEmulatorBuilds('darwin', home, { ...f.options, moneroEnabled: true }).map(build => build.id)).toEqual([f.sha256])
    expect(resolveEmulatorLibPath({ ...f.options, home, platform: 'darwin', moneroEnabled: true })).toBe(normal)
    expect(readFileSync(normal, 'utf8')).toBe('existing user override')
  })

  test('resolves only an explicitly selected verified build and uses its distinct flash name', () => {
    const f = fixture()
    const home = join(f.root, 'home')
    selectEmulatorBuild(f.sha256, home)
    const options = { ...f.options, home, platform: 'darwin' as const }
    expect(resolveEmulatorLibPath({ ...options, moneroEnabled: true })).toBe(f.path)
    expect(resolveEmulatorLibPath({ ...options, moneroEnabled: false })).toBeNull()
    expect(emulatorBuildFlashName(f.sha256)).toBe(`build-${f.sha256.slice(0, 16)}`)
    expect(emulatorBuildFlashName(f.sha256)).not.toBe('default')
    writeFileSync(f.path, 'tampered')
    expect(resolveEmulatorLibPath({ ...options, moneroEnabled: true })).toBeNull()
  })

  test('a bundle can hold the receive-only and the signing build; each is pinned by its own manifest', () => {
    const f = fixture(), signing = signingFixture(f)
    const builds = bundledMoneroEmulatorBuilds({ ...f.options, enabled: true })
    expect(builds.map(build => [build.label, build.signingEnabled, build.path])).toEqual([
      ['Monero receive-only (research)', false, f.path], ['Monero signing (research)', true, signing.path]])
    rmSync(f.path)
    expect(bundledMoneroEmulatorBuilds({ ...f.options, enabled: true }).map(build => build.id)).toEqual([signing.sha256])
    const home = join(f.root, 'home')
    selectEmulatorBuild(signing.sha256, home)
    expect(resolveEmulatorLibPath({ ...f.options, home, platform: 'darwin', moneroEnabled: true })).toBe(signing.path)
    expect(listEmulatorBuilds('darwin', home, { ...f.options, moneroEnabled: true })[0]).toMatchObject({ selected: true, signingEnabled: true })
  })

  test('signing capability, flag and file name must agree; a receive manifest never unlocks signing', () => {
    const f = fixture(), signing = signingFixture(f)
    expect(verifyMoneroEmulatorArtifact(signing.bytes, signing.manifest, 'darwin', 'arm64').manifest.signingEnabled).toBe(true)
    expect(() => verifyMoneroEmulatorArtifact(signing.bytes, { ...signing.manifest, capabilities: ['address', 'watch-key', 'key-image'] }, 'darwin', 'arm64')).toThrow('manifest')
    expect(() => verifyMoneroEmulatorArtifact(f.bytes, { ...f.manifest, capabilities: ['address', 'watch-key', 'key-image', 'sign'] }, 'darwin', 'arm64')).toThrow('manifest')
    expect(() => verifyMoneroEmulatorArtifact(signing.bytes, { ...signing.manifest, files: { 'darwin-arm64': { ...signing.manifest.files['darwin-arm64'], filename: 'libkkemu-monero.dylib' } } }, 'darwin', 'arm64')).toThrow('integrity')
    // A signing manifest in the receive slot (or the reverse) is ignored rather than trusted.
    writeFileSync(join(f.directory, 'manifest.json'), JSON.stringify(signing.manifest))
    writeFileSync(join(f.directory, 'signing-manifest.json'), JSON.stringify(f.manifest))
    expect(bundledMoneroEmulatorBuilds({ ...f.options, enabled: true })).toEqual([])
  })
})
