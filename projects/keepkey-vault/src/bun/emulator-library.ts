import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

type SupportedPlatform = 'darwin' | 'win32' | 'linux'

/** A build ID is its content hash, not a user-supplied version string. */
export function emulatorBuildId(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid emulator build hash')
  return hash
}

export function emulatorBuildDir(home = homedir()): string {
  return join(home, '.keepkey', 'emulator', 'builds')
}

export function emulatorBuildPath(id: string, platform: SupportedPlatform = process.platform as SupportedPlatform, home = homedir()): string {
  return join(emulatorBuildDir(home), `${emulatorBuildId(id)}-${emulatorLibFilename(platform)}`)
}

export function emulatorBuildFlashName(id: string): string {
  return `build-${emulatorBuildId(id).slice(0, 16)}`
}

export function selectedEmulatorBuild(home = homedir()): string | null {
  try {
    const id = readFileSync(join(emulatorBuildDir(home), 'selected'), 'utf8').trim()
    return emulatorBuildId(id)
  } catch { return null }
}

export function selectEmulatorBuild(id: string, home = homedir()): void {
  emulatorBuildId(id)
  mkdirSync(emulatorBuildDir(home), { recursive: true, mode: 0o700 })
  writeFileSync(join(emulatorBuildDir(home), 'selected'), `${id}\n`, { mode: 0o600 })
}

export function clearSelectedEmulatorBuild(home = homedir()): void {
  const path = join(emulatorBuildDir(home), 'selected')
  if (existsSync(path)) unlinkSync(path)
}

export function recordEmulatorBuildVersion(id: string, version: string, home = homedir()): void {
  emulatorBuildId(id)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid emulator firmware version')
  writeFileSync(join(emulatorBuildDir(home), `${id}.version`), `${version}\n`, { mode: 0o600 })
}

export function listEmulatorBuilds(platform: SupportedPlatform = process.platform as SupportedPlatform, home = homedir()): Array<{ id: string; path: string; selected: boolean; version?: string }> {
  const dir = emulatorBuildDir(home)
  if (!existsSync(dir)) return []
  const suffix = `-${emulatorLibFilename(platform)}`
  const selected = selectedEmulatorBuild(home)
  return readdirSync(dir).filter(name => name.endsWith(suffix) && /^[a-f0-9]{64}-/.test(name)).map(name => {
    const id = name.slice(0, 64)
    let version: string | undefined
    try { version = readFileSync(join(dir, `${id}.version`), 'utf8').trim() } catch {}
    return { id, path: join(dir, name), selected: id === selected, version }
  }).sort((a, b) => a.id.localeCompare(b.id))
}

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
  const selected = selectedEmulatorBuild(options.home ?? homedir())
  if (selected) {
    const path = emulatorBuildPath(selected, platform, options.home ?? homedir())
    return exists(path) ? path : null
  }
  const override = userEmulatorLibPath(platform, options.home ?? homedir())
  if (exists(override)) return override
  return bundledEmulatorCandidates(options.importDir, options.cwd ?? process.cwd(), platform)
    .find(exists) ?? null
}

/**
 * The ClearSign TEST root the emulator was started with, or undefined. A debug
 * libkkemu reads KK_CLEARSIGN_TEST_ROOT (a 33-byte compressed key, 66 hex) with
 * getenv in kkemu_init, so only the launch environment counts: Bun's
 * process.env assignments never reach getenv. Read it once, at startup. A QA
 * setting for the stock 7.16 emulator; it never applies to a real device.
 */
export function emulatorClearSignTestRoot(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env.KK_CLEARSIGN_TEST_ROOT?.trim()
  return key && /^0[23][0-9a-fA-F]{64}$/.test(key) ? key.toLowerCase() : undefined
}
