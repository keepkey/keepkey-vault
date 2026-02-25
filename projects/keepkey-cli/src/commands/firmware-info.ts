import { getDevice } from '../device'

const RELEASES_URL =
  'https://raw.githubusercontent.com/keepkey/keepkey-desktop/master/firmware/releases.json'

interface ReleasesManifest {
  latest: {
    firmware: { version: string; url: string; hash: string }
    bootloader: { version: string; url: string; hash: string }
  }
  hashes: {
    bootloader: Record<string, string>
    firmware: Record<string, string>
  }
}

/** Convert base64 hash (from device features) to hex string (manifest format) */
function b64ToHex(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex')
}

/** Fetch the remote releases.json manifest */
async function fetchManifest(): Promise<ReleasesManifest | null> {
  try {
    const resp = await fetch(RELEASES_URL, { signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) return null
    return (await resp.json()) as ReleasesManifest
  } catch {
    return null
  }
}

export async function firmwareInfoCommand() {
  const { features } = await getDevice()

  const fwVersion = features.majorVersion
    ? `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
    : features.firmwareVersion || 'unknown'

  const blHashB64 = features.bootloaderHash || ''
  const fwHashB64 = features.firmwareHash || ''
  const blHashHex = blHashB64 ? b64ToHex(blHashB64) : ''
  const fwHashHex = fwHashB64 ? b64ToHex(fwHashB64) : ''

  console.log('KeepKey Firmware Diagnostic')
  console.log('═'.repeat(60))

  // --- Device info ---
  console.log('\n  Device')
  console.log('  ──────')
  console.log(`  Device ID:       ${features.deviceId || 'n/a'}`)
  console.log(`  Label:           ${features.label || '(none)'}`)
  console.log(`  Model:           ${features.model || 'KeepKey'}`)
  console.log(`  Variant:         ${features.firmwareVariant || 'unknown'}`)
  console.log(`  Bootloader mode: ${features.bootloaderMode ? 'YES' : 'no'}`)
  console.log(`  Initialized:     ${features.initialized ? 'yes' : 'no'}`)

  // --- Firmware ---
  console.log('\n  Firmware')
  console.log('  ────────')
  console.log(`  Version:         ${fwVersion}`)
  console.log(`  Hash (hex):      ${fwHashHex || 'n/a'}`)

  // --- Bootloader ---
  console.log('\n  Bootloader')
  console.log('  ──────────')
  console.log(`  Hash (hex):      ${blHashHex || 'n/a'}`)

  // --- Remote manifest comparison ---
  console.log('\n  Fetching remote manifest...')
  const manifest = await fetchManifest()

  if (!manifest) {
    console.log('  ⚠ Could not fetch releases.json — offline comparison skipped')
  } else {
    const latestFw = manifest.latest.firmware.version.replace(/^v/, '')
    const latestBl = manifest.latest.bootloader.version.replace(/^v/, '')

    // Bootloader lookup
    const blManifestVersion = blHashHex ? manifest.hashes.bootloader[blHashHex] : null
    const blSigned = !!blManifestVersion

    console.log('\n  Bootloader Analysis')
    console.log('  ───────────────────')
    if (blSigned) {
      console.log(`  Status:          ✓ SIGNED (official)`)
      console.log(`  Manifest match:  ${blManifestVersion}`)
    } else if (blHashHex) {
      console.log(`  Status:          ✗ NOT IN MANIFEST (unsigned/dev)`)
    } else {
      console.log(`  Status:          ? No hash available`)
    }
    console.log(`  Latest official: v${latestBl}`)
    if (blSigned && blManifestVersion !== `v${latestBl}`) {
      console.log(`  Update:          ${blManifestVersion} → v${latestBl} available`)
    } else if (blSigned) {
      console.log(`  Update:          Up to date`)
    }

    // Firmware lookup
    const fwManifestVersion = fwHashHex ? manifest.hashes.firmware[fwHashHex] : null
    const fwSigned = !!fwManifestVersion

    console.log('\n  Firmware Analysis')
    console.log('  ─────────────────')
    if (fwSigned) {
      console.log(`  Status:          ✓ SIGNED (official)`)
      console.log(`  Manifest match:  ${fwManifestVersion}`)
    } else if (fwHashHex) {
      console.log(`  Status:          ✗ NOT IN MANIFEST (unsigned/dev)`)
      console.log(`  Device reports:  v${fwVersion}`)
    } else {
      console.log(`  Status:          ? No hash available`)
    }
    console.log(`  Latest official: v${latestFw}`)

    // Version comparison (even for unsigned fw, compare version strings)
    const deviceParts = fwVersion.split('.').map(Number)
    const latestParts = latestFw.split('.').map(Number)
    const cmp =
      (deviceParts[0] - latestParts[0]) * 10000 +
      (deviceParts[1] - latestParts[1]) * 100 +
      (deviceParts[2] - latestParts[2])

    if (cmp > 0) {
      console.log(`  Note:            Device v${fwVersion} is AHEAD of latest release v${latestFw}`)
      if (!fwSigned) {
        console.log(`                   This confirms dev/unsigned firmware`)
      }
    } else if (cmp < 0 && fwSigned) {
      console.log(`  Update:          ${fwManifestVersion} → v${latestFw} available`)
    } else if (cmp === 0 && fwSigned) {
      console.log(`  Update:          Up to date`)
    }

    // --- Security policies ---
    const policies = features.policiesList || []
    if (policies.length > 0) {
      console.log('\n  Policies')
      console.log('  ────────')
      for (const p of policies) {
        console.log(`  ${p.policyName}: ${p.enabled ? 'enabled' : 'disabled'}`)
      }
    }
  }

  console.log('')
  process.exit(0)
}
