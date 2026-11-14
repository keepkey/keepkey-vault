/**
 * Edits KeepKey makes to the macOS app bundle, shared by the build hook that
 * applies them (scripts/patch-bundle.ts, before Hutch hashes, signs and packs
 * the app) and the release verifier that checks they reached the shipped
 * archive (scripts/verify-release-bundle.ts).
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CAMERA_REASON = 'KeepKey Vault uses the camera to scan QR codes for wallet addresses.'

function findRecursive(dir: string, target: string, depth: number, maxDepth: number): string | null {
  if (depth > maxDepth) return null
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === target) return join(dir, entry.name)
      const found = findRecursive(join(dir, entry.name), target, depth + 1, maxDepth)
      if (found) return found
    }
  } catch {}
  return null
}

function findNodeModules(dir: string): string | null {
  if (!existsSync(dir)) return null
  for (const candidate of [join(dir, 'node_modules'), join(dir, 'bun', 'node_modules')]) {
    if (existsSync(candidate)) return candidate
  }
  return findRecursive(dir, 'node_modules', 0, 3)
}

function getPackageVersion(pkgDir: string): string | null {
  try {
    const pjPath = join(pkgDir, 'package.json')
    if (!existsSync(pjPath)) return null
    return JSON.parse(readFileSync(pjPath, 'utf8')).version || null
  } catch { return null }
}

const STRIP_DIRS = [
  // NOTE: lodash is required by minim (swagger/apidom transitive dep) — do NOT strip
  'rxjs',
  '@keepkey/hdwallet-core/src', '@keepkey/hdwallet-keepkey/src',
  '@keepkey/hdwallet-keepkey-nodehid/src', '@keepkey/hdwallet-keepkey-nodewebusb/src',
  '@keepkey/proto-tx-builder/src',
  'protobufjs/cli', 'protobufjs/dist',
  'ethers/dist', 'ethers/src.ts',
  'libsodium/dist/modules-esm',
  '@ethereumjs/common/dist.browser', '@ethereumjs/common/src',
  'osmojs/types', 'osmojs/main',
  'keccak/build',
  'tiny-secp256k1/build', 'secp256k1/build', 'secp256k1/src',
  '@cosmjs/amino/src', '@cosmjs/crypto/src', '@cosmjs/encoding/src',
  '@cosmjs/math/src', '@cosmjs/proto-signing/src', '@cosmjs/stargate/src',
  '@cosmjs/tendermint-rpc/src', '@cosmjs/utils/src',
  'cosmjs-types/src',
  'long/umd',
]

// SAFE_PRUNE: file-like names with extensions — safe to delete at any depth
const SAFE_PRUNE = new Set([
  'README.md', 'readme.md', 'CHANGELOG.md', 'HISTORY.md',
  'LICENSE.md', 'LICENSE.txt', 'LICENCE.md',
  'CONTRIBUTING.md', '.npmignore', '.eslintrc', '.eslintrc.js', '.eslintrc.json',
  '.prettierrc', '.prettierrc.js', '.editorconfig', '.travis.yml',
  'tsconfig.json', 'tsconfig.tsbuildinfo', '.babelrc', 'babel.config.js',
  'jest.config.js', 'jest.config.ts', 'karma.conf.js',
  'SECURITY.md', 'CODE_OF_CONDUCT.md',
])
// ROOT_ONLY_PRUNE: bare directory names that could collide with runtime code
// (e.g. @swagger-api ships runtime code in a dir named "license/").
// Only pruned at package root (depth 1 inside each package), never recursively.
const ROOT_ONLY_PRUNE = new Set([
  'README', 'CHANGELOG', 'LICENSE', 'license', 'LICENCE', 'AUTHORS',
  '.github', '.nyc_output', 'coverage',
  'test', 'tests', '__tests__', '__mocks__', 'spec', 'benchmark', 'benchmarks',
])
const NATIVE_EXTS = new Set(['.o', '.c', '.h', '.cc', '.cpp', '.gyp', '.gypi', '.vcxproj', '.m4', '.mk', '.am', '.in'])

/**
 * Strip bloat from the app's node_modules: duplicate nested packages, type and
 * source maps, known bloat directories, docs/tests and non-macOS native build
 * inputs. Returns the number of entries removed (0 means already pruned).
 */
