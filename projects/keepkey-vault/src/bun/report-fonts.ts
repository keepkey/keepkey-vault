import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFName, PDFRawStream, type PDFContext, type PDFRef, type PDFDocument, type PDFFont, type PDFPage, type PDFPageDrawTextOptions } from 'pdf-lib'

function fontBytes(name: string): Uint8Array {
  const candidates = [join(import.meta.dir, 'fonts', name), join(import.meta.dir, '..', 'report-fonts', name), join(import.meta.dir, '..', '..', 'src', 'bun', 'fonts', name)]
  const file = candidates.find(existsSync)
  if (!file) throw new Error(`Report font is missing: ${name}`)
  return new Uint8Array(readFileSync(file))
}

/** Remove control characters, preserving user names, combining marks and scripts. */
export const reportText = (text: string) => (text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/[\r\n\t]/g, ' ')

export async function createReportFonts(doc: PDFDocument, text: string) {
  // pdf-lib queries `font.cff`; fontkit exposes the actual CFF table by tag.
  // Without this adapter it declares CJK outlines as CIDFontType2 (TrueType).
  doc.registerFontkit({
    ...fontkit,
    create(bytes: Uint8Array) {
      const font = fontkit.create(bytes)
      Object.defineProperty(font, 'cff', {value: !!(font as unknown as Record<string,unknown>)['CFF ']})
      return font
    },
  })
  // Whole-font embedding is deliberate: fontkit's CJK subsets lose outlines in
  // common viewers even when text extraction succeeds. Keep one encoding path.
  const regular = await doc.embedFont(fontBytes('NotoSans-Regular.ttf'), { subset: false })
  const bold = await doc.embedFont(fontBytes('NotoSans-Bold.ttf'), { subset: false })
  const fallbacks: PDFFont[] = []
  if (/[\u1100-\u11FF\u2E80-\u9FFF\uA960-\uD7FF\uF900-\uFAFF\uFF00-\uFFEF]|[\u{20000}-\u{3134F}]/u.test(text)) {
    const cjk = await doc.embedFont(fontBytes('NotoSansCJKsc-Regular.otf'), { subset: false })
    // Whole OTF data includes its OpenType wrapper; CIDFontType0C would be
    // correct only for a raw CFF subset. Declare the embedded stream accordingly.
    const embedder = (cjk as unknown as {embedder: {embedFontStream(context: PDFContext): Promise<PDFRef>}}).embedder
    const original = embedder.embedFontStream.bind(embedder)
    embedder.embedFontStream = async context => {
      const ref = await original(context)
      const stream = context.lookup(ref)
      if (!(stream instanceof PDFRawStream)) throw new Error('Expected an embedded OpenType font stream')
      stream.dict.set(PDFName.of('Subtype'), PDFName.of('OpenType'))
      return ref
    }
    fallbacks.push(cjk)
  }
  if (/[\u0E00-\u0E7F]/.test(text)) fallbacks.push(await doc.embedFont(fontBytes('NotoSansThai-Regular.ttf'), { subset: false }))
  const supported = new Map([regular, bold, ...fallbacks].map(font => [font, new Set(font.getCharacterSet())]))
  const preparedIds = new Map<PDFFont, Set<number>>()

  function prepareGlyphs(font: PDFFont, value: string) {
    // pdf-lib's whole-font cache includes cmap glyphs only. Thai shaping can
    // select additional mark glyphs: include them in widths/ToUnicode too, or
    // viewers assign a full-em advance to zero-width accents and split words.
    // This adapter is covered by the mixed-script export regression test.
    type Glyph = {id: number; codePoints: number[]; advanceWidth: number}
    const embedder = (font as unknown as {embedder: {font: {layout(text: string): {glyphs: Glyph[]}}; glyphCache: {access(): Glyph[]}}}).embedder
    const cached = embedder.glyphCache.access()
    let ids = preparedIds.get(font)
    if (!ids) { ids = new Set(cached.map(glyph => glyph.id)); preparedIds.set(font, ids) }
    let changed = false
    for (const glyph of embedder.font.layout(value).glyphs) {
      if (!ids.has(glyph.id)) { cached.push(glyph); ids.add(glyph.id); changed = true }
    }
    if (changed) cached.sort((a,b) => a.id-b.id)
  }

  function runs(value: string, primary: PDFFont) {
    const result: Array<{font: PDFFont; text: string}> = []
    for (const char of Array.from(value)) {
      const point = char.codePointAt(0)!
      const font = [primary, ...fallbacks].find(candidate => supported.get(candidate)?.has(point))
      if (!font) throw new Error(`Report font does not support U+${point.toString(16).toUpperCase()}`)
      const last = result[result.length - 1]
      if (last?.font === font) last.text += char
      else result.push({font, text: char})
    }
    result.forEach(run => prepareGlyphs(run.font, run.text))
    return result
  }
  function width(value: string, font: PDFFont, size: number) {
    return runs(value, font).reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, size), 0)
  }
  function draw(page: PDFPage, value: string, options: PDFPageDrawTextOptions & {font: PDFFont; size: number; x: number}) {
    let x = options.x
    for (const run of runs(value, options.font)) {
      page.drawText(run.text, {...options, x, font: run.font})
      x += run.font.widthOfTextAtSize(run.text, options.size)
    }
  }
  return { regular, bold, width, draw }
}
