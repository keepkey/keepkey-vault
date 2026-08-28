#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(root, 'projects', 'keepkey-vault', 'emulator-bundle')
const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'))

if (manifest.version !== '7.16.0') throw new Error(`unexpected emulator release ${manifest.version}`)

for (const [name, record] of Object.entries(manifest.files)) {
  const path = join(bundleDir, name)
  if (!existsSync(path)) throw new Error(`missing certified emulator library: ${path}`)
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (digest !== record.sha256) throw new Error(`${name} SHA-256 mismatch: ${digest}`)
  console.log(`${name}: SHA-256 ${digest}`)
}

const dll = readFileSync(join(bundleDir, 'libkkemu.dll'))
const peOffset = dll.readUInt32LE(0x3c)
if (dll.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') throw new Error('libkkemu.dll is not a PE binary')
if (dll.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('libkkemu.dll is not x86_64')

if (process.platform === 'darwin') {
  const dylib = join(bundleDir, 'libkkemu.dylib')
  const arch = spawnSync('lipo', ['-archs', dylib], { encoding: 'utf8' })
  if (arch.status !== 0) throw new Error(`lipo failed: ${arch.stderr}`)
  for (const expected of manifest.files['libkkemu.dylib'].architectures) {
    if (!arch.stdout.split(/\s+/).includes(expected)) throw new Error(`libkkemu.dylib missing ${expected}`)
  }

  const symbols = spawnSync('nm', ['-gU', dylib], { encoding: 'utf8' })
  if (symbols.status !== 0) throw new Error(`nm failed: ${symbols.stderr}`)
  for (const symbol of manifest.requiredSymbols) {
    if (!symbols.stdout.includes(`_${symbol}`)) throw new Error(`libkkemu.dylib missing ${symbol}`)
  }
  console.log(`libkkemu.dylib architectures: ${arch.stdout.trim()}`)
}

console.log(`certified emulator ${manifest.version} verified`)
