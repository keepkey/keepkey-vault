/**
 * Zcash CLI sidecar manager — spawns and communicates with the Rust zcash-cli process.
 *
 * Uses NDJSON (newline-delimited JSON) over stdin/stdout for IPC.
 * The sidecar handles chain scanning, PCZT construction, Halo2 proving,
 * and transaction finalization. It NEVER opens the KeepKey device.
 */

import { Subprocess } from "bun"
import { join, dirname, resolve } from "path"
import { existsSync } from "fs"

interface IpcResponse {
	ok: boolean
	[key: string]: any
}

type PendingRequest = {
	resolve: (value: IpcResponse) => void
	reject: (error: Error) => void
}

let sidecarProc: Subprocess<"pipe", "pipe", "pipe"> | null = null
let pendingRequests: PendingRequest[] = []
let ready = false
let buffer = ""

/**
 * Resolve the path to the zcash-cli binary.
 *
 * Search order:
 *  1. ZCASH_CLI_BIN env var (explicit override)
 *  2. Source-tree dev build (zcash-cli/target/release/)
 *  3. Source-tree debug build (zcash-cli/target/debug/)
 *  4. Bundled alongside the app (production)
 *
 * Throws if the binary cannot be found anywhere.
 */
function getBinaryPath(): string {
	// Allow explicit override
	if (process.env.ZCASH_CLI_BIN && existsSync(process.env.ZCASH_CLI_BIN)) {
		return process.env.ZCASH_CLI_BIN
	}

	// In electrobun, import.meta.dir points inside the app bundle:
	//   .../build/dev-macos-arm64/keepkey-vault-dev.app/Contents/Resources/app/bun/
	// We need to find the binary relative to the actual source project root.
	const candidates: string[] = []

	// 1. cwd-relative (works if cwd is the project root)
	const cwdRoot = process.cwd()
	candidates.push(join(cwdRoot, "zcash-cli", "target", "release", "zcash-cli"))
	candidates.push(join(cwdRoot, "zcash-cli", "target", "debug", "zcash-cli"))

	// 2. Walk up from app bundle to source project root.
	//    import.meta.dir = .../projects/keepkey-vault/build/dev-macos-arm64/app.app/Contents/Resources/app/bun/
	//    project root    = .../projects/keepkey-vault/
	//    That's 7 levels up: bun → app → Resources → Contents → *.app → dev-macos-arm64 → build → project root
	const fromBundle = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..", "..")
	candidates.push(join(fromBundle, "zcash-cli", "target", "release", "zcash-cli"))
	candidates.push(join(fromBundle, "zcash-cli", "target", "debug", "zcash-cli"))

	// 3. Relative to import.meta.dir for non-bundled dev (running bun directly from src/bun/)
	const srcRelRoot = dirname(dirname(import.meta.dir))
	candidates.push(join(srcRelRoot, "zcash-cli", "target", "release", "zcash-cli"))

	// 4. Production: bundled next to the app binary
	const appBundleDir = resolve(import.meta.dir, "..", "..", "..")
	candidates.push(join(appBundleDir, "zcash-cli"))

	console.log(`[zcash-sidecar] cwd=${cwdRoot}, import.meta.dir=${import.meta.dir}`)

	for (const p of candidates) {
		if (existsSync(p)) {
			console.log(`[zcash-sidecar] Found binary: ${p}`)
			return p
		}
	}

	const searched = candidates.map(p => `  - ${p}`).join("\n")
	throw new Error(
		`zcash-cli binary not found. Build it with: cd zcash-cli && cargo build --release\n` +
		`Searched:\n${searched}`
	)
}

/**
 * Start the Zcash sidecar process.
 */
