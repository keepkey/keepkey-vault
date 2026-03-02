#!/usr/bin/env bun
/**
 * Collects external packages and their transitive dependencies into a staging
 * directory (build/node_modules) so they can be copied into the Electrobun app bundle.
 *
 * Usage: bun scripts/collect-externals.ts
 */
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

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

// Resolve file: linked packages to their actual source directories.
// Bun's file: resolution can leave broken stubs in node_modules (empty dir with only node_modules/).
// We read package.json's dependencies to find the real path for file: references.
const fileLinkedPaths = new Map<string, string>()
try {
  const rootPj = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
  for (const [name, spec] of Object.entries({ ...rootPj.dependencies, ...rootPj.overrides } as Record<string, string>)) {
    if (spec.startsWith('file:')) {
      const relPath = spec.slice(5)
      const absPath = resolve(projectRoot, relPath)
      if (existsSync(join(absPath, 'package.json'))) {
        fileLinkedPaths.set(name, absPath)
      }
    }
  }
  if (fileLinkedPaths.size > 0) {
    console.log(`[collect-externals] Resolved ${fileLinkedPaths.size} file: linked packages:`)
    for (const [name, path] of fileLinkedPaths) console.log(`  ${name} → ${path}`)
  }
} catch (e) {
  console.warn(`[collect-externals] WARN: Could not resolve file: links: ${e}`)
}

// Recursively collect all transitive dependencies
const allDeps = new Set<string>(EXTERNALS)
// Track nested packages that need their own node_modules copied
const nestedCopies: { src: string; dst: string }[] = []

// Dev-time packages that should NEVER be collected (they get pulled in via nested dep chains)
const DEV_BLOCKLIST = new Set([
  // --- Jest ecosystem ---
  'jest', 'jest-cli', 'jest-config', 'jest-runtime', 'jest-runner', 'jest-worker',
  'jest-haste-map', 'jest-resolve', 'jest-snapshot', 'jest-validate', 'jest-matcher-utils',
  'jest-message-util', 'jest-util', 'jest-environment-node', 'jest-environment-jsdom',
  'jest-changed-files', 'jest-circus', 'jest-each', 'jest-jasmine2', 'jest-leak-detector',
  'jest-mock', 'jest-pnp-resolver', 'jest-regex-util', 'jest-serializer', 'jest-watcher',
  'jest-docblock', 'babel-jest',
  '@jest/core', '@jest/console', '@jest/environment', '@jest/fake-timers', '@jest/globals',
  '@jest/reporters', '@jest/source-map', '@jest/test-result', '@jest/test-sequencer',
  '@jest/transform', '@jest/types',
  // --- Babel ecosystem ---
  '@babel/core', '@babel/cli', '@babel/preset-env', '@babel/preset-typescript',
  '@babel/plugin-transform-modules-commonjs', '@babel/code-frame', '@babel/generator',
  '@babel/helper-compilation-targets', '@babel/helper-function-name',
  '@babel/helper-hoist-variables', '@babel/helper-module-imports',
  '@babel/helper-module-transforms', '@babel/helper-plugin-utils',
  '@babel/helper-simple-access', '@babel/helper-split-export-declaration',
  '@babel/helper-validator-identifier', '@babel/helper-validator-option',
  '@babel/helpers', '@babel/highlight', '@babel/parser', '@babel/template',
  '@babel/traverse', '@babel/types', '@babel/compat-data',
  'babel-preset-current-node-syntax', 'babel-plugin-istanbul',
  // --- Istanbul / coverage ---
  'istanbul-lib-instrument', 'istanbul-lib-source-maps', 'istanbul-lib-report',
  'istanbul-lib-coverage', 'istanbul-reports', '@istanbuljs/load-nyc-config',
  '@istanbuljs/schema',
  // --- JSDOM / browser simulation ---
  'jsdom', 'pretty-format', 'expect', 'diff-sequences',
  'domexception', 'cssstyle', 'cssom', 'data-urls', 'html-encoding-sniffer',
  'nwsapi', 'saxes', 'symbol-tree', 'w3c-hr-time', 'w3c-xmlserializer',
  'whatwg-encoding', 'whatwg-mimetype', 'whatwg-url', 'webidl-conversions',
  'xml-name-validator', 'abab', 'acorn-globals', 'escodegen', 'estraverse',
  'esutils', 'iconv-lite', 'decimal.js',
  // --- Build tools ---
  '@vitejs/plugin-react', 'vite',
  'ts-jest', 'ts-node', 'typescript',
  // --- File watchers / dev tools (pulled in by proto-tx-builder's dev deps) ---
  'sane', 'fb-watchman', 'walker', 'makeerror', 'tmpl',
  'import-local', 'resolve-cwd',
  // --- V8 / source map dev tools ---
  'v8-to-istanbul', 'collect-v8-coverage', 'source-map-support',
  // --- ts-proto build tooling ---
  'ts-proto', 'ts-proto-descriptors', 'ts-poet', 'dprint-node',
  'case-anything',
  // --- Sinon / test mocking ---
  '@sinonjs/commons', '@sinonjs/fake-timers',
  // --- @types (runtime doesn't need type declarations) ---
  '@types/babel__core', '@types/babel__generator', '@types/babel__template',
  '@types/babel__traverse', '@types/istanbul-lib-coverage', '@types/istanbul-lib-report',
  '@types/istanbul-reports', '@types/prettier', '@types/stack-utils',
  '@types/yargs', '@types/yargs-parser', '@types/minimatch',
  '@types/normalize-package-data', '@types/graceful-fs',
  // --- More jest sub-deps ---
  'jest-diff', 'jest-get-type', 'jest-resolve-dependencies',
  'babel-plugin-jest-hoist', 'babel-preset-jest',
  'jest-environment-jsdom',
  // --- @bcoe/v8-coverage (test tooling) ---
  '@bcoe/v8-coverage',
  // --- @cnakazawa/watch (file watcher) ---
  '@cnakazawa/watch',
  // --- Other dev-time packages ---
  'capture-exit', 'exec-sh', 'rsvp', 'shellwords',
  'test-exclude', 'throat', 'p-each-series',
  'growly', 'is-wsl', 'node-notifier',
  'node-int64', 'parse5',
  // --- Dead chain SDK (Binance Beacon Chain is decommissioned) ---
  'bnb-javascript-sdk-nobroadcast',
])

