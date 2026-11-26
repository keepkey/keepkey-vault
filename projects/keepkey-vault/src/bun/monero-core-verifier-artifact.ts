/** Hash-pinned Core verification artifact and its app-sealed signed-byte receipt. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { release } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import manifest from '../../monero-cli/core-verifier-manifest.json'

export const MONERO_CORE_VERIFIER_RECEIPT = 'core-verifier-receipt.json'
/** The macOS floor fields apply to darwin keys only. Windows and Linux pins carry no kernel floor:
 * os.release() there is 10.0.x or a Linux kernel version, never a Darwin major. */
export type MoneroCoreVerifierArtifact = { filename: string; sha256: string; size: number; minimumMacosVersion?: string; minimumDarwinMajor?: number }
export function moneroCoreVerifierArtifact(platform = `${process.platform}-${process.arch}`): MoneroCoreVerifierArtifact | null {
  return (manifest.files as Record<string, MoneroCoreVerifierArtifact>)[platform] ?? null
}
export function moneroCoreVerifierHostSupported(platform = `${process.platform}-${process.arch}`, kernelRelease = release()): boolean {
  const artifact = moneroCoreVerifierArtifact(platform)
  if (!artifact) return false
  if (!platform.startsWith('darwin-')) return true
  return typeof artifact.minimumDarwinMajor === 'number' && /^\d+\./.test(kernelRelease) &&
    Number(kernelRelease.split('.')[0]) >= artifact.minimumDarwinMajor
}
export function moneroCoreVerifierSha256(path: string): string {
  return createHash('sha256').update(new Uint8Array(readFileSync(path))).digest('hex')
}
// Windows reports every writable file as 0o666, so group/other write bits mean nothing there
// (the same exemption as host-adapter.ts, monero-sidecar.ts and monero-node.ts).
const unsafeMode = (mode: number) => process.platform !== 'win32' && !!(mode & 0o022)
function regular(path: string, maxSize: number): boolean {
  try { const s = lstatSync(path); return s.isFile() && !s.isSymbolicLink() && !unsafeMode(s.mode) && s.size > 0 && s.size <= maxSize } catch { return false }
}
export function checkRawMoneroCoreVerifier(path: string, platform = `${process.platform}-${process.arch}`): boolean {
  const artifact = moneroCoreVerifierArtifact(platform)
  return !!artifact && regular(path, artifact.size) && lstatSync(path).size === artifact.size && moneroCoreVerifierSha256(path) === artifact.sha256
}
export function moneroCoreVerifierReceipt(actualSha256: string, platform = `${process.platform}-${process.arch}`) {
  const artifact = moneroCoreVerifierArtifact(platform)
  if (!artifact || !/^[a-f0-9]{64}$/.test(actualSha256)) throw new Error('No reviewed Monero Core verifier for this platform')
  return { schemaVersion: 1, platform, filename: artifact.filename, sourceSha256: artifact.sha256, signedSha256: actualSha256 }
}
export function checkMoneroCoreVerifierReceipt(receipt: unknown, actualSha256: string, platform = `${process.platform}-${process.arch}`): boolean {
  const artifact = moneroCoreVerifierArtifact(platform), value = receipt as Record<string, unknown>
  const fields = ['schemaVersion', 'platform', 'filename', 'sourceSha256', 'signedSha256']
  return !!artifact && !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && Object.keys(value).every(k => fields.includes(k)) &&
    value.schemaVersion === 1 && value.platform === platform && value.filename === artifact.filename &&
    value.sourceSha256 === artifact.sha256 && value.signedSha256 === actualSha256 && /^[a-f0-9]{64}$/.test(actualSha256)
}

/** Build tooling verifies the outer seal itself before trusting a receipt. */
export function checkMoneroCoreVerifierDirectory(directory: string, platform = `${process.platform}-${process.arch}`, outerSealVerified = false): string | null {
  const artifact = moneroCoreVerifierArtifact(platform)
  if (!artifact) return null
  const path = join(directory, artifact.filename)
  if (checkRawMoneroCoreVerifier(path, platform)) return path
  try {
    if (!outerSealVerified || !regular(path, artifact.size + 1048576)) return null
    const receiptPath = join(directory, MONERO_CORE_VERIFIER_RECEIPT)
    if (!regular(receiptPath, 8192)) return null
    return checkMoneroCoreVerifierReceipt(JSON.parse(readFileSync(receiptPath, 'utf8')), moneroCoreVerifierSha256(path), platform) ? path : null
  } catch { return null }
}

/** Signed bytes qualify only at the fixed bundled location after the actual
 * outer app code signature verifies. A developer directory cannot self-attest. */
export function verifiedMoneroCoreVerifierFile(directory: string): string | null {
  if (!moneroCoreVerifierHostSupported()) return null
  const raw = checkMoneroCoreVerifierDirectory(directory)
  if (raw) return raw
  // Windows and Linux ship the reviewed raw bytes (raw-hash policy); only macOS has a
  // signed copy, accepted after codesign verifies the outer app seal.
  if (process.platform !== 'darwin') return null
  try {
    const bundled = resolve(import.meta.dir, '../monero-device')
    if (resolve(directory) !== bundled || realpathSync(directory) !== bundled) return null
    const app = resolve(import.meta.dir, '../../../..')
    if (!basename(app).endsWith('.app') || basename(dirname(resolve(import.meta.dir, '../..'))) !== 'Contents') return null
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'ignore', timeout: 15000 })
    return checkMoneroCoreVerifierDirectory(bundled, undefined, true)
  } catch { return null }
}
