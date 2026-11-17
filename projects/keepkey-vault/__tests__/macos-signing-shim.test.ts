import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createMacosSigningShim, runMacosCodesign } from '../scripts/macos-signing/shim'

const cleanup: (() => void)[] = []
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove() })
const digest = (path: string) => createHash('sha256').update(new Uint8Array(readFileSync(path))).digest('hex')

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'macos-signing-shim-test-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const bundlePath = join(directory, 'Vault app.app')
  const helpers = ['emulator/libkkemu.dylib', 'zcash-cli', 'monero-tools/monero-wallet-rpc'].map((name, index) => {
    const source = join(directory, 'signed source ' + index)
    writeFileSync(source, 'PUBLIC SYNTHETIC PREVERIFIED SOURCE ' + index)
    return { bundleRelativePath: 'Contents/Resources/app/' + name, signedSourcePath: source }
  })
  const shim = createMacosSigningShim({ bundlePath, helpers, environment: { PATH: '/public/original/path', PUBLIC_BUILD_FLAG: 'kept' } })
  cleanup.push(shim.cleanup)
  const ledgerPath = shim.environment.KEEPKEY_MACOS_SIGNING_LEDGER!
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  for (const [index, helper] of ledger.helpers.entries()) {
    mkdirSync(dirname(helper.path), { recursive: true })
    copyFileSync(helpers[index].signedSourcePath, helper.path)
  }
  return { directory, bundlePath: ledger.bundlePath, helpers, ledger, shim, ledgerPath }
}

test('both Hutch signing passes preserve reviewed helper bytes and delegate other code and outer seals', () => {
  const f = fixture()
  const calls: string[][] = []
  const metadata = join(f.bundlePath, 'Contents', 'Resources', 'app', 'helper-checksums.json')
  writeFileSync(metadata, JSON.stringify(f.ledger.helpers))
  const other = join(f.bundlePath, 'Contents', 'MacOS', 'bun')
  mkdirSync(dirname(other), { recursive: true }); writeFileSync(other, 'PUBLIC SYNTHETIC BUN')
  const native = (arguments_: string[]) => {
    calls.push(arguments_)
    const path = arguments_.at(-1)!
    if (arguments_.includes('--verify')) return 0
    if (path === f.bundlePath) {
      // A real codesign outer seal must see each original paired checksum.
      for (const helper of JSON.parse(readFileSync(metadata, 'utf8'))) expect(digest(helper.path)).toBe(helper.sha256)
    } else writeFileSync(path, readFileSync(path, 'utf8') + '\nPUBLIC SYNTHETIC NEW SIGNATURE')
    return 0
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const helper of f.ledger.helpers) expect(runMacosCodesign(['--force', '--timestamp', '--sign', 'PUBLIC TEST ID', helper.path], f.ledger, native)).toBe(0)
    expect(runMacosCodesign(['--force', '--sign', 'PUBLIC TEST ID', other], f.ledger, native)).toBe(0)
    expect(runMacosCodesign(['--force', '--sign', 'PUBLIC TEST ID', f.bundlePath], f.ledger, native)).toBe(0)
  }
  expect(calls.filter(arguments_ => arguments_.includes('--sign')).map(arguments_ => arguments_.at(-1))).toEqual([other, f.bundlePath, other, f.bundlePath])
  expect(calls.filter(arguments_ => arguments_.includes('--verify'))).toHaveLength(6)
  for (const helper of f.ledger.helpers) expect(digest(helper.path)).toBe(helper.sha256)
  expect(f.shim.environment.PUBLIC_BUILD_FLAG).toBe('kept')
  expect(f.shim.environment.PATH?.endsWith(':/public/original/path')).toBe(true)
  const executable = join(dirname(f.ledgerPath), 'codesign')
  expect(readFileSync(executable, 'utf8')).toContain(process.execPath)
  expect(Bun.spawnSync(['sh', '-n', executable]).exitCode).toBe(0)
  f.shim.cleanup()
  expect(existsSync(f.ledgerPath)).toBe(false)
})

test('changed bytes and invalid signatures fail before a helper can be re-signed', () => {
  const f = fixture()
  const helper = f.ledger.helpers[0]
  const calls: string[][] = []
  const native = (arguments_: string[]) => { calls.push(arguments_); return 37 }
  expect(runMacosCodesign(['--sign', 'PUBLIC TEST ID', helper.path], f.ledger, native)).toBe(37)
  expect(calls).toEqual([['--verify', '--strict', helper.path]])
  writeFileSync(helper.path, 'PUBLIC SYNTHETIC TAMPERED CODE')
  calls.length = 0
  expect(() => runMacosCodesign(['--sign', 'PUBLIC TEST ID', helper.path], f.ledger, native)).toThrow('bytes changed')
  expect(calls).toEqual([])
})

