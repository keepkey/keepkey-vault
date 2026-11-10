import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18next from 'i18next'
import { formatFiat, formatFiatCompact } from '../src/shared/fiat'
import { decimalAmount, normalizeAmountInput, validNumberLocale } from '../src/shared/locale'
import { detectLanguage, supportedLanguage, SUPPORTED_LANGUAGES } from '../src/mainview/i18n/languages'
import { formatBalance } from '../src/mainview/lib/formatting'
import { backendText } from '../src/bun/i18n'
import { FIRMWARE_PROGRESS_KEYS } from '../src/shared/firmware-progress'
import { messageKey } from '../src/shared/message-key'

describe('financial locale boundaries', () => {
  test('never relabels USD without a valid exchange rate', () => {
    for (const currency of ['EUR', 'JPY', 'BRL'] as const) {
      for (const rate of [undefined, 0, -1, Infinity, NaN]) {
        expect(formatFiat(100, currency, 'en-US', rate)).toBe('$100.00')
        expect(formatFiatCompact(100, currency, 'en-US', rate)).toBe('$100.00')
      }
    }
    expect(formatFiat(100, 'EUR', 'de-DE', 0.9)).toBe(new Intl.NumberFormat('de-DE', {style:'currency',currency:'EUR'}).format(90))
    expect(formatFiat(100, 'USD', 'en-US', 2)).toBe('$100.00')
  })
  test('accepts complete ungrouped decimal input without rounding strings', () => {
    expect(normalizeAmountInput('1,5', 'pt-BR')).toBe('1.5')
    expect(normalizeAmountInput('0,5', 'de-DE')).toBe('0.5')
    expect(normalizeAmountInput('.5', 'en-US')).toBe('0.5')
    expect(normalizeAmountInput('0.123456789012345678')).toBe('0.123456789012345678')
    expect(Number(normalizeAmountInput('1,5', 'pt-BR')) / 100).toBe(0.015)
    for (const locale of ['en-US','de-DE','fr-FR']) {
      for (const input of ['1.234,56','1,234.56','1 234','1\u202f234,56','1e3','0x10','Infinity','1xyz','-1','1..2','1,,2']) expect(normalizeAmountInput(input,locale)).toBeNull()
    }
    expect(normalizeAmountInput('1,5','en-US')).toBeNull()
    expect(normalizeAmountInput('')).toBeNull()
    expect(normalizeAmountInput('.')).toBeNull()
  })
  test('computed tiny amounts stay usable without allowing exponent input', () => {
    expect(decimalAmount(1e-10)).toBe('0.0000000001')
    expect(decimalAmount(12345.123456789)).toBe('12345.12345679')
    expect(normalizeAmountInput(decimalAmount(1e-10))).toBe('0.0000000001')
    expect(decimalAmount(Infinity)).toBe('')
  })
  test('uses the locale at every balance magnitude', () => {
    expect(formatBalance('0.1234','de-DE')).toBe('0,123400')
    expect(formatBalance('12.34','de-DE')).toBe('12,3400')
    expect(formatBalance('1234.56','de-DE')).toBe('1.234,56')
    expect(formatBalance('1e-8','de-DE')).toBe(new Intl.NumberFormat('de-DE',{notation:'scientific',maximumFractionDigits:2}).format(1e-8))
    expect(validNumberLocale('../../invalid')).toBe('en-US')
  })
})

test('language preferences normalize regional tags and respect browser priority', () => {
  expect(supportedLanguage('pt-BR')).toBe('pt')
  expect(supportedLanguage('DE-de')).toBe('de')
  expect(supportedLanguage('../es')).toBeUndefined()
  expect(supportedLanguage('zh-TW')).toBeUndefined()
  expect(supportedLanguage('zh-Hans-HK')).toBe('zh')
  expect(detectLanguage('xx',['xx','fr-CA','de'])).toBe('fr')
  expect(detectLanguage(null,['pt-BR'])).toBe('pt')
  expect(detectLanguage('es',['pt-BR'])).toBe('es')
  expect(detectLanguage(null,[])).toBe('en')
})

