import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EMULATOR_RECEIPT_FILENAME, certifiedEmulatorSourceSha256, reviewedEmulatorReceiptSource } from '../src/shared/emulator-receipt'

const directories: string[] = []
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'emulator-sign-receipt-')); directories.push(path); return path }
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }) })

// Compile the real implementation against a public synthetic certified artifact.
// No runtime override exists: import.meta.dir still resolves the fixed bundle.
async function fixture(platform: 'darwin' | 'win32') {
  const directory = temporary()
  const source = 'PUBLIC SYNTHETIC CERTIFIED EMULATOR'
  const sourceSha = sha(source)
  const filename = platform === 'darwin' ? 'libkkemu.dylib' : 'libkkemu.dll'
  const code = join(directory, 'app', 'bun'); mkdirSync(code, { recursive: true })
  const bundle = join(directory, 'app', 'emulator'); mkdirSync(bundle)
  const entry = join(directory, 'entry.ts')
  const generator = JSON.stringify(resolve(import.meta.dir, '../scripts/write-emulator-signing-receipt.ts'))
  writeFileSync(entry, `export * from ${JSON.stringify(resolve(import.meta.dir, '../src/bun/emulator-signed-provenance.ts'))};
export * from ${generator};
import {verifyEmulatorBeforeSigning,writeEmulatorSigningReceipt} from ${generator};
if(import.meta.main){
 const [mode,path,source]=process.argv.slice(2);
 if(mode==='--record')writeEmulatorSigningReceipt(path,source);
 else console.log(verifyEmulatorBeforeSigning(path,mode==='--verify-sealed'));
}\n`)
  const result = await Bun.build({ entrypoints: [entry], target: 'bun', outdir: code, naming: 'verification.mjs',
    define: { 'process.platform': JSON.stringify(platform) }, plugins: [{ name: 'public-certified-fixture', setup(build) {
      build.onLoad({ filter: /emulator-bundle\/manifest\.json$/ }, () => ({ loader: 'json', contents: JSON.stringify({ version: '7.17.0', files: {
        'libkkemu.dylib': { sha256: sourceSha }, 'libkkemu.dll': { sha256: sourceSha },
      } }) }))
    } }] })
  if (!result.success) throw new Error(result.logs.join('\n'))
  const module = await import(join(code, 'verification.mjs'))
  const library = join(bundle, filename); writeFileSync(library, source)
  const sourceIdentity = module.verifyEmulatorBeforeSigning(library)
  // A signing operation changes bytes; the receipt is written afterwards.
  writeFileSync(library, source + '\nPUBLIC SYNTHETIC PLATFORM SIGNATURE')
  module.writeEmulatorSigningReceipt(library, sourceIdentity)
  return { directory, bundle, library, filename, sourceSha, module, modulePath: join(code, 'verification.mjs'),
    receipt: join(bundle, EMULATOR_RECEIPT_FILENAME), loadedSha: sha(readFileSync(library)) }
}

