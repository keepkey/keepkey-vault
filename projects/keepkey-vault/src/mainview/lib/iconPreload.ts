/* Module-level cache of preloaded Image objects.
   Holding a live reference to the Image keeps the bitmap in memory so the
   browser doesn't re-fetch when an <img> element with the same URL mounts
   again (e.g. when the user drills into a new chain and the token icons
   re-mount). The set is keyed by URL so we never preload the same icon
   twice. */

const PRELOADED = new Map<string, HTMLImageElement>()

export function preloadIcon(url: string | undefined | null): void {
	if (!url) return
	if (PRELOADED.has(url)) return
	const img = new Image()
	img.decoding = "async"
	img.src = url
	// Decode immediately so the bitmap is paint-ready when re-rendered.
	if (typeof img.decode === "function") img.decode().catch(() => {})
	PRELOADED.set(url, img)
}

export function preloadIcons(urls: Iterable<string | undefined | null>): void {
	for (const u of urls) preloadIcon(u)
}
