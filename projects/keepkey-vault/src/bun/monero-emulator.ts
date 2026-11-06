import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let enabled = false

/** Exposes the separate research build; never selects or starts it. */
export function setMoneroEmulatorEnabled(value: boolean): void { enabled = value === true }
export function isMoneroEmulatorEnabled(): boolean { return enabled }

export interface MoneroEmulatorBuild {
  id: string
  path: string
  selected: boolean
  version: string
  label: string
  research: true
  monero: true
  /** Research signing (65000/65001) is compiled in; never shipped in signed releases. */
  signingEnabled: boolean
}

interface MoneroArtifact {
  filename: string
  sha256: string
  size: number
}

export interface MoneroEmulatorManifest {
  schemaVersion: 1
  label: string
  version: string
  research: true
  capabilities: string[]
  signingEnabled: boolean
  files: Record<string, MoneroArtifact>
}

/** Does not execute the library. Staging and runtime use the same byte pin. */
/** Signing research builds Desktop may sign with: reviewed artifacts only, pinned in code (a manifest on disk is not enough). */
export const REVIEWED_MONERO_SIGNING_SHA256 = new Set([
  '92079869551ab26ccd41d33ede1fe6c69735927e38a3203f932cdb37abe134f7', // firmware alpha 570e88356, self-contained relink
])

export function verifyMoneroEmulatorArtifact(
  bytes: Uint8Array,
  manifest: unknown,
  platform = process.platform as string,
  arch = process.arch as string,
): { manifest: MoneroEmulatorManifest; artifact: MoneroArtifact } {
  const data = manifest as MoneroEmulatorManifest | null
  // Receive-only and signing builds have disjoint capability sets and file names.
  const capabilities = data?.signingEnabled === true ? ['address', 'watch-key', 'key-image', 'sign'] : ['address', 'watch-key', 'key-image']
  if (!data || data.schemaVersion !== 1 || data.research !== true || typeof data.signingEnabled !== 'boolean' ||
      typeof data.label !== 'string' || !data.label || data.label.length > 120 ||
      typeof data.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.version) ||
      !Array.isArray(data.capabilities) || data.capabilities.length !== capabilities.length ||
      !capabilities.every(capability => data.capabilities.includes(capability))) {
    throw new Error('Invalid Monero research emulator manifest')
  }
  // Only the independently tested macOS ARM64 artifact is currently shipped.
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Monero research emulator is unavailable on this platform')
  const artifact = data.files?.[`${platform}-${arch}`]
  if (!artifact || artifact.filename !== moneroEmulatorFilename(data.signingEnabled) ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) ||
      artifact.size < 32 || artifact.size > 128 * 1024 * 1024 || bytes.length !== artifact.size ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error('Monero research emulator integrity check failed')
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (header.getUint32(0, true) !== 0xfeedfacf || header.getUint32(4, true) !== 0x0100000c ||
      header.getUint32(12, true) !== 6) throw new Error('Monero research emulator architecture is invalid')
  return { manifest: data, artifact }
}

export function moneroEmulatorFilename(signing: boolean): string {
  return signing ? 'libkkemu-monero-signing.dylib' : 'libkkemu-monero.dylib'
}
/** A bundle directory may hold the receive-only build, the signing build, or both. */
const SLOTS = [{ manifest: 'manifest.json', signing: false }, { manifest: 'signing-manifest.json', signing: true }]

export function moneroEmulatorBundleCandidates(importDir: string, cwd: string): string[] {
  const paths: string[] = []
  for (let depth = 0; depth <= 12; ++depth) {
    const parents = Array(depth).fill('..')
    paths.push(resolve(importDir, ...parents, 'monero-emulator'))
    paths.push(resolve(importDir, ...parents, 'monero-emulator-bundle'))
  }
  paths.push(resolve(cwd, 'monero-emulator-bundle'))
  paths.push(resolve(cwd, 'projects/keepkey-vault/monero-emulator-bundle'))
  return [...new Set(paths)]
}

/** A missing, corrupt or unsupported research artifact is never a fallback. */
export function bundledMoneroEmulatorBuilds(options: {
  importDir: string
  cwd?: string
  platform?: string
  arch?: string
  enabled?: boolean
  selectedId?: string | null
}): MoneroEmulatorBuild[] {
  if (!(options.enabled ?? enabled)) return []
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform !== 'darwin' || arch !== 'arm64') return []
  const builds: MoneroEmulatorBuild[] = []
  for (const slot of SLOTS) {
    for (const directory of moneroEmulatorBundleCandidates(options.importDir, options.cwd ?? process.cwd())) {
      try {
        const metadata = resolve(directory, slot.manifest)
        const metadataInfo = lstatSync(metadata)
        if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 65536) continue
        const manifest = JSON.parse(readFileSync(metadata, 'utf8')) as MoneroEmulatorManifest
        if (manifest?.signingEnabled !== slot.signing) continue
        const path = resolve(directory, moneroEmulatorFilename(slot.signing))
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) continue
        const verified = verifyMoneroEmulatorArtifact(Uint8Array.from(readFileSync(path)), manifest, platform, arch)
        builds.push({ id: verified.artifact.sha256, path, selected: options.selectedId === verified.artifact.sha256,
          version: verified.manifest.version, label: verified.manifest.label, research: true, monero: true, signingEnabled: slot.signing })
        break
      } catch { /* This candidate must not activate an unverified library. */ }
    }
  }
  return builds
}

/** Names a research build from its staged manifest without verifying or loading
 *  the library, so a build that can't start can still be named. Never a fallback. */
export function moneroEmulatorManifestFor(id: string, options: { importDir: string; cwd?: string }): { version: string; label: string } | null {
  for (const slot of SLOTS) {
    for (const directory of moneroEmulatorBundleCandidates(options.importDir, options.cwd ?? process.cwd())) {
      try {
        const metadata = resolve(directory, slot.manifest)
        const info = lstatSync(metadata)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) continue
        const manifest = JSON.parse(readFileSync(metadata, 'utf8')) as MoneroEmulatorManifest
        if (!Object.values(manifest?.files ?? {}).some(file => file?.sha256 === id)) continue
        if (typeof manifest.label !== 'string' || typeof manifest.version !== 'string') continue
        return { version: manifest.version, label: manifest.label }
      } catch { /* not this candidate */ }
    }
  }
  return null
}
