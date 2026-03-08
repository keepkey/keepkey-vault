/**
 * Firmware Version Map — tracks features introduced in each firmware release.
 *
 * Used by the upgrade preview UI to show users what they gain from a firmware update.
 * Only versions that introduce notable user-facing features need entries.
 */

export interface FirmwareFeature {
  /** Short title: "Solana Support" */
  title: string
  /** One-line description */
  description: string
  /** Chain IDs from chains.ts that this feature enables (for logo display) */
  chains?: string[]
  /** Brand color override for the feature highlight */
  color?: string
  /** Icon key: 'chain' shows chain logos, 'security' shows a shield, 'performance' shows a bolt */
  icon?: 'chain' | 'security' | 'performance' | 'feature'
}

export interface FirmwareVersionInfo {
  version: string
  /** Release date (display only) */
  date?: string
  /** Headline shown at top of upgrade preview */
  headline: string
  /** Features introduced in this version */
  features: FirmwareFeature[]
}

/**
 * Map of firmware versions to their notable features.
 * Ordered newest-first. Only versions with user-visible features are listed.
 */
export const FIRMWARE_VERSION_MAP: FirmwareVersionInfo[] = [
  {
    version: '7.11.0',
    date: '2025-03',
    headline: 'Solana has arrived on KeepKey',
    features: [
      {
        title: 'Solana Support',
        description: 'Send, receive, and sign Solana transactions directly from your KeepKey.',
        chains: ['solana'],
        color: '#14F195',
        icon: 'chain',
      },
    ],
  },
  // Future versions go here:
  // {
  //   version: '7.12.0',
  //   headline: 'Zcash Privacy',
  //   features: [
  //     { title: 'Zcash Shielded', description: '...', chains: ['zcash'], color: '#F4B728', icon: 'chain' },
  //   ],
  // },
]

/**
 * Get features introduced between two firmware versions (exclusive of `from`, inclusive of `to`).
 * Returns features newest-first. If `from` is null, returns all features up to `to`.
 */
export function getUpgradeFeatures(from: string | null, to: string): FirmwareFeature[] {
  const features: FirmwareFeature[] = []
  for (const entry of FIRMWARE_VERSION_MAP) {
    if (versionCompare(entry.version, to) > 0) continue       // skip versions newer than target
    if (from && versionCompare(entry.version, from) <= 0) break // stop at current version
    features.push(...entry.features)
  }
  return features
}

/**
 * Get the version info for a specific firmware version.
 */
export function getVersionInfo(version: string): FirmwareVersionInfo | undefined {
  return FIRMWARE_VERSION_MAP.find(v => v.version === version)
}

/**
 * Get all version infos between two versions (features the user will gain).
 */
export function getUpgradeVersions(from: string | null, to: string): FirmwareVersionInfo[] {
  const versions: FirmwareVersionInfo[] = []
  for (const entry of FIRMWARE_VERSION_MAP) {
    if (versionCompare(entry.version, to) > 0) continue
    if (from && versionCompare(entry.version, from) <= 0) break
    versions.push(entry)
  }
  return versions
}

/**
 * On-device firmware hash → version map.
 *
 * The device reports SHA-256(meta_descriptor + app_code) which equals the
 * full-file SHA-256 of the downloadable .bin. This is different from the
 * manifest's hashes.firmware which are payload-only (skip 256-byte KPKY header).
 *
 * Used to resolve firmware version in bootloader mode where the device can't
 * report version numbers. Unknown hashes indicate custom/unsigned firmware.
 */