test.skipIf(process.platform !== 'darwin')('the generated executable runs its actual entrypoint and preserves verification arguments', () => {
  const f = fixture()
  const executable = join(dirname(f.ledgerPath), 'codesign')
  const lines = readFileSync(executable, 'utf8').split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[0]).toBe('#!/bin/sh')
  expect(lines[1]).toStartWith('exec ')
  // Verification of a nonexistent file is read-only. No --sign invocation
  // or identity reaches the native codesign executable in this test.
  const missing = join(f.directory, "missing helper with spaces and 'quotes'.dylib")
  const child = Bun.spawnSync([executable, '--verify', '--strict', missing], { env: f.shim.environment })
  expect(child.exitCode).not.toBe(0)
  expect(child.stderr.toString()).toContain(missing)
  expect(child.stderr.toString()).not.toContain('[macos-signing]')
  const rejected = Bun.spawnSync([executable, '--verify', '--strict', missing], { env: { ...f.shim.environment, KEEPKEY_MACOS_SIGNING_LEDGER: join(f.directory, 'missing-ledger.json') } })
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr.toString()).toContain('[macos-signing]')
})

test('signature verification cannot replace the helper bytes before preservation', () => {
  const f = fixture()
  const helper = f.ledger.helpers[0]
  expect(() => runMacosCodesign(['--sign', 'PUBLIC TEST ID', helper.path], f.ledger, () => {
    writeFileSync(helper.path, 'PUBLIC SYNTHETIC UNEXPECTED CHANGE'); return 0
  })).toThrow('changed during signature verification')
})

test('verification is delegated unchanged and deep ancestor signing fails closed', () => {
  const f = fixture()
  const arguments_ = ['--verify', '--deep', '--strict', f.bundlePath]
  const calls: string[][] = []
  const native = (value: string[]) => { calls.push(value); return 23 }
  expect(runMacosCodesign(arguments_, f.ledger, native)).toBe(23)
  expect(calls).toEqual([arguments_])
  expect(() => runMacosCodesign(['--force', '--deep', '--sign', 'PUBLIC TEST ID', f.bundlePath], f.ledger, native)).toThrow('Deep signing')
  expect(calls).toHaveLength(1)
})

test('preserving one helper never claims that additional targets or unknown options were signed', () => {
  const f = fixture()
  const helper = f.ledger.helpers[0]
  const other = join(f.directory, 'other.dylib')
  writeFileSync(other, 'PUBLIC SYNTHETIC OTHER CODE')
  const calls: string[][] = []
  const native = (value: string[]) => { calls.push(value); return 0 }
  expect(() => runMacosCodesign(['--sign', 'PUBLIC TEST ID', other, helper.path], f.ledger, native)).toThrow('exactly one target')
  expect(() => runMacosCodesign(['--sign', 'PUBLIC TEST ID', helper.path, other], f.ledger, native)).toThrow('exactly one target')
  expect(() => runMacosCodesign(['--sign', 'PUBLIC TEST ID', '--unknown-signing-behavior', helper.path], f.ledger, native)).toThrow('Unsupported codesign option')
  expect(() => runMacosCodesign(['--sign', 'PUBLIC TEST ID', '--entitlements', '--force', helper.path], f.ledger, native)).toThrow('Missing codesign option value')
  expect(calls).toEqual([])
  expect(runMacosCodesign(['--force', '--verbose', '--timestamp', '--sign', 'PUBLIC TEST ID', '--options', 'runtime', '--entitlements', '/public/entitlements.plist', helper.path], f.ledger, native)).toBe(0)
  expect(calls).toEqual([['--verify', '--strict', helper.path]])
})

test('symlink aliases and non-bundle helper entries cannot acquire preservation', () => {
  const f = fixture()
  const helper = f.ledger.helpers[0]
  const alias = join(f.directory, 'alias.dylib')
  symlinkSync(helper.path, alias)
  expect(() => runMacosCodesign(['--sign', 'PUBLIC TEST ID', alias], f.ledger, () => 0)).toThrow('symlink')
  rmSync(helper.path); symlinkSync(f.helpers[0].signedSourcePath, helper.path)
  expect(() => runMacosCodesign(['--sign', 'PUBLIC TEST ID', helper.path], f.ledger, () => 0)).toThrow('symlink')
  expect(() => createMacosSigningShim({ bundlePath: f.bundlePath, helpers: [{ ...f.helpers[0], bundleRelativePath: '../elsewhere.dylib' }] })).toThrow('Invalid macOS helper signing entry')
  expect(() => createMacosSigningShim({ bundlePath: f.bundlePath, helpers: [f.helpers[0], f.helpers[0]] })).toThrow('Invalid macOS helper signing entry')
})
