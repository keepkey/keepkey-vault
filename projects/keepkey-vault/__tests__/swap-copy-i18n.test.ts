import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { swapFeeLabel, swapPickerConfirmLabel, swapPickerHeading } from '../src/mainview/lib/swap-copy'
import { SUPPORTED_LANGUAGES } from '../src/mainview/i18n/languages'
import { messageKey } from '../src/shared/message-key'

// V20: the swap asset picker's title/step and the Bun fee labels reached
// Portuguese (and every other language) users in English.
const used = new Set<string>()
const record = (text: string) => { used.add(text); return text }
for (const side of ['from', 'to'] as const) for (const confirm of [true, false]) for (const unavailable of [true, false]) for (const network of ['Base', undefined]) {
  swapPickerHeading({ side, confirm, unavailable, network }, record)
}
for (const side of ['from', 'to'] as const) swapPickerConfirmLabel(side, 'ETH', 'Base', record)
const FEE_LABELS = ['Relay app fee', 'Source network fee (estimate)', 'Relay execution fee', 'NEAR app fee', 'Destination withdrawal fee',
  'Affiliate fee', 'Outbound fee', '0x fee', 'Partner fee', 'ShapeShift fee', 'Provider fee']
for (const label of FEE_LABELS) expect(swapFeeLabel(label, record)).toBe(label)

test('every picker heading and Bun fee label is a translated UI string', () => {
  expect(used.size).toBeGreaterThanOrEqual(12 + FEE_LABELS.length)
  const english = JSON.parse(readFileSync(new URL('../src/mainview/i18n/locales/en/ui.json', import.meta.url), 'utf8'))
  for (const text of used) expect(english[messageKey(text)]).toBe(text)
  for (const language of SUPPORTED_LANGUAGES.filter(l => l !== 'en')) {
    const catalog = JSON.parse(readFileSync(new URL(`../src/mainview/i18n/locales/${language}/ui.json`, import.meta.url), 'utf8'))
    for (const text of used) {
      const translated = catalog[messageKey(text)]
      expect({ language, text, translated: typeof translated === 'string' && translated !== text }).toEqual({ language, text, translated: true })
    }
  }
})

test('a label a provider sent that Desktop does not know is shown as sent', () => {
  expect(swapFeeLabel('Solver tip', () => { throw new Error('not a Desktop string') })).toBe('Solver tip')
})
