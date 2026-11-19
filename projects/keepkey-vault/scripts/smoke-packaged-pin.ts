#!/usr/bin/env bun
/** Launch an unmodified macOS package and unlock a disposable public fixture. */
import { strict as assert } from 'node:assert'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dlopen } from 'bun:ffi'
import { Database } from 'bun:sqlite'
import { PNG } from 'pngjs'
import { pinFontSymbols, pinGlyphs, readRenderedPinMatrix } from '../tests/emulator/pin-display'
import manifest from '../emulator-bundle/manifest.json'
import { verifyEmulatorBeforeSigning } from './write-emulator-signing-receipt'

assert.equal(process.platform, 'darwin', 'Requires a macOS desktop session')
const [input, legacyLibrary] = process.argv.slice(2)
assert(input, 'Usage: bun scripts/smoke-packaged-pin.ts APP_OR_ARCHIVE [LEGACY_DYLIB]')
const work = realpathSync(mkdtempSync('/tmp/kk-pin-'))
let child: ReturnType<typeof Bun.spawn> | undefined

function run(...command: string[]) {
  const result = Bun.spawnSync(command, {stdout: 'inherit', stderr: 'inherit'})
  assert.equal(result.exitCode, 0, `${command[0]} failed`)
}

try {
  writeFileSync(join(work, '.vault-pin-smoke'), '')
  let app = resolve(input)
  if (input.endsWith('.tar.zst')) {
    const archive = join(work, 'app.tar')
    run('zstd', '-d', '-q', app, '-o', archive)
    run('tar', 'xf', archive, '-C', work)
    rmSync(archive)
    const bundles = [...new Bun.Glob('*.app').scanSync({cwd: work, onlyFiles: false})]
    assert.equal(bundles.length, 1, 'Expected one macOS app in the archive')
    app = join(work, bundles[0])
  }
  const resources = join(app, 'Contents', 'Resources')
  const version = JSON.parse(readFileSync(join(resources, 'version.json'), 'utf8'))
  assert.equal(version.identifier, 'com.keepkey.vault')
  const library = join(resources, 'app', 'emulator', 'libkkemu.dylib')
  const hash = createHash('sha256').update(readFileSync(library)).digest('hex')
  if (hash !== manifest.files['libkkemu.dylib'].sha256) {
    // Local signed builds link their signed library to the certified bytes via
    // the receipt sealed by the app's signature.
    run('codesign', '--verify', '--strict', app)
    verifyEmulatorBeforeSigning(library, true)
  }

  const fixture = 'vault-pin-smoke'
  const pin = '1234'
  const storage = join(work, '.keepkey', 'emulator')
  mkdirSync(storage, {recursive: true, mode: 0o700})
  const legacy = join(storage, 'libkkemu.dylib')
  if (legacyLibrary) copyFileSync(resolve(legacyLibrary), legacy)
  else writeFileSync(legacy, 'Sentinel for the preexisting legacy emulator path')
  const key = randomBytes(32)
  const tools = join(work, 'bin')
  mkdirSync(tools)
  // The native app's usual keychain bridge gets only this fixture's key. The
  // shim refuses all other operations and never calls the user's Keychain.
  writeFileSync(join(tools, 'security'), `#!/bin/sh
if [ "$#" -eq 6 ] && [ "$1" = find-generic-password ] &&
   [ "$2" = -s ] && [ "$3" = keepkey-vault-emulator ] &&
   [ "$4" = -a ] && [ "$5" = flash-encryption-key ] && [ "$6" = -w ]; then
  printf '%s\\n' '${key.toString('hex')}'
else
  exit 1
fi
`, {mode: 0o700})

  process.env.KK_EMU_DYLIB = library
  const { EmuHarness, TEST_MNEMONIC } = await import('../tests/emulator/harness')
  const harness = new EmuHarness(true)
  try {
    await harness.boot()
    await harness.connect()
    await harness.loadSeed(TEST_MNEMONIC, pin, fixture)
    const features = await harness.wallet!.getFeatures()
    assert(features.initialized && features.pinProtection, 'Fixture provisioning failed')
    const flash = harness.getFlashSnapshot()!
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    writeFileSync(join(storage, `${fixture}.enc`),
      Buffer.concat([nonce, cipher.update(flash), cipher.final(), cipher.getAuthTag()]), {mode: 0o600})
    flash.fill(0)
    key.fill(0)
  } finally {
    harness.shutdown()
  }
  const font = dlopen(library, pinFontSymbols)
  const glyphs = pinGlyphs(font.symbols)
  font.close()

  const appSupport = join(work, 'Library', 'Application Support', version.identifier)
  const appData = join(appSupport, version.channel)
  mkdirSync(appData, {recursive: true})
  const db = new Database(join(appData, 'vault.db'))
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
           INSERT INTO settings VALUES ('emulator_enabled','1'), ('offline_mode','1'), ('rest_api_enabled','0')`)
  db.close()

  const launcher = join(app, 'Contents', 'MacOS', 'launcher')
  const log = join(work, 'launcher.log')
  // Give only this child a disposable macOS user-data namespace. The invoking
  // process and the user's active Vault session keep their original profile.
  child = Bun.spawn([launcher], {
    cwd: join(app, 'Contents', 'MacOS'),
    env: {
      PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: work,
      CFFIXED_USER_HOME: work,
      TMPDIR: work,
      ELECTROBUN_CONSOLE: '1',
      ELECTROBUN_INSTALL_ROOT_NAME: version.channel,
      KEEPKEY_AUTOSTART_EMULATOR_FLASH: fixture,
      KEEPKEY_PACKAGED_PIN_SMOKE: work,
    },
    stdout: Bun.file(log),
    stderr: 'inherit',
  })

  const deadline = Date.now() + 60_000
  async function waitFor<T>(description: string, read: () => T | null): Promise<T> {
    while (Date.now() < deadline) {
      const value = read()
      if (value !== null) return value
      if (child!.exitCode !== null) throw new Error(`Vault exited while waiting for ${description}`)
      await Bun.sleep(100)
    }
    throw new Error(`Timed out waiting for ${description}`)
  }
  for (const attempt of [1, 2]) {
    const matrix = await waitFor(`all nine digits on the rendered PIN canvas (attempt ${attempt})`, () => {
      const path = join(work, `frame-${attempt}`)
      if (!existsSync(path)) return null
      const capture = JSON.parse(readFileSync(path, 'utf8')) as { raw: string; png: string }
      assert(capture.png.startsWith('data:image/png;base64,'))
      const png = PNG.sync.read(Buffer.from(capture.png.split(',')[1], 'base64'))
      assert.equal(png.width, 256)
      assert.equal(png.height, 64)
      const isLit = (x: number, y: number) => {
        const offset = (y * png.width + x) * 4
        return png.data[offset] === 255 && png.data[offset + 3] === 255
      }
      const raw = Buffer.from(capture.raw, 'base64')
      assert.equal(raw.length, 2048)
      // While playback catches up, the visible canvas may still hold the
      // previous prompt. Only interpret the current firmware frame.
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          const expected = !!(raw[(y >> 3) * png.width + x] & (1 << (y & 7)))
          if (isLit(x, y) !== expected) return null
        }
      }
      return readRenderedPinMatrix(glyphs, isLit)
    })
    const answer = attempt === 1 ? '1' : [...pin].map(digit => matrix.indexOf(digit) + 1).join('')
    const path = join(work, `answer-${attempt}`)
    writeFileSync(path + '.tmp', answer, {mode: 0o600})
    renameSync(path + '.tmp', path)
    console.log(`Packaged OLED prompt ${attempt}: all nine digits visible`)
  }
  const result = await waitFor('successful unlock', () => {
    const path = join(work, 'result')
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  })
  assert.equal(realpathSync(result.path), realpathSync(library), 'Vault must use its bundle with a legacy library present')
  assert.equal(result.sha256, hash)
  assert.equal(result.wrongPin, true)
  assert(result.requests >= 2)
  assert.equal(await Promise.race([child.exited, Bun.sleep(5000).then(() => null)]), 0, 'Vault failed to quit cleanly')
  console.log('Packaged Vault rejected the wrong PIN and unlocked using the digits read from its own canvas.')
} catch (error) {
  const log = join(work, 'launcher.log')
  if (existsSync(log)) console.error(readFileSync(log, 'utf8').split('\n').slice(-70).join('\n'))
  throw error
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([child.exited, Bun.sleep(5000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
  rmSync(work, {recursive: true, force: true})
}
