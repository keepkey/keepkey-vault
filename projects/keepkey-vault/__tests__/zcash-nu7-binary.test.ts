import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireZcashNu7Builder, ZCASH_NU7_BUILDER_CAPABILITY } from '../src/bun/zcash-nu7-binary'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture(bytes: string = ZCASH_NU7_BUILDER_CAPABILITY) {
  const directory = mkdtempSync(join(tmpdir(), 'nu7-builder-test-')); directories.push(directory)
  const path = join(directory, 'zcash-cli')
  writeFileSync(path, bytes)
  const manifest = { schemaVersion: 1, capability: ZCASH_NU7_BUILDER_CAPABILITY, sha256: createHash('sha256').update(bytes).digest('hex') }
  const save = (value: unknown = manifest) => writeFileSync(`${path}.nu7.json`, JSON.stringify(value))
  return { path, manifest, save }
}

test('a matching builder manifest verifies bytes without executing an old program', () => {
  const f = fixture(); f.save()
  expect(requireZcashNu7Builder(f.path)).toBe(f.manifest.sha256)
})
test('missing, corrupt, mismatched or counterfeit capability metadata is rejected before launch', () => {
  const f = fixture()
  expect(() => requireZcashNu7Builder(f.path)).toThrow('updated Zcash Nu7 transaction builder')
  for (const wrong of [{}, { ...f.manifest, schemaVersion: 2 }, { ...f.manifest, capability: 'legacy' }, { ...f.manifest, sha256: '0'.repeat(64) }]) {
    f.save(wrong)
    expect(() => requireZcashNu7Builder(f.path)).toThrow('updated Zcash Nu7 transaction builder')
  }
  f.save(); writeFileSync(f.path, 'old binary, ignores new arguments')
  expect(() => requireZcashNu7Builder(f.path)).toThrow('updated Zcash Nu7 transaction builder')
  const old = fixture('old binary, ignores new arguments'); old.save()
  expect(() => requireZcashNu7Builder(old.path)).toThrow('updated Zcash Nu7 transaction builder')
})
