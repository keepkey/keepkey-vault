import { createHash } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { MONERO_VERSION, parseExactJson } from './protocol'

let versionProbe: ReturnType<typeof Bun.spawn> | null = null
export function stopToolVersionProbe(): void {
  if (versionProbe && versionProbe.exitCode === null) versionProbe.kill('SIGKILL')
  versionProbe = null
}

export const ARCHIVE_HASHES: Record<string, string> = {
  'darwin-arm64': 'd457de7c8a1ad42e3232fdea6d9f9003be9652143fb8f719c1fc906aa6b4917b',
  'darwin-x64': '9fefa7f5f7ae60fbd8d0ad18842b76c56ed161eca4ffb4f8b5f4800e5033b146',
  'linux-arm64': 'd20d71e6522b41eb8e549c3425f7f4622c9c9a448fc7147525393fd0a6b59703',
  'linux-x64': 'ba2928962c101b609434bf8c1b43ad59ebe96c5525977284ca599d8bf0f02d10',
  'win32-x64': '1ccac3b476ba75bf6dfdfa848f6520a79b64cdf3457a160eaa0dad82d5a2a042',
}

/** Runtime verifies the binary extracted by the signed-release preparation step. */
export async function verifiedWalletRpc(): Promise<string> {
  const platform = `${process.platform}-${process.arch}`, archiveHash = ARCHIVE_HASHES[platform]
  if (!archiveHash) throw new Error('This platform has no pinned official Monero wallet RPC')
  const name = process.platform === 'win32' ? 'monero-wallet-rpc.exe' : 'monero-wallet-rpc'
  const candidates = process.env.MONERO_TOOLS_DIR ? [resolve(process.env.MONERO_TOOLS_DIR)] : [
    join(dirname(process.execPath), 'monero-tools'), dirname(process.execPath), resolve(dirname(process.execPath), '../vendor', platform), resolve(import.meta.dir, '../vendor', platform),
    resolve(import.meta.dir, '../../..'), resolve(import.meta.dir, '../../../..'),
  ]
  for (const directory of candidates) {
    try {
      const info = JSON.parse(await readFile(join(directory, 'monero-tools.json'), 'utf8'))
      if (info.version !== MONERO_VERSION || info.platform !== platform || info.archiveSha256 !== archiveHash ||
          info.signerFingerprint !== '81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92' ||
          !/^[0-9a-f]{64}$/.test(info.walletRpcSha256)) continue
      const binary = join(directory, name), file = await lstat(binary)
      if (!file.isFile() || file.isSymbolicLink() || file.size > 256 * 1024 * 1024 ||
          (process.platform !== 'win32' && (file.mode & 0o022))) continue
      if (createHash('sha256').update(new Uint8Array(await readFile(binary))).digest('hex') !== info.walletRpcSha256) continue
      const child = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
      versionProbe = child
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000)
      let output: string, exit: number
      try { output = await new Response(child.stdout).text(); exit = await child.exited }
      finally { clearTimeout(timeout); if (versionProbe === child) versionProbe = null }
      if (exit === 0 && output.includes(`v${MONERO_VERSION}-release`)) return binary
    } catch { /* Try only known bundle locations; no runtime downloads. */ }
  }
  throw new Error('Verified Monero wallet RPC is unavailable; prepare the pinned host tools during the build')
}

/** Research signing adapter beside the verified wallet RPC, pinned by `hostAdapterSha256` in the same metadata. */
export async function verifiedHostAdapter(walletRpc: string): Promise<string | null> {
  try {
    const directory = dirname(walletRpc)
    const info = JSON.parse(await readFile(join(directory, 'monero-tools.json'), 'utf8'))
    if (typeof info.hostAdapterSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(info.hostAdapterSha256)) return null
    const binary = join(directory, process.platform === 'win32' ? 'monero-host-adapter.exe' : 'monero-host-adapter'), file = await lstat(binary)
    if (!file.isFile() || file.isSymbolicLink() || file.size > 256 * 1024 * 1024 || (process.platform !== 'win32' && (file.mode & 0o022))) return null
    return createHash('sha256').update(new Uint8Array(await readFile(binary))).digest('hex') === info.hostAdapterSha256 ? binary : null
  } catch { return null }
}

/** One JSON request on stdin, one bounded JSON reply on stdout. Credentials never reach argv; stderr is discarded. */
export async function runHostAdapter(binary: string, request: Record<string, string>): Promise<any> {
  const child = Bun.spawn([binary], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: {} })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60000)
  try {
    child.stdin.write(JSON.stringify(request)); await child.stdin.end()
    const reader = child.stdout.getReader(), chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      size += value.length
      if (size > 4 * 1024 * 1024) { child.kill('SIGKILL'); throw new Error('Monero adapter reply exceeds its bound') }
      chunks.push(value)
    }
    const exit = await child.exited
    const reply = parseExactJson(Buffer.concat(chunks).toString('utf8'))
    if (exit !== 0 || reply?.status !== 'pass') throw new Error('The Monero adapter refused the wallet data')
    return reply
  } finally { clearTimeout(timeout); request.view_key = '' }
}
