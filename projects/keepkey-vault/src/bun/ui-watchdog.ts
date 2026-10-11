/**
 * Records whether the window's UI ever reached the backend.
 *
 * A blank or grey window (the webview never loaded) used to look like a healthy
 * start in vault-backend.log: the engine boots and pairs the device with nothing
 * on screen. The first RPC call from the UI is the proof that it loaded, so log
 * that, and say so loudly when it has not happened in time.
 *
 * Pure module: no Electrobun/db/device imports, safe under bun test.
 */
export function createUiWatchdog(opts: {
	timeoutMs: number
	log: (message: string) => void
	error: (message: string) => void
	now?: () => number
}) {
	const now = opts.now ?? Date.now
	let startedAt = now()
	let loaded = false
	let timer: ReturnType<typeof setTimeout> | undefined

	function seen() {
		if (loaded) return
		loaded = true
		if (timer) clearTimeout(timer)
		opts.log(`[UI] loaded after ${now() - startedAt}ms`)
	}

	return {
		/** Call once the window has been created. */
		start() {
			startedAt = now()
			timer = setTimeout(() => {
				if (loaded) return
				opts.error(
					`[UI] nothing has loaded in the window after ${Math.round(opts.timeoutMs / 1000)}s. ` +
					`The backend is running but the UI never connected (blank or grey window). platform=${process.platform}`,
				)
			}, opts.timeoutMs)
		},
		/** Call on any request from the UI. */
		seen,
	}
}
