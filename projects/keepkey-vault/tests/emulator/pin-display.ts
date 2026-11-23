import { strict as assert } from 'node:assert'
import { FFIType, ptr, type Library } from 'bun:ffi'

export const pinFontSymbols = {
  get_pin_font: {args: [], returns: FFIType.ptr},
  draw_char: {args: [FFIType.ptr, FFIType.ptr, FFIType.i8, FFIType.ptr], returns: FFIType.void},
} as const

export const pinDisplaySymbols = {
  ...pinFontSymbols,
  kkemu_pop_frame: {args: [FFIType.ptr], returns: FFIType.i32},
} as const

const digits = '123456789'
const threshold = [[0,128,32,160],[192,64,224,96],[48,176,16,144],[240,112,208,80]]

export function pinGlyphs(font: Library<typeof pinFontSymbols>['symbols']) {
  const pixels = Buffer.alloc(256 * 64, 0x11)
  // C Canvas: pointer, uint16 height/width, bool dirty. This canvas is separate
  // from the emulator display. Both supported macOS ABIs use 64-bit pointers.
  const canvas = Buffer.alloc(16)
  canvas.writeBigUInt64LE(BigInt(ptr(pixels)), 0)
  canvas.writeUInt16LE(64, 8)
  canvas.writeUInt16LE(256, 10)
  const params = Buffer.alloc(6)
  params[0] = 255

  return Array.from({length: 9}, (_, position) => {
    const row = 2 - Math.floor(position / 3)
    const col = position % 3
    return [...digits].map(digit => {
      pixels.fill(0x11)
      const x = 200 + col * 19 + (digit === '1' ? 1 : 0)
      const y = 8 + row * 19
      params.writeUInt16LE(x, 2)
      params.writeUInt16LE(y, 4)
      font.draw_char(ptr(canvas), font.get_pin_font(), digit.charCodeAt(0), ptr(params))
      const width = digit === '1' ? 4 : 8
      const pattern = Array.from({length: width * 12}, (_, i) => {
        const xx = x + i % width
        const yy = y + Math.floor(i / width)
        return pixels[yy * 256 + xx] > threshold[yy & 3][xx & 3]
      })
      return { digit, matches: (isLit: (x: number, y: number) => boolean) =>
        pattern.every((lit, i) => isLit(x + i % width, y + Math.floor(i / width)) === lit) }
    })
  })
}

export function readRenderedPinMatrix(glyphs: ReturnType<typeof pinGlyphs>, isLit: (x: number, y: number) => boolean): string | null {
  const matrix = glyphs.map(cell => {
    const matches = cell.filter(glyph => glyph.matches(isLit))
    return matches.length === 1 ? matches[0].digit : ''
  })
  return matrix.slice().sort().join('') === digits ? matrix.join('') : null
}

/** Compare the firmware framebuffer against the independently reported matrix. */
export async function assertPinDisplay(ffi: Pick<Library<typeof pinDisplaySymbols>, 'symbols'>, matrix: string) {
  const glyphs = pinGlyphs(ffi.symbols)
  const frame = new Uint8Array(2048)
  let matchingDigits = 0
  const deadline = performance.now() + 2500
  while (matchingDigits !== 9 && performance.now() < deadline) {
    for (let drained = 0; drained < 64 && ffi.symbols.kkemu_pop_frame(ptr(frame)); drained++) {
      const isLit = (x: number, y: number) => !!(frame[(y >> 3) * 256 + x] & (1 << (y & 7)))
      matchingDigits = glyphs.filter((cell, i) => cell[Number(matrix[i]) - 1].matches(isLit)).length
    }
    if (matchingDigits !== 9) await Bun.sleep(20)
  }
  assert.equal(matchingDigits, 9, 'All nine PIN cells must match the prompted matrix')
}
