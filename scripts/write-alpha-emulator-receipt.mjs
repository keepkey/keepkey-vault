#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alphaHead, FIRMWARE_REPOSITORY } from './alpha-emulator-source.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const runtime = JSON.parse(readFileSync(process.argv[3], 'utf8'))
if (runtime.version !== source.version) throw new Error('Emulator Features version differs from frozen firmware source')
if (source.repository !== FIRMWARE_REPOSITORY || source.branch !== 'alpha' || source.commit !== alphaHead()) {
  throw new Error('Fork alpha moved during certification; rebuild both libraries together')
}
const files = {}
const productionRoot = Buffer.from('027c1fde75db6c36393e095e0dc5ab9a5bcf1ae9eb92b5d36e212a2bf7f8a6e321', 'hex')
const testRoot = Buffer.from('02de9231b2094433235532fb1932e324a2c7304195e12e610c675cccbbd606dae7', 'hex')
for (const name of ['libkkemu.dylib', 'libkkemu.dll']) {
  const data = readFileSync(resolve(root, 'projects/keepkey-vault/emulator-bundle', name))
  if (!data.includes(productionRoot) || data.includes(testRoot)) throw new Error(`${name} has the wrong compiled ClearSign root`)
  files[name] = { sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
}
const receipt = { schema: 1, version: source.version, source, files,
  qualification: { macosArchitectures: ['arm64', 'x86_64'], macosMinimum: '13.0', windowsArchitecture: 'x86_64', pinTests: 'passed', clearSignRoot: 'production', reportedFirmwareVersion: runtime.version } }
writeFileSync(resolve(root, 'projects/keepkey-vault/emulator-bundle/source-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
