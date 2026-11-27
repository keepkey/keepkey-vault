import i18n from '../i18n'
import { getNumberLocale } from './number-locale'
import { validNumberLocale } from '../../shared/locale'

/**
 * Locale for dates and times (audit v6 R8). Month names and the clock follow
 * the UI language, not the number-format preference: with Portuguese UI and the
 * default en-US number format, a date must read "18 de nov. de 2026, 16:21",
 * not "Nov 18, 2026, 4:21 PM". When the number format is the same language
 * (en-GB with English UI), its region is kept, so that choice still gives a
 * 24-hour clock and day-first dates. The calendar is always Gregorian.
 */
export function dateLocale(uiLanguage: string | undefined, numberLocale: string): string {
  const language = validNumberLocale(uiLanguage || 'en').split('-')[0]
  const number = validNumberLocale(numberLocale)
  // Gregorian always: Thai defaults to the Buddhist era (2569 for 2026), which
  // would not match explorers or any other timestamp the user compares with.
  const base = number.split('-')[0] === language ? number : language
  // Through Intl.Locale: a stored locale may already carry a -u- extension
  // (e.g. en-US-u-nu-arab), and appending a second one would be invalid.
  try { return new Intl.Locale(base, { calendar: 'gregory' }).toString() }
  catch { return 'en-US-u-ca-gregory' }
}

export const getDateLocale = (): string => dateLocale(i18n.resolvedLanguage || i18n.language, getNumberLocale())
