#!/usr/bin/env bun
/**
 * Post-build pruner: strips bloat from the Electrobun app bundle.
 *
 * Electrobun copies node_modules from build/_ext_modules into the app's
 * tar.zst archive. Even after collect-externals.ts prunes the staging dir,
 * Bun's `file:` dep resolution can re-introduce nested node_modules and
 * other artifacts. This script operates on the final tar.zst archive.
 *
 * Usage: bun scripts/prune-app-bundle.ts [stable|canary|dev]
 */
import { existsSync, readFileSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'

const env = process.argv[2] || 'stable'
const projectRoot = join(import.meta.dir, '..')
const buildDir = join(projectRoot, 'build')
const artifactsDir = join(projectRoot, 'artifacts')

// Find the .app.tar.zst
function findTarZst(): string | null {
  for (const dir of [artifactsDir, buildDir]) {
    if (!existsSync(dir)) continue
    const entries = readdirSync(dir)
    const match = entries.find(e => e.endsWith('.app.tar.zst'))
    if (match) return join(dir, match)
  }
  return null
}

const tarZst = findTarZst()
if (!tarZst) {
  console.log('[prune-bundle] No .app.tar.zst found, skipping pruning')
  process.exit(0)
}

console.log(`[prune-bundle] Pruning: ${tarZst}`)

// Create temp dir
const tmpDir = join(buildDir, '_prune_tmp')
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
mkdirSync(tmpDir, { recursive: true })

const tarFile = join(tmpDir, 'app.tar')

// Decompress zstd → tar
console.log('[prune-bundle] Decompressing...')
let result = Bun.spawnSync(['zstd', '-d', tarZst, '-o', tarFile, '--force'], { cwd: tmpDir })
if (result.exitCode !== 0) {
  console.error(`[prune-bundle] zstd decompress failed: ${result.stderr.toString()}`)
  process.exit(1)
}

// Extract tar
console.log('[prune-bundle] Extracting...')
result = Bun.spawnSync(['tar', 'xf', tarFile, '-C', tmpDir])
if (result.exitCode !== 0) {
  console.error(`[prune-bundle] tar extract failed: ${result.stderr.toString()}`)
  process.exit(1)
}
rmSync(tarFile)

// Find the .app directory
const appDir = readdirSync(tmpDir).find(e => e.endsWith('.app'))
if (!appDir) {
  console.error('[prune-bundle] No .app found after extraction')
  process.exit(1)
}

const appPath = join(tmpDir, appDir)
const resourcesDir = join(appPath, 'Contents', 'Resources')

// Find node_modules inside the app bundle
function findNodeModules(dir: string): string | null {
  if (!existsSync(dir)) return null
  // Check common Electrobun locations
  const candidates = [
    join(dir, 'node_modules'),
    join(dir, 'bun', 'node_modules'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Search recursively (max depth 3)
  return findRecursive(dir, 'node_modules', 0, 3)
}

function findRecursive(dir: string, target: string, depth: number, maxDepth: number): string | null {
  if (depth > maxDepth) return null
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === target) return join(dir, entry.name)
        const found = findRecursive(join(dir, entry.name), target, depth + 1, maxDepth)
        if (found) return found
      }
    }
  } catch {}
  return null
}

const nmDir = findNodeModules(resourcesDir) || findNodeModules(appPath)
if (!nmDir) {
  console.log('[prune-bundle] No node_modules found in app bundle, nothing to prune')
  rmSync(tmpDir, { recursive: true })
  process.exit(0)
}

console.log(`[prune-bundle] Found node_modules at: ${nmDir.replace(tmpDir, '...')}`)

// Get size before
const sizeBefore = parseInt(Bun.spawnSync(['du', '-sk', nmDir]).stdout.toString().split('\t')[0] || '0', 10)

// === PRUNING ===
let prunedFiles = 0
let prunedDirs = 0

// Helper: read version from package.json
function getPackageVersion(pkgDir: string): string | null {
  try {
    const pjPath = join(pkgDir, 'package.json')
    if (!existsSync(pjPath)) return null
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    return pj.version || null
  } catch { return null }
}

