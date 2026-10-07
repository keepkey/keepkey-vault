/**
 * Zcash Ironwood → transparent deshielding transaction builder.
 *
 * Orchestrates the flow:
 *   1. Sidecar builds deshield PCZT (Orchard spends + transparent output)
 *   2. Device signs Orchard actions (RedPallas) — no transparent signing needed
 *   3. Sidecar finalizes + serializes hybrid v5 tx
 *   4. Broadcast via lightwalletd
 */

import { sendCommand, isSidecarReady, startSidecar, getCachedFvk, beginZcashSend, endZcashSend } from "../zcash-sidecar"
import { initializeOrchardFromDevice } from "./zcash-shielded"

export interface DeshieldParams {
	/** Transparent recipient address (t1... or t3...) */
	recipient: string
	/** Amount in zatoshis */
	amount: number
	/** Account index (default 0) */
	account?: number
}

interface DeshieldBuildResult {
	orchard_signing_request: {
		n_actions: number
		account: number
		branch_id: number
		sighash: string
		pool: "orchard" | "ironwood"
		digests: { header: string; transparent: string; orchard: string; ironwood: string }
		header_fields?: { tx_version: number; version_group_id: number; lock_time: number; expiry_height: number }
		bundle_meta: { flags: number; value_balance: number; anchor: string }
		actions: Array<{
			index: number; alpha: string; cv_net: string; nullifier: string
			cmx: string; epk: string; enc_compact: string; enc_memo: string
			enc_noncompact: string; rk: string; out_ciphertext: string
			value: number; is_spend: boolean
			recipient?: string; rseed?: string
		}>
		display: { amount: string; fee: string; to: string }
	}
	transparent_outputs: Array<{ index: number; value: number; script_pubkey: string }>
	display: { amount: string; fee: string; action: string }
	batch?: import("./zcash-shielded").SpendBatchInfo
}

export interface DeshieldOptions {
	signWrap?: import("./zcash-shielded").DeviceSignWrap
	onProgress?: import("./zcash-shield").TxProgressFn
	/** The recipient is this wallet's own key at this path (ZIP-320
	 *  ephemeral address): the device can show it as the user's own. */
	outputAddressN?: number[]
	/** Called after each transaction broadcasts; its transparent output is
	 *  vout 0 (change stays shielded). */
	onBroadcast?: (tx: { txid: string; vout: number; value: number }) => void
}

let deshieldInProgress = false

/**
 * Full deshield flow: Ironwood shielded pool → transparent ZEC.
 *
 * @param wallet - hdwallet instance with zcashSignPczt method
 * @param params - Deshield parameters
 * @returns Transaction ID
 */
export async function deshieldZec(
	wallet: any,
	params: DeshieldParams,
	opts?: DeshieldOptions,
): Promise<{ txid: string; txids: string[] }> {
	if (deshieldInProgress) {
		throw new Error("A deshield transaction is already in progress")
	}
	deshieldInProgress = true
	beginZcashSend()
	try {
		return await _deshieldZecInner(wallet, params, opts)
	} finally {
		endZcashSend()
		deshieldInProgress = false
	}
}

async function _deshieldZecInner(
	wallet: any,
	params: DeshieldParams,
	opts?: DeshieldOptions,
): Promise<{ txid: string; txids: string[] }> {
	const account = params.account ?? 0

	// 0a. Validate inputs
	if (!params.recipient || !/^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/.test(params.recipient)) {
		throw new Error("Invalid transparent Zcash address — must be t1... (P2PKH) or t3... (P2SH)")
	}
	if (!Number.isInteger(params.amount) || params.amount <= 0) {
		throw new Error("Deshield amount must be a positive integer (zatoshis)")
	}

	// 0b. Ensure sidecar running + FVK set
	if (!isSidecarReady()) {
		await startSidecar()
	}
	const cached = getCachedFvk()
	if (!cached) {
		await initializeOrchardFromDevice(wallet, account)
	}

	// One transaction per batch: the sidecar spends at most 16 notes per
	// transaction and reports what is left to pay (see sendShielded).
	const { txidToDisplayOrder } = await import("./zcash-shield")
	const txids: string[] = []
	let remaining = params.amount
	while (remaining > 0) {
		try {
			const { txid, paid } = await deshieldOnce(wallet, { ...params, amount: remaining, account }, txids.length, opts)
			const display = txidToDisplayOrder(txid)
			txids.push(display)
			opts?.onBroadcast?.({ txid: display, vout: 0, value: paid.pay })
			console.log(`[zcash-deshield] Deshield transaction sent: ${display}`)
			remaining = paid.remaining_after
		} catch (e: any) {
			if (txids.length === 0) throw e
			throw new Error(
				`Unshielded in ${txids.length} transaction(s) (${txids.join(", ")}); ${remaining} ZAT was not sent: ${e?.message ?? e}`
			)
		}
	}
	return { txid: txids[txids.length - 1], txids }
}

