import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nu7ReleaseAssetProblems } from '../scripts/nu7-release-assets'
import { writeZcashNu7Manifest } from '../scripts/write-zcash-nu7-manifest'
import { ZCASH_NU7_BUILDER_CAPABILITY } from '../src/bun/zcash-nu7-binary'
import { certifiedEmulatorSourceSha256 } from '../src/shared/emulator-receipt'
import { writeEmulatorSigningReceipt } from '../scripts/write-emulator-signing-receipt'
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nu7-release-assets-')); directories.push(dir)
  mkdirSync(join(dir, 'emulator'))
  copyFileSync(join(import.meta.dir, '../emulator-bundle/libkkemu.dylib'), join(dir, 'emulator/libkkemu.dylib'))
  const builder = join(dir, 'zcash-cli')
  writeFileSync(builder, ZCASH_NU7_BUILDER_CAPABILITY); writeZcashNu7Manifest(builder)
  return { dir, builder, emulator: join(dir, 'emulator/libkkemu.dylib') }
}
test('read-only release verification checks the exact sidecar pair and certified emulator bytes', () => {
  const f = fixture()
  expect(nu7ReleaseAssetProblems(f.dir, 'arm64')).toEqual([])
  writeFileSync(f.builder, readFileSync(f.builder, 'utf8') + 'tampered')
  expect(nu7ReleaseAssetProblems(f.dir, 'arm64').join()).toContain('updated Zcash Nu7')
})
test('signed-byte receipts require an authenticated outer app seal and remain hash-bound', () => {
  const f = fixture()
  writeFileSync(f.emulator, Buffer.concat([readFileSync(f.emulator), Buffer.from('synthetic signature')]))
  writeEmulatorSigningReceipt(f.emulator, certifiedEmulatorSourceSha256('libkkemu.dylib')!)
  expect(nu7ReleaseAssetProblems(f.dir, 'arm64').join()).toContain('verified outer app seal')
  expect(nu7ReleaseAssetProblems(f.dir, 'arm64', true)).toEqual([])
  writeFileSync(f.emulator, 'tampered after seal')
  expect(nu7ReleaseAssetProblems(f.dir, 'arm64', true)).not.toEqual([])
})
test('Intel archives exclude both the unsupported sidecar and an orphaned paired manifest', () => {
  const f = fixture()
  rmSync(f.builder)
  expect(nu7ReleaseAssetProblems(f.dir, 'x64').join()).toContain('or its Nu7 manifest')
  rmSync(`${f.builder}.nu7.json`)
  expect(nu7ReleaseAssetProblems(f.dir, 'x64')).toEqual([])
})
