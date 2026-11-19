/** One chain's reply to scanChainHistory, or the error it threw. */
export type ChainScanOutcome = { count: number; skipped?: boolean } | { error: string }

export type RescanTone = 'new' | 'idle' | 'warn' | 'error'
export type RescanSummary = { tone: RescanTone; text: string }

// Loose on purpose: i18next TFunction overloads do not fit a narrow signature.
type Translate = (...args: any[]) => unknown

/**
 * Result line for a history rescan. Chains the backend skips by design (shielded, Hive off,
 * network off, firmware too old) are neither scanned nor failed (audit v6 U4).
 */
export function summarizeRescan(outcomes: ChainScanOutcome[], t: Translate, opts: { many?: boolean } = {}): RescanSummary {
	const say = (key: string, opts: Record<string, unknown> = {}) => String(t(key, { ns: 'dashboard', ...opts }))
	if (!outcomes.length) return { tone: 'error', text: say('rescanNoAddresses') }
	const scanned = outcomes.filter(o => !('count' in o && o.skipped))
	if (!scanned.length) return { tone: 'idle', text: say(opts.many ? 'rescanUnavailableAll' : 'rescanUnavailable') }
	const errors = scanned.filter((o): o is { error: string } => 'error' in o)
	if (errors.length === scanned.length) {
		// Localized headline; the backend detail (last chain's, English) only follows it.
		const detail = errors[errors.length - 1].error
		return { tone: 'error', text: detail ? say('rescanFailedDetail', { detail }) : say('rescanFailed') }
	}
	const total = scanned.reduce((sum, o) => sum + ('count' in o ? o.count || 0 : 0), 0)
	if (errors.length) return { tone: 'warn', text: say('rescanPartial', { count: errors.length, newCount: total }) }
	if (total > 0) return { tone: 'new', text: say('rescanNew', { count: total }) }
	return { tone: 'idle', text: say('rescanUpToDate') }
}

/** Run one scanChainHistory call and keep its failure as an outcome instead of throwing. */
export async function scanOutcome(run: () => Promise<{ count: number; skipped?: boolean } | null | undefined>): Promise<ChainScanOutcome> {
	try {
		const result = await run()
		return { count: result?.count || 0, skipped: !!result?.skipped }
	} catch (e: any) {
		return { error: e?.message || '' }
	}
}