export function pruneAppNodeModules(appPath: string, log: (line: string) => void = console.log): number {
  const nmDir = findNodeModules(join(appPath, 'Contents', 'Resources')) || findNodeModules(appPath)
  if (!nmDir) throw new Error(`no node_modules in ${appPath}`)
  const sizeKB = () => parseInt(Bun.spawnSync(['du', '-sk', nmDir]).stdout.toString().split('\t')[0] || '0', 10)
  const sizeBefore = sizeKB()

  // 1. Remove nested node_modules that DUPLICATE top-level packages at the same version.
  //    KEEP nested packages where the version differs — these are required by the parent
  //    package (e.g. ethereum-cryptography needs @noble/hashes@1.4.0, top-level has @1.8.0).
  let prunedDirs = 0
  const dropIfDuplicate = (nestedPath: string, name: string) => {
    const nestedVer = getPackageVersion(nestedPath)
    const topVer = getPackageVersion(join(nmDir, name))
    if (nestedVer && topVer && nestedVer === topVer) {
      rmSync(nestedPath, { recursive: true })
      prunedDirs++
    }
  }
  const stripDuplicateNestedNodeModules = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const fullPath = join(dir, entry.name)
        if (entry.name !== 'node_modules') {
          stripDuplicateNestedNodeModules(fullPath)
          continue
        }
        try {
          for (const pkg of readdirSync(fullPath, { withFileTypes: true })) {
            if (!pkg.isDirectory()) continue
            const nestedPkgPath = join(fullPath, pkg.name)
            if (pkg.name.startsWith('@')) {
              try {
                for (const scoped of readdirSync(nestedPkgPath, { withFileTypes: true })) {
                  if (scoped.isDirectory()) dropIfDuplicate(join(nestedPkgPath, scoped.name), `${pkg.name}/${scoped.name}`)
                }
                if (readdirSync(nestedPkgPath).length === 0) rmSync(nestedPkgPath, { recursive: true })
              } catch {}
            } else {
              dropIfDuplicate(nestedPkgPath, pkg.name)
            }
          }
          if (readdirSync(fullPath).length === 0) {
            rmSync(fullPath, { recursive: true })
            prunedDirs++
          }
        } catch {
          // If we can't read it, leave it alone (safer than deleting)
        }
      }
    } catch {}
  }
  // Only strip nested node_modules INSIDE packages, not the top-level one
  for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgDir = join(nmDir, entry.name)
    if (entry.name.startsWith('@')) {
      for (const sub of readdirSync(pkgDir, { withFileTypes: true })) {
        if (sub.isDirectory()) stripDuplicateNestedNodeModules(join(pkgDir, sub.name))
      }
    } else {
      stripDuplicateNestedNodeModules(pkgDir)
    }
  }
  log(`[prune-bundle] Stripped ${prunedDirs} duplicate nested deps (kept version-differing)`)

  // 2. Remove files by extension
  let prunedFiles = 0
  const pruneFilesByExtension = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          pruneFilesByExtension(fullPath)
          continue
        }
        const n = entry.name
        if (n.endsWith('.d.ts') || n.endsWith('.d.ts.map') || n.endsWith('.d.mts') || n.endsWith('.d.cts') ||
          n.endsWith('.map') || n.endsWith('.flow') || n.endsWith('.mts') || n.endsWith('.cts') || n.endsWith('.ts')) {
          try { rmSync(fullPath); prunedFiles++ } catch {}
        }
      }
    } catch {}
  }
  pruneFilesByExtension(nmDir)
  log(`[prune-bundle] Pruned ${prunedFiles} type/map/source files`)

  // 3. Remove known bloat directories
  let strippedDirs = 0
  for (const dir of STRIP_DIRS) {
    const target = join(nmDir, dir)
    if (existsSync(target)) {
      rmSync(target, { recursive: true })
      strippedDirs++
    }
  }
  log(`[prune-bundle] Stripped ${strippedDirs} bloat directories`)

  // 4. Remove doc/test files by name
  let docPruned = 0
  const pruneByName = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name)
        if (SAFE_PRUNE.has(entry.name)) {
          rmSync(fullPath, { recursive: true })
          docPruned++
          continue
        }
        if (entry.isDirectory()) pruneByName(fullPath)
      }
    } catch {}
  }
  const pruneRootOnlyIn = (pkgDir: string) => {
    for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
      if (ROOT_ONLY_PRUNE.has(entry.name)) {
        rmSync(join(pkgDir, entry.name), { recursive: true })
        docPruned++
      }
    }
  }
  pruneByName(nmDir)
  try {
    for (const pkg of readdirSync(nmDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const pkgDir = join(nmDir, pkg.name)
      if (pkg.name.startsWith('@')) {
        for (const sub of readdirSync(pkgDir, { withFileTypes: true })) {
          if (sub.isDirectory()) pruneRootOnlyIn(join(pkgDir, sub.name))
        }
      } else {
        pruneRootOnlyIn(pkgDir)
      }
    }
  } catch {}
  log(`[prune-bundle] Pruned ${docPruned} doc/test entries`)

  // 5. Remove C/C++ source, native build artifacts and non-macOS prebuilds
  let nativePruned = 0
  const pruneNative = (dir: string) => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.startsWith('linux') || entry.name.startsWith('win32') ||
              entry.name.startsWith('android') || entry.name.startsWith('HID-win') ||
              entry.name.startsWith('HID-linux') || entry.name.startsWith('HID_hidraw-linux') ||
              entry.name === 'node_gyp_bins' || entry.name === 'gyp') {
            rmSync(fullPath, { recursive: true })
            nativePruned++
            continue
          }
          pruneNative(fullPath)
        } else if (entry.isFile()) {
          const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')) : ''
          if (NATIVE_EXTS.has(ext) || entry.name === 'Makefile' || entry.name === 'configure' || entry.name === 'binding.gyp') {
            rmSync(fullPath)
            nativePruned++
          }
        }
      }
    } catch {}
  }
  pruneNative(nmDir)
  log(`[prune-bundle] Pruned ${nativePruned} native build artifacts`)

  const sizeAfter = sizeKB()
  log(`[prune-bundle] node_modules: ${(sizeBefore / 1024).toFixed(1)}MB → ${(sizeAfter / 1024).toFixed(1)}MB`)
  return prunedDirs + prunedFiles + strippedDirs + docPruned + nativePruned
}

