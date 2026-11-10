#!/usr/bin/env bun
/**
 * Wrapper around `electrobun build` that puts a quiet-zip shim on PATH.
 * This prevents ENOBUFS when the app bundle has many files (native node_modules).
 *
 * Electrobun's compiled Zig CLI uses Bun's execSync (1MB maxBuffer)
 * to run `zip -y -r -9 ...` which overflows when there are 13K+ files.
 * Our shim at scripts/zip adds -q (quiet) to suppress per-file output.
 */
import { join, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeZcashNu7Manifest } from './write-zcash-nu7-manifest'
import { verifyEmulatorBeforeSigning, writeEmulatorSigningReceipt } from './write-emulator-signing-receipt'

const env = process.argv[2] || 'stable'
const scriptsDir = join(import.meta.dir)
const currentPath = process.env.PATH || ''
let emulatorSource: string | undefined
let emulatorReceiptSource: string | undefined
let zcashSource: string | undefined

// Electrobun seals Resources but does not sign extensionless helpers there.
// Sign a disposable copy first, then hash the signed bytes before app sealing.
const zcashExecutable = process.platform === 'win32' ? 'zcash-cli.exe' : 'zcash-cli'
const zcashInput = resolve(import.meta.dir, '..', 'zcash-cli', 'target', 'release', zcashExecutable)
if (existsSync(zcashInput)) {
  let manifestBinary = zcashInput
  if (process.platform === 'darwin' && process.env.CI !== 'true') {
    const developer = process.env.ELECTROBUN_DEVELOPER_ID
    const team = process.env.ELECTROBUN_TEAMID
    if (!developer || !team) throw new Error('Developer ID and Team ID are required for the Zcash helper signature.')
    zcashSource = join('_build', '_signed_zcash', zcashExecutable)
    manifestBinary = resolve(import.meta.dir, '..', zcashSource)
    mkdirSync(resolve(import.meta.dir, '..', '_build', '_signed_zcash'), { recursive: true })
    copyFileSync(zcashInput, manifestBinary)
    const signed = Bun.spawnSync(['codesign', '--force', '--verbose', '--timestamp', '--options', 'runtime',
      '--sign', `Developer ID Application: ${developer} (${team})`, manifestBinary], { stdout: 'inherit', stderr: 'inherit' })
    if (signed.exitCode !== 0) process.exit(signed.exitCode ?? 1)
  }
  writeZcashNu7Manifest(manifestBinary)
}

// Stable/canary packages for supported emulator hosts must never silently ship
// without the pinned library. Developer `bun run build` remains optional.
if (process.platform === 'darwin' || process.platform === 'win32') {
  const lib = process.platform === 'win32' ? 'libkkemu.dll' : 'libkkemu.dylib'
  const staged = join(import.meta.dir, '..', 'emulator-bundle', lib)
  if (!existsSync(staged)) {
    console.error(`[release] Missing bundled emulator: ${staged}`)
    console.error('[release] Stage the certified emulator artifact with scripts/stage-certified-emulator.sh <artifact-dir>.')
    process.exit(1)
  }
  const reviewedSource = verifyEmulatorBeforeSigning(staged)

  // Apple notarization requires every embedded Mach-O to carry a timestamped
  // Developer ID signature. Verify-certified-emulator runs before this wrapper
  // in the release target, so sign a disposable copy and leave the immutable
  // certified artifact untouched for reproducible hash checks.
  if (process.platform === 'darwin' && process.env.CI !== 'true') {
    const developer = process.env.ELECTROBUN_DEVELOPER_ID
    const team = process.env.ELECTROBUN_TEAMID
    if (!developer || !team) {
      console.error('[release] ELECTROBUN_DEVELOPER_ID and ELECTROBUN_TEAMID are required for the emulator signature.')
      process.exit(1)
    }
    emulatorSource = join('_build', '_signed_emulator', lib)
    const signedCopy = join(import.meta.dir, '..', emulatorSource)
    mkdirSync(join(import.meta.dir, '..', '_build', '_signed_emulator'), { recursive: true })
    copyFileSync(staged, signedCopy)
    const signed = Bun.spawnSync([
      'codesign', '--force', '--verbose', '--timestamp', '--options', 'runtime',
      '--sign', `Developer ID Application: ${developer} (${team})`, signedCopy,
    ], { stdout: 'inherit', stderr: 'inherit' })
    if (signed.exitCode !== 0) process.exit(signed.exitCode ?? 1)
    writeEmulatorSigningReceipt(signedCopy, reviewedSource)
    emulatorReceiptSource = join('_build', '_signed_emulator', 'nu7-emulator-receipt.json')
  }
}

