/**
 * Validate ONDEVICE_FIRMWARE_HASHES against the published GitHub releases.
 *
 * Every constant in that table is a security claim: "a device reporting this
 * hash is running release vX.Y.Z". A reviewer is entitled to ask where the
 * number came from, and "someone pasted it" is not an answer. This script is
 * the answer -- it downloads each release asset and recomputes the hash.
 *
 * The convention is the FULL-FILE sha256 of firmware.keepkey.bin, because the
 * device's memory_firmware_hash() covers the whole 256-byte meta descriptor
 * (FLASH_META_DESC_LEN = 0x100) plus the app code.
 *
 * Do not confuse it with the PAYLOAD hash (tail -c +257), which exists for a
 * different comparison: a local reproducible build against the signed release,
 * where the local build has no signatures to hash. v7.14.1's published
 * HASHES.txt labelled the payload hash "matches device-verifiable build hash",
 * which is wrong and cost real debugging time. Current release.yml emits
 * neutral "sha256 (full)" / "sha256 (payload)" labels -- still ambiguous,
 * since neither states which comparison it is for.
 *
 * The table must stay 100% verifiable: 0 unverifiable rows is the target, not
 * a nice-to-have. A row nobody can recompute can only ever bless firmware that
 * is not what it claims -- that is how the phantom v7.9.0 entry survived.
 *
 * The table must stay 100% verifiable: 0 unverifiable rows is the target, not
 * a nice-to-have. A row nobody can recompute can only ever bless firmware
 * that is not what it claims -- that is how a phantom v7.9.0 entry survived
 * for a year.
 *
 * NOT COVERED YET: the bitcoin-only variant. release.yml builds it as a
 * separate matrix entry with its own suffixed assets, so it is a parallel
 * lineage with its own hashes and ONDEVICE_FIRMWARE_HASHES has none of them.
 * Until they are pinned, every btc-only device reads as unrecognised.
 *
 * Usage: bun scripts/verify-firmware-hashes.ts
 * Exit 1 on any mismatch so CI can gate on it.
 */
import { createHash } from 'node:crypto'
import { ONDEVICE_FIRMWARE_HASHES, versionCompare } from '../src/shared/firmware-versions'

const RELEASE = 'https://github.com/keepkey/keepkey-firmware/releases/download'
// Two lineages ship per release: the default build and the bitcoin-only
// variant, published by release.yml with a `-bitcoin-only` suffix. They are
// different binaries with different hashes, so both need pinning. The suffix
// allowlist stays explicit so unsigned in-house builds (-zcash, -solana) are
// not mistaken for a release lineage.
const OFFICIAL = /^v\d+\.\d+\.\d+(-bitcoin-only)?$/
const BTC_SUFFIX = '-bitcoin-only'

/** Split a pinned tag into its numeric version and variant suffix. */
function splitTag(tag: string): { semver: string; suffix: string } {
  const suffix = tag.endsWith(BTC_SUFFIX) ? BTC_SUFFIX : ''
  return { semver: tag.slice(1, tag.length - suffix.length), suffix }
}

// No btc-only row exists until 7.15 signs one, so the suffix path above is
// otherwise dead code until the day it matters. Pin its behaviour now.
{
  const btc = splitTag('v7.15.0-bitcoin-only')
  const plain = splitTag('v7.14.1')
  if (btc.semver !== '7.15.0' || btc.suffix !== BTC_SUFFIX ||
      plain.semver !== '7.14.1' || plain.suffix !== '') {
    throw new Error('splitTag is broken; btc-only asset URLs would be wrong')
  }
}

const expected = new Map<string, string>()  // version -> pinned hash
for (const [hash, version] of Object.entries(ONDEVICE_FIRMWARE_HASHES)) {
  if (!OFFICIAL.test(version)) continue  // unsigned in-house builds have no release
  if (expected.has(version)) {
    console.error(`DUPLICATE: ${version} pinned twice`)
    process.exitCode = 1
  }
  expected.set(version, hash)
}

let ok = 0
const bad: string[] = []
const skipped: string[] = []

