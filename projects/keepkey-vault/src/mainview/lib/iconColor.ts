/* Sample a small canvas of an icon and return its dominant saturated color.
   Used to make token glow ring colors match the logo (PEPE glows green,
   USDC glows blue, etc.) instead of inheriting the chain's brand color.

   Strategy:
   - Draw the image into a 32×32 canvas (downsample = fast + averages noise).
   - Quantize pixels to a coarse RGB histogram (32 levels per channel).
   - Skip transparent, near-black, near-white, and near-grayscale pixels —
     those tend to be background / outlines, not the logo's identity.
   - Pick the bucket with the highest pixel count, return its mean RGB as hex.
   - Cache by URL; canvas-read failures (CORS) resolve to null so the caller
     can fall back to a brand color.
*/

import { useEffect, useState } from "react"

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

export function extractDominantColor(url: string): Promise<string | null> {
	if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null)
	const existing = inflight.get(url)
	if (existing) return existing

	const p = new Promise<string | null>((resolve) => {
		const img = new Image()
		img.crossOrigin = "anonymous"
		img.onload = () => {
			try {
				const canvas = document.createElement("canvas")
				const w = (canvas.width = 32)
				const h = (canvas.height = 32)
				const ctx = canvas.getContext("2d", { willReadFrequently: true })
				if (!ctx) return resolve(null)
				ctx.drawImage(img, 0, 0, w, h)
				const data = ctx.getImageData(0, 0, w, h).data

				const buckets = new Map<string, { r: number; g: number; b: number; count: number }>()
				for (let i = 0; i < data.length; i += 4) {
					const r = data[i]!
					const g = data[i + 1]!
					const b = data[i + 2]!
					const a = data[i + 3]!
					if (a < 200) continue
					const max = Math.max(r, g, b)
					const min = Math.min(r, g, b)
					if (max < 30) continue          // too dark
					if (min > 235) continue         // near-white
					if (max - min < 30) continue    // grayscale-ish
					const key = `${r >> 5}-${g >> 5}-${b >> 5}`
					const entry = buckets.get(key)
					if (entry) {
						entry.r += r; entry.g += g; entry.b += b; entry.count++
					} else {
						buckets.set(key, { r, g, b, count: 1 })
					}
				}
				if (buckets.size === 0) return resolve(null)

				let best: { r: number; g: number; b: number; count: number } | null = null
				for (const v of buckets.values()) {
					if (!best || v.count > best.count) best = v
				}
				if (!best) return resolve(null)

				const r = Math.round(best.r / best.count)
				const g = Math.round(best.g / best.count)
				const b = Math.round(best.b / best.count)
				const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")
				resolve(hex)
			} catch {
				resolve(null)
			}
		}
		img.onerror = () => resolve(null)
		img.src = url
	}).then((hex) => {
		cache.set(url, hex)
		inflight.delete(url)
		return hex
	})

	inflight.set(url, p)
	return p
}

/** Hook: returns the dominant color of an icon URL, defaulting to fallback. */
export function useIconColor(url: string | undefined, fallback: string): string {
	const [color, setColor] = useState<string>(fallback)
	useEffect(() => {
		if (!url) { setColor(fallback); return }
		let cancelled = false
		extractDominantColor(url).then((c) => {
			if (!cancelled) setColor(c ?? fallback)
		})
		return () => { cancelled = true }
	}, [url, fallback])
	return color
}
