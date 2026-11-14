import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import pkg from '../package.json'

const project = join(import.meta.dir, '..')

export function buildElectrobun(channel: string, env = process.env) {
  if (!['dev', 'canary', 'stable'].includes(channel)) {
    throw new Error(`Unknown Electrobun build channel: ${channel}`)
  }

  const os = process.platform === 'darwin' ? 'macos'
    : process.platform === 'win32' ? 'win' : process.platform
  const arch = os === 'win' ? 'x64' : process.arch
  const name = channel === 'stable' ? pkg.name : `${pkg.name}-${channel}`
  const prefix = `${channel}-${os}-${arch}`
  const bundleName = os === 'macos' ? `${name}.app` : name
  const bundle = join(project, '_build', prefix, bundleName)
  const app = os === 'macos' ? join(bundle, 'Contents') : bundle
  const resources = join(app, 'Resources')
  // Electrobun replaces the release app directory with a compressed archive.
  const outputs = channel === 'dev' ? [join(resources, 'version.json')] : [
    join(project, 'artifacts', `${prefix}-update.json`),
    join(project, 'artifacts', `${prefix}-${bundleName}.tar.zst`),
  ]
  const before = outputs.map(path => statSync(path, { bigint: true, throwIfNoEntry: false }))

  const build = Bun.spawnSync(['hutch', 'electrobun', 'build', `--env=${channel}`], {
    cwd: project, env, stdout: 'inherit', stderr: 'inherit',
  })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)

  for (const [index, path] of outputs.entries()) {
    const after = statSync(path, { bigint: true, throwIfNoEntry: false })
    const previous = before[index]
    if (!after?.isFile() || after.size === 0n ||
      (previous && previous.ino === after.ino && previous.mtimeNs === after.mtimeNs && previous.ctimeNs === after.ctimeNs)) {
      throw new Error(`Electrobun did not write a fresh build output: ${path}`)
    }
  }
  const versionPath = outputs[0]
  const metadata = JSON.parse(readFileSync(versionPath, 'utf8'))
  const expectedIdentity = channel === 'dev'
    ? metadata.channel === channel && metadata.identifier === 'com.keepkey.vault'
    : metadata.platform === os && metadata.arch === arch && typeof metadata.hash === 'string' && metadata.hash.length > 0
  if (metadata.version !== pkg.version || !expectedIdentity) {
    throw new Error(`Electrobun built unexpected bundle metadata at ${versionPath}. Expected KeepKey Vault ${pkg.version} (${channel}).`)
  }
  if (channel === 'dev') {
    const launcher = os === 'macos' ? 'MacOS/launcher' : os === 'win' ? 'bin/launcher.exe' : 'bin/launcher'
    for (const path of [join(app, launcher), join(resources, 'app', 'bun', 'index.js')]) {
      const file = statSync(path, { throwIfNoEntry: false })
      if (!file?.isFile() || file.size === 0) throw new Error(`Electrobun build is missing ${path}`)
    }
  }
  console.log(`[build] Verified fresh KeepKey Vault ${pkg.version} (${channel}) at ${versionPath}`)
}

if (import.meta.main) buildElectrobun(process.argv[2] || 'dev')