test('receipt validation uses only the compiled source identity and exact schema', () => {
  const filename = 'libkkemu.dylib'
  const source = certifiedEmulatorSourceSha256(filename)!
  const signedSha = 'ab'.repeat(32)
  const receipt = { schemaVersion: 1, version: '7.17.0', filename, certifiedSourceSha256: source, signedSha256: signedSha }
  expect(reviewedEmulatorReceiptSource(receipt, filename, signedSha)).toBe(source)
  for (const patch of [{ schemaVersion: 2 }, { version: '7.18.0' }, { filename: 'other.dylib' },
    { certifiedSourceSha256: '11'.repeat(32) }, { signedSha256: '22'.repeat(32) }, { extra: 'untrusted' }]) {
    expect(reviewedEmulatorReceiptSource({ ...receipt, ...patch }, filename, signedSha)).toBeNull()
  }
  expect(reviewedEmulatorReceiptSource(receipt, 'libkkemu.dll', signedSha)).toBeNull()
})

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: actual fixed-path verifier accepts post-sign bytes and rejects altered identity`, async () => {
    const f = await fixture(platform)
    expect(f.module.reviewedBundledEmulatorSourceSha256(f.library, f.loadedSha)).toBe(f.sourceSha)
    expect(() => f.module.verifyEmulatorBeforeSigning(f.library)).toThrow('certified artifact')
    expect(f.module.verifyEmulatorBeforeSigning(f.library, true)).toBe(f.sourceSha)
    expect(f.module.reviewedBundledEmulatorSourceSha256(f.library, '00'.repeat(32))).toBeNull()
    const good = readFileSync(f.receipt, 'utf8')
    for (const patch of [{ certifiedSourceSha256: '00'.repeat(32) }, { filename: 'counterfeit' }, { signedSha256: '11'.repeat(32) }]) {
      writeFileSync(f.receipt, JSON.stringify({ ...JSON.parse(good), ...patch }))
      expect(f.module.reviewedBundledEmulatorSourceSha256(f.library, f.loadedSha)).toBeNull()
    }
    writeFileSync(f.receipt, good)
    writeFileSync(f.library, 'TAMPERED AFTER PLATFORM SIGNING')
    expect(f.module.reviewedBundledEmulatorSourceSha256(f.library, f.loadedSha)).toBeNull()
    expect(() => f.module.verifyEmulatorBeforeSigning(f.library, true)).toThrow('previously signed receipt')
    expect(() => f.module.writeEmulatorSigningReceipt(f.library, '22'.repeat(32))).toThrow('Unreviewed')
  })

  test(`${platform}: user paths and symlinked metadata cannot acquire bundled trust`, async () => {
    const f = await fixture(platform)
    const user = join(f.directory, 'user-firmware'); mkdirSync(user)
    const userLibrary = join(user, f.filename)
    copyFileSync(f.library, userLibrary); copyFileSync(f.receipt, join(user, EMULATOR_RECEIPT_FILENAME))
    expect(f.module.reviewedBundledEmulatorSourceSha256(userLibrary, f.loadedSha)).toBeNull()
    const good = readFileSync(f.receipt)
    rmSync(f.receipt)
    expect(f.module.reviewedBundledEmulatorSourceSha256(f.library, f.loadedSha)).toBeNull()
    symlinkSync(join(user, EMULATOR_RECEIPT_FILENAME), f.receipt)
    expect(f.module.reviewedBundledEmulatorSourceSha256(f.library, f.loadedSha)).toBeNull()
    rmSync(f.receipt); writeFileSync(f.receipt, good)
    rmSync(f.library); symlinkSync(userLibrary, f.library)
    expect(f.module.reviewedBundledEmulatorSourceSha256(f.library, f.loadedSha)).toBeNull()
    rmSync(f.bundle, { recursive: true }); symlinkSync(user, f.bundle, 'dir')
    expect(f.module.reviewedBundledEmulatorSourceSha256(userLibrary, f.loadedSha)).toBeNull()
  })
}

test('pipeline stages the receipt and records it between inner signing and the outer seal', () => {
  const project = resolve(import.meta.dir, '..')
  const config = readFileSync(join(project, 'electrobun.config.ts'), 'utf8')
  expect(config).toContain("'emulator/nu7-emulator-receipt.json'")
  const wrapper = readFileSync(join(project, 'scripts/build-signed.ts'), 'utf8')
  expect(wrapper.indexOf('verifyEmulatorBeforeSigning(staged)')).toBeLessThan(wrapper.indexOf('copyFileSync(staged, signedCopy)'))
  expect(wrapper.indexOf('writeEmulatorSigningReceipt(signedCopy')).toBeGreaterThan(wrapper.indexOf("'codesign', '--force'", wrapper.indexOf('copyFileSync(staged, signedCopy)')))
  expect(wrapper).toContain('KEEPKEY_EMULATOR_RECEIPT_SOURCE')
  const windows = readFileSync(resolve(project, '../../scripts/build-windows-production.ps1'), 'utf8')
  expect(windows.indexOf('$EmulatorVerifyMode $BundledEmulatorDll')).toBeLessThan(windows.indexOf('foreach ($file in $filesToSign)'))
  expect(windows.indexOf('--record $BundledEmulatorDll')).toBeGreaterThan(windows.indexOf('foreach ($file in $filesToSign)'))
})

test.skipIf(process.platform === 'win32')('actual macOS re-sign script refreshes the emulator receipt before sealing and rejects tampering before signing', async () => {
  const f = await fixture('darwin')
  const app = join(f.directory, 'Synthetic.app')
  const emulator = join(app, 'Contents', 'Resources', 'app', 'emulator'); mkdirSync(emulator, { recursive: true })
  mkdirSync(join(app, 'Contents', 'MacOS'))
  const library = join(emulator, f.filename)
  copyFileSync(f.library, library); copyFileSync(f.receipt, join(emulator, EMULATOR_RECEIPT_FILENAME))
  const commands = join(f.directory, 'commands'); mkdirSync(commands)
  const order = join(f.directory, 'order.txt')
  writeFileSync(join(commands, 'codesign'), `#!/usr/bin/env python3
