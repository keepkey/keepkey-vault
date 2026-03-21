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
	_req_id?: number
	[key: string]: any
}

type PendingRequest = {
	resolve: (value: IpcResponse) => void
	reject: (error: Error) => void
	timeout: ReturnType<typeof setTimeout>
}

let sidecarProc: Subprocess<"pipe", "pipe", "pipe"> | null = null
let pendingRequests = new Map<number, PendingRequest>()
let nextReqId = 1
let ready = false
let buffer = ""
let initPromise: Promise<void> | null = null
let scanProgressCallback: ((progress: { percent: number; scannedHeight: number; tipHeight: number; blocksPerSec: number; etaSeconds: number }) => void) | null = null
let lastProgressTime = 0
let lastProgressHeight = 0

/** Cached FVK + address from auto-load or set_fvk */
let cachedAddress: string | null = null
let cachedFvk: { ak: string; nk: string; rivk: string } | null = null

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

	// On Windows, Rust produces zcash-cli.exe
	const isWin = process.platform === "win32"
	const bin = isWin ? "zcash-cli.exe" : "zcash-cli"

	const candidates: string[] = []

	// 1. cwd-relative (works if cwd is the project root)
	const cwdRoot = process.cwd()
	candidates.push(join(cwdRoot, "zcash-cli", "target", "release", bin))
	candidates.push(join(cwdRoot, "zcash-cli", "target", "debug", bin))

	// 2. Walk up from app bundle to source project root.
	//    Dev:  _build/dev-macos-arm64/keepkey-vault-dev.app/Contents/Resources/app/bun/
	//    → 7 levels reaches _build/, 8 levels reaches project root
	for (const depth of [7, 8, 9]) {
		const fromBundle = resolve(import.meta.dir, ...Array(depth).fill(".."))
		candidates.push(join(fromBundle, "zcash-cli", "target", "release", bin))
		candidates.push(join(fromBundle, "zcash-cli", "target", "debug", bin))
	}

	// 3. Relative to import.meta.dir for non-bundled dev (running bun directly from src/bun/)
	const srcRelRoot = dirname(dirname(import.meta.dir))
	candidates.push(join(srcRelRoot, "zcash-cli", "target", "release", bin))

	// 4. Production: Electrobun copies into app/ dir, bun code runs from app/bun/
	const appDir = resolve(import.meta.dir, "..")
	candidates.push(join(appDir, bin))

	// 5. Fallback: walk further up in case bundle structure differs
	const appBundleDir = resolve(import.meta.dir, "..", "..", "..")
	candidates.push(join(appBundleDir, bin))

	console.log(`[zcash-sidecar] Searching for binary (cwd=${cwdRoot}, import.meta.dir=${import.meta.dir})`)
	for (const p of candidates) {
		console.log(`[zcash-sidecar]   ${existsSync(p) ? 'FOUND' : 'miss'}: ${p}`)
	}

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
 * Guards against concurrent startup calls.
 */
export async function startSidecar(): Promise<void> {
	if (sidecarProc && ready) {
		return
	}
	// Prevent concurrent startSidecar() calls
	if (initPromise) {
		return initPromise
	}

	initPromise = (async () => {
		try {
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

			// Read the first stdout line synchronously — the ready signal.
			// We do this BEFORE starting the background reader to avoid
			// event-loop scheduling issues with Electrobun's top-level await.
			const firstLine = await readFirstLine(sidecarProc)
			console.log(`[zcash-sidecar] First stdout line: ${firstLine.slice(0, 120)}...`)
			const readyResponse: IpcResponse = JSON.parse(firstLine)

			if (!readyResponse.ok || !readyResponse.ready) {
				throw new Error("Sidecar failed to start: " + JSON.stringify(readyResponse))
			}

			ready = true

			// Capture auto-loaded FVK if the sidecar had one persisted
			if (readyResponse.fvk_loaded && readyResponse.address) {
				cachedAddress = readyResponse.address
				cachedFvk = readyResponse.fvk || null
				console.log(`[zcash-sidecar] Ready (version ${readyResponse.version}) — FVK auto-loaded, UA: ${cachedAddress?.slice(0, 20)}...`)
			} else {
				console.log(`[zcash-sidecar] Ready (version ${readyResponse.version}) — no saved FVK`)
			}

			// Now start the background stdout reader for subsequent IPC
			readStdout(sidecarProc)
		} finally {
			initPromise = null
		}
	})()

	return initPromise
}

