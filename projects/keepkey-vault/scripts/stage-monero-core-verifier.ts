#!/usr/bin/env bun
/** Stage only the exact reviewed verifier. No signing, downloads, or device access. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkRawMoneroCoreVerifier, moneroCoreVerifierArtifact } from '../src/bun/monero-core-verifier-artifact'

export function stageMoneroCoreVerifier(options: { source: string; directory: string; platform?: string }): string {
  const platform = options.platform ?? `${process.platform}-${process.arch}`, artifact = moneroCoreVerifierArtifact(platform)
  if (!artifact) throw new Error(`No reviewed Monero Core verifier for ${platform}`)
  const source = resolve(options.source), directory = resolve(options.directory), target = join(directory, artifact.filename)
  if (!checkRawMoneroCoreVerifier(source, platform)) throw new Error('The Monero Core verifier does not match its reviewed bytes or permissions')
  if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error('The verifier output must be a regular directory')
  mkdirSync(directory, { recursive: true })
  if (source !== target) {
    const temporary = `${target}.stage-${process.pid}`
    try {
      copyFileSync(source, temporary)
      if (!checkRawMoneroCoreVerifier(temporary, platform)) throw new Error('The staged verifier failed verification')
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
  }
  return target
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let source = process.env.KEEPKEY_MONERO_CORE_VERIFIER_SOURCE ?? '', directory = resolve(import.meta.dir, '../monero-device-bundle')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1]) source = args[++i]
    else if (args[i] === '--directory' && args[i + 1]) directory = resolve(args[++i])
    else throw new Error('Usage: bun scripts/stage-monero-core-verifier.ts --source REVIEWED_DYLIB [--directory DIRECTORY]')
  }
  if (!source) throw new Error('Supply the reviewed Monero Core verifier explicitly')
  console.log(stageMoneroCoreVerifier({ source, directory }))
}
