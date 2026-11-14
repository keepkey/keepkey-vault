#!/usr/bin/env bun
/**
 * Read-only release gate for the archive Hutch packed (artifacts/<channel>-<os>-<arch>-*).
 * It never rewrites the archive: the update-v2 manifest pins the exact bytes of the
 * uncompressed tar, so any edit after Hutch would break 2.x auto-updates.
 * The edits themselves happen in scripts/patch-bundle.ts (postBuild).
 *
 * Usage: bun scripts/verify-release-bundle.ts [stable|canary] [--signed]
 *   --signed  also require a valid Developer ID signature and the entitlements
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pkg from '../package.json'
import { CAMERA_REASON, cameraUsageDescription, pruneAppNodeModules } from './app-bundle'

const args = process.argv.slice(2)
const channel = args.find(a => !a.startsWith('--')) ?? 'stable'
const signed = args.includes('--signed')
const project = join(import.meta.dir, '..')
const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win' : process.platform
const arch = os === 'win' ? 'x64' : process.arch
const prefix = `${channel}-${os}-${arch}`
const name = channel === 'stable' ? pkg.name : `${pkg.name}-${channel}`
const bundleName = os === 'macos' ? `${name}.app` : name
const artifacts = join(project, 'artifacts')
const tarZst = join(artifacts, `${prefix}-${bundleName}.tar.zst`)

const failures: string[] = []
const fail = (message: string) => { failures.push(message); console.error(`[verify-bundle] FAIL: ${message}`) }
const ok = (message: string) => console.log(`[verify-bundle] ok: ${message}`)
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

if (!existsSync(tarZst)) {
  console.error(`[verify-bundle] missing ${tarZst}`)
  process.exit(1)
}

// --- Update manifests: both must describe exactly this archive. ---
const work = mkdtempSync(join(tmpdir(), 'kk-verify-bundle-'))
try {
  const tar = join(work, 'app.tar')
  if (run(['zstd', '-d', '-q', tarZst, '-o', tar, '--force']).code !== 0) throw new Error(`zstd could not decompress ${tarZst}`)
  const tarBytes = await Bun.file(tar).bytes()
  const tarSha256 = new Bun.CryptoHasher('sha256').update(tarBytes).digest('hex')

  for (const manifestName of [`${prefix}-update.json`, `${prefix}-update-v2.json`]) {
    const path = join(artifacts, manifestName)
    if (!existsSync(path)) { fail(`missing ${manifestName}`); continue }
    const m = JSON.parse(readFileSync(path, 'utf8'))
    if (m.version !== pkg.version || m.channel !== channel || m.platform !== os || m.arch !== arch ||
      m.identifier !== 'com.keepkey.vault' || typeof m.hash !== 'string' || !m.hash ||
      m.artifact?.file !== `${prefix}-${bundleName}.tar.zst`) {
      fail(`${manifestName} does not describe KeepKey Vault ${pkg.version} ${prefix}: ${JSON.stringify(m)}`)
    } else if (manifestName.endsWith('-v2.json') &&
      (m.artifact.tarSha256 !== tarSha256 || m.artifact.tarSize !== tarBytes.length)) {
      fail(`${manifestName} pins tar ${m.artifact.tarSha256}/${m.artifact.tarSize}, archive is ${tarSha256}/${tarBytes.length}; the archive was rewritten after Hutch packed it`)
    } else {
      ok(manifestName)
    }
  }
  for (const stray of readdirSync(artifacts).filter(f => f.startsWith(prefix) && f.endsWith('.patch'))) {
    fail(`unexpected delta patch ${stray}: Vault does not publish patches (release.generatePatch is false)`)
  }

  if (os === 'macos') {
    if (run(['tar', 'xf', tar, '-C', work]).code !== 0) throw new Error('tar could not extract the archive')
    rmSync(tar)
    const app = join(work, bundleName)
    if (!existsSync(app)) throw new Error(`archive has no ${bundleName}`)
    const resources = join(app, 'Contents', 'Resources')

    const camera = cameraUsageDescription(app)
    camera === CAMERA_REASON ? ok('camera usage description') : fail(`NSCameraUsageDescription is ${JSON.stringify(camera)}`)

    // Hutch's update manager; full-app installs update through it.
    existsSync(join(resources, 'uninstall')) ? ok('Resources/uninstall present') : fail('Resources/uninstall (update manager) missing')

    const index = join(resources, 'app', 'bun', 'index.js')
    const code = existsSync(index) ? readFileSync(index, 'utf8') : ''
    if (!code) fail('Resources/app/bun/index.js missing')
    else if (code.includes('var exports_protocol_import = {};') && !code.includes('/* node_buffer_patch */')) fail('bun/index.js lacks the node_buffer patch')
    else ok('bun/index.js node_buffer')

    // Release apps carry the certified universal emulator: one archive per arch.
    const emulator = join(resources, 'app', 'emulator', 'libkkemu.dylib')
    const emuArchs = existsSync(emulator) ? run(['lipo', '-archs', emulator]).out.trim() : ''
    emuArchs.includes('arm64') && emuArchs.includes('x86_64') ? ok(`emulator ${emuArchs}`) : fail(`bundled emulator missing or not universal: ${emuArchs || 'absent'}`)

    // zcash-cli: required on Apple Silicon, unsupported (absent) on Intel.
    const zcash = join(resources, 'app', 'zcash-cli')
    if (arch === 'arm64') {
      existsSync(zcash) && run(['lipo', '-archs', zcash]).out.includes('arm64') ? ok('zcash-cli arm64') : fail('arm64 release is missing an arm64 zcash-cli')
    } else {
      existsSync(zcash) ? fail('Intel release must not ship zcash-cli') : ok('zcash-cli absent on Intel')
    }

    // Pruning ran in postBuild: a second pass on this throwaway copy must find nothing.
    const leftover = pruneAppNodeModules(app, () => {})
    leftover === 0 ? ok('node_modules already pruned') : fail(`${leftover} prunable node_modules entries reached the archive; postBuild pruning did not run`)

    if (signed) {
      const verify = run(['codesign', '--verify', '--deep', '--strict', app])
      verify.code === 0 ? ok('codesign --verify --deep --strict') : fail(`codesign verify failed: ${verify.out.trim()}`)
      const entitlements = (path: string) => run(['codesign', '-d', '--entitlements', ':-', path]).out
      for (const bin of ['launcher', 'bun']) {
        const e = entitlements(join(app, 'Contents', 'MacOS', bin))
        e.includes('com.apple.security.cs.allow-jit') && !e.includes('invalid entitlements blob')
          ? ok(`${bin} allow-jit`) : fail(`${bin} lacks allow-jit (bun dies with SIGTRAP)`)
      }
      entitlements(app).includes('com.apple.security.device.camera') ? ok('app camera entitlement') : fail('app lacks com.apple.security.device.camera (QR scanning blocked)')
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  rmSync(work, { recursive: true, force: true })
}

const size = (statSync(tarZst).size / 1024 / 1024).toFixed(1)
if (failures.length > 0) {
  console.error(`[verify-bundle] ${failures.length} check(s) failed for ${tarZst} (${size}MB). Do not sign or publish it.`)
  process.exit(1)
}
console.log(`[verify-bundle] ${tarZst} (${size}MB) passed`)
