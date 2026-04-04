#!/usr/bin/env bun
/**
 * Download KeepKey emulator binaries for each channel.
 *
 * Each channel's manifest entry declares a source { repo, ref, type }.
 * This script resolves the exact commit SHA for the declared ref, then
 * looks for CI artifacts or release assets built from THAT specific commit.
 * If no matching artifact is found, it suggests a local build.
 *
 * Usage:
 *   bun firmware/download-emulators.ts                    # Download all channels
 *   bun firmware/download-emulators.ts --channel alpha    # Download alpha only
 *   bun firmware/download-emulators.ts --channel beta     # Download beta only
 *   bun firmware/download-emulators.ts --channel release  # Download release only
 *   bun firmware/download-emulators.ts --fresh            # Force re-download even if exists
 *   bun firmware/download-emulators.ts --status           # Show what's installed
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'

const FIRMWARE_DIR = dirname(import.meta.path)
const EMULATORS_DIR = join(FIRMWARE_DIR, 'emulators')
const MANIFEST_PATH = join(EMULATORS_DIR, 'manifest.json')

interface EmulatorSource {
  repo: string
  ref: string
  type: 'branch' | 'commit'
}

interface EmulatorEntry {
  version: string
  firmwareVersion: string
  channel: string
  arch: string
  platform: string
  dylib: string
  binary: string
  debugLink: boolean
  description: string
  source: EmulatorSource
}

interface EmulatorManifest {
  emulators: EmulatorEntry[]
  default: string
}

function loadManifest(): EmulatorManifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`)
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
}

/** Resolve the declared source ref to a full SHA. */
function resolveSourceSha(source: EmulatorSource): string {
  if (source.type === 'commit') {
    // Already a SHA — verify it exists
    try {
      const full = execSync(
        `gh api repos/${source.repo}/commits/${source.ref} --jq '.sha' 2>/dev/null`,
        { encoding: 'utf-8' }
      ).trim()
      return full
    } catch {
      throw new Error(`Commit ${source.ref.slice(0, 12)} not found in ${source.repo}`)
    }
  }

  // Branch ref — resolve to HEAD SHA
  try {
    return execSync(
      `gh api repos/${source.repo}/commits/${source.ref} --jq '.sha' 2>/dev/null`,
      { encoding: 'utf-8' }
    ).trim()
  } catch {
    throw new Error(`Branch ${source.ref} not found in ${source.repo}`)
  }
}

function getInstalledStatus(manifest: EmulatorManifest): void {
  console.log('\n=== Emulator Channel Status ===\n')
  for (const entry of manifest.emulators) {
    const channelDir = join(EMULATORS_DIR, entry.version)
    const dylibPath = join(EMULATORS_DIR, entry.dylib)
    const binaryPath = join(EMULATORS_DIR, entry.binary)
    const hasDylib = existsSync(dylibPath)
    const hasBinary = existsSync(binaryPath)
    const installed = hasDylib && hasBinary
    const icon = installed ? '✅' : '❌'

    console.log(`  ${icon} ${entry.channel.toUpperCase()} (${entry.version})`)
    console.log(`     ${entry.description}`)
    console.log(`     Source: ${entry.source.repo} @ ${entry.source.ref} (${entry.source.type})`)
    if (installed) {
      const stat = statSync(dylibPath)
      const buildShaPath = join(channelDir, '.build-sha')
      const buildSha = existsSync(buildShaPath)
        ? readFileSync(buildShaPath, 'utf-8').trim().slice(0, 12)
        : 'unknown'
      console.log(`     dylib: ${(stat.size / 1024 / 1024).toFixed(1)} MB, built from ${buildSha}, modified ${stat.mtime.toISOString().slice(0, 10)}`)
    } else {
      console.log(`     NOT INSTALLED — run: make build-emulator-${entry.channel}`)
    }
    console.log()
  }
  console.log(`  Default channel: ${manifest.default}`)
}

/**
 * Download emulator binaries for a channel.
 *
 * Strategy:
 * 1. Resolve the declared source ref to a commit SHA
 * 2. Check GitHub release assets tagged for that version
 * 3. Check CI workflow artifacts, filtered by the resolved SHA
 * 4. Fall back to local build suggestion
 */
