#!/usr/bin/env bun
/** Check the Monero files of an assembled, unsigned-helper app (Windows and Linux build trees).
 * Usage: bun scripts/check-monero-bundle.ts <Resources/app directory> [--require]
 * --require fails when this platform has no reviewed native pins (KEEPKEY_REQUIRE_MONERO_SIDECAR=1). */
import { resolve } from 'node:path'
import { hostAdapterArtifact } from '../monero-cli/src/host-adapter'
import { moneroCoreVerifierArtifact } from '../src/bun/monero-core-verifier-artifact'
import { moneroReleaseAssetProblems } from './monero-release-assets'

const args = process.argv.slice(2)
const appDirectory = args.find(arg => !arg.startsWith('--'))
if (!appDirectory) throw new Error('Usage: bun scripts/check-monero-bundle.ts <Resources/app directory> [--require]')
const platform = `${process.platform}-${process.arch}`
const pinned = !!hostAdapterArtifact(platform) && !!moneroCoreVerifierArtifact(platform)
if (!pinned) {
  const message = `No reviewed Monero native pins for ${platform}; this build cannot offer Monero signing`
  if (args.includes('--require')) { console.error(`[monero-bundle] FAIL: ${message}`); process.exit(1) }
  console.log(`[monero-bundle] skip: ${message}`)
  process.exit(0)
}
const problems = moneroReleaseAssetProblems(resolve(appDirectory), platform)
for (const problem of problems) console.error(`[monero-bundle] FAIL: ${problem}`)
if (problems.length) process.exit(1)
console.log(`[monero-bundle] ok: reviewed Monero helpers load through the packaged Bun (${platform})`)
