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
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { globSync } from 'fs'

const projectRoot = join(import.meta.dir, '..')
const buildDir = join(projectRoot, '_build')

// Find the electrobun build output index.js
const candidates = [
  join(buildDir, 'dev-win-x64', 'keepkey-vault-dev', 'Resources', 'app', 'bun', 'index.js'),
  join(buildDir, 'dev-darwin-arm64', 'keepkey-vault-dev', 'Resources', 'app', 'bun', 'index.js'),
  join(buildDir, 'dev-linux-x64', 'keepkey-vault-dev', 'Resources', 'app', 'bun', 'index.js'),
]

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
