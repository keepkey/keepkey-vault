#!/usr/bin/env bun
/** Stage the independently tested receive-only artifact without installing or selecting it. */
import { readFileSync, writeFileSync, mkdirSync, lstatSync, renameSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { verifyMoneroEmulatorArtifact } from '../src/bun/monero-emulator'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--source') {
  console.error('Usage: bun scripts/stage-monero-emulator.ts --source /path/to/tested/libkkemu.dylib')
  process.exit(2)
}

const source = resolve(args[1])
const bundle = resolve(import.meta.dir, '../monero-emulator-bundle')
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'))
const sourceInfo = lstatSync(source)
if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > 128 * 1024 * 1024) {
  throw new Error('The Monero emulator source must be a regular artifact file')
}
const bytes = Uint8Array.from(readFileSync(source))
const { artifact } = verifyMoneroEmulatorArtifact(bytes, manifest)
mkdirSync(bundle, { recursive: true })
const target = join(bundle, artifact.filename)
const temporary = `${target}.stage-${process.pid}`
try {
  writeFileSync(temporary, bytes, { mode: 0o755, flag: 'wx' })
  verifyMoneroEmulatorArtifact(Uint8Array.from(readFileSync(temporary)), manifest)
  renameSync(temporary, target)
} finally { rmSync(temporary, { force: true }) }
console.log(JSON.stringify({ staged: true, path: target, sha256: artifact.sha256,
  signingEnabled: false, installed: false, selected: false }))
