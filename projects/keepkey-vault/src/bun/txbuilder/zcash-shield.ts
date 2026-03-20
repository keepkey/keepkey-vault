/**
 * Zcash transparent → Orchard shielding transaction builder.
 *
 * Orchestrates the flow:
 *   1. Fetch transparent UTXOs (via Pioneer)
 *   2. Coin selection
 *   3. Sidecar builds hybrid PCZT (transparent inputs + Orchard output)
 *   4. Device signs transparent inputs (ECDSA) + Orchard actions (RedPallas)
 *   5. Sidecar finalizes + serializes hybrid v5 tx
 *   6. Broadcast via lightwalletd
 */

import { sendCommand, isSidecarReady, startSidecar, getCachedFvk } from "../zcash-sidecar"
import { initializeOrchardFromDevice } from "./zcash-shielded"

/** Compute P2PKH scriptPubKey from compressed pubkey hex: OP_DUP OP_HASH160 <20> <HASH160> OP_EQUALVERIFY OP_CHECKSIG */
async function p2pkhScriptPubKey(pubkeyHex: string): Promise<string> {
	const pubkeyBytes = Buffer.from(pubkeyHex, 'hex')
	// SHA256
	const sha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', pubkeyBytes))
	// RIPEMD160 — not available in WebCrypto, use manual or import
	// Since we're in Bun, we can use node:crypto
	const { createHash } = await import('crypto')
	const hash160 = createHash('ripemd160').update(Buffer.from(sha256)).digest()
	// OP_DUP(76) OP_HASH160(a9) OP_PUSH20(14) <hash160> OP_EQUALVERIFY(88) OP_CHECKSIG(ac)
	return '76a914' + hash160.toString('hex') + '88ac'
}

/** Extract the 33-byte compressed pubkey from a Base58Check xpub string. */
function pubkeyFromXpub(xpub: string): string {
	// Base58Check decode → 78 bytes: 4 version + 1 depth + 4 fingerprint + 4 index + 32 chaincode + 33 pubkey
	const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	let num = 0n
	for (const c of xpub) {
		const idx = ALPHABET.indexOf(c)
		if (idx < 0) throw new Error(`Invalid base58 character: ${c}`)
		num = num * 58n + BigInt(idx)
	}
	let hex = num.toString(16)
	if (hex.length % 2) hex = "0" + hex
	// Pad to 164 hex chars (82 bytes = 78 payload + 4 checksum)
	while (hex.length < 164) hex = "0" + hex
	// Last 33 bytes of the 78-byte payload (before 4-byte checksum) = compressed pubkey
	// payload starts at offset 0, ends at 78*2=156, pubkey is bytes 45-77 → hex offset 90-156
	const pubkeyHex = hex.slice(90, 156)
	return pubkeyHex
}

export interface ShieldParams {
	/** Amount in zatoshis to shield */
	amount: number
	/** Account index (default 0) */
	account?: number
}

interface TransparentUtxo {
	txid: string
	vout: number
	value: number
	scriptPubKey: string
}

interface TransparentSigningInput {
	index: number
	sighash: string       // hex 32 bytes
	address_path: number[] // BIP44 path
	amount: number
}

interface ShieldBuildResult {
	transparent_inputs: TransparentSigningInput[]
	orchard_signing_request: any
	digests: { header: string; transparent: string; sapling: string; orchard: string }
	display: { amount: string; fee: string; action: string }
}

/**
 * Full shield flow: transparent ZEC → Orchard shielded pool.
 *
 * @param wallet - hdwallet instance with zcashSignPczt + Pioneer access
 * @param pioneer - Pioneer API client for UTXO lookup
 * @param params - Shield parameters
 * @returns Transaction ID
 */
let shieldInProgress = false

export async function shieldZec(
	wallet: any,
	pioneer: any,
	params: ShieldParams,
): Promise<{ txid: string }> {
	if (shieldInProgress) {
		throw new Error("A shield transaction is already in progress")
	}
	shieldInProgress = true
	try {
		return await _shieldZecInner(wallet, pioneer, params)
	} finally {
		shieldInProgress = false
	}
}

