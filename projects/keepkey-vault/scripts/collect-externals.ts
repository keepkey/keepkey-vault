#!/usr/bin/env bun
/**
 * Collects external packages and their transitive dependencies into a staging
 * directory (build/node_modules) so they can be copied into the Electrobun app bundle.
 *
 * Usage: bun scripts/collect-externals.ts
 */
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'

const EXTERNALS = [
  '@keepkey/hdwallet-core',
  '@keepkey/hdwallet-keepkey',
  '@keepkey/hdwallet-keepkey-nodehid',
  '@keepkey/hdwallet-keepkey-nodewebusb',
  '@keepkey/device-protocol',
  '@keepkey/proto-tx-builder',
  'google-protobuf',
  'node-hid',
  'usb',
  'ethers',
  // Dependencies of @keepkey packages (hdwallet-core)
  'type-assertions',
  'eventemitter2',
  'eip-712',
  // Dependencies of @keepkey packages (hdwallet-keepkey)
  '@ethereumjs/common',
  '@ethereumjs/tx',
  '@metamask/eth-sig-util',
  '@shapeshiftoss/bitcoinjs-lib',
  'bignumber.js',
  'bnb-javascript-sdk-nobroadcast',
  'crypto-js',
  'eip55',
  'icepick',
  'p-lazy',
  'semver',
  'tiny-secp256k1',
]

const projectRoot = join(import.meta.dir, '..')
const nmSource = join(projectRoot, 'node_modules')
const nmDest = join(projectRoot, 'build', '_ext_modules')
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const isLinux = process.platform === 'linux'

// Cross-platform directory size calculation
function getDirSize(dirPath: string): number {
  let size = 0
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        size += getDirSize(fullPath)
      } else {
        try {
          size += statSync(fullPath).size
        } catch {}
      }
    }
  } catch {}
  return size
}

// Recursively collect all transitive dependencies
const allDeps = new Set<string>(EXTERNALS)

function addDeps(pkg: string) {
  try {
    const pjPath = join(nmSource, pkg, 'package.json')
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    for (const dep of Object.keys(pj.dependencies || {})) {
      if (!allDeps.has(dep)) {
        allDeps.add(dep)
        addDeps(dep)
      }
    }
  } catch (e) {
    // Package may be a sub-dependency already resolved elsewhere
    if (allDeps.size < 20) console.warn(`  WARN: Could not read deps for ${pkg}: ${e}`)
  }
}

EXTERNALS.forEach(addDeps)

console.log(`[collect-externals] ${allDeps.size} packages to copy:`)
const sorted = [...allDeps].sort()
for (const dep of sorted) {
  console.log(`  ${dep}`)
}

// Clean destination
if (existsSync(nmDest)) {
  rmSync(nmDest, { recursive: true })
}

// Map of file:-linked packages to their actual source locations
const FILE_LINKED_PACKAGES: Record<string, string> = {
  '@keepkey/hdwallet-core': join(projectRoot, '..', '..', 'modules', 'hdwallet', 'packages', 'hdwallet-core'),
  '@keepkey/hdwallet-keepkey': join(projectRoot, '..', '..', 'modules', 'hdwallet', 'packages', 'hdwallet-keepkey'),
  '@keepkey/hdwallet-keepkey-nodehid': join(projectRoot, '..', '..', 'modules', 'hdwallet', 'packages', 'hdwallet-keepkey-nodehid'),
  '@keepkey/hdwallet-keepkey-nodewebusb': join(projectRoot, '..', '..', 'modules', 'hdwallet', 'packages', 'hdwallet-keepkey-nodewebusb'),
  '@keepkey/device-protocol': join(projectRoot, '..', '..', 'modules', 'hdwallet', 'packages', 'hdwallet-keepkey', 'node_modules', '@keepkey', 'device-protocol'),
  '@keepkey/proto-tx-builder': join(projectRoot, '..', '..', 'modules', 'proto-tx-builder-vendored'),
}

// Additional node_modules locations to search (for hdwallet dependencies)
const EXTRA_NODE_MODULES = [
  join(projectRoot, '..', '..', 'modules', 'hdwallet', 'node_modules'),
]

// Copy each package
let copiedCount = 0

