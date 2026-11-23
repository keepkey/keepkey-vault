import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dateLocale } from './date-locale'

// Audit v6 R8: with Portuguese UI the asset header read "Em cache · Nov 18, 2026,
// 4:21 PM" and "Sincronizado · 05:31 PM": dates used the number-format
// preference (default en-US), not the UI language.

const at = new Date(2026, 10, 18, 16, 21)
const synced = new Date(2026, 10, 18, 17, 31)

describe('dateLocale', () => {
	it('follows the UI language over the default en-US number format', () => {
		expect(dateLocale('pt', 'en-US')).toBe('pt-u-ca-gregory')
		expect(at.toLocaleString(dateLocale('pt', 'en-US'), { dateStyle: 'medium', timeStyle: 'short' })).toBe('18 de nov. de 2026, 16:21')
		expect(synced.toLocaleTimeString(dateLocale('pt', 'en-US'), { timeStyle: 'short' })).toBe('17:31')
	})

	it('keeps the region of a number format in the same language', () => {
		expect(dateLocale('en', 'en-GB')).toBe('en-GB-u-ca-gregory')
		expect(synced.toLocaleTimeString(dateLocale('en', 'en-GB'), { timeStyle: 'short' })).toBe('17:31')
		expect(dateLocale('pt', 'pt-PT')).toBe('pt-PT-u-ca-gregory')
		expect(dateLocale('en', 'en-US')).toBe('en-US-u-ca-gregory')
	})

	it('ignores a number format in another language, and bad values', () => {
		expect(dateLocale('de', 'pt-BR')).toBe('de-u-ca-gregory')
		expect(dateLocale(undefined, 'en-US')).toBe('en-US-u-ca-gregory')
		expect(dateLocale('not a locale!!', 'also bad!!')).toBe('en-US-u-ca-gregory')
	})

	it('merges with a -u- extension a stored number format may already carry', () => {
		const locale = dateLocale('en', 'en-US-u-nu-arab')
		expect(() => at.toLocaleString(locale)).not.toThrow()
		expect(new Intl.Locale(locale).calendar).toBe('gregory')
	})

	it('keeps Gregorian years in Thai, matching explorers (not Buddhist-era 2569)', () => {
		expect(at.toLocaleDateString(dateLocale('th', 'en-US'), { year: 'numeric' })).toContain('2026')
		expect(at.toLocaleDateString(dateLocale('th', 'th-TH'), { year: 'numeric' })).toContain('2026')
	})
})

describe('UI date formatting', () => {
	const root = join(import.meta.dir, '..')
	const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return name === 'locales' ? [] : files(path)
		return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : []
	})

	it('formats every date and time with getDateLocale()', () => {
		const offenders = files(root).flatMap(path => readFileSync(path, 'utf8').split('\n').flatMap((line, i) =>
			// Any date/time formatter whose locale is not getDateLocale().
			/toLocale(?:Date|Time)String\((?!getDateLocale\(\))/.test(line)
			|| /DateTimeFormat\((?!getDateLocale\(\))/.test(line)
			|| /Date\(.*?\)\.toLocaleString\((?!getDateLocale\(\))/.test(line)
			|| /\.toLocaleString\((?!getDateLocale\(\))[^)]*\b(?:dateStyle|timeStyle|hour|minute|month|weekday)\b/.test(line)
				? [`${path.slice(root.length + 1)}:${i + 1}`] : []))
		expect(offenders).toEqual([])
	})
})
