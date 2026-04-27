/**
 * Zcash Orchard shielded transaction builder.
 *
 * Orchestrates the three-way flow: sidecar (crypto) + device (signing) + sidecar (finalize).
 *
 * Data flow:
 *   1. Sidecar builds PCZT, extracts signing request
 *   2. Electrobun sends signing fields to device via hdwallet/protobuf
 *   3. Device returns RedPallas signatures
 *   4. Sidecar applies signatures, generates binding sig, serializes v5 tx
 *   5. Sidecar (or Pioneer API) broadcasts
 */

import { sendCommand, isSidecarReady, startSidecar, setCachedFvk } from "../zcash-sidecar"

export interface ShieldedSendParams {
	/** Hex-encoded Orchard recipient address (43 bytes) */
	recipient: string
	/** Amount in zatoshis */
	amount: number
	/** Account index (default 0) */
	account?: number
	/** Optional memo */
	memo?: string
}

/**
 * Optional wrapper around the device-signing call. When the emulator is the
 * active transport, the caller passes a function that pops the user-approval
 * UI and pre-writes ButtonAck + DebugLinkDecision into the firmware's confirm
 * loop. Without this on the emulator, the firmware busy-loops in
 * confirm_helper() and the watchdog SIGKILLs the bun process.
 */
export type DeviceSignWrap = <T>(fn: () => Promise<T>) => Promise<T>

export interface SigningRequest {
	n_actions: number
	account: number
	branch_id: number
	sighash: string
	digests: {
		header: string
		transparent: string
		sapling: string
		orchard: string
	}
	bundle_meta: {
		flags: number
		value_balance: number
		anchor: string
	}
	actions: Array<{
		index: number
		alpha: string
		cv_net: string
		nullifier: string
		cmx: string
		epk: string
		enc_compact: string
		enc_memo: string
		enc_noncompact: string
		rk: string
		out_ciphertext: string
		value: number
		is_spend: boolean
	}>
	display: {
		amount: string
		fee: string
		to: string
	}
}

/**
 * Initialize the sidecar with a seed (testing/dev only — seed should not leave device in production).
 *
 * @param seedHex - 64-byte master seed (hex)
 * @param account - Account index (default 0)
 */
export async function initializeOrchardFromSeed(seedHex: string, account: number = 0): Promise<{
	fvk: { ak: string; nk: string; rivk: string }
	address: string
}> {
	if (!isSidecarReady()) {
		await startSidecar()
	}

	const result = await sendCommand("derive_fvk", { seed_hex: seedHex, account })
	return { fvk: result.fvk, address: result.address }
}

/** @deprecated Use initializeOrchardFromDevice for production */
export const initializeOrchard = initializeOrchardFromSeed

/**
 * Initialize Orchard from device-exported FVK.
 *
 * This is the production path — the seed never leaves the device.
 * The device exports {ak, nk, rivk} via the ZcashGetOrchardFVK protobuf message.
 *
 * @param wallet - hdwallet instance with zcashGetOrchardFvk method
 * @param account - Account index (default 0)
 */
export async function initializeOrchardFromDevice(wallet: any, account: number = 0): Promise<{
	fvk: { ak: string; nk: string; rivk: string }
	address: string
}> {
	if (!isSidecarReady()) {
		await startSidecar()
	}

	if (typeof wallet.zcashGetOrchardFVK !== "function") {
		throw new Error(
			"hdwallet does not support zcashGetOrchardFVK — " +
			"ensure keepkey-firmware with Zcash/Orchard support is flashed"
		)
	}

	// Request FVK from device — device derives internally, seed never leaves
	console.log("[zcash-shielded] Requesting Orchard FVK from device...")
	const deviceResult = await wallet.zcashGetOrchardFVK(account)
	const { ak, nk, rivk } = deviceResult

	if (!ak || !nk || !rivk) {
		throw new Error("Device returned incomplete FVK — missing ak, nk, or rivk")
	}

	// Convert Uint8Array to hex strings for sidecar IPC
	const toHex = (buf: Uint8Array | Buffer) =>
		Buffer.from(buf).toString("hex")
	const akHex = toHex(ak)
	const nkHex = toHex(nk)
	const rivkHex = toHex(rivk)

	// Send FVK components to sidecar
	console.log("[zcash-shielded] Setting FVK on sidecar...")
	const result = await sendCommand("set_fvk", { ak: akHex, nk: nkHex, rivk: rivkHex })
	// Update the in-process cache so hasFvkLoaded() / getCachedFvk() see the
	// new FVK without each caller having to remember to call setCachedFvk().
	setCachedFvk(result.address, result.fvk)
	return { fvk: result.fvk, address: result.address }
}

/**
 * Scan the Zcash chain for Orchard notes.
 * Resumes from last scan position automatically.
 */
export async function scanOrchardNotes(startHeight?: number, fullRescan?: boolean): Promise<{
	balance: number
	notes_found: number
	synced_to: number
}> {
	if (!isSidecarReady()) {
		throw new Error("Sidecar not initialized — call initializeOrchard() first")
	}

	const params: Record<string, any> = {}
	if (startHeight !== undefined) params.start_height = startHeight
	if (fullRescan) params.full_rescan = true

	return await sendCommand("scan", params)
}

/**
 * Get the current shielded balance (in zatoshis).
 *
 * `confirmed` and `notes_unspent` reflect every unspent note (regardless of
 * depth). `spendable_confirmed` and `spendable_notes_count` only count notes
 * deeper than `min_confirmations` from `synced_to` — that's the set the
 * builder will actually accept, so UI controls (Max button, available-to-send)
 * should use these.
 */