for (const dep of sorted) {
  // Check if this is a file:-linked package
  const fileLinkSrc = FILE_LINKED_PACKAGES[dep]
  let src = fileLinkSrc && existsSync(fileLinkSrc) ? fileLinkSrc : join(nmSource, dep)

  // If not found in main node_modules, check extra locations
  if (!existsSync(src)) {
    for (const extraNm of EXTRA_NODE_MODULES) {
      const extraSrc = join(extraNm, dep)
      if (existsSync(extraSrc)) {
        src = extraSrc
        break
      }
    }
  }

  const dst = join(nmDest, dep)

  if (!existsSync(src)) {
    console.warn(`  WARN: ${dep} not found in any node_modules, skipping`)
    continue
  }

  // Ensure parent dir exists for scoped packages (@keepkey/...)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true, dereference: true })
  if (fileLinkSrc) {
    console.log(`  Copied file-linked: ${dep} from ${src}`)
  } else if (!src.startsWith(nmSource)) {
    console.log(`  Copied from hdwallet: ${dep}`)
  }
  copiedCount++
}

console.log(`[collect-externals] Copied ${copiedCount} packages to ${nmDest}`)

// Prune unnecessary files to reduce bundle size
const PRUNE_PATTERNS = [
  // Docs & metadata
  'README.md', 'readme.md', 'README', 'CHANGELOG.md', 'CHANGELOG', 'HISTORY.md',
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE', 'LICENCE.md',
  'CONTRIBUTING.md', '.npmignore', '.eslintrc', '.eslintrc.js', '.eslintrc.json',
  '.prettierrc', '.prettierrc.js', '.editorconfig', '.travis.yml', '.github',
  'tsconfig.json', 'tsconfig.tsbuildinfo', '.babelrc', 'babel.config.js',
  'jest.config.js', 'jest.config.ts', 'karma.conf.js', '.nyc_output',
  'coverage', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'AUTHORS',
  // Test directories
  'test', 'tests', '__tests__', '__mocks__', 'spec', 'benchmark', 'benchmarks',
  // NOTE: Do NOT prune 'src' — many packages (bip32, etc.) use src/ as their main entry point
  // TypeScript source maps
  '*.map',
]

let prunedCount = 0
let prunedSize = 0

function pruneDir(dirPath: string) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      // Prune by name
      if (PRUNE_PATTERNS.includes(entry.name)) {
        try {
          const stat = statSync(fullPath)
          const size = entry.isDirectory() ? 0 : stat.size
          rmSync(fullPath, { recursive: true })
          prunedCount++
          prunedSize += size
        } catch (e) {
          console.warn(`  WARN: Failed to prune ${fullPath}: ${e}`)
        }
        continue
      }
      // Prune by extension (including .d.ts — Bun doesn't need type declarations at runtime)
      if (entry.isFile()) {
        if (
          entry.name.endsWith('.map') ||
          entry.name.endsWith('.d.ts') ||
          entry.name.endsWith('.d.ts.map') ||
          entry.name.endsWith('.d.mts') ||
          entry.name.endsWith('.d.cts') ||
          entry.name.endsWith('.flow') ||
          (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) ||
          entry.name.endsWith('.mts') ||
          entry.name.endsWith('.cts')
        ) {
          try {
            prunedSize += statSync(fullPath).size
            rmSync(fullPath)
            prunedCount++
          } catch (e) {
            console.warn(`  WARN: Failed to prune ${fullPath}: ${e}`)
          }
          continue
        }
      }
      // Recurse into directories
      if (entry.isDirectory()) {
        pruneDir(fullPath)
      }
    }
  } catch (e) {
    console.warn(`  WARN: Error scanning directory ${dirPath}: ${e}`)
  }
}

pruneDir(nmDest)
console.log(`[collect-externals] Pruned ${prunedCount} files/dirs (${(prunedSize / 1024 / 1024).toFixed(1)}MB removed)`)

// Remove prebuilds for other platforms, build artifacts, and native source files
const REMOVE_DIRS = ['node_gyp_bins', 'gyp', 'binding.gyp']

// Prefixes to REMOVE (non-current platform)
const REMOVE_PREBUILD_PREFIXES = isWindows
  ? ['linux', 'darwin', 'android']  // On Windows, remove Linux/Mac/Android
  : isMac
    ? ['linux', 'win32', 'android']  // On Mac, remove Linux/Windows/Android
    : ['darwin', 'win32', 'android'] // On Linux, remove Mac/Windows/Android

// C/C++ source and build artifacts not needed at runtime (~7MB)
const NATIVE_PRUNE_EXTENSIONS = ['.o', '.c', '.h', '.cc', '.cpp', '.gyp', '.gypi', '.vcxproj', '.m4', '.mk', '.am', '.in']