// Read deps from a nested package dir and add them to allDeps (so they get collected at top level).
// Uses DEV_BLOCKLIST to prevent pulling in dev-time packages.
function addNestedDeps(nestedPkgDir: string) {
  try {
    const pjPath = join(nestedPkgDir, 'package.json')
    if (!existsSync(pjPath)) return
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    for (const dep of Object.keys(pj.dependencies || {})) {
      if (!allDeps.has(dep) && !DEV_BLOCKLIST.has(dep)) {
        allDeps.add(dep)
        addDeps(dep)
      }
    }
  } catch {}
}

function addDeps(pkg: string) {
  try {
    // For file: linked packages, read package.json from the actual source directory
    const pkgDir = fileLinkedPaths.get(pkg) || join(nmSource, pkg)
    const pjPath = join(pkgDir, 'package.json')
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    for (const dep of Object.keys(pj.dependencies || {})) {
      if (!allDeps.has(dep) && !DEV_BLOCKLIST.has(dep)) {
        allDeps.add(dep)
        addDeps(dep)
      }
    }
    // Also check for nested node_modules (version-differing deps).
    // These exist because the nested version differs from top-level (e.g. readable-stream@2 vs @3).
    // We must also discover the nested package's OWN deps so they get collected at top level.
    // Skip @keepkey/* packages — their nested node_modules are lerna monorepo artifacts
    // that we strip entirely (their deps are already collected at top-level).
    if (pkg.startsWith('@keepkey/')) return
    const nestedNm = join(nmSource, pkg, 'node_modules')
    if (existsSync(nestedNm)) {
      try {
        for (const entry of readdirSync(nestedNm, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const nestedPkgDir = join(nestedNm, entry.name)
          if (entry.name.startsWith('@')) {
            for (const sub of readdirSync(nestedPkgDir, { withFileTypes: true })) {
              if (!sub.isDirectory()) continue
              const scopedName = `${entry.name}/${sub.name}`
              nestedCopies.push({
                src: join(nestedPkgDir, sub.name),
                dst: join(nmDest, pkg, 'node_modules', entry.name, sub.name),
              })
              // Add nested package's deps to allDeps so they get collected at top level
              addNestedDeps(join(nestedPkgDir, sub.name))
            }
          } else {
            nestedCopies.push({
              src: nestedPkgDir,
              dst: join(nmDest, pkg, 'node_modules', entry.name),
            })
            // Add nested package's deps to allDeps so they get collected at top level
            addNestedDeps(nestedPkgDir)
          }
        }
      } catch {}
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
  // For file: linked packages, copy from the actual source directory
  const src = fileLinkedPaths.get(dep) || join(nmSource, dep)
  const dst = join(nmDest, dep)

  if (!existsSync(src)) {
    console.warn(`  WARN: ${dep} not found in node_modules, skipping`)
    continue
  }

  // Verify the source has actual content (not just an empty node_modules stub)
  const hasPj = existsSync(join(src, 'package.json'))
  if (!hasPj && fileLinkedPaths.has(dep)) {
    console.warn(`  WARN: ${dep} file: link target has no package.json, skipping`)
    continue
  }

  // Ensure parent dir exists for scoped packages (@keepkey/...)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  copiedCount++
}

console.log(`[collect-externals] Copied ${copiedCount} packages to ${nmDest}`)

// Strip node_modules from @keepkey/* packages (file: deps).
// These are lerna monorepo artifacts — Bun copies the entire directory including
// node_modules when resolving file: references. All their deps are already
// collected at top-level by this script, so the nested copies are pure bloat.
const keepkeyDir = join(nmDest, '@keepkey')
if (existsSync(keepkeyDir)) {
  let strippedKK = 0
  for (const entry of readdirSync(keepkeyDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nestedNm = join(keepkeyDir, entry.name, 'node_modules')
    if (existsSync(nestedNm)) {
      const result = Bun.spawnSync(['du', '-sk', nestedNm])
      const kb = parseInt(result.stdout.toString().split('\t')[0] || '0', 10)
      rmSync(nestedNm, { recursive: true })
      strippedKK += kb
    }
  }
  if (strippedKK > 0) {
    console.log(`[collect-externals] Stripped ${(strippedKK / 1024).toFixed(1)}MB from @keepkey/*/node_modules (file: dep artifacts)`)
  }
}

// Copy nested node_modules (version-differing deps that packages need)
let nestedCount = 0
for (const { src, dst } of nestedCopies) {
  if (!existsSync(src)) continue
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  nestedCount++
}
if (nestedCount > 0) {
  console.log(`[collect-externals] Copied ${nestedCount} nested version-differing deps`)
}

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

// Remove prebuilds for OTHER platforms, build artifacts, and native source files
const REMOVE_DIRS = ['node_gyp_bins', 'gyp', 'binding.gyp']
// Platform-aware: keep prebuilds for the current build platform, strip the rest
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const REMOVE_PREBUILD_PREFIXES = isWindows
  ? ['linux', 'darwin', 'android']
  : isMac
    ? ['linux', 'win32', 'android']
    : ['darwin', 'win32', 'android'] // linux build
// HID prebuild directory prefixes (node-hid uses HID-{platform}-{arch} naming)
const REMOVE_HID_PREFIXES = isWindows
  ? ['HID-linux', 'HID-darwin', 'HID_hidraw-linux']
  : isMac
    ? ['HID-win', 'HID-linux', 'HID_hidraw-linux']
    : ['HID-win', 'HID-darwin']
// C/C++ source and build artifacts not needed at runtime (~7MB)
const NATIVE_PRUNE_EXTENSIONS = ['.o', '.c', '.h', '.cc', '.cpp', '.gyp', '.gypi', '.vcxproj', '.m4', '.mk', '.am', '.in']

let nativePrunedSize = 0
function cleanNativeArtifacts(dirPath: string) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        // Remove prebuilds for other platforms (HID-win32-*, linux-x64-*, etc.)
        if (REMOVE_PREBUILD_PREFIXES.some(p => entry.name.startsWith(p)) ||
            REMOVE_HID_PREFIXES.some(p => entry.name.startsWith(p))) {
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

  // NOTE: lodash and rxjs are runtime deps of hdwallet-core — do NOT strip them

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

  // --- node-notifier: test/dev utility, contains unsigned macOS binary (terminal-notifier.app) ---
  'node-notifier',
  '@keepkey/proto-tx-builder/node_modules/node-notifier',
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

// Recursively remove packages that should never ship (contain unsigned binaries, test utils, etc.)
const BANNED_PACKAGES = ['node-notifier', 'growly', 'is-wsl']
function removeBannedPackages(dirPath: string) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = join(dirPath, entry.name)
      if (BANNED_PACKAGES.includes(entry.name)) {
        rmSync(fullPath, { recursive: true })
        console.log(`  Removed banned package: ${fullPath.replace(nmDest + '/', '')}`)
      } else {
        removeBannedPackages(fullPath)
      }
    }
  } catch {}
}
removeBannedPackages(nmDest)

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
        } else if (entry.name.endsWith('.node') || entry.name.endsWith('.dylib') || entry.name.endsWith('.so') || entry.name.endsWith('.app')) {
          // For .app bundles, sign the whole bundle
        } else if (!entry.name.includes('.') && entry.isFile()) {
          // Check if extensionless file is a Mach-O binary
          try {
            const header = new Uint8Array(readFileSync(fullPath).buffer, 0, 4)
            const magic = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3]
            const isMachO = magic === 0xFEEDFACE || magic === 0xFEEDFACF || magic === 0xCEFAEDFE || magic === 0xCFFAEDFE || magic === 0xCAFEBABE
            if (!isMachO) continue
          } catch { continue }
        } else {
          continue
        }
        {
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
