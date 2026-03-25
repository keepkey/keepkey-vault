/**
 * Zcash Orchard → transparent deshielding transaction builder.
 *
 * Orchestrates the flow:
 *   1. Sidecar builds deshield PCZT (Orchard spends + transparent output)
 *   2. Device signs Orchard actions (RedPallas) — no transparent signing needed
 *   3. Sidecar finalizes + serializes hybrid v5 tx
 *   4. Broadcast via lightwalletd
 */

import { sendCommand, isSidecarReady, startSidecar, getCachedFvk } from "../zcash-sidecar"
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
		digests: { header: string; transparent: string; sapling: string; orchard: string }
		bundle_meta: { flags: number; value_balance: number; anchor: string }
		actions: Array<{
			index: number; alpha: string; cv_net: string; nullifier: string
			cmx: string; epk: string; enc_compact: string; enc_memo: string
			enc_noncompact: string; rk: string; out_ciphertext: string
			value: number; is_spend: boolean
		}>
		display: { amount: string; fee: string; to: string }
	}
	transparent_outputs: Array<{ value: number; script_pubkey: string }>
	display: { amount: string; fee: string; action: string }
}

let deshieldInProgress = false

/**
 * Full deshield flow: Orchard shielded pool → transparent ZEC.
 *
 * @param wallet - hdwallet instance with zcashSignPczt method
 * @param params - Deshield parameters
 * @returns Transaction ID
 */
export async function deshieldZec(
	wallet: any,
	params: DeshieldParams,
): Promise<{ txid: string }> {
	if (deshieldInProgress) {
		throw new Error("A deshield transaction is already in progress")
	}
	deshieldInProgress = true
	try {
		return await _deshieldZecInner(wallet, params)
	} finally {
		deshieldInProgress = false
	}
}

async function _deshieldZecInner(
	wallet: any,
	params: DeshieldParams,
): Promise<{ txid: string }> {
	const account = params.account ?? 0

	// 0. Ensure sidecar running + FVK set
	if (!isSidecarReady()) {
		await startSidecar()
	}
	const cached = getCachedFvk()
	if (!cached) {
		await initializeOrchardFromDevice(wallet, account)
	}

	// 1. Build deshield PCZT via sidecar
	console.log("[zcash-deshield] Building deshield PCZT...")
	const buildResult: DeshieldBuildResult = await sendCommand("build_deshield_pczt", {
		recipient: params.recipient,
		amount: params.amount,
		account,
	}, 600000) // Halo2 proof can take a while

	const sr = buildResult.orchard_signing_request
	console.log(`[zcash-deshield] PCZT built: ${sr.n_actions} Orchard actions`)
	console.log(`[zcash-deshield] Display: ${buildResult.display.amount} → ${buildResult.display.action}`)

	// 2. Device signs Orchard actions (same as shielded send — no transparent signing needed)
	console.log("[zcash-deshield] Requesting device signatures...")
	if (typeof wallet.zcashSignPczt !== "function") {
		throw new Error("hdwallet does not support zcashSignPczt — ensure Zcash-capable firmware")
	}

	const signatures = await wallet.zcashSignPczt(sr, sr.sighash)
	if (!signatures || !Array.isArray(signatures)) {
		throw new Error("Device did not return signatures")
	}

	console.log(`[zcash-deshield] Got ${signatures.length} Orchard signatures`)

	// 3. Finalize via sidecar — only Orchard signatures, no transparent sigs
	console.log("[zcash-deshield] Finalizing deshield transaction...")
	const { raw_tx, txid } = await sendCommand("finalize_deshield", {
		orchard_signatures: signatures,
	})

	// 4. Broadcast
	console.log(`[zcash-deshield] raw_tx length: ${raw_tx?.length / 2} bytes`)
	console.log("[zcash-deshield] Broadcasting...")
	await sendCommand("broadcast", { raw_tx })

	console.log(`[zcash-deshield] Deshield transaction sent: ${txid}`)
	return { txid }
}
