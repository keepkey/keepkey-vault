// Jasper audit v5 V11: the empty-balance line was glued from fragments
// ("No" + chain + "balance yet"), which read "Não Bitcoin saldo ainda" in pt.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18next from 'i18next'
import { messageKey } from '../src/shared/message-key'

const SOURCE = 'No {{chain}} balance yet'
const key = messageKey(SOURCE)
const dir = join(import.meta.dir, '../src/mainview/i18n/locales')
const ui = (locale: string) => JSON.parse(readFileSync(join(dir, locale, 'ui.json'), 'utf8')) as Record<string, string>

describe('empty-balance line (V11)', () => {
  test('every locale has one sentence with a {{chain}} placeholder', () => {
    for (const locale of readdirSync(dir)) {
      const text = ui(locale)[key]
      expect(typeof text, locale).toBe('string')
      expect(text.match(/\{\{chain\}\}/g)?.length, locale).toBe(1)
    }
    expect(ui('en')[key]).toBe(SOURCE)
  })

  test('Portuguese reads as a sentence', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({ lng: 'pt', resources: { pt: { ui: ui('pt') } }, interpolation: { escapeValue: false } })
    expect(i18n.t(key, { ns: 'ui', chain: 'Bitcoin' })).toBe('Ainda não há saldo de Bitcoin')
    expect(i18n.t(key, { ns: 'ui', chain: 'Zcash' })).toBe('Ainda não há saldo de Zcash')
  })

  test('the dashboard uses the one key, not the fragments', () => {
    const dashboard = readFileSync(join(import.meta.dir, '../src/mainview/components/Dashboard.tsx'), 'utf8')
    expect(dashboard).toContain(`uiText("${SOURCE}", { chain: dchain.coin })`)
    expect(dashboard).not.toContain('uiText("balance yet")')
  })
})
