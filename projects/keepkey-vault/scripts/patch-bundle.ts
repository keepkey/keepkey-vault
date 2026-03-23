#!/usr/bin/env bun
/**
 * Patches the Electrobun build output to fix Bun bundler bugs.
 *
 * Must run AFTER `bunx electrobun build`.
 *
 * Bug: `export * from 'node:buffer'` in @swagger-api/apidom-reference gets
 * compiled to `__reExport(exports_protocol_import, node_buffer)` but
 * `node_buffer` is never defined. We inject the missing require().
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

const projectRoot = join(import.meta.dir, '..')
const buildDir = join(projectRoot, '_build')

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
