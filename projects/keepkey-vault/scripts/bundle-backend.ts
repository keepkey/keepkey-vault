#!/usr/bin/env bun
/**
 * Pre-bundles the backend entry point (src/bun/index.ts) into a single JS file,
 * resolving file: linked @keepkey/* packages and inlining all pure-JS dependencies.
 *
 * Only truly native packages (node-hid, usb) and unbuilt packages (proto-tx-builder)
 * remain external and must be provided via node_modules at runtime.
 *
 * This reduces installed file count from ~13,400 to ~100, cutting Windows Defender
 * first-launch scan time from 56s to ~5s.
 *
 * Usage: bun scripts/bundle-backend.ts
 * Output: _build/_bundled_backend/index.js
 */
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'

const projectRoot = join(import.meta.dir, '..')
const outDir = join(projectRoot, '_build', '_bundled_backend')

// Discover file: linked packages from package.json
const pj = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const aliases = new Map<string, string>()

for (const [name, spec] of Object.entries({ ...pj.dependencies, ...pj.overrides } as Record<string, string>)) {
  if (spec.startsWith('file:')) {
    aliases.set(name, resolve(projectRoot, spec.slice(5)))
  }
}

console.log(`[bundle-backend] Resolved ${aliases.size} file: linked packages`)

// These MUST stay external — native C++ addons only
const FORCE_EXTERNAL = new Set([
  'node-hid',
  'usb',
  'electrobun',
])

// Pre-flight: device-protocol lib/ must be built (submodule has lib/ in .gitignore).
// Missing messages_pb.js causes a silent bun crash at runtime — fail hard at build time.
for (const [name, pkgDir] of aliases) {
  if (name === '@keepkey/device-protocol') {
    const msgPb = join(pkgDir, 'lib', 'messages_pb.js')
    if (!existsSync(msgPb)) {
      console.error('[bundle-backend] FATAL: @keepkey/device-protocol/lib/messages_pb.js is MISSING')
      console.error('[bundle-backend] Build it first: cd modules/device-protocol && npm install && npm run build')
      process.exit(1)
    }
    console.log('[bundle-backend] Verified: device-protocol/lib/messages_pb.js present')
    break
  }
}

mkdirSync(outDir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(projectRoot, 'src/bun/index.ts')],
  outdir: outDir,
  target: 'bun',
  external: [...FORCE_EXTERNAL],
  plugins: [{
    name: 'file-link-resolver',
    setup(build) {
      // Sort by longest name first so @keepkey/hdwallet-keepkey-nodehid
      // matches before @keepkey/hdwallet-keepkey
      const sorted = [...aliases.entries()].sort((a, b) => b[0].length - a[0].length)

      for (const [name, pkgDir] of sorted) {
        if (FORCE_EXTERNAL.has(name)) continue

        const escapedName = name.replace(/[\/\-]/g, '\\$&')

        // Exact match: import "@keepkey/hdwallet-core"
        build.onResolve({ filter: new RegExp(`^${escapedName}$`) }, () => {
          const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
          const main = pkgJson.main || 'index.js'
          return { path: join(pkgDir, main) }
        })

        // Subpath match: import "@keepkey/device-protocol/lib/messages_pb"
        build.onResolve({ filter: new RegExp(`^${escapedName}/(.+)`) }, (args) => {
          const subpath = args.path.slice(name.length + 1)
          let resolved = join(pkgDir, subpath)
          if (!existsSync(resolved) && existsSync(resolved + '.js')) resolved += '.js'
          return { path: resolved }
        })
      }
    },
  }],
})

if (!result.success) {
  console.error('[bundle-backend] FAILED:')
  for (const msg of result.logs) {
    console.error(`  ${msg.message || msg}`)
  }
  process.exit(1)
}

const output = result.outputs[0]
const sizeMB = (output.size / 1024 / 1024).toFixed(2)
console.log(`[bundle-backend] OK: ${output.path} (${sizeMB} MB)`)
console.log(`[bundle-backend] Bundled all deps except: ${[...FORCE_EXTERNAL].join(', ')}`)
