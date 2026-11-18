import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PDFDocument } from 'pdf-lib'

/** Vendored official artwork; report export also works offline. */
export async function embedBitcoinComLogo(doc: PDFDocument) {
  const candidates = [
    join(import.meta.dir, '..', 'mainview', 'assets', 'logo', 'bitcoin-com.png'),
    join(import.meta.dir, '..', 'report-assets', 'bitcoin-com.png'),
    join(import.meta.dir, '..', '..', 'src', 'mainview', 'assets', 'logo', 'bitcoin-com.png'),
  ]
  const file = candidates.find(existsSync)
  if (!file) throw new Error('Bitcoin.com report logo is missing')
  return doc.embedPng(new Uint8Array(readFileSync(file)))
}
