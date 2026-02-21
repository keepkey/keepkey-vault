/**
 * Camera-based QR code scanner using BarcodeDetector API
 * with jsQR dynamic-import fallback for older systems.
 */

/** Request a rear-facing (or any available) camera stream at 720p. */
export async function getCameraStream(): Promise<MediaStream> {
	return navigator.mediaDevices.getUserMedia({
		video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
		audio: false,
	})
}

type DetectCallback = (value: string) => void
type ErrorCallback = (err: Error) => void

/**
 * Start a ~15 fps detection loop on a playing <video> element.
 * Returns a cleanup function that stops the loop.
 */
export function startScanning(
	video: HTMLVideoElement,
	onDetect: DetectCallback,
	onError: ErrorCallback,
): () => void {
	let stopped = false
	let rafId = 0
	let frameCount = 0

	// Detect which scanner to use
	const hasBarcodeDetector = typeof (globalThis as any).BarcodeDetector !== "undefined"

	if (hasBarcodeDetector) {
		const detector = new (globalThis as any).BarcodeDetector({ formats: ["qr_code"] })
		const loop = async () => {
			if (stopped) return
			frameCount++
			// Scan every other frame (~15 fps at 30fps video)
			if (frameCount % 2 === 0 && video.readyState >= video.HAVE_CURRENT_DATA) {
				try {
					const results = await detector.detect(video)
					if (results.length > 0 && results[0].rawValue) {
						onDetect(results[0].rawValue)
						return // stop after first detection
					}
				} catch (e: any) {
					// detect() can throw if video not ready — ignore and retry
				}
			}
			rafId = requestAnimationFrame(loop)
		}
		rafId = requestAnimationFrame(loop)
	} else {
		// Fallback: dynamic import jsQR
		let jsQR: any = null
		const canvas = document.createElement("canvas")
		const ctx = canvas.getContext("2d", { willReadFrequently: true })!

		import("jsqr")
			.then((mod) => { jsQR = mod.default || mod })
			.catch((e) => onError(new Error("QR scanner not available on this system")))

		const loop = () => {
			if (stopped) return
			frameCount++
			if (frameCount % 2 === 0 && jsQR && video.readyState >= video.HAVE_CURRENT_DATA) {
				canvas.width = video.videoWidth
				canvas.height = video.videoHeight
				ctx.drawImage(video, 0, 0)
				const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
				const result = jsQR(imageData.data, imageData.width, imageData.height)
				if (result?.data) {
					onDetect(result.data)
					return
				}
			}
			rafId = requestAnimationFrame(loop)
		}
		rafId = requestAnimationFrame(loop)
	}

	return () => {
		stopped = true
		if (rafId) cancelAnimationFrame(rafId)
	}
}

/** Stop all tracks on a MediaStream. */
export function stopStream(stream: MediaStream | null) {
	if (!stream) return
	for (const track of stream.getTracks()) {
		track.stop()
	}
}
