#!/usr/bin/env bun
/**
 * Download official KeepKey firmware binaries from GitHub.
 *
 * Usage:
 *   bun firmware/download.ts              # Download latest firmware + bootloader
 *   bun firmware/download.ts --sync       # Also update manifest.json from remote
 *   bun firmware/download.ts --version 7.10.0  # Download specific version
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'

const RELEASES_URL =
  'https://raw.githubusercontent.com/keepkey/keepkey-desktop/master/firmware/releases.json'
const FW_BASE_URL =
  'https://github.com/keepkey/keepkey-desktop/raw/master/firmware'

const FIRMWARE_DIR = dirname(import.meta.path)
const SIGNED_DIR = join(FIRMWARE_DIR, 'signed')
const MANIFEST_PATH = join(FIRMWARE_DIR, 'manifest.json')

interface RemoteManifest {
  latest: {
    firmware: { version: string; url: string; hash: string }
    bootloader: { version: string; url: string; hash: string }
  }
  hashes: {
    bootloader: Record<string, string>
    firmware: Record<string, string>
  }
}

async function fetchManifest(): Promise<RemoteManifest> {
  console.log('Fetching releases.json...')
  const resp = await fetch(RELEASES_URL)
  if (!resp.ok) throw new Error(`Failed to fetch manifest: ${resp.status}`)
  return resp.json() as Promise<RemoteManifest>
}

/**
 * KeepKey firmware files have a 256-byte header (magic "KPKY" + metadata).
 * The manifest SHA-256 hashes cover the PAYLOAD ONLY (after the 256-byte header),
 * which matches what the device stores and reports via features.firmwareHash.
 * Bootloader updater binaries do NOT have this header — hash the full file.
 */
const FIRMWARE_HEADER_SIZE = 256

function hashBinary(buf: Buffer, isFirmware: boolean): string {
  const payload = isFirmware && buf.length > FIRMWARE_HEADER_SIZE
    ? buf.subarray(FIRMWARE_HEADER_SIZE)
    : buf
  return createHash('sha256').update(payload).digest('hex')
}

async function downloadBinary(
  url: string,
  destPath: string,
  expectedHash: string,
  isFirmware: boolean,
): Promise<void> {
  if (existsSync(destPath)) {
    const existing = readFileSync(destPath)
    const hash = hashBinary(existing, isFirmware)
    if (hash === expectedHash) {
      console.log(`  Already exists and verified: ${destPath}`)
      return
    }
    console.log(`  Hash mismatch for existing file, re-downloading...`)
  }

  console.log(`  Downloading: ${url}`)
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${url}`)

  const buf = Buffer.from(await resp.arrayBuffer())
  const fullHash = createHash('sha256').update(buf).digest('hex')
  const payloadHash = hashBinary(buf, isFirmware)

  if (payloadHash !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch!\n  Expected (payload): ${expectedHash}\n  Got (payload):      ${payloadHash}\n  Got (full file):    ${fullHash}`,
    )
  }

  writeFileSync(destPath, buf)
  console.log(`  Saved: ${destPath} (${buf.length} bytes, payload SHA-256 verified)`)
}

function syncManifest(remote: RemoteManifest): void {
  const local: any = {
    $schema: './manifest-schema.json',
    _generated: `Synced from ${RELEASES_URL}`,
    _updated: new Date().toISOString().slice(0, 10),
    latest: {
      firmware: {
        version: remote.latest.firmware.version.replace(/^v/, ''),
        filename: `firmware-v${remote.latest.firmware.version.replace(/^v/, '')}.bin`,
        url: `${FW_BASE_URL}/${remote.latest.firmware.url}`,
        sha256: remote.latest.firmware.hash,
      },
      bootloader: {
        version: remote.latest.bootloader.version.replace(/^v/, ''),
        filename: `blupdater-v${remote.latest.bootloader.version.replace(/^v/, '')}.bin`,
        url: `${FW_BASE_URL}/${remote.latest.bootloader.url}`,
        sha256: remote.latest.bootloader.hash,
      },
    },
    bootloader_hashes: Object.fromEntries(
      Object.entries(remote.hashes.bootloader).map(([k, v]) => [k, v.replace(/^v/, '')]),
    ),
    firmware_hashes: Object.fromEntries(
      Object.entries(remote.hashes.firmware).map(([k, v]) => [k, v.replace(/^v/, '')]),
    ),
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(local, null, 2) + '\n')
  console.log(`Manifest updated: ${MANIFEST_PATH}`)
}

// --- Main ---
const args = process.argv.slice(2)
const doSync = args.includes('--sync')

const remote = await fetchManifest()

if (doSync) {
  syncManifest(remote)
}

mkdirSync(SIGNED_DIR, { recursive: true })

const fwVer = remote.latest.firmware.version.replace(/^v/, '')
const blVer = remote.latest.bootloader.version.replace(/^v/, '')

console.log(`\nLatest firmware:   v${fwVer}`)
console.log(`Latest bootloader: v${blVer}\n`)

// Download firmware (has 256-byte KPKY header — hash payload only)
const fwDest = join(SIGNED_DIR, `firmware-v${fwVer}.bin`)
const fwUrl = `${FW_BASE_URL}/${remote.latest.firmware.url}`
await downloadBinary(fwUrl, fwDest, remote.latest.firmware.hash, true)

// Download bootloader updater (no header — hash full file)
const blDest = join(SIGNED_DIR, `blupdater-v${blVer}.bin`)
const blUrl = `${FW_BASE_URL}/${remote.latest.bootloader.url}`
await downloadBinary(blUrl, blDest, remote.latest.bootloader.hash, false)

console.log('\nDone.')