// CI's Monero builds require all inputs; legacy builds without the optional
// sidecar retain their existing packaging and show Monero as unavailable.
const moneroExecutable = process.platform === 'win32' ? 'monero-cli.exe' : 'monero-cli'
const moneroRpc = process.platform === 'win32' ? 'monero-wallet-rpc.exe' : 'monero-wallet-rpc'
const moneroDaemon = process.platform === 'win32' ? 'monerod.exe' : 'monerod'
const moneroInputs = [`monero-cli/dist/${moneroExecutable}`, `monero-cli/vendor/${process.platform}-${process.arch}/${moneroRpc}`, `monero-cli/vendor/${process.platform}-${process.arch}/${moneroDaemon}`, `monero-cli/vendor/${process.platform}-${process.arch}/monero-tools.json`, `monero-cli/vendor/${process.platform}-${process.arch}/LICENSE`]
const presentMoneroInputs = moneroInputs.filter(relative => existsSync(join(import.meta.dir, '..', relative)))
const hasMoneroInputs = presentMoneroInputs.length === moneroInputs.length
if ((process.env.KEEPKEY_REQUIRE_MONERO_SIDECAR === '1' || presentMoneroInputs.length > 0) && !hasMoneroInputs) {
  console.error('[release] Missing Monero sidecar input. Run bun run monero:prepare and bun run monero:build.')
  process.exit(1)
}

// Electrobun signs/notarizes before the later release re-signing pass. Stage
// Developer ID signed copies of both extensionless helpers first; changing the
// official RPC signature changes its bytes, so update only the copied receipt.
// The prepared vendor inputs remain immutable and the outer app seals metadata.
let signedMoneroSources: Record<string, string> = {}
if (hasMoneroInputs && process.platform === 'darwin' && process.env.CI !== 'true') {
  const developer = process.env.ELECTROBUN_DEVELOPER_ID
  const team = process.env.ELECTROBUN_TEAMID
  if (!developer || !team) {
    console.error('[release] Developer ID and Team ID are required for the Monero helper signatures.')
    process.exit(1)
  }
  const project = resolve(import.meta.dir, '..')
  const tools = join(project, 'monero-cli', 'vendor', `${process.platform}-${process.arch}`)
  const output = join(project, '_build', '_signed_monero')
  const staged = Bun.spawnSync(['python3', resolve(project, '../../scripts/monero-signing-metadata.py'), 'stage',
    '--worker', join(project, 'monero-cli/dist', moneroExecutable),
    '--rpc', join(tools, moneroRpc), '--metadata', join(tools, 'monero-tools.json'),
    '--daemon', join(tools, moneroDaemon),
    '--output', output, '--entitlements', join(project, 'entitlements.plist'),
    '--identity', `Developer ID Application: ${developer} (${team})`], { stdout: 'inherit', stderr: 'inherit' })
  if (staged.exitCode !== 0) process.exit(staged.exitCode ?? 1)
  signedMoneroSources = {
    KEEPKEY_MONERO_CLI_SOURCE: join(output, moneroExecutable),
    KEEPKEY_MONERO_RPC_SOURCE: join(output, moneroRpc),
    KEEPKEY_MONERO_METADATA_SOURCE: join(output, 'monero-tools.json'),
    KEEPKEY_MONERO_DAEMON_SOURCE: join(output, moneroDaemon),
  }
}

if (process.env.KEEPKEY_INCLUDE_MONERO_EMULATOR === '1') {
  console.error('[release] The Monero research emulator is a development artifact; its signing and deployment target are not release-certified.')
  process.exit(1)
}

const result = Bun.spawnSync(
  ['electrobun', 'build', `--env=${env}`],
  {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PATH: `${scriptsDir}:${currentPath}`,
      ...(emulatorSource ? { KEEPKEY_EMULATOR_SOURCE: emulatorSource } : {}),
      ...(emulatorReceiptSource ? { KEEPKEY_EMULATOR_RECEIPT_SOURCE: emulatorReceiptSource } : {}),
      ...(zcashSource ? { KEEPKEY_ZCASH_CLI_SOURCE: zcashSource } : {}),
      ...signedMoneroSources,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  }
)

if (result.exitCode !== 0) process.exit(result.exitCode ?? 1)

// Post-build: patch Bun bundler node:buffer bug in the electrobun output
const patch = Bun.spawnSync(
  ['bun', join(scriptsDir, 'patch-bundle.ts')],
  {
    cwd: join(import.meta.dir, '..'),
    stdout: 'inherit',
    stderr: 'inherit',
  }
)

process.exit(patch.exitCode ?? 1)