let nativePrunedSize = 0
function cleanNativeArtifacts(dirPath: string) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        // Remove prebuilds for other platforms
        const shouldRemove = REMOVE_PREBUILD_PREFIXES.some(p => entry.name.startsWith(p)) ||
            (isWindows && (entry.name.startsWith('HID-darwin') || entry.name.startsWith('HID-linux') || entry.name.startsWith('HID_hidraw-linux'))) ||
            (isMac && (entry.name.startsWith('HID-win') || entry.name.startsWith('HID-linux') || entry.name.startsWith('HID_hidraw-linux'))) ||
            (isLinux && (entry.name.startsWith('HID-win') || entry.name.startsWith('HID-darwin')))
        if (shouldRemove) {
          nativePrunedSize += getDirSize(fullPath)
          rmSync(fullPath, { recursive: true })
          continue
        }
        // Remove node-gyp build artifacts
        if (REMOVE_DIRS.includes(entry.name)) {
          rmSync(fullPath, { recursive: true })
          continue
        }
        cleanNativeArtifacts(fullPath)
      } else if (entry.isFile()) {
        // Remove C/C++ source and build config files
        const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')) : ''
        if (NATIVE_PRUNE_EXTENSIONS.includes(ext) || entry.name === 'Makefile' || entry.name === 'configure') {
          try {
            nativePrunedSize += statSync(fullPath).size
          } catch {}
          rmSync(fullPath)
        }
      }
    }
  } catch (e) {
    console.warn(`  WARN: Error cleaning native artifacts in ${dirPath}: ${e}`)
  }
}

cleanNativeArtifacts(nmDest)
console.log(`[collect-externals] Cleaned native artifacts (${(nativePrunedSize / 1024 / 1024).toFixed(1)}MB removed)`)

// Aggressively strip large directories not needed at runtime
const STRIP_DIRS = [
  // --- Local packages: TS source (compiled to dist/) ---
  '@keepkey/hdwallet-core/src',
  '@keepkey/hdwallet-keepkey/src',
  '@keepkey/hdwallet-keepkey-nodehid/src',
  '@keepkey/hdwallet-keepkey-nodewebusb/src',
  '@keepkey/proto-tx-builder/src',
  '@keepkey/proto-tx-builder/osmosis-frontend',

  // --- protobufjs: CLI tooling + dist bundles (main→index.js at root) ---
  'protobufjs/cli',
  'protobufjs/dist',
  'protobufjs/src',

  // --- rxjs: UMD bundles + ESM duplicates (main→dist/cjs/) ---
  'rxjs/src',
  'rxjs/dist/bundles',

  // --- ethers: dist/ has UMD/ESM bundles 3.4MB (main→lib/) ---
  'ethers/dist',
  'ethers/src.ts',

  // --- libsodium: ESM copy (main→dist/modules/) ---
  'libsodium/dist/modules-esm',

  // --- @ethereumjs/common: browser bundle + TS source ---
  '@ethereumjs/common/dist.browser',
  '@ethereumjs/common/src',

  // --- osmojs: large proto directories ---
  'osmojs/types',
  'osmojs/main',

  // --- keccak: build/Release artifacts (prebuilds are used) ---
  'keccak/build',

  // --- Native build artifacts (obj files, C source not needed) ---
  'tiny-secp256k1/build',
  'secp256k1/build',
  'secp256k1/src',

  // --- lodash: not needed at runtime (hdwallet-core inlines isObject) ---
  'lodash',

  // --- rxjs: not needed at runtime (hdwallet-core no longer imports it) ---
  'rxjs',

  // --- @cosmjs: TypeScript source dirs ---
  '@cosmjs/amino/src',
  '@cosmjs/crypto/src',
  '@cosmjs/encoding/src',
  '@cosmjs/math/src',
  '@cosmjs/proto-signing/src',
  '@cosmjs/stargate/src',
  '@cosmjs/tendermint-rpc/src',
  '@cosmjs/utils/src',

  // --- cosmjs-types: source not needed ---
  'cosmjs-types/src',

  // --- long: ESM build not needed (main→src/long.js) ---
  'long/umd',
]

// Remove nested node_modules that duplicate top-level packages at the SAME version.
// Keep nested node_modules where the version differs from top-level — these exist because
// the parent package requires a different (often older) version of a dependency.
// e.g. ethereum-cryptography/node_modules/@noble/hashes@1.4.0 vs top-level @noble/hashes@1.8.0
function getPackageVersion(pkgDir: string): string | null {
  try {
    const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    return pj.version || null
  } catch { return null }
}