/** Build, sign, finalize and broadcast one deshield transaction paying up to
 *  `params.amount`. Returns its internal-order txid and what it paid. */
async function deshieldOnce(
	wallet: any,
	params: Required<DeshieldParams>,
	done: number,
	opts?: DeshieldOptions,
): Promise<{ txid: string; paid: { pay: number; remaining_after: number } }> {
	if (done > 0) opts?.onProgress?.("building", { index: done + 1, total: done + 1 })
	console.log("[zcash-deshield] Building deshield PCZT...")
	const buildResult: DeshieldBuildResult = await sendCommand("build_deshield_pczt", {
		recipient: params.recipient,
		amount: params.amount,
		account: params.account,
	}, 600000) // Halo2 proof can take a while

	const sr = buildResult.orchard_signing_request
	const batch = buildResult.batch
	const paid = batch ?? { pay: params.amount, remaining_after: 0 }
	const progress = { index: done + 1, total: done + (batch?.total_txs ?? 1), fee: batch?.fee }
	console.log(`[zcash-deshield] PCZT built: ${sr.n_actions} ${sr.pool} actions (transaction ${progress.index} of ${progress.total})`)

	// Device signs Ironwood actions (no transparent signing needed).
	// The transparent output MUST be declared and streamed: the firmware recomputes the
	// transparent digest from plaintext (reviewing the t-address + amount on-device) and
	// derives the sighash from it. Omitting it makes the device sign against the EMPTY
	// transparent digest — an invalid signature — and fail the fee gate (value_balance ≠ fee).
	opts?.onProgress?.("signing", progress)
	if (typeof wallet.zcashSignPczt !== "function") {
		throw new Error("hdwallet does not support zcashSignPczt — ensure Zcash-capable firmware")
	}
	if (!Array.isArray(buildResult.transparent_outputs) || buildResult.transparent_outputs.length === 0) {
		throw new Error("Sidecar returned no transparent_outputs for deshield — refusing to sign")
	}

	const transparentOutputs = opts?.outputAddressN
		? buildResult.transparent_outputs.map(o => ({ ...o, address_n: opts.outputAddressN }))
		: buildResult.transparent_outputs
	const signingRequest = { ...sr, transparent_outputs: transparentOutputs }
	const signFn = () => wallet.zcashSignPczt(signingRequest, sr.sighash)
	const signatures = opts?.signWrap ? await opts.signWrap(signFn) : await signFn()
	if (!signatures || !Array.isArray(signatures)) {
		throw new Error("Device did not return signatures")
	}
	console.log(`[zcash-deshield] Got ${signatures.length} Ironwood signatures`)

	// Finalize via sidecar — only Ironwood signatures, no transparent sigs
	const { raw_tx, txid } = await sendCommand("finalize_deshield", {
		orchard_signatures: signatures,
	})
	if (!raw_tx) {
		throw new Error("Sidecar returned no raw_tx from finalize_deshield")
	}
	console.log(`[zcash-deshield] raw_tx length: ${raw_tx.length / 2} bytes`)
	opts?.onProgress?.("broadcasting", progress)
	await sendCommand("broadcast", { raw_tx })
	return { txid, paid }
}
