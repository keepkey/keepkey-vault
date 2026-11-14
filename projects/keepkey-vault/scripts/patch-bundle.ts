#!/usr/bin/env bun
/**
 * Electrobun postBuild hook (electrobun.config.ts scripts.postBuild). Hutch runs it
 * after the app is assembled and before it hashes, signs and packs the app, so
 * every edit here reaches the shipped archive and its update manifests.
 *
 * 1. node_buffer: `export * from 'node:buffer'` in @swagger-api/apidom-reference
 *    gets compiled to `__reExport(exports_protocol_import, node_buffer)` but
 *    `node_buffer` is never defined. We inject the missing import.
 * 2. macOS: real NSCameraUsageDescription copy (see scripts/app-bundle.ts).
 * 3. macOS release builds: prune node_modules bloat from the app.
 *
 * scripts/verify-release-bundle.ts checks the packed archive for all three.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { pruneAppNodeModules, setCameraUsageDescription } from './app-bundle'

const projectRoot = join(import.meta.dir, '..')
const hookBuildDir = process.env.ELECTROBUN_BUILD_DIR
const buildDir = resolve(projectRoot, process.argv[2] ?? hookBuildDir ?? '_build')
const buildEnv = process.env.ELECTROBUN_BUILD_ENV
const buildOs = process.env.ELECTROBUN_OS

// Find the electrobun build output index.js by scanning _build/ recursively.
// Electrobun uses platform names that differ from Node (macos vs darwin, win vs win32)
// and macOS bundles nest under .app/Contents/Resources/. Just glob for the actual file.
function findBunIndexFiles(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Only descend into build output dirs, not node_modules or source
        if (entry.name !== 'node_modules' && entry.name !== '_ext_modules' && entry.name !== '_bundled_backend') {
          results.push(...findBunIndexFiles(full))
        }
      } else if (entry.name === 'index.js' && dir.endsWith(join('app', 'bun'))) {
        results.push(full)
      }
    }
  } catch {}
  return results
}
const candidates = findBunIndexFiles(buildDir)
if (hookBuildDir && candidates.length === 0) {
  throw new Error(`Electrobun did not bundle its backend in ${buildDir}`)
}

let patched = false
for (const candidate of candidates) {
  if (!existsSync(candidate)) continue

  let code = readFileSync(candidate, 'utf8')
  const needle = 'var exports_protocol_import = {};'

  const patchMarker = '/* node_buffer_patch */'
  if (code.includes(needle) && !code.includes(patchMarker)) {
    // Inject at the very top of the file so node_buffer is in global scope
    code = `${patchMarker}\nimport * as node_buffer from "node:buffer";\n${code}`
    writeFileSync(candidate, code)
    const sizeMB = (code.length / 1024 / 1024).toFixed(2)
    console.log(`[patch-bundle] Patched: ${candidate} (${sizeMB} MB)`)
    console.log('[patch-bundle] Injected top-level: import * as node_buffer from "node:buffer"')
    patched = true
  } else if (!code.includes(needle)) {
    console.log(`[patch-bundle] No patch needed for ${candidate}`)
  } else {
    console.log(`[patch-bundle] Already patched: ${candidate}`)
  }
}

if (!patched) {
  console.log('[patch-bundle] No files needed patching')
}

// The app bundles this hook build produced: <buildDir>[/<env>-macos-<arch>]/<name>.app
function findApps(dir: string, depth = 0): string[] {
  const apps: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (entry.name.endsWith('.app')) apps.push(full)
    else if (depth === 0 && (!buildEnv || entry.name.startsWith(`${buildEnv}-macos-`))) apps.push(...findApps(full, 1))
  }
  return apps
}

if (buildOs === 'macos') {
  const apps = findApps(buildDir)
  if (apps.length === 0) throw new Error(`[patch-bundle] no .app bundle under ${buildDir}`)
  for (const app of apps) {
    console.log(`[patch-bundle] ${setCameraUsageDescription(app) ? 'Set' : 'Kept'} camera usage description in ${app}`)
    if (buildEnv !== 'dev') {
      console.log(`[prune-bundle] Pruning ${app}`)
      pruneAppNodeModules(app)
    }
  }
}