async function downloadChannel(entry: EmulatorEntry, fresh: boolean): Promise<boolean> {
  const channelDir = join(EMULATORS_DIR, entry.version)
  const dylibPath = join(EMULATORS_DIR, entry.dylib)
  const binaryPath = join(EMULATORS_DIR, entry.binary)

  if (!fresh && existsSync(dylibPath) && existsSync(binaryPath)) {
    console.log(`  ⏭  ${entry.channel}: already installed (use --fresh to re-download)`)
    return true
  }

  mkdirSync(channelDir, { recursive: true })

  const { repo } = entry.source
  const platform = process.platform === 'darwin' ? 'macos' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const assetPattern = `emulator-${platform}-${arch}`

  try {
    // Step 1: Resolve source to exact SHA
    console.log(`  🔍 ${entry.channel}: resolving ${entry.source.type} ref ${entry.source.ref.slice(0, 12)}...`)
    const targetSha = resolveSourceSha(entry.source)
    console.log(`     Target SHA: ${targetSha.slice(0, 12)}`)

    // Step 2: Check release assets (tagged releases)
    const tag = `v${entry.firmwareVersion}`
    try {
      const releaseJson = execSync(
        `gh api repos/${repo}/releases/tags/${tag} --jq '{tag_name, target_commitish, assets: [.assets[] | {name, id}]}' 2>/dev/null`,
        { encoding: 'utf-8' }
      ).trim()

      if (releaseJson) {
        const release = JSON.parse(releaseJson)
        const matchingAsset = release.assets.find((a: any) => a.name.includes(assetPattern))
        if (matchingAsset) {
          // Verify the release was built from our target commit
          const releaseCommit = execSync(
            `gh api repos/${repo}/commits/${release.target_commitish} --jq '.sha' 2>/dev/null`,
            { encoding: 'utf-8' }
          ).trim()

          if (releaseCommit === targetSha) {
            console.log(`  📦 ${entry.channel}: downloading from release ${tag} (SHA match: ${targetSha.slice(0, 12)})...`)
            execSync(
              `gh release download ${tag} --repo ${repo} --pattern "${assetPattern}*" --dir "${channelDir}" --clobber`,
              { stdio: 'inherit' }
            )
            const tarball = join(channelDir, `${assetPattern}.tar.gz`)
            if (existsSync(tarball)) {
              execSync(`tar xzf "${tarball}" -C "${channelDir}"`)
              execSync(`rm -f "${tarball}"`)
            }
            if (existsSync(dylibPath) && existsSync(binaryPath)) {
              execSync(`chmod +x "${binaryPath}"`)
              writeFileSync(join(channelDir, '.build-sha'), targetSha + '\n')
              console.log(`  ✅ ${entry.channel}: installed from release (${targetSha.slice(0, 12)})`)
              return true
            }
          } else {
            console.log(`     Release ${tag} SHA mismatch: release=${releaseCommit.slice(0, 12)}, want=${targetSha.slice(0, 12)} — skipping`)
          }
        }
      }
    } catch {
      // No release found
    }

    // Step 3: Check CI artifacts, filtered by the target SHA
    console.log(`  🔍 ${entry.channel}: checking CI artifacts for SHA ${targetSha.slice(0, 12)}...`)
    try {
      // Find workflow artifacts that match our target SHA
      const artifactsJson = execSync(
        `gh api "repos/${repo}/actions/artifacts?name=${assetPattern}&per_page=20" --jq '[.artifacts[] | select(.expired == false) | {id, name, workflow_run: {head_sha: .workflow_run.head_sha, head_branch: .workflow_run.head_branch}}]' 2>/dev/null`,
        { encoding: 'utf-8' }
      ).trim()

      if (artifactsJson) {
        const artifacts = JSON.parse(artifactsJson)
        // Find an artifact whose workflow run was triggered by our target SHA
        const matching = artifacts.find((a: any) => a.workflow_run.head_sha === targetSha)

        if (matching) {
          console.log(`  📦 ${entry.channel}: downloading CI artifact (SHA: ${targetSha.slice(0, 12)}, branch: ${matching.workflow_run.head_branch})...`)
          execSync(
            `gh api "repos/${repo}/actions/artifacts/${matching.id}/zip" > "${channelDir}/artifact.zip" 2>/dev/null`
          )
          execSync(`cd "${channelDir}" && unzip -o artifact.zip && rm artifact.zip`)
          if (existsSync(dylibPath) && existsSync(binaryPath)) {
            execSync(`chmod +x "${binaryPath}"`)
            writeFileSync(join(channelDir, '.build-sha'), targetSha + '\n')
            console.log(`  ✅ ${entry.channel}: installed from CI artifact (${targetSha.slice(0, 12)})`)
            return true
          }
          console.log(`     Artifact extracted but expected binaries not found (${entry.dylib})`)
        } else {
          const shas = artifacts.map((a: any) => a.workflow_run.head_sha.slice(0, 12))
          console.log(`     No CI artifact matches SHA ${targetSha.slice(0, 12)}`)
          if (shas.length > 0) {
            console.log(`     Available artifact SHAs: ${shas.join(', ')}`)
          }
        }
      }
    } catch {
      // No CI artifacts
    }

    // Step 4: Fall back to local build
    console.log(`  ⚠️  ${entry.channel}: no pre-built binaries found for SHA ${targetSha.slice(0, 12)}`)
    console.log(`     Build locally with: make build-emulator-${entry.channel}`)
    return false

  } catch (err: any) {
    console.error(`  ❌ ${entry.channel}: ${err.message}`)
    return false
  }
}

// ── Main ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const channelFilter = args.includes('--channel')
  ? args[args.indexOf('--channel') + 1]
  : null
const fresh = args.includes('--fresh')
const statusOnly = args.includes('--status')

const manifest = loadManifest()

if (statusOnly) {
  getInstalledStatus(manifest)
  process.exit(0)
}

console.log('\n=== KeepKey Emulator Download ===\n')

const entries = channelFilter
  ? manifest.emulators.filter(e => e.channel === channelFilter)
  : manifest.emulators

if (entries.length === 0) {
  console.error(`No emulator entries found for channel: ${channelFilter}`)
  console.error(`Available channels: ${manifest.emulators.map(e => e.channel).join(', ')}`)
  process.exit(1)
}

// Filter by current platform/arch
const platformEntries = entries.filter(
  e => e.platform === process.platform && e.arch === process.arch
)

if (platformEntries.length === 0) {
  console.error(`No emulators available for ${process.platform}/${process.arch}`)
  process.exit(1)
}

let allOk = true
for (const entry of platformEntries) {
  const ok = await downloadChannel(entry, fresh)
  if (!ok) allOk = false
}

console.log()
if (allOk) {
  console.log('All requested emulators are ready.')
} else {
  console.log('Some emulators need to be built locally. See instructions above.')
  process.exit(1)
}