// 1. Remove nested node_modules that DUPLICATE top-level packages at the same version.
//    KEEP nested packages where the version differs — these are required by the parent
//    package (e.g. ethereum-cryptography needs @noble/hashes@1.4.0, top-level has @1.8.0).
function stripDuplicateNestedNodeModules(dir: string) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const fullPath = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        // Check each package inside this nested node_modules
        try {
          const nestedPkgs = readdirSync(fullPath, { withFileTypes: true })
          for (const pkg of nestedPkgs) {
            if (!pkg.isDirectory()) continue
            const nestedPkgPath = join(fullPath, pkg.name)
            if (pkg.name.startsWith('@')) {
              // Scoped package — check each sub-package
              try {
                const scopedPkgs = readdirSync(nestedPkgPath, { withFileTypes: true })
                for (const scoped of scopedPkgs) {
                  if (!scoped.isDirectory()) continue
                  const scopedPath = join(nestedPkgPath, scoped.name)
                  const scopedName = `${pkg.name}/${scoped.name}`
                  const nestedVer = getPackageVersion(scopedPath)
                  const topVer = getPackageVersion(join(nmDir, scopedName))
                  if (nestedVer && topVer && nestedVer === topVer) {
                    rmSync(scopedPath, { recursive: true })
                    prunedDirs++
                  }
                  // else: version differs or missing top-level → keep it
                }
                // Remove the scope dir if empty
                try {
                  if (readdirSync(nestedPkgPath).length === 0) rmSync(nestedPkgPath, { recursive: true })
                } catch {}
              } catch {}
            } else {
              const nestedVer = getPackageVersion(nestedPkgPath)
              const topVer = getPackageVersion(join(nmDir, pkg.name))
              if (nestedVer && topVer && nestedVer === topVer) {
                rmSync(nestedPkgPath, { recursive: true })
                prunedDirs++
              }
              // else: version differs or missing top-level → keep it
            }
          }
          // Remove the node_modules dir if empty
          try {
            if (readdirSync(fullPath).length === 0) {
              rmSync(fullPath, { recursive: true })
              prunedDirs++
            }
          } catch {}
        } catch {
          // If we can't read it, leave it alone (safer than deleting)
        }
      } else {
        stripDuplicateNestedNodeModules(fullPath)
      }
    }
  } catch {}
}

// Only strip nested node_modules INSIDE packages, not the top-level one
for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const pkgDir = join(nmDir, entry.name)
  if (entry.name.startsWith('@')) {
    // Scoped package — go one level deeper
    for (const sub of readdirSync(pkgDir, { withFileTypes: true })) {
      if (sub.isDirectory()) stripDuplicateNestedNodeModules(join(pkgDir, sub.name))
    }
  } else {
    stripDuplicateNestedNodeModules(pkgDir)
  }
}
console.log(`[prune-bundle] Stripped ${prunedDirs} duplicate nested deps (kept version-differing)`)

// 2. Remove files by extension
function pruneFilesByExtension(dir: string) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        pruneFilesByExtension(fullPath)
        continue
      }
      if (
        entry.name.endsWith('.d.ts') ||
        entry.name.endsWith('.d.ts.map') ||
        entry.name.endsWith('.d.mts') ||
        entry.name.endsWith('.d.cts') ||
        entry.name.endsWith('.map') ||
        entry.name.endsWith('.flow') ||
        entry.name.endsWith('.mts') ||
        entry.name.endsWith('.cts') ||
        (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.cts') && !entry.name.endsWith('.mts'))
      ) {
        try { rmSync(fullPath); prunedFiles++ } catch {}
      }
    }
  } catch {}
}
pruneFilesByExtension(nmDir)
console.log(`[prune-bundle] Pruned ${prunedFiles} type/map/source files`)

