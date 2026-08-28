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
import { existsSync } from 'node:fs'

const env = process.argv[2] || 'stable'
const scriptsDir = join(import.meta.dir)
const currentPath = process.env.PATH || ''

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
}

const result = Bun.spawnSync(
  ['electrobun', 'build', `--env=${env}`],
  {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PATH: `${scriptsDir}:${currentPath}`,
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
