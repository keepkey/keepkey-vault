import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { messageKey } from '../src/shared/message-key'
import { SUPPORTED_LANGUAGES } from '../src/mainview/i18n/languages'

// KEEPKEY-139: with the UI in another language, no text of the PSBT signing
// dialog may show in English. Review warnings, output badges and the "Signed."
// messages were plain JS strings outside uiText, which the JSX check missed.
const file = new URL('../src/mainview/components/PsbtSignDialog.tsx', import.meta.url)
const source = readFileSync(file, 'utf8')
const texts = [...new Set([...source.matchAll(/uiText\("((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`) as string))]
const catalog = (language: string) => JSON.parse(readFileSync(new URL(`../src/mainview/i18n/locales/${language}/ui.json`, import.meta.url), 'utf8')) as Record<string, string>
const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) || []).sort()

test('every text of the PSBT dialog is translated in every UI language, with its placeholders', () => {
	expect(texts.length).toBeGreaterThan(50)
	const missing: string[] = []
	for (const language of SUPPORTED_LANGUAGES) {
		const strings = catalog(language)
		for (const text of texts) {
			const translated = strings[messageKey(text)]
			if (!translated) missing.push(`${language}: ${text}`)
			else expect(placeholders(translated), `${language}: ${text}`).toEqual(placeholders(text))
		}
	}
	expect(missing).toEqual([])
})

test('review warnings, badges, errors and results go through uiText', () => {
	expect(source).not.toMatch(/warnings\.push\((?!uiText\()/)
	expect(source).not.toMatch(/setError\((?:err\?\.message \|\| )?["`]/)
	// A thrown message reaches setError(err.message) and is shown as is.
	expect(source).not.toMatch(/new Error\(["`]/)
	// The pasted-input name is shown translated, never the raw "pasted".
	expect(source).toContain('name === PASTED_NAME ? uiText("Pasted text") : name')
	for (const english of ['High fee:', 'Locktime ', 'Unusual transaction version', 'change, hidden on KeepKey', 'KeepKey shows address`', 'Signed. Quorum reached', 'Signed. Load the file', '% of sent`']) {
		const lines = source.split('\n').filter(line => line.includes(english) && !line.includes('uiText("'))
		expect(lines, english).toEqual([])
	}
})
