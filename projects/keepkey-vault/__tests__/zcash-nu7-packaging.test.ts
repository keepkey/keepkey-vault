import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeZcashNu7Manifest } from '../scripts/write-zcash-nu7-manifest'
import { requireZcashNu7Builder, ZCASH_NU7_BUILDER_CAPABILITY } from '../src/bun/zcash-nu7-binary'
import config from '../electrobun.config'

const directories: string[] = []
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'zcash-nu7-package-')); directories.push(path); return path }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

test('a staged helper is accepted only with its matching post-mutation manifest', () => {
  const directory = temporary()
  const source = join(directory, 'source-cli')
  writeFileSync(source, `${ZCASH_NU7_BUILDER_CAPABILITY}\nunsigned synthetic bytes`)
  writeZcashNu7Manifest(source)
  const original = requireZcashNu7Builder(source)
  // Codesigning mutates executable bytes; the old receipt must fail closed.
  writeFileSync(source, `${ZCASH_NU7_BUILDER_CAPABILITY}\nsynthetically signed bytes`)
  expect(() => requireZcashNu7Builder(source)).toThrow('updated Zcash Nu7')
  writeZcashNu7Manifest(source)
  const signed = requireZcashNu7Builder(source)
  expect(signed).not.toBe(original)
  const staged = join(directory, 'app', 'zcash-cli')
  mkdirSync(join(directory, 'app'))
  copyFileSync(source, staged)
  expect(() => requireZcashNu7Builder(staged)).toThrow('updated Zcash Nu7')
  copyFileSync(`${source}.nu7.json`, `${staged}.nu7.json`)
  expect(requireZcashNu7Builder(staged)).toBe(signed)
})

test('the actual Electrobun copy map keeps the manifest next to its selected executable', () => {
  const executable = process.platform === 'win32' ? 'zcash-cli.exe' : 'zcash-cli'
  const copy = config.build.copy as Record<string, string>
  const source = Object.keys(copy).find(key => copy[key] === executable)
  expect(source).toBeDefined()
  expect(copy[`${source}.nu7.json`]).toBe(`${executable}.nu7.json`)
})

test.skipIf(process.platform === 'win32')('the real macOS signing script refreshes the helper receipt before the outer application seal', async () => {
  const directory = temporary()
  const app = join(directory, 'Synthetic.app')
  const resources = join(app, 'Contents', 'Resources', 'app')
  mkdirSync(resources, { recursive: true })
  mkdirSync(join(app, 'Contents', 'MacOS'))
  const binary = join(resources, 'zcash-cli')
  writeFileSync(binary, ZCASH_NU7_BUILDER_CAPABILITY)
  writeZcashNu7Manifest(binary)
  const original = requireZcashNu7Builder(binary)
  const commands = join(directory, 'commands'); mkdirSync(commands)
  // This is the ONLY codesign executable reachable in this child. It alters
  // synthetic bytes and independently checks the checksum at the outer seal.
  writeFileSync(join(commands, 'codesign'), `#!/usr/bin/env python3
import hashlib,json,os,pathlib,sys
if '--verify' in sys.argv: sys.exit(0)
path=pathlib.Path(sys.argv[-1])
if path.name == 'zcash-cli':
 path.write_bytes(path.read_bytes()+b'\\nsynthetic-inner-signature')
 with open(os.environ['QA_SIGN_ORDER'],'a') as f: f.write('inner\\n')
elif path.suffix == '.app':
 binary=path/'Contents/Resources/app/zcash-cli'
 receipt=json.loads(pathlib.Path(str(binary)+'.nu7.json').read_text())
 if receipt['sha256'] != hashlib.sha256(binary.read_bytes()).hexdigest(): sys.exit(29)
 with open(os.environ['QA_SIGN_ORDER'],'a') as f: f.write('outer-with-fresh-manifest\\n')
`, { mode: 0o755 })
  const entitlements = join(directory, 'entitlements.plist'); writeFileSync(entitlements, '<plist/>')
  const order = join(directory, 'order.txt')
  const project = resolve(import.meta.dir, '..')
  const run = () => Bun.spawn(['bash', resolve(project, '../../scripts/sign-macos-app.sh'), app, entitlements], {
    env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, BUN_EXECUTABLE: process.execPath,
      ELECTROBUN_DEVELOPER_ID: 'PUBLIC SYNTHETIC IDENTITY', ELECTROBUN_TEAMID: 'TEST', QA_SIGN_ORDER: order },
    stdout: 'pipe', stderr: 'pipe',
  })
  const child = run()
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exit) throw new Error(err || out)
  expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual(['inner', 'outer-with-fresh-manifest'])
  expect(requireZcashNu7Builder(binary)).not.toBe(original)
  // A damaged staged pair is rejected before any inner or outer signing call.
  writeFileSync(binary, readFileSync(binary, 'utf8') + 'tampered-after-staging')
  const rejected = run()
  const [rejectedExit, , rejectedError] = await Promise.all([rejected.exited, new Response(rejected.stdout).text(), new Response(rejected.stderr).text()])
  expect(rejectedExit).not.toBe(0)
  expect(rejectedError).toContain('updated Zcash Nu7 transaction builder')
  expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual(['inner', 'outer-with-fresh-manifest'])
})

test('build and CI paths regenerate after binary creation and remove the paired Intel manifest', () => {
  const project = resolve(import.meta.dir, '..')
  const make = readFileSync(resolve(project, '../../Makefile'), 'utf8')
  expect(make.slice(make.indexOf('build-zcash-cli-debug:'), make.indexOf('# Cross-compile'))).toContain('write-zcash-nu7-manifest.ts zcash-cli/target/debug/zcash-cli')
  const intel = make.slice(make.indexOf('build-zcash-cli-intel:'), make.indexOf('# --- Architecture Verification'))
  expect(intel.indexOf('write-zcash-nu7-manifest.ts')).toBeGreaterThan(intel.indexOf('codesign --force'))
  const workflow = readFileSync(resolve(project, '../../.github/workflows/build.yml'), 'utf8')
  expect(workflow).toContain('bun ../scripts/write-zcash-nu7-manifest.ts target/release/zcash-cli')
  expect(workflow).toContain('rm "$ZCASH_DEST" "${ZCASH_DEST}.nu7.json"')
})
