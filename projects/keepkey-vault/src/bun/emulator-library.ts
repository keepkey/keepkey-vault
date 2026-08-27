import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

type SupportedPlatform = 'darwin' | 'win32' | 'linux'

export function emulatorLibFilename(platform: SupportedPlatform = process.platform as SupportedPlatform): string {
  if (platform === 'win32') return 'libkkemu.dll'
  if (platform === 'linux') return 'libkkemu.so'
  return 'libkkemu.dylib'
}

export function userEmulatorLibPath(
  platform: SupportedPlatform = process.platform as SupportedPlatform,
  home = homedir(),
): string {
  return join(home, '.keepkey', 'emulator', emulatorLibFilename(platform))
}

/** Candidate locations for Resources/app/emulator and source-tree staging. */
export function bundledEmulatorCandidates(
  importDir: string,
  cwd: string,
  platform: SupportedPlatform = process.platform as SupportedPlatform,
): string[] {
  const filename = emulatorLibFilename(platform)
  const candidates: string[] = []
  for (let depth = 0; depth <= 12; depth++) {
    const parents = Array(depth).fill('..')
    candidates.push(resolve(importDir, ...parents, 'emulator', filename))
    candidates.push(resolve(importDir, ...parents, 'emulator-bundle', filename))
  }
  candidates.push(resolve(cwd, 'emulator-bundle', filename))
  candidates.push(resolve(cwd, 'projects', 'keepkey-vault', 'emulator-bundle', filename))
  return [...new Set(candidates)]
}

/** User-installed libraries remain an explicit override; releases need no install. */
export function resolveEmulatorLibPath(options: {
  importDir: string
  cwd?: string
  home?: string
  platform?: SupportedPlatform
  exists?: (path: string) => boolean
}): string | null {
  const platform = options.platform ?? process.platform as SupportedPlatform
  const exists = options.exists ?? existsSync
  const override = userEmulatorLibPath(platform, options.home ?? homedir())
  if (exists(override)) return override
  return bundledEmulatorCandidates(options.importDir, options.cwd ?? process.cwd(), platform)
    .find(exists) ?? null
}
