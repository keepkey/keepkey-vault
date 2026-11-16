/** The read-only Core decoder has its own provenance, independent of emulator firmware. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import manifest from '../host-adapter-manifest.json'

export interface HostAdapterArtifact { filename: string; sha256: string; size: number }
export const HOST_ADAPTER_PROTOCOL = manifest.protocol

export function hostAdapterArtifact(platform = `${process.platform}-${process.arch}`): HostAdapterArtifact | undefined {
  return (manifest.files as Record<string, HostAdapterArtifact>)[platform]
}

/** Validate bytes without executing them. A caller-supplied path never supplies its own trust pin. */
export function checkHostAdapterFile(path: string, artifact: HostAdapterArtifact): boolean {
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size || info.size > 256 * 1024 * 1024 ||
        (process.platform !== 'win32' && (info.mode & 0o022))) return false
    return createHash('sha256').update(new Uint8Array(readFileSync(path))).digest('hex') === artifact.sha256
  } catch { return false }
}

/** Signing changes the hash. The app signature seals this receipt and the current
 * bytes together, exactly as for wallet RPC; the JSON is not its own trust root. */
export function verifiedHostAdapterFile(path: string, metadataPath: string, platform = `${process.platform}-${process.arch}`): string | null {
  const artifact = hostAdapterArtifact(platform)
  if (!artifact) return null
  try {
    const stat = lstatSync(metadataPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return null
    const info = JSON.parse(readFileSync(metadataPath, 'utf8'))
    const runtimeHash = info.hostAdapterSha256
    if (info.version !== manifest.moneroVersion || info.platform !== platform ||
        typeof runtimeHash !== 'string' || !/^[0-9a-f]{64}$/.test(runtimeHash) ||
        (info.hostAdapterRawSha256 ?? runtimeHash) !== artifact.sha256) return null
    const size = runtimeHash === artifact.sha256 ? artifact.size : lstatSync(path).size
    return checkHostAdapterFile(path, { ...artifact, size, sha256: runtimeHash }) ? path : null
  } catch { return null }
}

/** Both packaging and the worker use the same review pin and sealed runtime receipt. */
export function verifiedHostAdapterIn(directory: string, platform = `${process.platform}-${process.arch}`): string | null {
  const artifact = hostAdapterArtifact(platform)
  return artifact ? verifiedHostAdapterFile(join(directory, artifact.filename), join(directory, 'monero-tools.json'), platform) : null
}