/**
 * Send a command to the sidecar and wait for the response.
 * Uses request IDs to correctly match responses to requests.
 */
export async function sendCommand(cmd: string, params: Record<string, any> = {}, timeoutMs: number = 300000): Promise<any> {
	if (!sidecarProc || !ready) {
		throw new Error("Sidecar not running — call startSidecar() first")
	}

	const reqId = nextReqId++
	const request = JSON.stringify({ cmd, _req_id: reqId, ...params }) + "\n"

	return new Promise<any>((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(reqId)
			reject(new Error(`Sidecar command '${cmd}' timed out after ${timeoutMs}ms`))
		}, timeoutMs)

		pendingRequests.set(reqId, {
			resolve: (response) => {
				clearTimeout(timeout)
				if (response.ok) {
					resolve(response)
				} else {
					reject(new Error(response.error || "Sidecar command failed"))
				}
			},
			reject: (e) => { clearTimeout(timeout); reject(e) },
			timeout,
		})

		try {
			sidecarProc!.stdin.write(request)
			sidecarProc!.stdin.flush()
		} catch (e: any) {
			clearTimeout(timeout)
			pendingRequests.delete(reqId)
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

/**
 * Check if the sidecar has a FVK loaded (either auto-loaded from DB or set via device).
 */
export function hasFvkLoaded(): boolean {
	return cachedAddress !== null
}

/**
 * Get the cached address + FVK (from auto-load or set_fvk).
 */
export function getCachedFvk(): { address: string; fvk: { ak: string; nk: string; rivk: string } } | null {
	if (!cachedAddress || !cachedFvk) return null
	return { address: cachedAddress, fvk: cachedFvk }
}

/**
 * Update the cached FVK (called after set_fvk succeeds).
 */
export function setCachedFvk(address: string, fvk: { ak: string; nk: string; rivk: string }): void {
	cachedAddress = address
	cachedFvk = fvk
}

/**
 * Clear the cached FVK (call on device disconnect to prevent stale state).
 */
export function clearCachedFvk(): void {
	cachedAddress = null
	cachedFvk = null
}

/**
 * Register a callback for scan progress events parsed from sidecar stderr.
 */
export function onScanProgress(cb: typeof scanProgressCallback): void {
	scanProgressCallback = cb
	lastProgressTime = 0
	lastProgressHeight = 0
}

// ── Transaction history & memo helpers ───────────────────────────────────

/**
 * Get all Orchard notes with decoded memos for transaction history.
 */
export async function getZcashTransactions(): Promise<any> {
	return sendCommand("get_transactions", {}, 30000)
}

/**
 * Fetch full transactions for notes missing memos and decrypt them.
 * This backfills memos that compact scanning couldn't retrieve.
 */
export async function backfillMemos(): Promise<{ backfilled: number }> {
	return sendCommand("backfill_memos", {}, 300000) // 5 min — network I/O per note
}

/**
 * Run anchor diagnostic on a specific shard index.
 * Cross-validates subtree roots, tree state, and leaf-computed hashes.
 */
export async function diagnoseAnchor(shardIndex?: number): Promise<any> {
	return sendCommand("diagnose_anchor", { shard_index: shardIndex ?? 0 }, 600000)
}

// ── Shield transaction helpers ──────────────────────────────────────────

/**
 * Build a shield PCZT via the sidecar (transparent → Orchard).
 * Returns signing request with both transparent and Orchard fields.
 */
export async function buildShieldPczt(params: {
	transparent_inputs: Array<{ txid: string; vout: number; value: number; script_pubkey: string }>
	amount: number
	fee?: number
	account?: number
}): Promise<any> {
	return sendCommand("build_shield_pczt", params, 600000) // Halo2 proof can be slow
}

/**
 * Finalize a shield transaction with device signatures.
 * Returns raw tx hex and txid.
 */
export async function finalizeShield(params: {
	transparent_signatures: string[]
	orchard_signatures: string[]
}): Promise<{ raw_tx: string; txid: string }> {
	return sendCommand("finalize_shield", params)
}

// ── Internal I/O ────────────────────────────────────────────────────────

/** Read the first complete NDJSON line from stdout. Used for startup ready signal. */
async function readFirstLine(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<string> {
	const reader = proc.stdout.getReader()
	const decoder = new TextDecoder()
	let buf = ""
	const deadline = Date.now() + 10000 // 10s timeout
	try {
		while (Date.now() < deadline) {
			const { done, value } = await reader.read()
			if (done) throw new Error("Sidecar stdout closed before sending ready signal")
			buf += decoder.decode(value, { stream: true })
			const nlIdx = buf.indexOf("\n")
			if (nlIdx >= 0) {
				const line = buf.slice(0, nlIdx).trim()
				// Push remainder back into the shared buffer for the background reader
				buffer = buf.slice(nlIdx + 1)
				reader.releaseLock()
				return line
			}
		}
		reader.releaseLock()
		throw new Error("Sidecar startup timeout — no newline in stdout within 10s")
	} catch (e) {
		try { reader.releaseLock() } catch { /* already released */ }
		throw e
	}
}

function readStdout(proc: Subprocess<"pipe", "pipe", "pipe">): void {
	;(async () => {
		const reader = proc.stdout.getReader()
		const decoder = new TextDecoder()
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })

				// Guard against unbounded buffer growth (malformed response without newline)
				if (buffer.length > 65536) {
					console.error("[zcash-sidecar] stdout buffer exceeded 64KB — likely malformed response, clearing")
					buffer = ""
				}

				// Parse complete NDJSON lines
				let nlIdx: number
				while ((nlIdx = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, nlIdx).trim()
					buffer = buffer.slice(nlIdx + 1)

					if (!line) continue

					try {
						const response: IpcResponse = JSON.parse(line)
						// Match by request ID if present, otherwise use FIFO for startup
						const reqId = response._req_id
						if (reqId !== undefined && pendingRequests.has(reqId)) {
							const pending = pendingRequests.get(reqId)!
							pendingRequests.delete(reqId)
							pending.resolve(response)
						} else if (reqId === undefined && pendingRequests.has(0)) {
							// Startup ready signal (no req_id) — matched to id 0
							const pending = pendingRequests.get(0)!
							pendingRequests.delete(0)
							pending.resolve(response)
						} else {
							console.warn("[zcash-sidecar] Unexpected response (req_id:", reqId, "):", line.slice(0, 200))
						}
					} catch (e) {
						console.error("[zcash-sidecar] Invalid JSON from sidecar:", line.slice(0, 200))
					}
				}
			}
		} catch (e) {
			console.error("[zcash-sidecar] stdout reader error:", e)
		}
		try { reader.releaseLock() } catch { /* already released */ }

		// Process exited — reject any pending requests
		for (const [, pending] of pendingRequests) {
			clearTimeout(pending.timeout)
			pending.reject(new Error("Sidecar process exited"))
		}
		pendingRequests.clear()
		ready = false
		sidecarProc = null
		console.log("[zcash-sidecar] Process exited")
	})()
}