export async function startSidecar(): Promise<void> {
	if (sidecarProc) {
		console.log("[zcash-sidecar] Already running")
		return
	}

	const binPath = getBinaryPath()
	console.log(`[zcash-sidecar] Starting: ${binPath}`)

	sidecarProc = Bun.spawn([binPath], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			RUST_LOG: "info",
		},
	})

	// Read stderr for logs (Rust logs go to stderr)
	readStderr(sidecarProc)

	// Read stdout for NDJSON responses
	readStdout(sidecarProc)

	// Wait for ready signal
	const readyResponse = await new Promise<IpcResponse>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Sidecar startup timeout")), 10000)
		pendingRequests.push({
			resolve: (r) => { clearTimeout(timeout); resolve(r) },
			reject: (e) => { clearTimeout(timeout); reject(e) },
		})
	})

	if (!readyResponse.ok || !readyResponse.ready) {
		throw new Error("Sidecar failed to start")
	}

	ready = true
	console.log(`[zcash-sidecar] Ready (version ${readyResponse.version})`)
}

/**
 * Send a command to the sidecar and wait for the response.
 */
export async function sendCommand(cmd: string, params: Record<string, any> = {}): Promise<any> {
	if (!sidecarProc || !ready) {
		throw new Error("Sidecar not running — call startSidecar() first")
	}

	const request = JSON.stringify({ cmd, ...params }) + "\n"

	return new Promise<any>((resolve, reject) => {
		pendingRequests.push({
			resolve: (response) => {
				if (response.ok) {
					resolve(response)
				} else {
					reject(new Error(response.error || "Sidecar command failed"))
				}
			},
			reject,
		})

		try {
			sidecarProc!.stdin.write(request)
			sidecarProc!.stdin.flush()
		} catch (e: any) {
			reject(new Error(`Failed to write to sidecar stdin: ${e.message}`))
		}
	})
}

/**
 * Stop the sidecar process.
 */
export function stopSidecar(): void {
	ready = false
	if (sidecarProc) {
		try {
			// Send quit command gracefully
			sidecarProc.stdin.write('{"cmd":"quit"}\n')
			sidecarProc.stdin.flush()
		} catch { /* already dead */ }

		// Force kill after 2s
		setTimeout(() => {
			try { sidecarProc?.kill() } catch { /* already dead */ }
			sidecarProc = null
		}, 2000)

		console.log("[zcash-sidecar] Stopping")
	}
}

/**
 * Check if the sidecar is running and ready.
 */
export function isSidecarReady(): boolean {
	return ready && sidecarProc !== null
}

// ── Internal I/O ────────────────────────────────────────────────────────

function readStdout(proc: Subprocess<"pipe", "pipe", "pipe">): void {
	;(async () => {
		const reader = proc.stdout.getReader()
		const decoder = new TextDecoder()
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })

				// Parse complete NDJSON lines
				let nlIdx: number
				while ((nlIdx = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nlIdx).trim()
					buffer = buffer.slice(nlIdx + 1)

					if (!line) continue

					try {
						const response: IpcResponse = JSON.parse(line)
						const pending = pendingRequests.shift()
						if (pending) {
							pending.resolve(response)
						} else {
							console.warn("[zcash-sidecar] Unexpected response:", line.slice(0, 200))
						}
					} catch (e) {
						console.error("[zcash-sidecar] Invalid JSON from sidecar:", line.slice(0, 200))
					}
				}
			}
		} catch { /* process exited */ }
		try { reader.releaseLock() } catch { /* already released */ }

		// Process exited — reject any pending requests
		for (const pending of pendingRequests) {
			pending.reject(new Error("Sidecar process exited"))
		}
		pendingRequests = []
		ready = false
		sidecarProc = null
		console.log("[zcash-sidecar] Process exited")
	})()
}

function readStderr(proc: Subprocess<"pipe", "pipe", "pipe">): void {
	;(async () => {
		const reader = proc.stderr.getReader()
		const decoder = new TextDecoder()
		let stderrBuf = ""
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				stderrBuf += decoder.decode(value, { stream: true })

				// Forward complete lines as log messages
				let nlIdx: number
				while ((nlIdx = stderrBuf.indexOf("\n")) !== -1) {
					const line = stderrBuf.slice(0, nlIdx).trim()
					stderrBuf = stderrBuf.slice(nlIdx + 1)
					if (line) {
						console.log(`[zcash-sidecar] ${line}`)
					}
				}

				// Prevent unbounded growth
				if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048)
			}
		} catch { /* process exited */ }
		try { reader.releaseLock() } catch { /* already released */ }
	})()
}
