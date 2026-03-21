/**
 * Stale Assets Guard Tests
 *
 * Prevents the "20MB stale Vite assets" bug from recurring.
 *
 * Bug: Each Vite build produces uniquely-hashed JS/CSS files (e.g. index-Bf_MDLkO.js).
 * Without cleanup, old files accumulate across builds and hot-patches. WebView2 or
 * the Electrobun flat-file loader scans all files in the assets directory, causing
 * startup to go from 1.4s to 30+ seconds.
 *
 * Root cause: Inno Setup installer and hot-patch workflows add new files without
 * removing old ones. The index.html only references the current hashed files, but
 * the stale ones still exist on disk.
 *
 * Mitigations tested here:
 * 1. Vite dist/ output should have bounded number of JS files
 * 2. installer.iss must have [InstallDelete] section for stale assets
 * 3. Only one index-*.js and one index-*.css should exist per build
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '..')
const DIST_ASSETS = join(PROJECT_ROOT, 'dist', 'assets')
const INSTALLER_ISS = join(PROJECT_ROOT, '..', '..', 'scripts', 'installer.iss')

describe('Stale assets prevention', () => {

  test('installer.iss has [InstallDelete] for stale Vite assets', () => {
    expect(existsSync(INSTALLER_ISS)).toBe(true)
    const content = readFileSync(INSTALLER_ISS, 'utf-8')
    expect(content).toContain('[InstallDelete]')
    expect(content).toContain('assets')
  })

  test('installer.iss cleans assets dir before installing new files', () => {
    const content = readFileSync(INSTALLER_ISS, 'utf-8')
    // Must delete the assets dir BEFORE [Files] copies new ones
    const deleteIdx = content.indexOf('[InstallDelete]')
    const filesIdx = content.indexOf('[Files]')
    expect(deleteIdx).toBeGreaterThan(-1)
    expect(filesIdx).toBeGreaterThan(-1)
    expect(deleteIdx).toBeLessThan(filesIdx)
  })

})

describe('Vite build output sanity', () => {

  test('dist/assets/ has at most 30 JS files', () => {
    if (!existsSync(DIST_ASSETS)) return // skip if no build
    const jsFiles = readdirSync(DIST_ASSETS).filter(f => f.endsWith('.js'))
    expect(jsFiles.length).toBeLessThanOrEqual(30)
  })

  test('dist/assets/ has exactly one index-*.js', () => {
    if (!existsSync(DIST_ASSETS)) return
    const indexJs = readdirSync(DIST_ASSETS).filter(f => f.startsWith('index-') && f.endsWith('.js'))
    expect(indexJs.length).toBe(1)
  })

  test('dist/assets/ has exactly one index-*.css', () => {
    if (!existsSync(DIST_ASSETS)) return
    const indexCss = readdirSync(DIST_ASSETS).filter(f => f.startsWith('index-') && f.endsWith('.css'))
    expect(indexCss.length).toBe(1)
  })

  test('dist/assets/ has exactly one asset-data-*.js', () => {
    if (!existsSync(DIST_ASSETS)) return
    const assetData = readdirSync(DIST_ASSETS).filter(f => f.startsWith('asset-data-') && f.endsWith('.js'))
    expect(assetData.length).toBe(1)
  })

  test('total dist/assets/ size is under 10MB', () => {
    if (!existsSync(DIST_ASSETS)) return
    let totalSize = 0
    for (const f of readdirSync(DIST_ASSETS)) {
      const stat = Bun.file(join(DIST_ASSETS, f)).size
      totalSize += stat
    }
    const mb = totalSize / (1024 * 1024)
    expect(mb).toBeLessThan(10)
  })

})
