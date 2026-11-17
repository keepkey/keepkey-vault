#!/usr/bin/env bun
/** Stage a reviewed read-only decoder independently of the research signing emulator. No downloads. */
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkHostAdapterFile, hostAdapterArtifact, verifiedHostAdapterIn } from '../monero-cli/src/host-adapter'

export function stageMoneroAdapter(options: { source?: string; directory: string; sha256?: string; platform?: string; ifAvailable?: boolean }): { staged: boolean; path?: string; sha256?: string; reason?: string } {
  const platform = options.platform ?? `${process.platform}-${process.arch}`
  const artifact = hostAdapterArtifact(platform)
  if (!artifact) {
    if (options.ifAvailable && !options.source) return { staged: false, reason: `No reviewed adapter for ${platform}` }
    throw new Error(`No reviewed Monero host adapter for ${platform}`)
  }
  if (options.sha256 !== undefined && options.sha256 !== artifact.sha256) throw new Error('The requested adapter hash is not the reviewed platform pin')
  const directory = resolve(options.directory), target = join(directory, artifact.filename)
  const source = options.source ? resolve(options.source) : target
  if (!checkHostAdapterFile(source, artifact)) {
    // Optional means absent, never corrupt or an explicitly supplied wrong artifact.
    let absent = false
    try { lstatSync(source) } catch (error: any) { absent = error?.code === 'ENOENT' }
    if (options.ifAvailable && !options.source && absent) return { staged: false, reason: 'Reviewed Monero host adapter is not staged' }
    throw new Error('The Monero host adapter does not match the reviewed bytes and permissions')
  }
  const metadataPath = join(directory, 'monero-tools.json'), stat = lstatSync(metadataPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid Monero tools metadata file')
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  if (metadata.version !== '0.18.5.4' || metadata.platform !== platform) throw new Error('The adapter requires matching pinned Monero wallet tools')
  const binaryTemporary = `${target}.stage-${process.pid}`, metadataTemporary = `${metadataPath}.stage-${process.pid}`
  try {
    if (source !== target) {
      writeFileSync(binaryTemporary, readFileSync(source), { mode: 0o755, flag: 'wx' })
      if (!checkHostAdapterFile(binaryTemporary, artifact)) throw new Error('Staged Monero host adapter failed verification')
      renameSync(binaryTemporary, target)
    }
    writeFileSync(metadataTemporary, JSON.stringify({ ...metadata, hostAdapterSha256: artifact.sha256, hostAdapterRawSha256: artifact.sha256 }, null, 2) + '\n', { mode: 0o644, flag: 'wx' })
    renameSync(metadataTemporary, metadataPath)
  } finally {
    rmSync(binaryTemporary, { force: true }); rmSync(metadataTemporary, { force: true })
  }
  if (verifiedHostAdapterIn(directory, platform) !== target) throw new Error('Installed Monero host adapter failed verification')
  return { staged: true, path: target, sha256: artifact.sha256 }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let source = process.env.KEEPKEY_MONERO_HOST_ADAPTER_SOURCE || undefined
  let directory = resolve(dirname(fileURLToPath(import.meta.url)), '../monero-cli/vendor', `${process.platform}-${process.arch}`)
  let sha256: string | undefined, ifAvailable = false
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i]
    if (arg === '--if-available') ifAvailable = true
    else if (arg === '--require') ifAvailable = false
    else if (['--source', '--directory', '--sha256'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i]
      if (arg === '--source') source = value
      else if (arg === '--directory') directory = resolve(value)
      else sha256 = value
    } else throw new Error('Usage: bun scripts/stage-monero-adapter.ts [--source FILE] [--sha256 REVIEWED_SHA256] [--directory TOOLS] [--if-available|--require]')
  }
  console.log(JSON.stringify(stageMoneroAdapter({ source, directory, sha256, ifAvailable })))
}
