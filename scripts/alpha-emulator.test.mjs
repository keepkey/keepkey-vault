import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { alphaHead, qualifiedAlpha, firmwareVersion, FIRMWARE_REPOSITORY } from './alpha-emulator-source.mjs'
import { verifyAlphaReceipt, bundleManifest, newestArtifacts, REQUIRED_SYMBOLS } from './refresh-alpha-emulator.mjs'

const sha = 'a'.repeat(40)
const root = Buffer.from('027c1fde75db6c36393e095e0dc5ab9a5bcf1ae9eb92b5d36e212a2bf7f8a6e321', 'hex')
const files = { 'libkkemu.dylib': Buffer.concat([root, Buffer.from('mac')]), 'libkkemu.dll': Buffer.concat([root, Buffer.from('win')]) }
test('artifact intake orders by creation time rather than API order or numeric ID', () => {
  const old = { id: 200, created_at: '2026-11-18T20:52:42Z' }, current = { id: 100, created_at: '2026-11-18T21:02:23Z' }
  assert.deepEqual(newestArtifacts([old, current]), [current, old])
})
const receipt = () => ({ schema: 1, version: '7.17.0', source: { repository: FIRMWARE_REPOSITORY, branch: 'alpha', commit: sha, runId: 12, runUrl: `https://github.com/${FIRMWARE_REPOSITORY}/actions/runs/12` },
  files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, { size: data.length, sha256: createHash('sha256').update(data).digest('hex') }])),
  qualification: { macosArchitectures: ['arm64', 'x86_64'], macosMinimum: '13.0', windowsArchitecture: 'x86_64', pinTests: 'passed', clearSignRoot: 'production', reportedFirmwareVersion: '7.17.0' } })

test('firmware version comes from the named project, never the CMake minimum', () => {
  const cmake = 'cmake_minimum_required(VERSION 3.7.2)\nproject(\n KeepKeyFirmware\n VERSION 7.17.0\n LANGUAGES C CXX ASM)'
  assert.equal(firmwareVersion(cmake), '7.17.0')
  assert.throws(() => firmwareVersion('cmake_minimum_required(VERSION 3.7.2)'))
  const bad = receipt(); bad.qualification.reportedFirmwareVersion = '3.7.2'
  assert.throws(() => verifyAlphaReceipt(bad, files, sha), /qualification/)
})

test('only an exact alpha branch response establishes the default source', () => {
  assert.equal(alphaHead(() => `${sha}\trefs/heads/alpha\n`), sha)
  for (const response of ['', `${sha}\trefs/heads/develop`, `bad\trefs/heads/alpha`, `${sha}\trefs/heads/alpha\n${sha}\trefs/heads/master`]) {
    assert.throws(() => alphaHead(() => response), /resolve/)
  }
})

test('a green run for another head, or an unfinished run, cannot qualify alpha', () => {
  const good = { id: 12, head_sha: sha, status: 'completed', conclusion: 'success', html_url: 'https://github.com/example' }
  const run = workflow_runs => () => JSON.stringify({ workflow_runs })
  assert.equal(qualifiedAlpha(sha, run([good])).runId, 12)
  for (const bad of [{ ...good, head_sha: 'b'.repeat(40) }, { ...good, status: 'in_progress' }, { ...good, conclusion: 'failure' }]) {
    assert.throws(() => qualifiedAlpha(sha, run([bad])), /no successful exact-head/)
  }
  assert.throws(() => qualifiedAlpha('alpha', () => { throw new Error('network must not run') }), /Invalid alpha commit/)
})

test('both libraries must bind the same current alpha source and qualification', () => {
  verifyAlphaReceipt(receipt(), files, sha)
  for (const change of [r => { r.source.branch = 'develop' }, r => { r.source.commit = 'b'.repeat(40) },
    r => { r.qualification.macosArchitectures = ['arm64'] }, r => { r.qualification.pinTests = 'skipped' },
    r => { r.qualification.clearSignRoot = 'test' }]) {
    const r = receipt(); change(r); assert.throws(() => verifyAlphaReceipt(r, files, sha))
  }
  assert.throws(() => verifyAlphaReceipt(receipt(), { 'libkkemu.dylib': files['libkkemu.dylib'] }, sha), /libkkemu.dll/)
  assert.throws(() => verifyAlphaReceipt(receipt(), { ...files, 'libkkemu.dll': Buffer.from('different build') }, sha), /libkkemu.dll/)
})

test('a matching file hash cannot hide a compiled test root', () => {
  const r = receipt()
  const bad = Buffer.concat([files['libkkemu.dll'], Buffer.from('02de9231b2094433235532fb1932e324a2c7304195e12e610c675cccbbd606dae7', 'hex')])
  r.files['libkkemu.dll'] = { size: bad.length, sha256: createHash('sha256').update(bad).digest('hex') }
  assert.throws(() => verifyAlphaReceipt(r, { ...files, 'libkkemu.dll': bad }, sha), /wrong compiled ClearSign root/)
})

test('manifest distinguishes the app certification head from its firmware source', () => {
  const app = 'c'.repeat(40)
  const m = bundleManifest(receipt(), { id: 13, name: 'artifact', digest: 'sha256:123' }, { id: 14, head_sha: app }, 'BitHighlander/keepkey-vault')
  assert.equal(m.source.headSha, app)
  assert.equal(m.source.firmwareSha, sha)
  assert.equal(m.source.firmwareBranch, 'alpha')
  assert.equal(m.files['libkkemu.dll'].sha256, receipt().files['libkkemu.dll'].sha256)
  assert.equal(m.requiredSymbols.length, 12)
  assert.deepEqual(m.requiredSymbols, REQUIRED_SYMBOLS)
})
