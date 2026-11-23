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
