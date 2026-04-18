#!/usr/bin/env node
// Copies swagger.json from the vault server source into this package's
// openapi/ directory so it ships in the published tarball. Run by the
// `prepublishOnly` script. Idempotent.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = resolve(__dirname, '../../keepkey-vault/src/bun/swagger.json')
const destDir = resolve(__dirname, '../openapi')
const dest = resolve(destDir, 'swagger.json')

if (!existsSync(src)) {
  console.error(`[bundle-openapi] source not found: ${src}`)
  console.error('[bundle-openapi] aborting publish to prevent shipping a stale spec')
  process.exit(1)
}

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)

const size = statSync(dest).size
console.log(`[bundle-openapi] copied swagger.json (${(size / 1024).toFixed(1)} KB)`)
console.log(`[bundle-openapi]   from: ${src}`)
console.log(`[bundle-openapi]   to:   ${dest}`)