// Regex to parse: "Scan progress: 0.6% (1697103/3266985)"
const PROGRESS_RE = /Scan progress:\s+([\d.]+)%\s+\((\d+)\/(\d+)\)/

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

						// Parse scan progress for UI updates
						const match = line.match(PROGRESS_RE)
						if (match && scanProgressCallback) {
							const percent = parseFloat(match[1])
							const scannedHeight = parseInt(match[2], 10)
							const tipHeight = parseInt(match[3], 10)

							const now = Date.now()
							let blocksPerSec = 0
							let etaSeconds = 0

							if (lastProgressTime > 0 && lastProgressHeight > 0) {
								const elapsed = (now - lastProgressTime) / 1000
								const blocksDone = scannedHeight - lastProgressHeight
								if (elapsed > 0 && blocksDone > 0) {
									blocksPerSec = Math.round(blocksDone / elapsed)
									const remaining = tipHeight - scannedHeight
									etaSeconds = blocksPerSec > 0 ? Math.round(remaining / blocksPerSec) : 0
								}
							}

							lastProgressTime = now
							lastProgressHeight = scannedHeight

							scanProgressCallback({ percent, scannedHeight, tipHeight, blocksPerSec, etaSeconds })
						}
					}
				}

				// Prevent unbounded growth
				if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048)
			}
		} catch (e) {
			console.error("[zcash-sidecar] stderr reader error:", e)
		}
		try { reader.releaseLock() } catch { /* already released */ }
	})()
}
