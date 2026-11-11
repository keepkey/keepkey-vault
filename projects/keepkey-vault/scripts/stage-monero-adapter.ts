#!/usr/bin/env bun
/** Stage the research signing adapter beside the verified wallet RPC and pin it in monero-tools.json. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--sha256' || !/^[0-9a-f]{64}$/.test(args[3])) {
  console.error('Usage: bun scripts/stage-monero-adapter.ts --source /path/to/monero-host-adapter --sha256 REVIEWED_SHA256')
  process.exit(2)
}
const source = resolve(args[1]), pin = args[3]
const info = lstatSync(source)
if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024) throw new Error('The adapter source must be a regular file')
const bytes = Uint8Array.from(readFileSync(source))
if (createHash('sha256').update(bytes).digest('hex') !== pin) throw new Error('The adapter does not match the reviewed SHA-256')

const tools = resolve(import.meta.dir, '../monero-cli/vendor', `${process.platform}-${process.arch}`)
const metadataPath = join(tools, 'monero-tools.json')
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
const target = join(tools, 'monero-host-adapter'), temporary = `${target}.stage-${process.pid}`
try {
  writeFileSync(temporary, bytes, { mode: 0o755, flag: 'wx' })
  renameSync(temporary, target)
} finally { rmSync(temporary, { force: true }) }
writeFileSync(metadataPath, JSON.stringify({ ...metadata, hostAdapterSha256: pin }, null, 2) + '\n')
console.log(JSON.stringify({ staged: true, path: target, sha256: pin }))
