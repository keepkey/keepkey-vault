#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alphaHead, qualifiedAlpha, FIRMWARE_REPOSITORY } from './alpha-emulator-source.mjs'

export const REQUIRED_SYMBOLS = ['kkemu_init', 'kkemu_shutdown', 'kkemu_write', 'kkemu_read', 'kkemu_poll', 'kkemu_is_running', 'kkemu_pop_frame', 'kkemu_start', 'kkemu_stop', 'kkemu_lock', 'kkemu_unlock', 'kkemu_trylock']
const sha256 = data => createHash('sha256').update(data).digest('hex')
const LIBRARIES = ['libkkemu.dylib', 'libkkemu.dll']

export function verifyAlphaReceipt(receipt, files, sha) {
  if (receipt.schema !== 1 || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(receipt.version) || receipt.source?.repository !== FIRMWARE_REPOSITORY ||
      receipt.source?.branch !== 'alpha' || receipt.source?.commit !== sha || !/^[a-f0-9]{40}$/.test(sha) ||
      !Number.isSafeInteger(receipt.source?.runId) || receipt.source.runId <= 0) throw new Error('Artifact does not bind the current fork alpha source')
  const q = receipt.qualification
  if (q?.macosArchitectures?.slice().sort().join(',') !== 'arm64,x86_64' || q.macosMinimum !== '13.0' ||
      q.windowsArchitecture !== 'x86_64' || q.pinTests !== 'passed' || q.clearSignRoot !== 'production') throw new Error('Incomplete alpha emulator qualification')
  for (const name of LIBRARIES) {
    const data = files[name], expected = receipt.files?.[name]
    if (!Buffer.isBuffer(data) || !expected || data.length !== expected.size || sha256(data) !== expected.sha256) throw new Error(`${name} does not match the certified source receipt`)
    if (!data.includes(Buffer.from('027c1fde75db6c36393e095e0dc5ab9a5bcf1ae9eb92b5d36e212a2bf7f8a6e321', 'hex')) ||
        data.includes(Buffer.from('02de9231b2094433235532fb1932e324a2c7304195e12e610c675cccbbd606dae7', 'hex'))) throw new Error(`${name} has the wrong compiled ClearSign root`)
  }
}

export function bundleManifest(receipt, artifact, run, repository) {
  return { version: receipt.version, source: { repository, runId: run.id, headSha: run.head_sha,
    artifactId: artifact.id, artifactName: artifact.name, artifactDigest: artifact.digest,
    firmwareRepository: receipt.source.repository, firmwareBranch: 'alpha', firmwareSha: receipt.source.commit,
    firmwareRunId: receipt.source.runId, firmwareRunUrl: receipt.source.runUrl,
    macArchive: '', macLibraryPath: 'libkkemu.dylib', windowsLibrary: 'libkkemu.dll' },
    files: { 'libkkemu.dylib': { sha256: receipt.files['libkkemu.dylib'].sha256, architectures: ['arm64', 'x86_64'] },
      'libkkemu.dll': { sha256: receipt.files['libkkemu.dll'].sha256, architecture: 'x86_64' } }, requiredSymbols: REQUIRED_SYMBOLS }
}

export function refreshAlphaEmulator(repository = 'BitHighlander/keepkey-vault') {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid artifact repository')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const bundle = join(root, 'projects/keepkey-vault/emulator-bundle')
  const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))
  const sha = alphaHead()
  qualifiedAlpha(sha)
  const name = `certified-emulator-alpha-${sha}`
  const workflow = api(`repos/${repository}/actions/workflows/build-certified-emulator.yml`)
  const candidates = api(`repos/${repository}/actions/artifacts?name=${name}&per_page=50`).artifacts
  let selected
  for (const artifact of candidates ?? []) {
    if (artifact.expired || artifact.name !== name) continue
    const run = api(`repos/${repository}/actions/runs/${artifact.workflow_run.id}`)
    if (run.status === 'completed' && run.conclusion === 'success' && run.workflow_id === workflow.id && run.head_sha === artifact.workflow_run.head_sha) {
      selected = { artifact, run }; break
    }
  }
  if (!selected) throw new Error(`No qualified default emulator for fork alpha ${sha}. Run Build Certified Emulator Artifact on the current Vault branch first.`)
  const { artifact, run } = selected
  const archive = execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 64 * 1024 * 1024 })
  if (`sha256:${sha256(archive)}` !== artifact.digest) throw new Error('Certified artifact ZIP digest mismatch')
  const temporary = mkdtempSync(join(tmpdir(), 'keepkey-alpha-intake-'))
  try {
    const zip = join(temporary, 'artifact.zip'); writeFileSync(zip, archive)
    const python = process.platform === 'win32' ? 'python' : 'python3'
    execFileSync(python, ['-c', `import zipfile,pathlib,sys
root=pathlib.Path(sys.argv[2])
names={'libkkemu.dylib','libkkemu.dll','source-receipt.json'}
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist()
 if len(entries)!=3 or {i.filename for i in entries}!=names: raise SystemExit('Unexpected certified artifact members')
 for i in entries:
  if i.file_size>32*1024*1024: raise SystemExit('Certified artifact member exceeds size bound')
  (root/i.filename).write_bytes(z.read(i))
`, zip, temporary], { stdio: 'inherit' })
    const receipt = JSON.parse(readFileSync(join(temporary, 'source-receipt.json'), 'utf8'))
    const files = Object.fromEntries(LIBRARIES.map(name => [name, readFileSync(join(temporary, name))]))
    verifyAlphaReceipt(receipt, files, sha)
    if (alphaHead() !== sha) throw new Error('Fork alpha moved during intake; refresh its new artifact')
    mkdirSync(bundle, { recursive: true })
    for (const name of LIBRARIES) {
      const pending = join(bundle, `${name}.new-${process.pid}`)
      writeFileSync(pending, files[name]); renameSync(pending, join(bundle, name))
    }
    const manifest = bundleManifest(receipt, artifact, run, repository)
    const pendingManifest = join(bundle, `manifest.json.new-${process.pid}`)
    writeFileSync(pendingManifest, JSON.stringify(manifest, null, 2) + '\n')
    renameSync(pendingManifest, join(bundle, 'manifest.json'))
    execFileSync(process.execPath, [join(root, 'scripts/verify-certified-emulator.mjs')], { stdio: 'inherit' })
    console.log(`Default bundled emulator: fork alpha ${sha}; certified artifact ${artifact.id} from run ${run.id}`)
    return manifest
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refreshAlphaEmulator(process.argv[2] || process.env.EMU_ARTIFACT_REPOSITORY || 'BitHighlander/keepkey-vault')
}
