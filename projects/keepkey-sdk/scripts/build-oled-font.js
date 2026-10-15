#!/usr/bin/env node
/**
 * Build tests/fixtures/oled-font.json from the firmware's own font tables, so
 * the test harness can read device screens exactly instead of guessing at
 * pixels.
 *
 * usage: node scripts/build-oled-font.js <keepkey-firmware>/lib/board/font.c
 *
 * Each glyph becomes { w, h, rows } where rows[y] is a string of '#' (lit) and
 * '.' per pixel. Re-run when the firmware fonts change.
 */
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(process.argv[2], 'utf8')
const fonts = {}
for (const font of ['title', 'body']) {
  const glyphs = {}
  const data = new RegExp(`image_data_${font}_font_0x([0-9a-f]+)\\[[^\\]]*\\]\\s*=\\s*\\{([^}]*)\\}`, 'g')
  for (const [, code, body] of src.matchAll(data)) {
    const size = new RegExp(`${font}_font_0x${code}\\s*=\\s*\\{\\s*image_data_${font}_font_0x${code},\\s*(\\d+),\\s*(\\d+)\\s*\\}`).exec(src)
    if (!size) throw new Error(`no size for ${font} 0x${code}`)
    const w = Number(size[1]), h = Number(size[2])
    const bytes = body.split(',').map((x) => x.trim()).filter(Boolean).map(Number)
    if (bytes.length !== w * h) throw new Error(`${font} 0x${code}: ${bytes.length} bytes for ${w}x${h}`)
    const rows = []
    for (let y = 0; y < h; y++) rows.push(bytes.slice(y * w, (y + 1) * w).map((b) => (b === 0 ? '#' : '.')).join(''))
    glyphs[String.fromCharCode(parseInt(code, 16))] = { w, h, rows }
  }
  fonts[font] = glyphs
}
const out = path.join(__dirname, '../tests/fixtures/oled-font.json')
fs.writeFileSync(out, JSON.stringify({ source: 'keepkey-firmware lib/board/font.c', fonts }) + '\n')
console.log(`${out}: title ${Object.keys(fonts.title).length} glyphs, body ${Object.keys(fonts.body).length} glyphs`)
if (process.argv[3]) for (const ch of process.argv[3]) console.log(`'${ch}'\n` + fonts.body[ch].rows.join('\n'))
