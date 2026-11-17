/** Build-only signing of a disposable copy. The final app signature seals the receipt. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkRawMoneroCoreVerifier, moneroCoreVerifierArtifact, moneroCoreVerifierReceipt, moneroCoreVerifierSha256, MONERO_CORE_VERIFIER_RECEIPT } from '../src/bun/monero-core-verifier-artifact'

export function stageSignedMoneroCoreVerifier(options: {
  source: string; directory: string; identity: string; platform?: string
  /** Fixture-only substitute: production uses codesign and verifies the resulting signature. */
  sign?: (path: string, identity: string) => void
}): { library: string; receipt: string } {
  const platform = options.platform ?? `${process.platform}-${process.arch}`, artifact = moneroCoreVerifierArtifact(platform)
  if (!artifact || !checkRawMoneroCoreVerifier(options.source, platform)) throw new Error('Signing requires the reviewed raw Monero Core verifier')
  const directory = resolve(options.directory), library = join(directory, artifact.filename), receipt = join(directory, MONERO_CORE_VERIFIER_RECEIPT)
  if (resolve(options.source) === library || (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) ||
      (existsSync(library) && lstatSync(library).isSymbolicLink()) || (existsSync(receipt) && lstatSync(receipt).isSymbolicLink())) {
    throw new Error('Monero Core signing requires a disposable regular output directory')
  }
  mkdirSync(directory, { recursive: true })
  copyFileSync(options.source, library)
  const sign = options.sign ?? ((path: string, identity: string) => {
    for (const args of [
      ['--force', '--verbose', '--timestamp', '--options', 'runtime', '--sign', identity, path],
      ['--verify', '--strict', path],
    ]) {
      const result = Bun.spawnSync(['codesign', ...args], { stdout: 'inherit', stderr: 'inherit' })
      if (result.exitCode !== 0) throw new Error('Monero Core verifier signing failed')
    }
  })
  sign(library, options.identity)
  writeFileSync(receipt, JSON.stringify(moneroCoreVerifierReceipt(moneroCoreVerifierSha256(library), platform), null, 2) + '\n', { mode: 0o644 })
  return { library, receipt }
}
