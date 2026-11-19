// Vault 1.6.7 audit (i18n): receive-screen and Bitcoin QR copy was hardcoded in
// components or only had keys in en/pt, so other locales showed English.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18next from 'i18next'
import { messageKey } from '../src/shared/message-key'

const dir = join(import.meta.dir, '../src/mainview/i18n/locales')
const json = (locale: string, ns: string) => JSON.parse(readFileSync(join(dir, locale, `${ns}.json`), 'utf8'))
const source = (file: string) => readFileSync(join(import.meta.dir, '../src/mainview/components', file), 'utf8')
const locales = readdirSync(dir)

const COPY = [
  'Address Type', 'UQ (Safe)', 'EQ (Bounceable)',
  "Non-bounceable — funds won't bounce back if wallet is uninitialized",
  'Bounceable — funds will bounce back if wallet contract is not deployed',
  'Scan Bitcoin QR', 'Sign PSBT', 'Watch-only export',
  'Watch video', 'Recent Activity', 'View all', 'No indexed activity yet', 'Scan history →',
  "Edit the BIP44 derivation path. Use ' for hardened indices.", 'Apply & Re-derive',
  'Could not encode QR', 'Too much data for one QR. Choose animated UR or BBQr.',
  'Frame {{current}} of {{total}} · Keep scanning until complete', 'Single QR code',
  'Electrum transaction QR requires a PSBT or transaction',
  'Too large for an Electrum static QR; choose animated UR or BBQr', 'Too many BBQr frames',
  'Signed PSBT QR', 'Signed transaction QR',
]

describe('receive and Bitcoin QR copy (Vault 1.6.7 audit)', () => {
  test('every listed string has a key in every locale', () => {
    for (const locale of locales) {
      const ui = json(locale, 'ui')
      for (const text of COPY) expect(typeof ui[messageKey(text)], `${locale}: ${text}`).toBe('string')
      expect(typeof json(locale, 'receive').btcAccountType?.recommendation, `${locale}: SegWit tip`).toBe('string')
    }
  })

  test('the frame counter keeps both placeholders in every locale', () => {
    const key = messageKey('Frame {{current}} of {{total}} · Keep scanning until complete')
    for (const locale of locales) {
      const text: string = json(locale, 'ui')[key]
      expect(text.match(/\{\{current\}\}/g)?.length, locale).toBe(1)
      expect(text.match(/\{\{total\}\}/g)?.length, locale).toBe(1)
    }
  })

  test('the components route the copy through uiText instead of literals', () => {
    const receive = source('ReceiveView.tsx')
    expect(receive).toContain('label: uiText("UQ (Safe)")')
    expect(receive).toContain('label: uiText("EQ (Bounceable)")')
    const qr = source('BitcoinQrDialog.tsx')
    expect(qr).toContain('uiText("Too much data for one QR. Choose animated UR or BBQr.")')
    expect(qr).toContain('uiText(e.message)')
    expect(qr).not.toMatch(/`Frame \$\{/)
    // The dialog heading comes from its caller: the signed PSBT/tx titles too.
    const psbt = source('PsbtSignDialog.tsx')
    expect(psbt).toContain('uiText("Signed PSBT QR") : uiText("Signed transaction QR")')
    expect(psbt).not.toMatch(/[?:] "Signed (PSBT|transaction) QR"/)
  })

  test('Portuguese renders the frame counter as a sentence', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'pt', resources: { pt: { ui: json('pt', 'ui') } }, interpolation: { escapeValue: false } })
    const key = messageKey('Frame {{current}} of {{total}} · Keep scanning until complete')
    expect(i18n.t(key, { ns: 'ui', current: 2, total: 5 })).toBe('Parte 2 de 5 · Continue escaneando até concluir')
  })
})