function stripDuplicateNestedNodeModules(dirPath: string) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = join(dirPath, entry.name)
      if (entry.name === 'node_modules') {
        // Check each package inside this nested node_modules
        try {
          const nestedPkgs = readdirSync(fullPath, { withFileTypes: true })
          for (const pkg of nestedPkgs) {
            if (!pkg.isDirectory()) continue
            const nestedPkgPath = join(fullPath, pkg.name)
            if (pkg.name.startsWith('@')) {
              // Scoped package — check each sub-package
              const scopedPkgs = readdirSync(nestedPkgPath, { withFileTypes: true })
              for (const scoped of scopedPkgs) {
                if (!scoped.isDirectory()) continue
                const scopedPath = join(nestedPkgPath, scoped.name)
                const scopedName = `${pkg.name}/${scoped.name}`
                const nestedVer = getPackageVersion(scopedPath)
                const topVer = getPackageVersion(join(nmDest, scopedName))
                if (nestedVer && topVer && nestedVer === topVer) {
                  rmSync(scopedPath, { recursive: true })
                } else if (nestedVer && topVer && nestedVer !== topVer) {
                  console.log(`  Keeping nested: ${scopedName}@${nestedVer} (top-level: ${topVer})`)
                }
              }
              // Remove the scope dir if empty
              try {
                if (readdirSync(nestedPkgPath).length === 0) rmSync(nestedPkgPath, { recursive: true })
              } catch {}
            } else {
              const nestedVer = getPackageVersion(nestedPkgPath)
              const topVer = getPackageVersion(join(nmDest, pkg.name))
              if (nestedVer && topVer && nestedVer === topVer) {
                rmSync(nestedPkgPath, { recursive: true })
              } else if (nestedVer && topVer && nestedVer !== topVer) {
                console.log(`  Keeping nested: ${pkg.name}@${nestedVer} (top-level: ${topVer})`)
              }
            }
          }
          // Remove the node_modules dir if empty
          try {
            if (readdirSync(fullPath).length === 0) rmSync(fullPath, { recursive: true })
          } catch {}
        } catch {
          // If we can't read it, remove it
          rmSync(fullPath, { recursive: true })
        }
      } else {
        stripDuplicateNestedNodeModules(fullPath)
      }
    }
  } catch {}
}
// Packages that must never appear in the production bundle (contain unsigned binaries, are dev-only, etc.)
// proto-tx-builder@0.9.1 nested in hdwallet-keepkey must be stripped — the vendored
// bundle at top-level has everything inlined and must win resolution.
const STRIP_NESTED_PACKAGES = ['node-notifier', 'jest', 'jest-cli', 'ts-jest', '.cache']
const STRIP_NESTED_SCOPED: Record<string, string[]> = {
  '@keepkey': ['proto-tx-builder'],
}

function stripUnwantedNestedPackages(dirPath: string) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = join(dirPath, entry.name)
      if (entry.name === 'node_modules') {
        // Scan this nested node_modules for unwanted packages
        try {
          const pkgs = readdirSync(fullPath, { withFileTypes: true })
          for (const pkg of pkgs) {
            if (!pkg.isDirectory()) continue
            if (STRIP_NESTED_PACKAGES.includes(pkg.name)) {
              rmSync(join(fullPath, pkg.name), { recursive: true })
              console.log(`  Stripped unwanted nested: ${pkg.name} from ${dirPath.replace(nmDest + sep, '')}`)
            }
            // Strip scoped packages (e.g. @keepkey/proto-tx-builder nested copies)
            if (pkg.name.startsWith('@') && STRIP_NESTED_SCOPED[pkg.name]) {
              const scopedDir = join(fullPath, pkg.name)
              for (const sub of STRIP_NESTED_SCOPED[pkg.name]) {
                const subPath = join(scopedDir, sub)
                if (existsSync(subPath)) {
                  rmSync(subPath, { recursive: true })
                  console.log(`  Stripped unwanted nested: ${pkg.name}/${sub} from ${dirPath.replace(nmDest + sep, '')}`)
                }
              }
              try { if (readdirSync(scopedDir).length === 0) rmSync(scopedDir, { recursive: true }) } catch {}
            }
          }
        } catch {}
      }
      stripUnwantedNestedPackages(fullPath)
    }
  } catch {}
}

stripUnwantedNestedPackages(nmDest)

stripDuplicateNestedNodeModules(nmDest)
console.log(`[collect-externals] Stripped duplicate nested node_modules (kept version-differing deps)`)