/**
 * Give NSCameraUsageDescription real copy. The camera entitlement in
 * electrobun.config.ts must be `true` (a string value lands in entitlements.plist
 * as <string>, which codesign rejects), and `true` is exactly what makes Electrobun
 * write the placeholder "This app requires access for camera". A wallet asking
 * for the camera should say why. Throws when the key is missing: macOS kills the
 * app when QrScannerOverlay calls getUserMedia without it.
 */
export function setCameraUsageDescription(appPath: string): boolean {
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
  const plist = readFileSync(infoPlistPath, 'utf8')
  if (!plist.includes('<key>NSCameraUsageDescription</key>')) {
    throw new Error(`${infoPlistPath} has no NSCameraUsageDescription; check com.apple.security.device.camera in electrobun.config.ts`)
  }
  if (cameraUsageDescription(appPath) === CAMERA_REASON) return false
  const updated = plist.replace(
    /(<key>NSCameraUsageDescription<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${CAMERA_REASON}$2`,
  )
  if (updated === plist) throw new Error(`could not rewrite NSCameraUsageDescription in ${infoPlistPath}; Electrobun changed its Info.plist shape`)
  writeFileSync(infoPlistPath, updated)
  return true
}

export function cameraUsageDescription(appPath: string): string | null {
  const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
  return plist.match(/<key>NSCameraUsageDescription<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? null
}
