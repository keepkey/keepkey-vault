import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkHostAdapterFile, hostAdapterArtifact, verifiedHostAdapterFile } from '../monero-cli/src/host-adapter'
import { ARCHIVE_HASHES } from '../monero-cli/src/tools'
import { MONERO_VERSION } from '../monero-cli/src/protocol'
import { checkMoneroCoreVerifierDirectory, moneroCoreVerifierArtifact } from '../src/bun/monero-core-verifier-artifact'

type Probe = (bun: string, verifier: string, appDirectory: string) => { code: number; output: string }
const PLAN_SIZE = 7544
// Windows reports writable files as 0o666; POSIX group/other bits are checked everywhere else.
const regular = (path: string, bound = 256 * 1024 * 1024) => {
  try { const s = lstatSync(path); return s.isFile() && !s.isSymbolicLink() && (process.platform === 'win32' || !(s.mode & 0o022)) && s.size > 0 && s.size <= bound } catch { return false }
}

/** Where each packaged file lives, per platform. macOS: <app>/Contents/Resources/app with Bun in
 * Contents/MacOS. Windows and Linux: <root>/Resources/app with Bun in <root>/bin. */
export function moneroBundleLayout(appDirectory: string, platform: string) {
  const windows = platform.startsWith('win32-'), exe = windows ? '.exe' : ''
  return {
    worker: join(appDirectory, `monero-cli${exe}`),
    walletRpc: `monero-wallet-rpc${exe}`,
    daemon: `monerod${exe}`,
    bun: platform.startsWith('darwin-') ? join(appDirectory, '..', '..', 'MacOS', 'bun') : join(appDirectory, '..', '..', 'bin', `bun${exe}`),
  }
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Load only the reviewed verifier with the Bun actually packed into this app.
 * No backend entry point, daemon, wallet or device operation is executed. */
const probeVerifier: Probe = (bun, verifier, appDirectory) => {
  const script = `import { dlopen, FFIType } from 'bun:ffi';
const library = dlopen(${JSON.stringify(verifier)}, {
  monero_core_verify: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  monero_core_plan_size: { args: [], returns: FFIType.u64 }
});
try { console.log(JSON.stringify({ moneroCorePlanSize: Number(library.symbols.monero_core_plan_size()) })); }
finally { library.close(); }`
  const windows = process.platform === 'win32'
  // NUL is the Windows null device. Bun on Windows needs SystemRoot to start; nothing else is passed.
  const result = Bun.spawnSync([bun, windows ? '--config=NUL' : '--config=/dev/null', '--no-env-file', '--no-install', '-e', script], {
    cwd: appDirectory, env: windows && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}, stdout: 'pipe', stderr: 'ignore', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 4096,
  })
  return { code: result.exitCode, output: result.stdout.toString().trim() }
}

/** Signed-byte receipts are accepted only after the caller verifies the outer
 * app seal. Platforms without qualified native pins do not advertise Monero. */
export function moneroReleaseAssetProblems(appDirectory: string, platform: string, outerSealVerified = false, probe: Probe = probeVerifier): string[] {
  const adapterArtifact = hostAdapterArtifact(platform), verifierArtifact = moneroCoreVerifierArtifact(platform)
  if (!adapterArtifact && !verifierArtifact) return []
  if (!adapterArtifact || !verifierArtifact) return ['Monero has an incomplete reviewed native artifact set for this platform']
  const problems: string[] = [], tools = join(appDirectory, 'monero-tools'), layout = moneroBundleLayout(appDirectory, platform)
  for (const path of [layout.worker, join(tools, layout.walletRpc), join(tools, layout.daemon),
    join(tools, 'HOST-ADAPTER-LICENSES.txt'), join(appDirectory, 'monero-device', 'LICENSES.txt')]) {
    if (!regular(path)) problems.push(`required Monero bundle input is missing or unsafe: ${path}`)
  }
  const metadata = join(tools, 'monero-tools.json'), adapter = join(tools, adapterArtifact.filename)
  try {
    if (!regular(metadata, 65536)) throw new Error()
    const value = JSON.parse(readFileSync(metadata, 'utf8'))
    if (value.version !== MONERO_VERSION || value.platform !== platform || value.archiveSha256 !== ARCHIVE_HASHES[platform] ||
      value.signerFingerprint !== '81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92' ||
      !['walletRpc', 'daemon'].every(field => /^[a-f0-9]{64}$/.test(value[`${field}Sha256`]) &&
        regular(join(tools, field === 'walletRpc' ? layout.walletRpc : layout.daemon)) &&
        sha(join(tools, field === 'walletRpc' ? layout.walletRpc : layout.daemon)) === value[`${field}Sha256`])) throw new Error()
  } catch { problems.push('Monero wallet RPC/node metadata does not authenticate the packaged tools') }
  if (!verifiedHostAdapterFile(adapter, metadata, platform) || (!checkHostAdapterFile(adapter, adapterArtifact) && !outerSealVerified)) {
    problems.push('Monero decoder is neither the reviewed raw artifact nor a signed copy authenticated by the verified outer app seal')
  }
  const verifier = checkMoneroCoreVerifierDirectory(join(appDirectory, 'monero-device'), platform, outerSealVerified)
  if (!verifier) problems.push('Monero Core verifier is neither the reviewed raw artifact nor a signed copy authenticated by the verified outer app seal')
  const bun = layout.bun
  if (!regular(bun)) problems.push('packaged Bun is missing or unsafe for the Monero verifier probe')
  if (problems.length === 0 && verifier) {
    try {
      const result = probe(bun, verifier, appDirectory)
      if (result.code !== 0 || result.output !== JSON.stringify({ moneroCorePlanSize: PLAN_SIZE })) throw new Error()
    } catch { problems.push('packaged Bun could not load the reviewed Monero Core verifier with the required 7544-byte ABI') }
  }
  return problems
}