async function _shieldZecInner(
	wallet: any,
	pioneer: any,
	params: ShieldParams,
): Promise<{ txid: string }> {
	const account = params.account ?? 0

	// 0. Ensure sidecar running + FVK set
	if (!isSidecarReady()) {
		await startSidecar()
	}
	// Only call device for FVK if sidecar doesn't have one cached already
	const cached = getCachedFvk()
	if (!cached) {
		await initializeOrchardFromDevice(wallet, account)
	}

	// 1. Get transparent address + compressed pubkey from device
	console.log("[zcash-shield] Deriving transparent ZEC address + pubkey...")
	const zcashPath = [0x80000000 + 44, 0x80000000 + 133, 0x80000000, 0, 0]
	let transparentAddress: string | undefined
	let compressedPubkey: string | undefined // hex, 33 bytes
	try {
		const addressResult = await wallet.btcGetAddress({
			addressNList: zcashPath,
			coin: "Zcash",
			scriptType: "p2pkh",
			showDisplay: false,
		})
		transparentAddress = typeof addressResult === 'string' ? addressResult : addressResult?.address
		console.log(`[zcash-shield] btcGetAddress result:`, JSON.stringify(addressResult)?.slice(0, 200))
	} catch (e: any) {
		console.error("[zcash-shield] btcGetAddress failed:", e.message)
	}
	if (!transparentAddress) {
		throw new Error("Failed to get transparent ZEC address from device — ensure device is unlocked")
	}

	// Get compressed public key for scriptSig construction
	// getPublicKeys expects the account-level path (m/44'/133'/0'), not the full address path
	const accountPath = [0x80000000 + 44, 0x80000000 + 133, 0x80000000]
	try {
		const pubkeyResult = await wallet.getPublicKeys([{
			addressNList: accountPath,
			coin: "Zcash",
			scriptType: "p2pkh",
			curve: "secp256k1",
		}])
		console.log("[zcash-shield] getPublicKeys raw:", JSON.stringify(pubkeyResult)?.slice(0, 500))
		const entry = pubkeyResult?.[0]
		const node = entry?.node || entry
		compressedPubkey = node?.public_key || node?.publicKey
		if (!compressedPubkey) {
			// getPublicKeys returns account-level xpub at m/44'/133'/0'
			// We need the child key at m/44'/133'/0'/0/0 — get that xpub and extract pubkey
			try {
				const fullResult = await wallet.getPublicKeys([{
					addressNList: zcashPath,
					coin: "Zcash",
					scriptType: "p2pkh",
					curve: "secp256k1",
				}])
				const fullXpub = fullResult?.[0]?.xpub
				if (fullXpub) {
					compressedPubkey = pubkeyFromXpub(fullXpub)
					console.log("[zcash-shield] Extracted pubkey from child xpub:", compressedPubkey)
				}
			} catch (e2: any) {
				console.error("[zcash-shield] Full path getPublicKeys failed:", e2.message)
			}
		}
		console.log(`[zcash-shield] Compressed pubkey: ${compressedPubkey}`)
	} catch (e: any) {
		console.error("[zcash-shield] getPublicKeys failed:", e.message)
	}
	if (!compressedPubkey) {
		throw new Error("Failed to get compressed pubkey for transparent input scriptSig")
	}
	console.log(`[zcash-shield] Transparent address: ${transparentAddress}`)

	// 2. Fetch UTXOs for the transparent address
	console.log("[zcash-shield] Fetching transparent UTXOs...")
	let utxos: TransparentUtxo[]
	try {
		const utxoResult = await pioneer.ListUnspent({ network: "ZEC", xpub: transparentAddress })
		console.log("[zcash-shield] ListUnspent raw response:", JSON.stringify(utxoResult)?.slice(0, 500))
		// Pioneer may return { data: [...] } or [...] or { utxos: [...] }
		const utxoArray = Array.isArray(utxoResult) ? utxoResult
			: Array.isArray(utxoResult?.data) ? utxoResult.data
			: Array.isArray(utxoResult?.utxos) ? utxoResult.utxos
			: []
		utxos = utxoArray.map((u: any) => {
			const raw = String(u.value ?? u.amount ?? '0')
			// Pioneer ListUnspent returns values as strings — parse as zatoshis (integers).
			// If the string contains a decimal point, treat as ZEC and convert to zatoshis.
			const value = raw.includes('.')
				? Math.round(parseFloat(raw) * 1e8)
				: parseInt(raw, 10)
			return {
				txid: u.txid || u.tx_hash,
				vout: u.vout ?? u.tx_output_n ?? u.index ?? 0,
				value: isNaN(value) ? 0 : value,
				scriptPubKey: u.scriptPubKey || u.script || u.scriptpubkey || "",
			}
		})
	} catch (e: any) {
		throw new Error(`Failed to fetch UTXOs: ${e.message}`)
	}

	if (utxos.length === 0) {
		throw new Error("No transparent UTXOs found for shielding")
	}

	const totalAvailable = utxos.reduce((sum, u) => sum + u.value, 0)
	console.log(`[zcash-shield] Found ${utxos.length} UTXOs totaling ${totalAvailable} ZAT`)

	// 3. Coin selection — select UTXOs covering amount + fee
	// ZIP-317: fee = 5000 × max(grace_actions, logical_actions)
	// Shield-wrap logical_actions = max(transparent_in, transparent_out) + nActionsOrchard
	// Orchard always pads to ≥ 2 actions; transparent has ≥ 1 input.
	// Change output adds 1 transparent output, so: max(nInputs, 1) + 2
	// We compute this conservatively before coin selection; re-check after.
	const nOrchardActions = 2 // Builder always pads to minimum 2
	const estimatedTransparent = 1 // At least 1 input, 1 change output → max(1,1) = 1
	const logicalActions = estimatedTransparent + nOrchardActions
	const fee = 5000 * Math.max(2, logicalActions) // ZIP-317
	const target = params.amount + fee

	if (totalAvailable < target) {
		throw new Error(
			`Insufficient transparent balance: have ${totalAvailable} ZAT, need ${target} ZAT ` +
			`(${params.amount} amount + ${fee} fee)`
		)
	}

	// Simple greedy selection — sort by value descending, take until covered
	const sorted = [...utxos].sort((a, b) => b.value - a.value)
	const selected: TransparentUtxo[] = []
	let selectedTotal = 0
	for (const utxo of sorted) {
		selected.push(utxo)
		selectedTotal += utxo.value
		if (selectedTotal >= target) break
	}

	console.log(`[zcash-shield] Selected ${selected.length} UTXOs totaling ${selectedTotal} ZAT`)

	// Re-check fee after coin selection — more inputs = more logical actions
	const actualTransparent = Math.max(selected.length, 1) // max(inputs, change_outputs)
	const actualLogical = actualTransparent + nOrchardActions
	const actualFee = 5000 * Math.max(2, actualLogical)
	if (actualFee > fee) {
		console.log(`[zcash-shield] ZIP-317 fee adjusted: ${fee} → ${actualFee} ZAT (${actualLogical} logical actions)`)
		// Re-select with higher fee if needed
		if (selectedTotal < params.amount + actualFee) {
			throw new Error(
				`Insufficient balance after ZIP-317 fee adjustment: have ${selectedTotal} ZAT, ` +
				`need ${params.amount + actualFee} ZAT (${params.amount} + ${actualFee} fee for ${actualLogical} actions)`
			)
		}
	}
	const finalFee = Math.max(fee, actualFee)

	// Derive scriptPubKey from pubkey if UTXOs don't have it (Pioneer often omits it)
	const derivedScriptPubKey = await p2pkhScriptPubKey(compressedPubkey!)
	console.log(`[zcash-shield] Derived P2PKH scriptPubKey: ${derivedScriptPubKey}`)

	for (const u of selected) {
		if (!u.scriptPubKey) {
			u.scriptPubKey = derivedScriptPubKey
			console.log(`[zcash-shield]   UTXO ${u.txid}:${u.vout} — using derived scriptPubKey`)
		}
		console.log(`[zcash-shield]   UTXO: txid=${u.txid} vout=${u.vout} value=${u.value} script=${u.scriptPubKey?.slice(0, 30)}`)
	}

	// 4. Build shield PCZT via sidecar
	console.log("[zcash-shield] Building shield PCZT...")
	const buildResult: ShieldBuildResult = await sendCommand("build_shield_pczt", {
		transparent_inputs: selected.map(u => ({
			txid: u.txid,
			vout: u.vout,
			value: u.value,
			script_pubkey: u.scriptPubKey,
		})),
		amount: params.amount,
		fee: finalFee,
		account,
	}, 600000) // Halo2 proof can take a while

	console.log(`[zcash-shield] Shield PCZT built: ${buildResult.transparent_inputs.length} transparent inputs, ${buildResult.orchard_signing_request.n_actions} Orchard actions`)

	// 5. Device signs — two-phase: Orchard first, then transparent
	//
	// The hybrid signing protocol (ZcashTransparentInput/ZcashTransparentSig)
	// requires firmware support that may not be present. Check first and
	// fall back to Orchard-only signing with a clear error for transparent.
	console.log("[zcash-shield] Requesting device signatures...")

	const hasTransparentInputs = buildResult.transparent_inputs.length > 0

	// Check if firmware supports hybrid signing by checking if the method
	// accepts transparent_inputs. If firmware returns "Unknown message",
	// we need firmware >= 7.15.0 with ZcashTransparentInput support.
	const signingRequest = {
		...buildResult.orchard_signing_request,
		transparent_inputs: hasTransparentInputs
			? buildResult.transparent_inputs.map((ti: any) => ({
				index: ti.index,
				sighash: ti.sighash,
				addressNList: ti.address_path,
				amount: ti.amount,
			}))
			: undefined,
	}

	let signatures: any
	try {
		signatures = await wallet.zcashSignPczt(signingRequest, buildResult.orchard_signing_request.sighash)
	} catch (e: any) {
		if (e?.message?.includes("Unknown message") && hasTransparentInputs) {
			throw new Error(
				"Shielding requires firmware with transparent input signing support (ZcashTransparentInput). " +
				"Your firmware does not implement this message type yet. " +
				"Please update to firmware >= 7.15.0 when available."
			)
		}
		throw e
	}

	// Extract transparent signatures (attached by hdwallet adapter)
	const transparentSigs: string[] = (signatures as any)._transparentSignatures || []
	const orchardSigs: string[] = signatures

	console.log(`[zcash-shield] Got ${transparentSigs.length} transparent sigs, ${orchardSigs.length} Orchard sigs`)
	if (transparentSigs.length > 0) {
		console.log(`[zcash-shield] Transparent sig[0]: ${transparentSigs[0]?.slice(0, 40)}...`)
	}
	console.log(`[zcash-shield] Pubkey for scriptSig: ${compressedPubkey}`)

	// 6. Finalize via sidecar — pass pubkey for scriptSig construction
	console.log("[zcash-shield] Finalizing shield transaction...")
	const { raw_tx, txid } = await sendCommand("finalize_shield", {
		transparent_signatures: transparentSigs,
		orchard_signatures: orchardSigs,
		compressed_pubkey: compressedPubkey,
	})

	// 7. Broadcast
	console.log(`[zcash-shield] raw_tx (first 200): ${raw_tx?.slice(0, 200)}`)
	console.log(`[zcash-shield] raw_tx length: ${raw_tx?.length / 2} bytes`)
	console.log("[zcash-shield] Broadcasting...")
	await sendCommand("broadcast", { raw_tx })

	console.log(`[zcash-shield] Shield transaction sent: ${txid}`)
	return { txid }
}
