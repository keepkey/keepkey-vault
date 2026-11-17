export interface DesktopUpdateRelease {
  tag_name: string
  prerelease: boolean
  draft: boolean
}

/** Internal artifact releases share the repository, but are not desktop versions. */
export function isDesktopVersionTag(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false
  const match = value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match || !match.slice(1, 4).every(part => Number.isSafeInteger(Number(part)))) return false
  // SemVer permits leading zeroes in build metadata, but not numeric prerelease identifiers.
  return !match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))
}

/** Keep GitHub's release order and prerelease channel policy, skipping helper tags. */
export function selectDesktopUpdateRelease(releases: unknown, includePrereleases: boolean): DesktopUpdateRelease | undefined {
  if (!Array.isArray(releases)) return undefined
  return releases.find((release): release is DesktopUpdateRelease => !!release && typeof release === 'object'
    && release.draft === false && typeof release.prerelease === 'boolean'
    && (includePrereleases || !release.prerelease) && isDesktopVersionTag(release.tag_name))
}
