/**
 * Native camera capture via ffmpeg + AVFoundation (macOS).
 *
 * Spawns ffmpeg to capture MJPEG frames from the system camera,
 * parses the stream into individual JPEG frames, and emits them
 * as base64 strings via a callback.
 */

import { Subprocess } from "bun"

let cameraProc: Subprocess<"ignore", "pipe", "pipe"> | null = null
let scanning = false

// JPEG markers
const SOI_0 = 0xff
const SOI_1 = 0xd8
const EOI_0 = 0xff
const EOI_1 = 0xd9

/**
 * Start capturing camera frames.
 * Spawns ffmpeg and returns immediately. Frames arrive via onFrame callback.
 */
export function startCamera(
	onFrame: (base64: string) => void,
	onError: (message: string) => void,
): void {
	if (cameraProc) {
		console.log("[camera] Already running")
		return
	}

	// Check ffmpeg availability
	const ffmpegPath = Bun.which("ffmpeg")
	if (!ffmpegPath) {
		onError("ffmpeg not found. Install with: brew install ffmpeg")
		return
	}

	scanning = true
	console.log("[camera] Starting ffmpeg capture...")

	cameraProc = Bun.spawn(
		[
			ffmpegPath,
			"-f", "avfoundation",
			"-pixel_format", "uyvy422",
			"-framerate", "30",
			"-video_size", "640x480",
			"-i", "0:none",     // video device 0, no audio
			"-f", "mjpeg",
			"-q:v", "8",        // moderate quality → smaller frames
			"-r", "10",         // output at 10fps (downsample from 30)
			"pipe:1",
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		},
	)

	const proc = cameraProc

	// Read stderr for errors (ffmpeg logs to stderr) — background task
	readStderr(proc, onError)

	// Parse MJPEG stream from stdout — background task
	readFrames(proc, onFrame, onError)
}

/** Background: read stderr and detect camera errors */
function readStderr(proc: Subprocess<"ignore", "pipe", "pipe">, onError: (msg: string) => void) {
	;(async () => {
		const reader = proc.stderr.getReader()
		const decoder = new TextDecoder()
		let stderrBuf = ""
		try {
			while (scanning) {
				const { done, value } = await reader.read()
				if (done) break
				stderrBuf += decoder.decode(value, { stream: true })

				if (stderrBuf.includes("Could not find video device") || stderrBuf.includes("No such device")) {
					onError("No camera found on this device.")
					stopCamera()
					return
				}
				if (stderrBuf.includes("Permission Denied") || stderrBuf.includes("not granted")) {
					onError("Camera permission denied. Check System Settings > Privacy > Camera.")
					stopCamera()
					return
				}
				// Trim buffer to avoid unbounded growth
				if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048)
			}
		} catch { /* process exited */ }
	})()
}

/** Background: parse MJPEG frames from stdout and emit via callback */
function readFrames(
	proc: Subprocess<"ignore", "pipe", "pipe">,
	onFrame: (base64: string) => void,
	onError: (msg: string) => void,
) {
	;(async () => {
		const reader = proc.stdout.getReader()
		let buffer = new Uint8Array(0)
		let firstFrame = false

		try {
			while (scanning) {
				const { done, value } = await reader.read()
				if (done) break
				if (!value) continue

				// Append to buffer
				const newBuf = new Uint8Array(buffer.length + value.length)
				newBuf.set(buffer, 0)
				newBuf.set(value, buffer.length)
				buffer = newBuf

				// Extract complete JPEG frames (SOI=FF D8 ... EOI=FF D9)
				while (buffer.length > 4) {
					// Find SOI
					let soiIdx = -1
					for (let i = 0; i < buffer.length - 1; i++) {
						if (buffer[i] === SOI_0 && buffer[i + 1] === SOI_1) {
							soiIdx = i
							break
						}
					}
					if (soiIdx < 0) break

					// Find EOI after SOI
					let eoiIdx = -1
					for (let i = soiIdx + 2; i < buffer.length - 1; i++) {
						if (buffer[i] === EOI_0 && buffer[i + 1] === EOI_1) {
							eoiIdx = i
							break
						}
					}
					if (eoiIdx < 0) break // incomplete frame, wait for more data

					// Extract frame
					const frame = buffer.slice(soiIdx, eoiIdx + 2)
					buffer = buffer.slice(eoiIdx + 2)

					if (!firstFrame) {
						firstFrame = true
						console.log(`[camera] First frame received (${frame.length} bytes)`)
					}

					// Convert to base64 and emit
					const base64 = Buffer.from(frame).toString("base64")
					onFrame(base64)
				}
			}
		} catch (err: any) {
			if (scanning) {
				console.error("[camera] Stream read error:", err.message)
				onError("Camera stream interrupted")
			}
		}
	})()
}

/** Stop camera capture and kill ffmpeg process. */
export function stopCamera(): void {
	scanning = false
	if (cameraProc) {
		try { cameraProc.kill() } catch { /* already dead */ }
		cameraProc = null
		console.log("[camera] Stopped")
	}
}
