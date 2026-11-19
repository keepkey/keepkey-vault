import { describe, expect, test } from 'bun:test'
import { scanOutcome, summarizeRescan } from './rescan-summary'

// Echo key and interpolation so the test sees which message was chosen.
const t = (key: string, opts: Record<string, unknown> = {}) => {
	const { ns, ...values } = opts
	return Object.keys(values).length ? `${ns}:${key}:${JSON.stringify(values)}` : `${ns}:${key}`
}

describe('summarizeRescan (audit v6 U4)', () => {
	test('chains skipped by design are not counted as failures', () => {
		expect(summarizeRescan([{ count: 3 }, { count: 0, skipped: true }, { count: 1 }], t))
			.toEqual({ tone: 'new', text: 'dashboard:rescanNew:{"count":4}' })
		expect(summarizeRescan([{ count: 0 }, { count: 0, skipped: true }], t))
			.toEqual({ tone: 'idle', text: 'dashboard:rescanUpToDate' })
	})

	test('real failures are still reported with the pluralised count', () => {
		expect(summarizeRescan([{ count: 2 }, { error: 'boom' }, { count: 0, skipped: true }], t))
			.toEqual({ tone: 'warn', text: 'dashboard:rescanPartial:{"count":1,"newCount":2}' })
	})

	test('every scanned chain failing shows the last error', () => {
		expect(summarizeRescan([{ error: 'first' }, { count: 0, skipped: true }, { error: 'No device connected' }], t))
			.toEqual({ tone: 'error', text: 'dashboard:rescanFailedDetail:{"detail":"No device connected"}' })
		expect(summarizeRescan([{ error: '' }], t)).toEqual({ tone: 'error', text: 'dashboard:rescanFailed' })
	})

	test('a single skipped chain says history is unavailable, not up to date', () => {
		expect(summarizeRescan([{ count: 0, skipped: true }], t)).toEqual({ tone: 'idle', text: 'dashboard:rescanUnavailable' })
		expect(summarizeRescan([{ count: 0, skipped: true }, { count: 0, skipped: true }], t, { many: true }))
			.toEqual({ tone: 'idle', text: 'dashboard:rescanUnavailableAll' })
	})

	test('nothing to scan', () => {
		expect(summarizeRescan([], t)).toEqual({ tone: 'error', text: 'dashboard:rescanNoAddresses' })
	})
})

describe('scanOutcome', () => {
	test('keeps replies and turns throws into outcomes', async () => {
		expect(await scanOutcome(async () => ({ count: 2 }))).toEqual({ count: 2, skipped: false })
		expect(await scanOutcome(async () => ({ count: 0, skipped: true }))).toEqual({ count: 0, skipped: true })
		expect(await scanOutcome(async () => null)).toEqual({ count: 0, skipped: false })
		expect(await scanOutcome(async () => { throw new Error('timeout') })).toEqual({ error: 'timeout' })
	})
})

describe('real catalogs', () => {
	test('plural forms render in English and Portuguese', async () => {
		const i18n = (await import('../i18n')).default
		const original = i18n.language
		const render = async (lang: string) => {
			await i18n.changeLanguage(lang)
			await i18n.loadNamespaces('dashboard')
			return [
				summarizeRescan([{ count: 1 }], i18n.t).text,
				summarizeRescan([{ count: 5 }], i18n.t).text,
				summarizeRescan([{ count: 12 }, { error: 'x' }], i18n.t).text,
				summarizeRescan([{ count: 1 }, { error: 'x' }, { error: 'y' }], i18n.t).text,
			]
		}
		try {
			expect(await render('en')).toEqual(['+1 transaction', '+5 transactions', '12 new · 1 network failed', '1 new · 2 networks failed'])
			expect(await render('pt')).toEqual(['+1 transação', '+5 transações', 'Novas: 12 · 1 rede falhou', 'Novas: 1 · 2 redes falharam'])
		} finally {
			// Shared i18next singleton: leave it as other tests expect it.
			await i18n.changeLanguage(original)
		}
	})
})
