#!/usr/bin/env bun
/**
 * Wrapper around `electrobun build` that puts a quiet-zip shim on PATH.
 * This prevents ENOBUFS when the app bundle has many files (native node_modules).
 *
 * Electrobun's compiled Zig CLI uses Bun's execSync (1MB maxBuffer)
 * to run `zip -y -r -9 ...` which overflows when there are 13K+ files.
 * Our shim at scripts/zip adds -q (quiet) to suppress per-file output.
 */
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'

const env = process.argv[2] || 'stable'
const scriptsDir = join(import.meta.dir)
const currentPath = process.env.PATH || ''
let emulatorSource: string | undefined

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
  }
}

const result = Bun.spawnSync(
  ['electrobun', 'build', `--env=${env}`],
  {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PATH: `${scriptsDir}:${currentPath}`,
      ...(emulatorSource ? { KEEPKEY_EMULATOR_SOURCE: emulatorSource } : {}),
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
