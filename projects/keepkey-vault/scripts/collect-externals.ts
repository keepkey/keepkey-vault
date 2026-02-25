#!/usr/bin/env bun
/**
 * Collects external packages and their transitive dependencies into a staging
 * directory (build/node_modules) so they can be copied into the Electrobun app bundle.
 *
 * Usage: bun scripts/collect-externals.ts
 */
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

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
]

const projectRoot = join(import.meta.dir, '..')
const nmSource = join(projectRoot, 'node_modules')
const nmDest = join(projectRoot, 'build', '_ext_modules')

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

// Copy each package
let copiedCount = 0

for (const dep of sorted) {
  const src = join(nmSource, dep)
  const dst = join(nmDest, dep)

  if (!existsSync(src)) {
    console.warn(`  WARN: ${dep} not found in node_modules, skipping`)
    continue
  }

  // Ensure parent dir exists for scoped packages (@keepkey/...)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
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

// Ensure protobufjs/src is present (minimal.js requires ./src/index-minimal)
try {
  const pbSrc = join(nmSource, 'protobufjs', 'src')
  const pbDst = join(nmDest, 'protobufjs', 'src')
  if (existsSync(pbSrc) && !existsSync(pbDst)) {
    mkdirSync(pbDst, { recursive: true })
    cpSync(pbSrc, pbDst, { recursive: true })
    console.log('[collect-externals] Restored protobufjs/src (required by minimal.js)')
  }
} catch (e) {
  console.warn(`[collect-externals] Failed to restore protobufjs/src: ${e}`)
}

// Remove non-macOS prebuilds, build artifacts, and native source files
const REMOVE_DIRS = ['node_gyp_bins', 'gyp', 'binding.gyp']
const REMOVE_PREBUILD_PREFIXES = ['linux', 'win32', 'android']
// C/C++ source and build artifacts not needed at runtime (~7MB)
const NATIVE_PRUNE_EXTENSIONS = ['.o', '.c', '.h', '.cc', '.cpp', '.gyp', '.gypi', '.vcxproj', '.m4', '.mk', '.am', '.in']

let nativePrunedSize = 0
function cleanNativeArtifacts(dirPath: string) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        // Remove non-macOS prebuilds (HID-win32-*, HID-linux-*, etc.)
        if (REMOVE_PREBUILD_PREFIXES.some(p => entry.name.startsWith(p)) ||
            entry.name.startsWith('HID-win') || entry.name.startsWith('HID-linux') ||
            entry.name.startsWith('HID_hidraw-linux')) {
          try {
            const result = Bun.spawnSync(['du', '-sk', fullPath])
            nativePrunedSize += parseInt(result.stdout.toString().split('\t')[0] || '0', 10) * 1024
          } catch {}
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
stripDuplicateNestedNodeModules(nmDest)
console.log(`[collect-externals] Stripped duplicate nested node_modules (kept version-differing deps)`)
let strippedSize = 0
for (const dir of STRIP_DIRS) {
  const target = join(nmDest, dir)
  if (existsSync(target)) {
    try {
      const result = Bun.spawnSync(['du', '-sk', target])
      const kb = parseInt(result.stdout.toString().split('\t')[0] || '0', 10)
      rmSync(target, { recursive: true })
      strippedSize += kb * 1024
      console.log(`  Stripped: ${dir} (${(kb / 1024).toFixed(1)}MB)`)
    } catch {}
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
const { stdout } = Bun.spawnSync(['du', '-sh', nmDest])
console.log(`[collect-externals] Final size: ${stdout.toString().trim().split('\t')[0]}`)