export const ONDEVICE_FIRMWARE_HASHES: Record<string, string> = {
  'd380357b7403064d7b1ea963dc56032239541a21ef0b7e08082fb36ed470de82': 'v6.0.0',
  '699f75ae5936977bf4f9df0478afe40106ea21bc2d94746bbe244a7832d4c5ca': 'v6.0.1',
  '14cf71b0872a5c3cda1af2007aafd9bd0d5401be927e08e5b226fe764334d515': 'v6.0.2',
  '61c157a7fbc22f4d9825909ac067277a94e44c174e77db419fbb78b361fbf4ea': 'v6.0.4',
  '4246ff0e1b71a2a6b3e89e2cfd0882dc207f96b2516640d6c5fff406c02097bf': 'v6.1.0',
  'f9dfd903e6d4d8189409a72b9d31897ca1753a4000a24cc1c9217f4b8141403c': 'v6.1.1',
  '0158073bb527b3b14148641722e77346ecec66a12fc4a5b4457dc0559c63169e': 'v6.2.0',
  '5bcbeecea0a1c78cbd11344bb31c809072a01cb775f1e42368ef275888012208': 'v6.2.2',
  '0e2463b777f39dc8b450aca78f55b3355e906c69d19b59e84052786c5fa8f78c': 'v6.3.0',
  '0ef1b51a450fafd8e0586103bda38526c5d012fc260618b8df5437cba7682c5b': 'v6.4.0',
  '89d1b5230bbca2e02901b091cbd77207d0636e6f1956f6f27a0ecb10c43cce3d': 'v6.5.1',
  '85a44f1872b4b4ed0d5ff062711cfd4d4d69d9274312c9e3780b7db8da9072e8': 'v6.6.0',
  '24071db7596f0824e51ce971c1ec39ac5a07e7a5bcaf5f1b33313de844e25580': 'v6.7.0',
  '6a5e2bcf98aeafbb2faa98ea425ac066a7b4733e5b9edb29e544bad659cb3766': 'v7.0.3',
  'd8b2b43eada45ded399f347289750a7083081186b37158b85eab41a38cbc6e50': 'v7.1.0',
  'eb3d8853d549671dee532b51363cffdfa2038bc7730117e72dc17bb1452de4db': 'v7.1.1',
  'aa5834bb591c40dffd5e083797fe25e6d5591199a781220025fa469a965d0279': 'v7.1.2',
  '7a52fa75be2e3e9794c4a01e74fc2a68cd502aace13fca1f272d5296156f1499': 'v7.1.4',
  '2b7edd319536076e0a00058d0cfd1b1863c8d616ba5851668796d04966df8594': 'v7.1.7',
  '72838adfe3762760dbbbadd74c8914b783660ea0ef3b8fe340e4a663442c5549': 'v7.1.8',
  'c6cf79e7c2cc1b9cf7eca57aacaab5310b4dd0eff1559cda307295d753251eff': 'v7.2.1',
  'efcdcb32f199110e9a38010bc48d2acc66da89d41fb30c7d0b64c1ef74c90359': 'v7.3.2',
  '43472b6fc1a3c9a2546ba771af830005f5758acbd9ea0679d4f20d480f63a040': 'v7.4.0',
  '08b1153a6e9ba5f45776094d62c8d055632d414a38f0c70acd1e751229bf097c': 'v7.5.0',
  'fdd10f5cf6469655c82c8259f075cdb3c704a93eb691072e3fa8ba5b4c4cafc4': 'v7.5.1',
  'a94ba237468243929e0363a1bd2f48914580abfe2a90abbb533b0a201c434d54': 'v7.5.2',
  'b4022a002278d1c00ccea54eb4d03934542ac509d03d77c0b7a8b8485b731f11': 'v7.6.0',
  '1eb79470f73e40464d5e689e5008dddb47e7eb53bc87c50b1de4f3f150ed36bf': 'v7.7.0',
  '31c1cdd945a7331e01b3cced866cb28add5b49eef87c2bbc08370e5aa7daf9bf': 'v7.8.0',
  '387ec4c8d3dcc83df8707aa0129eeb44e824c3797fb629a493be845327669da1': 'v7.9.0',
  'fc13cb3a405fdee342ebd0d945403b334f0c43ba19771fdabd0e81caf85a63f7': 'v7.9.1',
  '24cca93ef5e7907dc6d8405b8ab9800d4e072dd9259138cf7679107985b88137': 'v7.9.3',
  '518ad41643ee8a0aa6a6422f8534ac94f56cd65bc637aea4db7f3fdbb53255c3': 'v7.10.0',
}

/**
 * Resolve firmware version from on-device hash. Returns version string or null for custom firmware.
 */
export function resolveOndeviceFirmwareVersion(hash: string | undefined): string | null {
  if (!hash) return null
  return ONDEVICE_FIRMWARE_HASHES[hash] ?? null
}

/** Compare semver strings: returns -1 (a<b), 0 (a==b), 1 (a>b) */
function versionCompare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0
    const vb = pb[i] || 0
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}
