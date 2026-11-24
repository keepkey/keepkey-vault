import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import jsQR from 'jsqr'

test.skipIf(!Bun.which('magick'))('pairing dialog QR decodes to the visible manual code and production relay', () => {
  const fixture = new URL('./support/mobile-pairing.tsx', import.meta.url).pathname
  const output = execFileSync(process.execPath, [fixture], { encoding: 'utf8' })
  const { displayedCode, svg, size } = JSON.parse(output.trim().split('\n').at(-1)!)
  expect(displayedCode).toBe('SAMPLE42')
  const rgba = execFileSync('magick', ['-background', 'white', 'msvg:-', '-alpha', 'on', '-depth', '8', 'rgba:-'], { input: svg })
  const decoded = jsQR(new Uint8ClampedArray(rgba), size, size)
  expect(JSON.parse(decoded!.data)).toEqual({ code: displayedCode, url: 'https://vault.keepkey.com' })
}, 30_000)

test.skipIf(!process.env.CHROME_EXECUTABLE)('short viewport can scroll to the bottom of the pairing dialog', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const dir = await mkdtemp(join(tmpdir(), 'vault-pairing-layout-'))
  try {
    const html = join(dir, 'pairing.html')
    execFileSync(process.execPath, [new URL('./support/mobile-pairing.tsx', import.meta.url).pathname], {
      env: { ...process.env, PAIRING_LAYOUT_HTML: html },
    })
    const page = execFileSync(process.env.CHROME_EXECUTABLE!, [
      '--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
      '--window-size=800,400', '--user-data-dir=' + join(dir, 'profile'), '--dump-dom', pathToFileURL(html).href,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20000 })
    expect(page).toContain('<html data-pairing-scroll="passed">')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 30_000)