// Ensure transitive deps of preserved nested packages are available at the top level.
// Only scan non-@keepkey packages — @keepkey packages are file: deps with huge dev node_modules
// that we don't want to crawl. The real cases are small packages like through2/node_modules/readable-stream.
const collectedExtra = new Set<string>()

function collectMissingNestedDeps(dir: string, depth = 0) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const fullPath = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        // Only process at depth 0 (top-level packages), skip @keepkey and protobufjs
        // which have massive dev-dep trees that aren't needed at runtime
        const parentPkg = dir.replace(nmDest + sep, '')
        if (parentPkg.startsWith('@keepkey/') || parentPkg.startsWith('protobufjs')) continue
        for (const pkg of readdirSync(fullPath, { withFileTypes: true })) {
          if (!pkg.isDirectory()) continue
          const pkgPath = join(fullPath, pkg.name)
          if (pkg.name.startsWith('@')) {
            for (const scoped of readdirSync(pkgPath, { withFileTypes: true })) {
              if (!scoped.isDirectory()) continue
              ensureDepsExist(join(pkgPath, scoped.name))
            }
          } else {
            ensureDepsExist(pkgPath)
          }
        }
      } else if (depth < 1) {
        // Only recurse one level into top-level packages
        collectMissingNestedDeps(fullPath, depth + 1)
      }
    }
  } catch {}
}

function ensureDepsExist(pkgDir: string) {
  try {
    const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    for (const dep of Object.keys(pj.dependencies || {})) {
      if (collectedExtra.has(dep)) continue
      const topDest = join(nmDest, dep)
      if (!existsSync(topDest)) {
        const topSrc = join(nmSource, dep)
        if (existsSync(topSrc)) {
          mkdirSync(dirname(topDest), { recursive: true })
          cpSync(topSrc, topDest, {
            recursive: true,
            filter: (src: string) => !src.slice(topSrc.length).includes(`${sep}node_modules`),
          })
          collectedExtra.add(dep)
          pruneDir(topDest)
          console.log(`  Collected missing nested dep: ${dep} (needed by ${pkgDir.replace(nmDest + sep, '')})`)
        }
      }
    }
  } catch {}
}

collectMissingNestedDeps(nmDest)
if (collectedExtra.size > 0) {
  console.log(`[collect-externals] Collected ${collectedExtra.size} extra deps for nested packages: ${[...collectedExtra].join(', ')}`)
}
let strippedSize = 0
for (const dir of STRIP_DIRS) {
  const target = join(nmDest, dir)
  if (existsSync(target)) {
    const size = getDirSize(target)
    rmSync(target, { recursive: true })
    strippedSize += size
    console.log(`  Stripped: ${dir} (${(size / 1024 / 1024).toFixed(1)}MB)`)
  }
}
console.log(`[collect-externals] Stripped ${(strippedSize / 1024 / 1024).toFixed(1)}MB from large directories`)

// Code-sign all native .node binaries and .dylib files
const DEVELOPER_ID = process.env.ELECTROBUN_DEVELOPER_ID
if (DEVELOPER_ID) {
  console.log(`[collect-externals] Signing native binaries with: ${DEVELOPER_ID}`)
  let signedCount = 0

  function signNativeBinaries(dirPath: string) {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name)
        if (entry.isDirectory()) {
          signNativeBinaries(fullPath)
        } else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || entry.name.endsWith('.so')) {
          const result = Bun.spawnSync([
            'codesign', '--force', '--verbose', '--timestamp',
            '--sign', `Developer ID Application: ${DEVELOPER_ID} (${process.env.ELECTROBUN_TEAMID || ''})`,
            '--options', 'runtime',
            fullPath,
          ])
          if (result.exitCode === 0) {
            signedCount++
            console.log(`  Signed: ${entry.name}`)
          } else {
            console.warn(`  WARN: Failed to sign ${fullPath}: ${result.stderr.toString()}`)
          }
        }
      }
    } catch (e) {
      console.warn(`  WARN: Error scanning for native binaries in ${dirPath}: ${e}`)
    }
  }

  signNativeBinaries(nmDest)
  console.log(`[collect-externals] Signed ${signedCount} native binaries`)
} else {
  console.log(`[collect-externals] ELECTROBUN_DEVELOPER_ID not set, skipping native binary signing`)
}

// Report final size
const finalSize = getDirSize(nmDest)
console.log(`[collect-externals] Final size: ${(finalSize / 1024 / 1024).toFixed(1)}MB`)
