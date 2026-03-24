#!/usr/bin/env bun
/**
 * Audits the vendored _ext_modules bundle and generates:
 * 1. artifacts/deps.runtime.json  — full dependency manifest (name, version, size)
 * 2. artifacts/deps.install-scripts.txt — packages with install scripts
 * 3. artifacts/sbom.cdx.json — CycloneDX 1.5 SBOM
 *
 * Usage: bun scripts/audit-deps.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

const projectRoot = join(import.meta.dir, '..')
const artifactsDir = join(projectRoot, 'artifacts')

// collect-externals outputs to _build/_ext_modules (Electrobun build dir)
const candidates = [
  join(projectRoot, '_build', '_ext_modules'),
  join(projectRoot, 'build', '_ext_modules'),
]
const extModules = candidates.find(p => existsSync(p))
if (!extModules) {
  console.error(`[audit-deps] ERROR: _ext_modules not found in _build/ or build/. Run 'bun run build' first.`)
  process.exit(1)
}

mkdirSync(artifactsDir, { recursive: true })

interface DepInfo {
  name: string
  version: string
  license: string
  size: number
  fileCount: number
  hasInstallScripts: boolean
  installScripts: string[]
  integrity: string
}

// Walk _ext_modules and collect package info
const deps: DepInfo[] = []
let totalFiles = 0
let totalSize = 0

function getDirSize(dir: string): { size: number; files: number } {
  let size = 0
  let files = 0
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        const sub = getDirSize(fullPath)
        size += sub.size
        files += sub.files
      } else {
        try {
          size += statSync(fullPath).size
          files++
        } catch {}
      }
    }
  } catch {}
  return { size, files }
}

function scanPackages(baseDir: string, prefix = '') {
  try {
    const entries = readdirSync(baseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = join(baseDir, entry.name)
      const pkgName = prefix ? `${prefix}/${entry.name}` : entry.name

      // Scoped packages: @scope/name
      if (entry.name.startsWith('@')) {
        scanPackages(fullPath, entry.name)
        continue
      }

      const pjPath = join(fullPath, 'package.json')
      if (!existsSync(pjPath)) continue

      try {
        const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
        const { size, files } = getDirSize(fullPath)

        const installScripts: string[] = []
        const scriptNames = ['preinstall', 'install', 'postinstall', 'prepare']
        for (const s of scriptNames) {
          if (pj.scripts?.[s]) installScripts.push(`${s}: ${pj.scripts[s]}`)
        }

        // Compute SHA-256 of package.json for integrity
        const hash = createHash('sha256').update(readFileSync(pjPath)).digest('hex')

        deps.push({
          name: pj.name || pkgName,
          version: pj.version || '0.0.0',
          license: pj.license || 'UNKNOWN',
          size,
          fileCount: files,
          hasInstallScripts: installScripts.length > 0,
          installScripts,
          integrity: `sha256:${hash}`,
        })

        totalFiles += files
        totalSize += size
      } catch {}
    }
  } catch {}
}

scanPackages(extModules)
deps.sort((a, b) => a.name.localeCompare(b.name))

console.log(`[audit-deps] Found ${deps.length} packages, ${totalFiles} files, ${(totalSize / 1024 / 1024).toFixed(1)}MB`)

// 1. deps.runtime.json
const manifest = {
  generated: new Date().toISOString(),
  source: 'build/_ext_modules',
  summary: {
    packages: deps.length,
    files: totalFiles,
    sizeBytes: totalSize,
    sizeMB: Math.round(totalSize / 1024 / 1024 * 10) / 10,
  },
  packages: deps.map(d => ({
    name: d.name,
    version: d.version,
    license: d.license,
    sizeBytes: d.size,
    fileCount: d.fileCount,
    integrity: d.integrity,
  })),
}

const manifestPath = join(artifactsDir, 'deps.runtime.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`[audit-deps] Wrote ${manifestPath}`)

// 2. deps.install-scripts.txt
const scriptsEntries = deps.filter(d => d.hasInstallScripts)
const scriptLines = [
  `# Packages with install scripts in _ext_modules`,
  `# Generated: ${new Date().toISOString()}`,
  `# ${scriptsEntries.length} packages with install scripts out of ${deps.length} total`,
  '',
  ...scriptsEntries.flatMap(d => [
    `## ${d.name}@${d.version}`,
    ...d.installScripts.map(s => `  ${s}`),
    '',
  ]),
]

const scriptsPath = join(artifactsDir, 'deps.install-scripts.txt')
writeFileSync(scriptsPath, scriptLines.join('\n') + '\n')
console.log(`[audit-deps] Wrote ${scriptsPath}`)

// 3. CycloneDX 1.5 SBOM
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: {
      components: [{
        type: 'application',
        name: 'audit-deps',
        version: '1.0.0',
      }],
    },
    component: {
      type: 'application',
      name: 'keepkey-vault',
      version: JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version,
    },
  },
  components: deps.map(d => ({
    type: 'library',
    name: d.name,
    version: d.version,
    licenses: d.license !== 'UNKNOWN' ? [{ license: { id: d.license } }] : [],
    hashes: [{ alg: 'SHA-256', content: d.integrity.replace('sha256:', '') }],
    purl: d.name.startsWith('@')
      ? `pkg:npm/${encodeURIComponent(d.name.split('/')[0])}/${d.name.split('/')[1]}@${d.version}`
      : `pkg:npm/${d.name}@${d.version}`,
  })),
}

const sbomPath = join(artifactsDir, 'sbom.cdx.json')
writeFileSync(sbomPath, JSON.stringify(sbom, null, 2) + '\n')
console.log(`[audit-deps] Wrote ${sbomPath}`)

// Summary table — top 10 by size
console.log(`\n[audit-deps] Top 10 packages by size:`)
const top10 = [...deps].sort((a, b) => b.size - a.size).slice(0, 10)
for (const d of top10) {
  console.log(`  ${(d.size / 1024 / 1024).toFixed(1).padStart(6)}MB  ${d.name}@${d.version}`)
}
