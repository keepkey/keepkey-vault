/**
 * fw-715/00-capabilities.js — what the device claims to be. No presses.
 *
 * Cheap enough to run on every build. Catches a device that is not on 7.15,
 * and the policy state that makes other suites report false greens.
 */
const { run } = require('../_helpers')

/** The REST features payload reports the version as split integer fields.
 *  There is no dotted `version` string here — reading one yields undefined,
 *  which compares false against every bound and fails closed but for the wrong
 *  reason. */
function atLeast(f, major, minor, patch) {
  const a = Number(f.major_version), b = Number(f.minor_version), c = Number(f.patch_version)
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return false
  if (a !== major) return a > major
  if (b !== minor) return b > minor
  return c >= patch
}

run('fw-715 capabilities — device is on 7.15 and reports what 7.15 reports', async (getSdk, assert) => {
  const sdk = await getSdk()
  const f = await sdk.system.info.getFeatures()

  const version = `${f.major_version}.${f.minor_version}.${f.patch_version}`
  console.log(`\n  firmware:  ${version}`)
  console.log(`  variant:   ${f.firmware_variant || '(none)'}`)
  console.log(`  fw hash:   ${f.firmware_hash || '(none)'}`)
  console.log(`  taproot:   ${f.supports_taproot}`)
  console.log(`  policies:  ${(f.policies || []).map(p => `${p.policy_name}=${p.enabled}`).join(', ') || '(none)'}\n`)

  assert('firmware >= 7.15.0', atLeast(f, 7, 15, 0))
  assert('device is initialized', f.initialized === true)

  // #367 ships the manifest labelling; the device side of it is simply that a
  // firmware hash is reported at all. An all-zero hash means "no firmware
  // present" and must not read as a valid measurement.
  const hash = f.firmware_hash || ''
  assert('reports a firmware hash', hash.length > 0 && !/^0+$/.test(hash))

  // Taproot (BIP-86) landed in the 7.15 line. The flag is what the host uses to
  // decide whether to offer p2tr accounts at all.
  assert('reports Taproot support', f.supports_taproot === true)

  // Not a 7.15 feature — a testing hazard. With AdvancedMode ON the blind-sign
  // gate is disabled, so suites asserting "unknown contract is rejected" pass
  // only because a human pressed cancel. Fail here rather than let those suites
  // report green for the wrong reason.
  const adv = (f.policies || []).find(p => p.policy_name === 'AdvancedMode')
  assert('AdvancedMode is OFF (blind-sign gate active)', !adv || adv.enabled === false)
})