import hashlib,json,os,pathlib,sys
if '--verify' in sys.argv: sys.exit(0)
path=pathlib.Path(sys.argv[-1])
if path.name == 'libkkemu.dylib':
 path.write_bytes(path.read_bytes()+b'\\nsecond-public-platform-signature')
 with open(os.environ['QA_SIGN_ORDER'],'a') as f: f.write('inner\\n')
elif path.suffix == '.app':
 library=path/'Contents/Resources/app/emulator/libkkemu.dylib'
 receipt=json.loads((library.parent/'nu7-emulator-receipt.json').read_text())
 if receipt['certifiedSourceSha256'] != os.environ['QA_SOURCE_SHA']: sys.exit(28)
 if receipt['signedSha256'] != hashlib.sha256(library.read_bytes()).hexdigest(): sys.exit(29)
 with open(os.environ['QA_SIGN_ORDER'],'a') as f: f.write('outer-with-fresh-receipt\\n')
`, { mode: 0o755 })
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const bunShim = join(commands, 'receipt-bun')
  // Route the production script's generator invocation to the same real
  // generator compiled against this test's synthetic certified manifest.
  writeFileSync(bunShim, `#!/bin/sh\nshift\nexec ${quote(process.execPath)} ${quote(f.modulePath)} "$@"\n`, { mode: 0o755 })
  const entitlements = join(f.directory, 'entitlements.plist'); writeFileSync(entitlements, '<plist/>')
  const run = () => Bun.spawn(['bash', resolve(import.meta.dir, '../../../scripts/sign-macos-app.sh'), app, entitlements], {
    env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, BUN_EXECUTABLE: bunShim,
      ELECTROBUN_DEVELOPER_ID: 'PUBLIC SYNTHETIC IDENTITY', ELECTROBUN_TEAMID: 'TEST', QA_SIGN_ORDER: order, QA_SOURCE_SHA: f.sourceSha },
    stdout: 'pipe', stderr: 'pipe',
  })
  const child = run()
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exit) throw new Error(err || out)
  expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual(['inner', 'outer-with-fresh-receipt'])
  expect(f.module.verifyEmulatorBeforeSigning(library, true)).toBe(f.sourceSha)
  writeFileSync(library, readFileSync(library, 'utf8') + 'tampered-after-staging')
  const rejected = run()
  const [rejectedExit, , rejectedError] = await Promise.all([rejected.exited, new Response(rejected.stdout).text(), new Response(rejected.stderr).text()])
  expect(rejectedExit).not.toBe(0)
  expect(rejectedError).toContain('previously signed receipt')
  expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual(['inner', 'outer-with-fresh-receipt'])
})
