import type { AppSettings } from '../../shared/types'

/** Waits between attempts after a failed read. After the last one the loader stops; a later settings-changed event
 *  (including the backend's push) starts a fresh read. */
export const SETTINGS_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

export interface SettingsLoaderDeps {
	request: () => Promise<AppSettings>
	setTimer: (run: () => void, ms: number) => unknown
	clearTimer: (timer: unknown) => void
	delaysMs?: number[]
	warn?: (message: string) => void
}

/** Reads app settings and retries a failed read, so Zcash, Hive and Monero are not left hidden by one failed call
 *  (audit v6 H10). The latest load wins: an older reply or retry never overwrites a newer one. */
export function createSettingsLoader(apply: (settings: AppSettings) => void, deps: SettingsLoaderDeps) {
	const delays = deps.delaysMs ?? SETTINGS_RETRY_DELAYS_MS
	let generation = 0
	let timer: unknown = null
	const clear = () => { if (timer !== null) { deps.clearTimer(timer); timer = null } }
	const attempt = (gen: number, failures: number) => {
		deps.request().then(settings => {
			if (gen === generation) apply(settings)
		}, (error: unknown) => {
			if (gen !== generation) return
			if (failures >= delays.length) {
				deps.warn?.(`[settings] Could not read app settings after ${failures + 1} attempts: ${error instanceof Error ? error.message : String(error)}`)
				return
			}
			timer = deps.setTimer(() => { timer = null; attempt(gen, failures + 1) }, delays[failures])
		})
	}
	return {
		load() { clear(); attempt(++generation, 0) },
		cancel() { generation++; clear() },
	}
}

/** The window event every settings reader listens for. */
export const SETTINGS_CHANGED_EVENT = 'keepkey-settings-changed'

/** Re-read settings because the backend changed one (push) or the connection to it came back (reconnect). Marked as
 *  coming from the backend, so a listener that starts device work (Monero's wallet open) can ignore it and only follow
 *  changes the user made. */
export function dispatchBackendSettingsChanged(reason: 'push' | 'reconnect') {
	if (typeof window === 'undefined') return
	window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { source: 'backend', reason } }))
}

export function settingsChangedByBackend(event: Event): boolean {
	return (event as CustomEvent<{ source?: string } | undefined>).detail?.source === 'backend'
}
