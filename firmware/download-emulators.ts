#!/usr/bin/env bun
/**
 * Download KeepKey emulator binaries for each channel.
 *
 * Emulator dylibs are built from the keepkey-firmware repo via CMake.
 * This script manages downloading pre-built emulator binaries from
 * GitHub release assets, or triggering local builds from the submodule.
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
  branch: string
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

interface ChannelInfo {
  description: string
  repo: string
  branch: string
  autoUpdate: boolean
}

interface EmulatorManifest {
  emulators: EmulatorEntry[]
  default: string
  channels: Record<string, ChannelInfo>
}

function loadManifest(): EmulatorManifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`)
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
}

function getInstalledStatus(manifest: EmulatorManifest): void {
  console.log('\n=== Emulator Channel Status ===\n')
  for (const entry of manifest.emulators) {
    const dylibPath = join(EMULATORS_DIR, entry.dylib)
    const binaryPath = join(EMULATORS_DIR, entry.binary)
    const hasDylib = existsSync(dylibPath)
    const hasBinary = existsSync(binaryPath)
    const installed = hasDylib && hasBinary
    const icon = installed ? '✅' : '❌'

    console.log(`  ${icon} ${entry.channel.toUpperCase()} (${entry.version})`)
    console.log(`     ${entry.description}`)
    console.log(`     Source: ${entry.source.repo} @ ${entry.source.branch}`)
    if (installed) {
      const stat = statSync(dylibPath)
      console.log(`     dylib: ${(stat.size / 1024 / 1024).toFixed(1)} MB, modified ${stat.mtime.toISOString().slice(0, 10)}`)
    } else {
      console.log(`     NOT INSTALLED — run: make download-emulator-${entry.channel}`)
    }
    console.log()
  }
  console.log(`  Default channel: ${manifest.default}`)
}

/**
 * Try to download emulator binaries from GitHub release assets.
 * Falls back to suggesting a local build if no release assets exist.
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

  // Try downloading from GitHub release assets
  const { repo, branch } = entry.source
  console.log(`  🔍 ${entry.channel}: checking ${repo} @ ${branch} for release assets...`)

  try {
    // Get the latest commit SHA on the branch
    const sha = execSync(
      `gh api repos/${repo}/commits/${branch} --jq '.sha' 2>/dev/null`,
      { encoding: 'utf-8' }
    ).trim().slice(0, 8)

    // Look for emulator release assets matching this platform/arch
    const platform = process.platform === 'darwin' ? 'macos' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

    // Check for a release tagged with this firmware version
    const tag = `v${entry.firmwareVersion}`
    const assetPattern = `emulator-${platform}-${arch}`

    try {
      const assets = execSync(
        `gh release view ${tag} --repo ${repo} --json assets --jq '.assets[].name' 2>/dev/null`,
        { encoding: 'utf-8' }
      ).trim()

      if (assets.includes(assetPattern)) {
        console.log(`  📦 ${entry.channel}: downloading from release ${tag}...`)
        execSync(
          `gh release download ${tag} --repo ${repo} --pattern "${assetPattern}*" --dir "${channelDir}" --clobber`,
          { stdio: 'inherit' }
        )
        // Extract if it's a tarball
        const tarball = join(channelDir, `${assetPattern}.tar.gz`)
        if (existsSync(tarball)) {
          execSync(`tar xzf "${tarball}" -C "${channelDir}"`)
          execSync(`rm -f "${tarball}"`)
        }
        if (existsSync(dylibPath) && existsSync(binaryPath)) {
          execSync(`chmod +x "${binaryPath}"`)
          console.log(`  ✅ ${entry.channel}: installed from release`)
          return true
        }
      }
    } catch {
      // No release found, that's ok
    }

    // No release assets — check for CI workflow artifacts
    console.log(`  🔍 ${entry.channel}: no release assets, checking CI artifacts...`)
    try {
      const artifactJson = execSync(
        `gh api "repos/${repo}/actions/artifacts?name=emulator-${platform}-${arch}&per_page=5" --jq '.artifacts[0] | {id, name, expired}' 2>/dev/null`,
        { encoding: 'utf-8' }
      ).trim()

      if (artifactJson && !artifactJson.includes('null')) {
        const artifact = JSON.parse(artifactJson)
        if (!artifact.expired) {
          console.log(`  📦 ${entry.channel}: downloading CI artifact ${artifact.name}...`)
          execSync(
            `gh api "repos/${repo}/actions/artifacts/${artifact.id}/zip" > "${channelDir}/artifact.zip" 2>/dev/null`
          )
          execSync(`cd "${channelDir}" && unzip -o artifact.zip && rm artifact.zip`)
          if (existsSync(dylibPath) && existsSync(binaryPath)) {
            execSync(`chmod +x "${binaryPath}"`)
            console.log(`  ✅ ${entry.channel}: installed from CI artifact`)
            return true
          }
        }
      }
    } catch {
      // No CI artifacts, that's ok
    }

    // Final fallback — prompt for local build
    console.log(`  ⚠️  ${entry.channel}: no pre-built binaries available`)
    console.log(`     Build locally with: make build-emulator-${entry.channel}`)
    console.log(`     This requires CMake + the firmware submodule`)
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