test('shipped plural categories and translated critical acknowledgments resolve', async () => {
  const root=join(import.meta.dir,'../src/mainview/i18n/locales')
  const resources=Object.fromEntries(SUPPORTED_LANGUAGES.map(language=>[language,Object.fromEntries(readdirSync(join(root,language)).filter(f=>f.endsWith('.json')).map(file=>[file.slice(0,-5),JSON.parse(readFileSync(join(root,language,file),'utf8'))]))]))
  const instance=i18next.createInstance()
  await instance.init({resources,lng:'en',fallbackLng:'en',defaultNS:'common',interpolation:{escapeValue:false}})
  for(const language of SUPPORTED_LANGUAGES) {
    await instance.changeLanguage(language)
    expect(instance.t('language')).toBe(resources[language].common.language)
    const warning=instance.t('firmware.installWipe.wipeAck',{ns:'setup'})
    expect(warning).toBe(resources[language].setup.firmware.installWipe.wipeAck)
    if(language!=='en')expect(warning).not.toBe(resources.en.setup.firmware.installWipe.wipeAck)
    for (const key of ['crossBody','downgradeBody','lockBody','unknownBody','noFirmwareBody','unsignedBody']) {
      expect(resources[language].setup.firmware.installWipe[key]).toBeDefined()
      if (language!=='en') expect(resources[language].setup.firmware.installWipe[key]).not.toBe(resources.en.setup.firmware.installWipe[key])
    }
    expect(instance.t('deviceBlindSignCaveat',{ns:'swap'})).toBe(resources[language].swap.deviceBlindSignCaveat)
    if (language!=='en') expect(backendText(language,'Quit')).not.toBe('Quit')
    for (const key of Object.values(FIRMWARE_PROGRESS_KEYS)) {
      expect(instance.exists(key, { lng: language, fallbackLng: false })).toBe(true)
    }
    for(const count of [0,1,2,5,21,1000000]) {
      const category=new Intl.PluralRules(language).select(count)
      expect(resources[language].asset[`tokenCount_${category}`]).toBeDefined()
      expect(instance.t('tokenCount',{ns:'asset',count})).toBe(resources[language].asset[`tokenCount_${category}`].replace('{{count}}',String(count)))
    }
  }
  await instance.changeLanguage('ru')
  expect(instance.t('tokenCount',{ns:'asset',count:2})).toBe('2 токена')
  await instance.changeLanguage('pl')
  expect(instance.t('showFiltered',{ns:'asset',count:2})).toBe('Pokaż 2 odfiltrowane tokeny')
  expect(backendText('pt-BR','Quit')).toBe('Sair')
  expect(backendText('de','at least {{minimum}}',{minimum:'1 ETH'})).toBe('mindestens 1 ETH')
})

test('the unified trade summary and cost acknowledgments stay translated', async () => {
  const sources = [
    'You send', 'Minimum receive', 'Estimated swap cost', 'Price data unavailable',
    'Source network fee', 'Paid separately', 'Estimated time', 'Fees & details',
    'Minimum source', 'Transaction memo', 'Estimate', 'Provider quote',
    'Value difference at minimum',
    'Swap cost compares the quoted input and output values, including the rate and route fees. The source network fee is separate. Minimum receive is an execution limit, not a guaranteed refund.',
    'Review and approve on KeepKey',
    'I accept the estimated swap cost of {{cost}} and a value difference of {{loss}} at minimum receive. The source network fee is separate.',
    'High swap cost: {{cost}}, excluding the source network fee.',
  ]
  const root = join(import.meta.dir, '../src/mainview/i18n/locales')
  const resources = Object.fromEntries(SUPPORTED_LANGUAGES.map(language => [language, {
    ui: JSON.parse(readFileSync(join(root, language, 'ui.json'), 'utf8')) as Record<string, string>,
  }]))
  const instance = i18next.createInstance()
  await instance.init({ resources, lng: 'en', fallbackLng: 'en', defaultNS: 'ui', interpolation: { escapeValue: false } })
  for (const language of SUPPORTED_LANGUAGES) {
    for (const source of sources) {
      const key = messageKey(source)
      expect(instance.exists(key, { lng: language, fallbackLng: false })).toBe(true)
      const translated = instance.t(key, { lng: language, cost: 'COST_TEST', loss: 'LOSS_TEST' })
      expect(translated).toBe(resources[language].ui[key].replace('{{cost}}', 'COST_TEST').replace('{{loss}}', 'LOSS_TEST'))
      expect(translated).not.toContain('{{')
      if (language !== 'en') expect(resources[language].ui[key]).not.toBe(source)
      if (source.includes('{{cost}}')) expect(translated).toContain('COST_TEST')
      if (source.includes('{{loss}}')) expect(translated).toContain('LOSS_TEST')
    }
  }
})