export async function getShieldedBalance(): Promise<{
	confirmed: number
	pending: number
	notes_unspent?: number
	spendable_confirmed?: number
	spendable_notes_count?: number
	min_confirmations?: number
	synced_to?: number | null
}> {
	if (!isSidecarReady()) {
		throw new Error("Sidecar not initialized — call initializeOrchard() first")
	}

	return await sendCommand("balance")
}

/**
 * Build a shielded transaction and get the signing request for the device.
 *
 * The caller must then send the signing request to the device,
 * collect signatures, and call finalizeShieldedTx().
 */
export async function buildShieldedTx(params: ShieldedSendParams): Promise<{
	signing_request: SigningRequest
}> {
	if (!isSidecarReady()) {
		throw new Error("Sidecar not initialized — call initializeOrchard() first")
	}

	return await sendCommand("build_pczt", {
		recipient: params.recipient,
		amount: params.amount,
		account: params.account ?? 0,
		memo: params.memo,
	})
}

/**
 * Apply device signatures and produce the final broadcast-ready transaction.
 *
 * @param signatures - Array of 64-byte RedPallas signatures (hex strings), one per action
 */
export async function finalizeShieldedTx(signatures: string[]): Promise<{
	raw_tx: string
	txid: string
}> {
	if (!isSidecarReady()) {
		throw new Error("Sidecar not initialized")
	}

	return await sendCommand("finalize", { signatures })
}

/**
 * Broadcast a finalized transaction via lightwalletd.
 */
export async function broadcastShieldedTx(rawTxHex: string): Promise<{
	txid: string
}> {
	if (!isSidecarReady()) {
		throw new Error("Sidecar not initialized")
	}

	return await sendCommand("broadcast", { raw_tx: rawTxHex })
}

/**
 * Full shielded send flow — orchestrates sidecar + device signing.
 *
 * @param wallet - hdwallet instance with zcashSignPczt method
 * @param params - Send parameters
 * @returns Transaction ID
 */
let sendInProgress = false

export async function sendShielded(
	wallet: any,
	params: ShieldedSendParams,
	opts?: { signWrap?: DeviceSignWrap },
): Promise<{ txid: string }> {
	if (sendInProgress) {
		throw new Error("A shielded send is already in progress — wait for it to complete")
	}
	sendInProgress = true
	try {
		return await _sendShieldedInner(wallet, params, opts)
	} finally {
		sendInProgress = false
	}
}

async function _sendShieldedInner(
	wallet: any,
	params: ShieldedSendParams,
	opts?: { signWrap?: DeviceSignWrap },
): Promise<{ txid: string }> {
	// 0. Ensure sidecar is running and FVK is set
	if (!isSidecarReady()) {
		await startSidecar()
	}
	// Use cached FVK if available (auto-loaded from DB), only refresh from device if missing
	const { getCachedFvk } = await import("../zcash-sidecar")
	const cached = getCachedFvk()
	if (!cached) {
		console.log("[zcash-shielded] No cached FVK — refreshing from device...")
		await initializeOrchardFromDevice(wallet, params.account ?? 0)
	} else {
		console.log("[zcash-shielded] Using cached FVK, skipping device refresh")
	}

	// 1. Build PCZT via sidecar
	console.log("[zcash-shielded] Building PCZT...")
	const { signing_request } = await buildShieldedTx(params)

	console.log(`[zcash-shielded] PCZT built: ${signing_request.n_actions} actions`)
	console.log(`[zcash-shielded] Display: ${signing_request.display.amount} to ${signing_request.display.to}`)

	// 2. Send to device for signing via hdwallet
	// The device protobuf flow:
	//   ZcashSignPCZT (digests + metadata) → ZcashPCZTActionAck
	//   For each action: ZcashPCZTAction (fields) → ZcashPCZTActionAck | ZcashSignedPCZT
	console.log("[zcash-shielded] Requesting device signatures...")
	const signatures = opts?.signWrap
		? await opts.signWrap(() => deviceSign(wallet, signing_request))
		: await deviceSign(wallet, signing_request)
	console.log(`[zcash-shielded] Got ${signatures.length} signatures`)

	// 3. Finalize via sidecar (apply sigs + binding sig + serialize)
	console.log("[zcash-shielded] Finalizing transaction...")
	const { raw_tx, txid } = await finalizeShieldedTx(signatures)

	// 4. Broadcast
	console.log("[zcash-shielded] Broadcasting...")
	await broadcastShieldedTx(raw_tx)

	console.log(`[zcash-shielded] Transaction sent: ${txid}`)
	return { txid }
}

/**
 * Send signing request to device and collect signatures.
 *
 * Uses the hdwallet zcashSignPczt method which handles the full protobuf
 * message flow: ZcashSignPCZT → ZcashPCZTAction(s) → ZcashSignedPCZT.
 */
async function deviceSign(wallet: any, sr: SigningRequest): Promise<string[]> {
	if (typeof wallet.zcashSignPczt !== "function") {
		throw new Error(
			"hdwallet does not support zcashSignPczt — " +
			"ensure keepkey-firmware with Zcash support is flashed"
		)
	}

	// The hdwallet zcashSignPczt method takes the signing request directly
	// and handles the protobuf streaming internally
	const signatures = await wallet.zcashSignPczt(sr, sr.sighash)

	if (!signatures || !Array.isArray(signatures)) {
		throw new Error("Device did not return signatures")
	}

	if (signatures.length !== sr.n_actions) {
		throw new Error(
			`Signature count mismatch: got ${signatures.length} signatures for ${sr.n_actions} actions`
		)
	}

	return signatures
}
