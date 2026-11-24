// KEEPKEY-159: the Activity page, its transaction detail and the top bar
// showed English in every locale but pt, because their keys only existed in
// en/pt, and a few labels (fee, filter pills, counters) never went through uiText.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { messageKey } from '../src/shared/message-key'

const dir = join(import.meta.dir, '../src/mainview/i18n/locales')
const ui = (locale: string) => JSON.parse(readFileSync(join(dir, locale, 'ui.json'), 'utf8'))
const source = (file: string) => readFileSync(join(import.meta.dir, '../src/mainview/components', file), 'utf8')
const locales = readdirSync(dir)
const FILES = ['ActivityPage.tsx', 'ActivityPanel.tsx', 'TopNav.tsx']
// Symbols and brand names read the same in every language.
const INVARIANT = new Set(['…', '×', '→', '· dev', 'blk', 'KeepKey', 'KeepKey Vault', 'ShapeShift', 'Memo'])

const copy = [...new Set(FILES.flatMap(file =>
  [...source(file).matchAll(/uiText\("((?:[^"\\]|\\.)*)"/g)].map(m => m[1])))]
  .filter(text => !INVARIANT.has(text))
const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',')

describe('Activity copy (KEEPKEY-159)', () => {
  test('every uiText string on the Activity screens has a key in every locale', () => {
    expect(copy.length).toBeGreaterThan(50)
    for (const locale of locales) {
      const catalog = ui(locale)
      const missing = copy.filter(text => typeof catalog[messageKey(text)] !== 'string')
      expect(missing, locale).toEqual([])
    }
  })

  test('translations keep the same placeholders', () => {
    for (const locale of locales) {
      const catalog = ui(locale)
      for (const text of copy) expect(placeholders(catalog[messageKey(text)]), `${locale}: ${text}`).toBe(placeholders(text))
    }
  })

  test('labels that were literals now go through uiText', () => {
    const page = source('ActivityPage.tsx'), panel = source('ActivityPanel.tsx')
    expect(panel).not.toContain('`fee: ')
    expect(panel).not.toMatch(/label=\{`Payment /)
    expect(panel).not.toContain("'Select a chain to scan'")
    expect(panel).not.toContain('uiText("Swaps (")')
    expect(page).not.toMatch(/label: '(Sent|Received|Swaps|Signs)'/)
    expect(page).not.toContain(": 'None'")
    expect(page).not.toContain("'Loading…'")
    // The history error is raw backend text; it must not be rendered as-is.
    expect(page).not.toContain('historyError ||')
    expect(page).toContain('uiText("Could not load activity history. Try Rescan.")')
  })

  test('the broadcast status is a state, not the "Broadcast" button verb', () => {
    expect(source('ActivityPanel.tsx')).toContain(`case 'broadcast': return uiText("Broadcasted")`)
    expect(ui('pt')[messageKey('Broadcasted')]).toBe('Transmitida')
  })
})