for (const [version, pinned] of expected) {
  const { semver, suffix } = splitTag(version)
  // Asset naming changed: older releases ship `firmware.keepkey.bin`, the
  // current release.yml renames to `firmware.keepkey.v{VER}{SUFFIX}.bin`. Try
  // both rather than calling the releases API, which rate-limits
  // unauthenticated callers at 60/hour -- fewer than the rows in this table.
  const candidates = suffix
    ? [`${RELEASE}/v${semver}/firmware.keepkey.v${semver}${suffix}.bin`]
    : [
        `${RELEASE}/v${semver}/firmware.keepkey.bin`,
        `${RELEASE}/v${semver}/firmware.keepkey.v${semver}.bin`,
      ]
  let res: Response | undefined
  for (const url of candidates) {
    const r = await fetch(url)
    if (r.ok) { res = r; break }
  }
  if (!res) {
    // A release with no recoverable asset is unverifiable here, not proven
    // wrong. Report it rather than counting it as a pass.
    skipped.push(`${version} (no asset found)`)
    continue
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')

  if (actual === pinned) {
    ok++
    console.log(`  ok   ${version}  ${actual}`)
  } else {
    bad.push(version)
    console.error(`  FAIL ${version}`)
    console.error(`       pinned ${pinned}`)
    console.error(`       actual ${actual}`)
    const payload = createHash('sha256').update(bytes.subarray(256)).digest('hex')
    if (payload === pinned) {
      console.error(`       ^ pinned value is the PAYLOAD hash, not the full file`)
    }
  }
}

// Validating the rows that exist says nothing about a release that has no row
// at all -- and that is the failure waiting to happen, since a new firmware
// release does not touch this repo. Without this check the table silently goes
// stale on release day and every updated device reads as unrecognised.
//
// Needs a token for the API's 60/hour unauthenticated limit; CI has one. A
// local run without one skips the check rather than reporting a false all-clear.
const token = process.env.GITHUB_TOKEN
if (token) {
  const res = await fetch(
    'https://api.github.com/repos/keepkey/keepkey-firmware/releases?per_page=100',
    { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } },
  )
  if (res.ok) {
    const releases = (await res.json()) as Array<{
      tag_name: string
      draft: boolean
      prerelease: boolean
      assets: Array<{ name: string }>
    }>
    // Floor the check at the oldest version we pin. The repo has releases back
    // to v1.0.3 that this table has never claimed to cover, and flagging 25 of
    // them every run would train everyone to ignore the check -- which costs
    // more than the coverage it pretends to add. The floor moves itself: pin an
    // older version and it widens automatically.
    const floor = [...expected.keys()]
      .map((v) => splitTag(v).semver)
      .sort(versionCompare)[0]

    const unpinned: string[] = []
    for (const r of releases) {
      // A release with no .bin asset was withdrawn -- v7.1.5 is tagged but
      // publishes nothing ("superceded by v7.1.7"). Nothing to flash, nothing
      // to hash, so it is not a coverage gap. The releases list already
      // carries assets, so this costs no extra request.
      if (r.draft || r.prerelease) continue
      if (!/^v\d+\.\d+\.\d+$/.test(r.tag_name)) continue
      if (versionCompare(r.tag_name.slice(1), floor) < 0) continue

      // Each published .bin lineage needs its own row. 7.15 is the first
      // release to carry a bitcoin-only asset, so this is what will flag the
      // missing btc-only hash on release day rather than a user reporting it.
      const bins = r.assets.map((a) => a.name).filter((n) => n.endsWith('.bin'))
      if (!bins.length) continue
      if (bins.some((n) => !n.includes(BTC_SUFFIX)) && !expected.has(r.tag_name)) {
        unpinned.push(r.tag_name)
      }
      if (bins.some((n) => n.includes(BTC_SUFFIX)) && !expected.has(r.tag_name + BTC_SUFFIX)) {
        unpinned.push(r.tag_name + BTC_SUFFIX)
      }
    }

    console.log(`\nunpinned-release check floor: v${floor}`)

    if (unpinned.length) {
      console.error(`\nUNPINNED RELEASES: ${unpinned.join(', ')}`)
      console.error('Devices on these versions will read as unrecognised.')
      console.error('Add them to ONDEVICE_FIRMWARE_HASHES using the hash this script prints.')
      process.exitCode = 1
    } else {
      console.log('\nno unpinned official releases')
    }
  } else {
    console.warn(`\ncould not list releases (HTTP ${res.status}) -- unpinned check skipped`)
  }
} else {
  console.warn('\nGITHUB_TOKEN unset -- unpinned-release check skipped')
}

console.log(`\n${ok} verified, ${bad.length} mismatched, ${skipped.length} unverifiable`)
if (skipped.length) console.log(`unverifiable: ${skipped.join(', ')}`)
if (bad.length) {
  console.error(`\nMISMATCHED: ${bad.join(', ')}`)
  process.exit(1)
}
