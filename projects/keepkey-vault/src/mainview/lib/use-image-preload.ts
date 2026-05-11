import { useEffect, useState } from "react"

/**
 * Resolves once every URL has either loaded or errored. Use to gate a UI
 * block on its remote images so the layout doesn't paint with empty boxes
 * that fill in 200–500ms later. An errored image still counts as "done" —
 * a missing icon shouldn't pin the whole dashboard behind a network failure.
 *
 * The dep is `urls.join("|")` so unchanged URL arrays don't reset progress
 * on every parent re-render; pass a memoised `urls` if you can.
 */
export function useImagePreload(urls: string[]): boolean {
	const [ready, setReady] = useState(false)
	useEffect(() => {
		if (urls.length === 0) { setReady(true); return }
		setReady(false)
		let alive = true
		let pending = urls.length
		const done = () => { if (--pending === 0 && alive) setReady(true) }
		const imgs: HTMLImageElement[] = urls.map(u => {
			const img = new Image()
			img.onload = done
			img.onerror = done
			img.src = u
			return img
		})
		return () => {
			alive = false
			// Prevent late callbacks from firing once we've unmounted/changed urls.
			for (const img of imgs) { img.onload = null; img.onerror = null }
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [urls.join("|")])
	return ready
}
