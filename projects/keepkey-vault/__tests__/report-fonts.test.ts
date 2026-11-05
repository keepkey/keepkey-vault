import { expect, test } from 'bun:test'
import { PDFDocument, PDFName, PDFRawStream, rgb } from 'pdf-lib'
import { createReportFonts, reportText } from '../src/bun/report-fonts'

test('exports mixed supported scripts with embedded glyphs and Unicode maps', async () => {
  const text='Café São Paulo Łódź İstanbul Кошелёк 钱包 日本語 한국어 กระเป๋าเงิน'
  expect(reportText(text)).toBe(text)
  const doc=await PDFDocument.create()
  const fonts=await createReportFonts(doc,text)
  const page=doc.addPage([1200,300])
  expect(fonts.width(text,fonts.regular,12)).toBeGreaterThan(100)
  expect(fonts.width(text,fonts.bold,12)).toBeGreaterThan(100)
  fonts.draw(page,text,{x:20,y:200,font:fonts.regular,size:12,color:rgb(0,0,0)})
  fonts.draw(page,text,{x:20,y:160,font:fonts.bold,size:12,color:rgb(0,0,0)})
  const bytes=await doc.save()
  expect(bytes.length).toBeGreaterThan(1000)
  const parsed = await PDFDocument.load(bytes)
  expect(parsed.getPageCount()).toBe(1)
  const hasOpenType = parsed.context.enumerateIndirectObjects().some(([,object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString()==='/OpenType')
  expect(hasOpenType).toBe(true)
})