// 3. Remove known bloat directories
const STRIP_DIRS = [
  'lodash', 'rxjs',
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

let strippedDirs = 0
for (const dir of STRIP_DIRS) {
  const target = join(nmDir, dir)
  if (existsSync(target)) {
    rmSync(target, { recursive: true })
    strippedDirs++
  }
}
console.log(`[prune-bundle] Stripped ${strippedDirs} bloat directories`)

// 4. Remove doc/test files by name
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
// (e.g. @swagger-api ships runtime code in a dir named "license/")
// Only pruned at package root (depth 1 inside each package), never recursively
const ROOT_ONLY_PRUNE = new Set([
  'README', 'CHANGELOG', 'LICENSE', 'license', 'LICENCE', 'AUTHORS',
  '.github', '.nyc_output', 'coverage',
  'test', 'tests', '__tests__', '__mocks__', 'spec', 'benchmark', 'benchmarks',
])

let docPruned = 0
function pruneByName(dir: string) {
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
// Prune ROOT_ONLY names at package root level only
function pruneRootOnly(nmBase: string) {
  try {
    for (const pkg of readdirSync(nmBase, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const pkgDir = join(nmBase, pkg.name)
      // Handle scoped packages (@org/pkg)
      if (pkg.name.startsWith('@')) {
        for (const sub of readdirSync(pkgDir, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue
          const scopedDir = join(pkgDir, sub.name)
          for (const entry of readdirSync(scopedDir, { withFileTypes: true })) {
            if (ROOT_ONLY_PRUNE.has(entry.name)) {
              rmSync(join(scopedDir, entry.name), { recursive: true })
              docPruned++
            }
          }
        }
      } else {
        for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
          if (ROOT_ONLY_PRUNE.has(entry.name)) {
            rmSync(join(pkgDir, entry.name), { recursive: true })
            docPruned++
          }
        }
      }
    }
  } catch {}
}
pruneByName(nmDir)
pruneRootOnly(nmDir)
console.log(`[prune-bundle] Pruned ${docPruned} doc/test entries`)

// 5. Remove C/C++ source and native build artifacts
const NATIVE_EXTS = new Set(['.o', '.c', '.h', '.cc', '.cpp', '.gyp', '.gypi', '.vcxproj', '.m4', '.mk', '.am', '.in'])
let nativePruned = 0
function pruneNative(dir: string) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Remove non-macOS prebuilds
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
console.log(`[prune-bundle] Pruned ${nativePruned} native build artifacts`)

// Get size after
const sizeAfter = parseInt(Bun.spawnSync(['du', '-sk', nmDir]).stdout.toString().split('\t')[0] || '0', 10)
const savedMB = ((sizeBefore - sizeAfter) / 1024).toFixed(1)
console.log(`[prune-bundle] node_modules: ${(sizeBefore / 1024).toFixed(1)}MB → ${(sizeAfter / 1024).toFixed(1)}MB (saved ${savedMB}MB)`)

// === RE-PACK ===

// Re-sign native binaries after pruning (signatures may have been invalidated)
const DEVELOPER_ID = process.env.ELECTROBUN_DEVELOPER_ID
const TEAM_ID = process.env.ELECTROBUN_TEAMID
if (DEVELOPER_ID && TEAM_ID) {
  console.log('[prune-bundle] Re-signing native binaries...')
  let signedCount = 0
  function signBinaries(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          signBinaries(fullPath)
        } else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || entry.name.endsWith('.so')) {
          const r = Bun.spawnSync([
            'codesign', '--force', '--verbose', '--timestamp',
            '--sign', `Developer ID Application: ${DEVELOPER_ID} (${TEAM_ID})`,
            '--options', 'runtime',
            fullPath,
          ])
          if (r.exitCode === 0) signedCount++
        }
      }
    } catch {}
  }
  signBinaries(nmDir)
  console.log(`[prune-bundle] Re-signed ${signedCount} native binaries`)
}

// Re-sign the entire .app bundle with entitlements (JIT required for Bun)
const entitlementsPath = join(projectRoot, 'entitlements.plist')
if (DEVELOPER_ID && TEAM_ID) {
  console.log('[prune-bundle] Re-signing .app bundle with entitlements...')
  const signArgs = [
    'codesign', '--force', '--deep', '--verbose', '--timestamp',
    '--sign', `Developer ID Application: ${DEVELOPER_ID} (${TEAM_ID})`,
    '--options', 'runtime',
  ]
  if (existsSync(entitlementsPath)) {
    signArgs.push('--entitlements', entitlementsPath)
  }
  signArgs.push(appPath)
  result = Bun.spawnSync(signArgs)
  if (result.exitCode !== 0) {
    console.warn(`[prune-bundle] WARNING: .app re-signing failed: ${result.stderr.toString()}`)
  } else {
    console.log('[prune-bundle] .app re-signed successfully')
  }
}

// Re-create tar
console.log('[prune-bundle] Re-packing tar...')
const newTarFile = join(tmpDir, 'app-pruned.tar')
result = Bun.spawnSync(['tar', 'cf', newTarFile, '-C', tmpDir, appDir])
if (result.exitCode !== 0) {
  console.error(`[prune-bundle] tar create failed: ${result.stderr.toString()}`)
  process.exit(1)
}

// Re-compress with zstd
console.log('[prune-bundle] Compressing with zstd...')
const newTarZst = tarZst + '.pruned'
result = Bun.spawnSync(['zstd', '-19', '--force', '-o', newTarZst, newTarFile])
if (result.exitCode !== 0) {
  console.error(`[prune-bundle] zstd compress failed: ${result.stderr.toString()}`)
  process.exit(1)
}

// Replace original
rmSync(tarZst)
Bun.spawnSync(['mv', newTarZst, tarZst])

// Cleanup
rmSync(tmpDir, { recursive: true })

// Report
const origSize = parseInt(Bun.spawnSync(['du', '-sk', tarZst]).stdout.toString().split('\t')[0] || '0', 10)
console.log(`[prune-bundle] Final archive: ${(origSize / 1024).toFixed(1)}MB`)
console.log('[prune-bundle] Done!')
