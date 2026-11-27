// The Portuguese catalog calls the device "a KeepKey" (KEEPKEY-210). The apps keep their own names
// ("o KeepKey Desktop", "o KeepKey Vault", "o KeepKey Mobile"), so only the device is checked here.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dir, '../src/mainview/i18n/locales/pt')
const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []

const APP = String.raw`(?!\s+(?:Desktop|Vault|Mobile)\b)`
// A whole word before "KeepKey": the lookbehind is Unicode-aware, so "endereço KeepKey" is not read as "o KeepKey".
const MASCULINE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:o|do|no|ao|pelo|um|seu|meu|este|esse|deste|desse|neste|nesse)\s+KeepKey\b${APP}`, 'iu')
const PARTICIPLE = new RegExp(String.raw`\bKeepKey\b${APP}(?:\s+\{\{\w+\}\})?\s+(?:detectado|conectado|desconectado|bloqueado|desbloqueado|pronto|vazio)\b`)

test('the Portuguese catalog never treats the KeepKey device as masculine', () => {
  const found = readdirSync(dir).filter(file => file.endsWith('.json')).flatMap(file =>
    strings(JSON.parse(readFileSync(join(dir, file), 'utf8')))
      .filter(text => MASCULINE.test(text) || PARTICIPLE.test(text))
      .map(text => `${file}: ${text}`))
  expect(found).toEqual([])
})

test('the app names stay as they are', () => {
  expect(MASCULINE.test('Abra o KeepKey Desktop')).toBe(false)
  expect(MASCULINE.test('Conecte o KeepKey')).toBe(true)
  expect(MASCULINE.test('Usar endereço KeepKey')).toBe(false)
})
