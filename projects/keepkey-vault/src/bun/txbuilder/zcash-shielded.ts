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

import { sendCommand, isSidecarReady, startSidecar } from "../zcash-sidecar"

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
	return { fvk: result.fvk, address: result.address }
}

/**
 * Scan the Zcash chain for Orchard notes.
 * Resumes from last scan position automatically.
 */
export async function scanOrchardNotes(startHeight?: number): Promise<{
	balance: number
	notes_found: number
	synced_to: number
}> {
	if (!isSidecarReady()) {
		throw new Error("Sidecar not initialized — call initializeOrchard() first")
	}

	const params: Record<string, any> = {}
	if (startHeight !== undefined) params.start_height = startHeight

	return await sendCommand("scan", params)
}

/**
 * Get the current shielded balance (in zatoshis).
 */
export async function getShieldedBalance(): Promise<{
	confirmed: number
	pending: number
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
export async function sendShielded(
	wallet: any,
	params: ShieldedSendParams,
): Promise<{ txid: string }> {
	// 0. Ensure sidecar is running and FVK is set from device
	if (!isSidecarReady()) {
		await startSidecar()
	}
	// Always refresh FVK from device to ensure ak matches device's ask
	console.log("[zcash-shielded] Refreshing FVK from device before build...")
	await initializeOrchardFromDevice(wallet, params.account ?? 0)

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
	const signatures = await deviceSign(wallet, signing_request)
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

	return signatures
}
