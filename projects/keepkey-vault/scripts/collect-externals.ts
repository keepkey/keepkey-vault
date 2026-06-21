#!/usr/bin/env bun
/**
 * Collects external packages and their transitive dependencies into a staging
 * directory (build/node_modules) so they can be copied into the Electrobun app bundle.
 *
 * Usage: bun scripts/collect-externals.ts
 */
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

function directorySizeBytes(dirPath: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = join(dirPath, entry.name)
      try {
        if (entry.isDirectory()) {
          total += directorySizeBytes(fullPath)
        } else if (entry.isFile()) {
          total += statSync(fullPath).size
        }
      } catch {}
    }
  } catch {}
  return total
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${bytes}B`
}

// Only packages left external by scripts/bundle-backend.ts.
// Everything else (ethers, pioneer, swagger, cosmjs, protobuf, @keepkey/*)
// is pre-bundled into a single index.js. This reduces installed file count
// from ~13,400 to ~100, cutting Windows Defender first-launch scan from 56s to ~5s.
const EXTERNALS = [
  'node-hid',
  'usb',
  'google-protobuf',
  '@keepkey/proto-tx-builder',
  'swagger-client',
  // WalletConnect: marked external in bundle-backend.ts (ESM/CJS dual-package
  // resolution breaks in Bun bundler). Must be present at runtime.
  '@walletconnect/web3wallet',
  '@walletconnect/core',
  '@walletconnect/types',
  '@walletconnect/utils',
  '@walletconnect/jsonrpc-utils',
  // Transitive deps of version-differing nested WC packages (not hoisted to top level)
  '@stablelib/ed25519',
  'fast-redact',
  'duplexify',
  // Marked external in bundle-backend.ts (large JSON sub-path imports Bun's
  // bundler refuses in fresh-install CI). Must be copied so runtime require works.
  '@pioneer-platform/pioneer-discovery',
]

const projectRoot = join(import.meta.dir, '..')
const nmSource = join(projectRoot, 'node_modules')
const nmDest = join(projectRoot, '_build', '_ext_modules')

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
  // --- TypeScript type packages (not needed at runtime) ---
  'types-ramda',
])

// Read deps from a nested package dir and add them to allDeps (so they get collected at top level).
// Uses DEV_BLOCKLIST to prevent pulling in dev-time packages.
// Recursively walks the nested package's OWN nested node_modules to find deps
// (e.g. @walletconnect/logger/node_modules/pino needs its own fast-redact).
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
    // Also recurse into THIS nested package's own node_modules —
    // e.g. @walletconnect/logger/node_modules/pino has its own deps.
    const innerNm = join(nestedPkgDir, 'node_modules')
    if (existsSync(innerNm)) {
      for (const entry of readdirSync(innerNm, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const innerPkgDir = join(innerNm, entry.name)
        if (entry.name.startsWith('@')) {
          for (const sub of readdirSync(innerPkgDir, { withFileTypes: true })) {
            if (sub.isDirectory()) addNestedDeps(join(innerPkgDir, sub.name))
          }
        } else {
          addNestedDeps(innerPkgDir)
        }
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
  cpSync(src, dst, { recursive: true, dereference: true })
  copiedCount++
}

console.log(`[collect-externals] Copied ${copiedCount} packages to ${nmDest}`)

// Strip node_modules from file:-linked packages in the staging area.
// npm/bun may have installed transitive deps INSIDE the source directory
// (e.g. modules/proto-tx-builder/node_modules/). These should be resolved
// at top level, not nested. Leaving them causes Inno Setup MAX_PATH failures.
for (const [name] of fileLinkedPaths) {
  const nestedNm = join(nmDest, name, 'node_modules')
  if (existsSync(nestedNm)) {
    rmSync(nestedNm, { recursive: true })
    console.log(`[collect-externals] Stripped nested node_modules from file:-linked ${name}`)
  }
}

// device-protocol is now bundled into index.js by bundle-backend.ts,
// so we no longer need to verify messages_pb.js here.

// Copy nested node_modules (version-differing deps that packages need)
let nestedCount = 0
for (const { src, dst } of nestedCopies) {
  if (!existsSync(src)) continue
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true, dereference: true })
  nestedCount++
}
if (nestedCount > 0) {
  console.log(`[collect-externals] Copied ${nestedCount} nested version-differing deps`)
}

// Prune unnecessary files to reduce bundle size
// SAFE_PRUNE: can be removed anywhere in the tree (files/config that are never runtime code)
const SAFE_PRUNE = new Set([
  'README.md', 'readme.md', 'README', 'CHANGELOG.md', 'CHANGELOG', 'HISTORY.md',
  'LICENSE.md', 'LICENSE.txt', 'LICENCE.md',
  'CONTRIBUTING.md', '.npmignore', '.eslintrc', '.eslintrc.js', '.eslintrc.json',
  '.prettierrc', '.prettierrc.js', '.editorconfig', '.travis.yml', '.github',
  'tsconfig.json', 'tsconfig.tsbuildinfo', '.babelrc', 'babel.config.js',
  'jest.config.js', 'jest.config.ts', 'karma.conf.js', '.nyc_output',
  'SECURITY.md', 'CODE_OF_CONDUCT.md', 'AUTHORS',
])

// ROOT_ONLY_PRUNE: directories that should ONLY be pruned at a package root (direct child
// of a dir with package.json). Some packages (e.g. @swaggerexpert/json-pointer,
// @swagger-api/apidom-ns-openapi-3-0) ship runtime code inside dirs named "test" or "license",
// so we can't blindly remove these deep in the tree.
const ROOT_ONLY_PRUNE = new Set([
  'test', 'tests', '__tests__', '__mocks__', 'spec',
  'benchmark', 'benchmarks', 'coverage',
  'LICENSE', 'license', 'LICENCE',
])

let prunedCount = 0
let prunedSize = 0

function pruneDir(dirPath: string, isPackageRoot: boolean) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      // Always-safe prune (docs, config, metadata)
      if (SAFE_PRUNE.has(entry.name)) {
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
      // Root-only prune: only remove test/coverage dirs at package root level
      if (isPackageRoot && entry.isDirectory() && ROOT_ONLY_PRUNE.has(entry.name)) {
        try {
          rmSync(fullPath, { recursive: true })
          prunedCount++
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
      // Recurse into directories — mark as package root if it has a package.json
      if (entry.isDirectory()) {
        const childIsRoot = existsSync(join(fullPath, 'package.json'))
        pruneDir(fullPath, childIsRoot)
      }
    }
  } catch (e) {
    console.warn(`  WARN: Error scanning directory ${dirPath}: ${e}`)
  }
}

pruneDir(nmDest, false)
console.log(`[collect-externals] Pruned ${prunedCount} files/dirs (${(prunedSize / 1024 / 1024).toFixed(1)}MB removed)`)

// Remove prebuilds for OTHER platforms, build artifacts, and native source files
const REMOVE_DIRS = ['node_gyp_bins', 'gyp', 'binding.gyp']
// Platform + architecture aware: keep prebuilds only for the current build target
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const isArm64 = process.arch === 'arm64'
const isX64 = process.arch === 'x64'
console.log(`[collect-externals] Platform: ${process.platform}, Arch: ${process.arch}`)
const REMOVE_PREBUILD_PREFIXES = isWindows
  ? ['linux', 'darwin', 'android']
  : isMac
    ? ['linux', 'win32', 'android']
    : ['darwin', 'win32', 'android'] // linux build
// HID prebuild directory prefixes (node-hid uses HID-{platform}-{arch} naming)
// On macOS, filter by architecture so only the matching HID binary is bundled.
const REMOVE_HID_PREFIXES: string[] = isWindows
  ? ['HID-linux', 'HID-darwin', 'HID_hidraw-linux']
  : isMac
    ? [
        'HID-win', 'HID-linux', 'HID_hidraw-linux',
        // Strip the OTHER macOS architecture to reduce bundle size
        ...(isArm64 ? ['HID-darwin-x64'] : []),
        ...(isX64 ? ['HID-darwin-arm64'] : []),
      ]
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
          nativePrunedSize += directorySizeBytes(fullPath)
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
  // keep osmosis-frontend — dist/proto/index.js requires ../../osmosis-frontend/src/proto/generated/codecimpl

  // --- protobufjs: CLI tooling + dist bundles (keep src/ — minimal.js requires ./src/index-minimal) ---
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

  // --- types-ramda: TypeScript types, not needed at runtime ---
  'types-ramda',
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

// Parse "5.7.0" / "5.7.0-beta.1" → [5,7,0]; returns null if unparseable.
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// True when the top-level copy can safely satisfy a nested copy, making the
// nested one redundant (Node resolution falls back UP to top-level):
//   - identical versions, OR
//   - same MAJOR (>=1) and top-level is the same-or-newer minor/patch.
// Per semver a caret range (^x.y.z — how the ethers/@ethersproject 5.x ecosystem
// pins itself) is satisfied by any same-major, >= version, so collapsing the
// nested ethers@5.7.x to top-level ethers@5.8.0 is safe and matches the version
// the app's own EVM paths already load. We deliberately do NOT collapse 0.x
// packages (every 0.minor is a breaking change — e.g. @cosmjs 0.28 vs 0.29,
// axios 0.21 vs 0.27) or cross-major copies (ws 7 vs 8): those stay nested.
function topLevelSupersedes(nestedVer: string, topVer: string): boolean {
  if (nestedVer === topVer) return true
  const n = parseSemver(nestedVer), t = parseSemver(topVer)
  if (!n || !t) return false
  if (n[0] < 1 || n[0] !== t[0]) return false
  if (t[1] !== n[1]) return t[1] > n[1]
  return t[2] >= n[2]
}

// Long-path-safe recursive removal. Deeply re-nested node_modules (e.g. the
// @ethersproject chain inside pioneer-discovery's ethers@5.7.2) exceed Windows
// MAX_PATH; a bare rmSync fails partway and leaves broken shadow dirs (the reason
// same-version nested dedupe used to be skipped on Windows). The \\?\ extended-
// length prefix lets the removal complete on >260-char paths so the dedupe can
// run on Windows too, instead of shipping a tree Inno Setup can't package.
function rmTreeSafe(p: string) {
  const target = process.platform === 'win32' ? '\\\\?\\' + resolve(p) : p
  rmSync(target, { recursive: true, force: true })
}

// The Windows installer stages the bundle under
// C:\tmp\kk\Resources\app\node_modules\<rel> before Inno Setup packages it, and
// Inno chokes as paths approach MAX_PATH (260). This prefix is that staged root;
// a file's staged length ≈ STAGE_PREFIX_LEN + (its path beneath nmDest).
// Keep in sync with the staging dir in scripts/build-windows-production.ps1 — if
// that root moves, the post-strip MAX_PATH assertion below surfaces the mismatch.
const STAGE_PREFIX_LEN = 'C:\\tmp\\kk\\Resources\\app\\node_modules\\'.length
const STAGE_BUDGET = 248 // collapse only what would overflow, with margin under 260

// Longest staged path any file under `dir` would occupy once staged for Inno.
function subtreeMaxStagedLen(dir: string): number {
  let max = 0
  const walk = (d: string) => {
    let entries: ReturnType<typeof readdirSync>
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = join(d, e.name)
      if (e.isDirectory()) walk(fp)
      else {
        const staged = STAGE_PREFIX_LEN + (fp.length - nmDest.length)
        if (staged > max) max = staged
      }
    }
  }
  walk(dir)
  return max
}

// Whether a redundant nested package should be collapsed (removed so resolution
// falls back to top-level). Non-Windows keeps the original conservative behavior
// (exact-version dups only). Windows ALSO collapses semver-superseded copies, but
// ONLY when their subtree would overflow the Inno staging budget — so trees that
// already fit (e.g. the WalletConnect chain the build script probes for) are left
// byte-for-byte as the working build had them, and we touch only the genuine
// MAX_PATH offenders (pioneer-discovery's deep ethers/@ethersproject re-nesting).
function shouldCollapseNested(pkgPath: string, nestedVer: string, topVer: string): boolean {
  if (process.platform !== 'win32') return nestedVer === topVer
  return topLevelSupersedes(nestedVer, topVer) && subtreeMaxStagedLen(pkgPath) > STAGE_BUDGET
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
                if (nestedVer && topVer && shouldCollapseNested(scopedPath, nestedVer, topVer)) {
                  // Redundant + overflows the staging budget — collapse it.
                  // Long-path-safe so it completes on deep Windows paths instead
                  // of leaving broken shadow dirs.
                  rmTreeSafe(scopedPath)
                } else if (nestedVer && topVer) {
                  if (nestedVer !== topVer) console.log(`  Keeping nested: ${scopedName}@${nestedVer} (top-level: ${topVer})`)
                  // Recurse INTO the kept package (Windows): a version-differing dep
                  // (e.g. ethers@5.7.2) can re-nest its own deep semver-superseded
                  // dups that overflow MAX_PATH; reach and collapse just those.
                  if (process.platform === 'win32') stripDuplicateNestedNodeModules(scopedPath)
                }
              }
              // Remove the scope dir if empty
              try {
                if (readdirSync(nestedPkgPath).length === 0) rmSync(nestedPkgPath, { recursive: true })
              } catch {}
            } else {
              const nestedVer = getPackageVersion(nestedPkgPath)
              const topVer = getPackageVersion(join(nmDest, pkg.name))
              if (nestedVer && topVer && shouldCollapseNested(nestedPkgPath, nestedVer, topVer)) {
                // Redundant + overflows the staging budget — long-path-safe removal
                // (see scoped case above) so it completes on deep paths.
                rmTreeSafe(nestedPkgPath)
              } else if (nestedVer && topVer) {
                if (nestedVer !== topVer) console.log(`  Keeping nested: ${pkg.name}@${nestedVer} (top-level: ${topVer})`)
                // Recurse into the kept package (Windows) to collapse its own deep
                // semver-superseded dups (MAX_PATH offenders).
                if (process.platform === 'win32') stripDuplicateNestedNodeModules(nestedPkgPath)
              }
            }
          }
          // Remove the node_modules dir if empty
          try {
            if (readdirSync(fullPath).length === 0) rmSync(fullPath, { recursive: true })
          } catch {}
        } catch (e) {
          // On Windows, very deep nested node_modules paths can fail to read
          // even though Bun still needs files inside them at runtime.
          if (process.platform === 'win32') {
            console.warn(`  WARN: Preserving unreadable nested node_modules on Windows: ${fullPath}: ${e}`)
          } else {
            // If we can't read it elsewhere, remove it.
            rmSync(fullPath, { recursive: true })
          }
        }
      } else {
        stripDuplicateNestedNodeModules(fullPath)
      }
    }
  } catch {}
}
stripDuplicateNestedNodeModules(nmDest)
console.log(`[collect-externals] Stripped duplicate nested node_modules (kept version-differing deps)`)

// Fail LOUDLY if anything still exceeds Windows MAX_PATH after the dedupe. A future
// deep nested tree this pass can't collapse (a 0.x or cross-major dup that must stay
// nested) would otherwise surface only as an opaque Inno Setup "The system cannot
// find the path specified" mid-compress. Catch it here with the offending length.
// Windows-only: the staging budget / MAX_PATH limit is Windows-specific.
if (process.platform === 'win32') {
  const deepestStaged = subtreeMaxStagedLen(nmDest)
  console.log(`[collect-externals] Windows: deepest staged path = ${deepestStaged} chars (MAX_PATH 260)`)
  if (deepestStaged > 260) {
    throw new Error(
      `[collect-externals] A staged path is ${deepestStaged} chars — over Windows MAX_PATH (260) — ` +
      `after nested dedupe. A deep nested tree could not be collapsed (likely a 0.x or cross-major ` +
      `dup that must stay nested). Inno Setup would fail to package it; resolve the offending dep tree.`
    )
  }
}
let strippedSize = 0
for (const dir of STRIP_DIRS) {
  const target = join(nmDest, dir)
  if (existsSync(target)) {
    try {
      const bytes = directorySizeBytes(target)
      rmSync(target, { recursive: true })
      strippedSize += bytes
      console.log(`  Stripped: ${dir} (${(bytes / 1024 / 1024).toFixed(1)}MB)`)
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

// Remove dangling symlinks (left behind after pruning/stripping)
function removeDanglingSymlinks(dirPath: string) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isSymbolicLink()) {
        try { statSync(fullPath) } catch {
          rmSync(fullPath)
        }
      } else if (entry.isDirectory()) {
        removeDanglingSymlinks(fullPath)
      }
    }
  } catch {}
}
removeDanglingSymlinks(nmDest)

// Report final size
console.log(`[collect-externals] Final size: ${formatBytes(directorySizeBytes(nmDest))}`)
