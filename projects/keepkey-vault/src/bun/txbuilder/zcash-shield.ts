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

import { sendCommand, isSidecarReady, startSidecar, getCachedFvk, getScanState } from "../zcash-sidecar"
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
	/** Confirmation count if Pioneer provides one — used by the 10-conf gate. */
	confirmations?: number
	/** Block height the UTXO was mined at, if reported. */
	height?: number
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

export type TxProgressStep = "building" | "signing" | "broadcasting" | "complete"
export type TxProgressFn = (step: TxProgressStep, detail?: any) => void

export async function shieldZec(
	wallet: any,
	pioneer: any,
	params: ShieldParams,
	opts?: { signWrap?: import("./zcash-shielded").DeviceSignWrap; onProgress?: TxProgressFn },
): Promise<{ txid: string }> {
	if (shieldInProgress) {
		throw new Error("A shield transaction is already in progress")
	}
	shieldInProgress = true
	try {
		return await _shieldZecInner(wallet, pioneer, params, opts)
	} finally {
		shieldInProgress = false
	}
}

async function _shieldZecInner(
	wallet: any,
	pioneer: any,
	params: ShieldParams,
	opts?: { signWrap?: import("./zcash-shielded").DeviceSignWrap; onProgress?: TxProgressFn },
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
			// Pull a confirmation count when Pioneer provides one. Some UTXO
			// indexers return `confirmations` directly; others return a `height`
			// that we'd compare against tip. We defensively keep both forms.
			const confirmations = typeof u.confirmations === 'number'
				? u.confirmations
				: (typeof u.confirmations === 'string' ? parseInt(u.confirmations, 10) : undefined)
			const height = typeof u.height === 'number'
				? u.height
				: (typeof u.height === 'string' ? parseInt(u.height, 10) : undefined)
			return {
				txid: u.txid || u.tx_hash,
				vout: u.vout ?? u.tx_output_n ?? u.index ?? 0,
				value: isNaN(value) ? 0 : value,
				scriptPubKey: u.scriptPubKey || u.script || u.scriptpubkey || "",
				confirmations: Number.isFinite(confirmations as number) ? (confirmations as number) : undefined,
				height: Number.isFinite(height as number) ? (height as number) : undefined,
			}
		})
	} catch (e: any) {
		throw new Error(`Failed to fetch UTXOs: ${e.message}`)
	}

	if (utxos.length === 0) {
		throw new Error("No transparent UTXOs found for shielding")
	}

	// Min-confirmations gate (matches the Orchard 10-conf rule in the sidecar).
	// Reorgs can move recent transparent inputs the same way they can move recent
	// shielded notes; signing against an unconfirmed UTXO that later disappears
	// produces a doomed tx. 10 matches zcashd / ywallet defaults.
	//
	// Pioneer's UTXO indexer may report `confirmations` directly OR just `height`.
	// We prefer `confirmations` (no tip lookup needed); when only `height` is
	// present we derive confirmations from `synced_to` (the sidecar's latest
	// scanned block height, ≈ chain tip after the auto-scan that runs upstream
	// of every send). If neither is present we let the UTXO through rather than
	// blocking the user — better to broadcast and have the chain reject than to
	// fail with a confusing UI error when the indexer schema changes.
	const MIN_CONFIRMATIONS = 10
	const tipHeight = getScanState().syncedTo
	const filtered = utxos.filter(u => {
		if (typeof u.confirmations === 'number') return u.confirmations >= MIN_CONFIRMATIONS
		if (typeof u.height === 'number' && tipHeight != null && u.height > 0) {
			const derived = tipHeight - u.height + 1
			return derived >= MIN_CONFIRMATIONS
		}
		// No confirmation info we can use: don't block the send.
		return true
	})
	if (filtered.length === 0 && utxos.length > 0) {
		throw new Error(
			`All ${utxos.length} transparent UTXOs are within ${MIN_CONFIRMATIONS} confirmations of the chain tip. ` +
			`Wait a few minutes and retry.`
		)
	}
	if (filtered.length < utxos.length) {
		const filteredOut = utxos.length - filtered.length
		console.log(`[zcash-shield] Filtered out ${filteredOut} UTXO(s) below ${MIN_CONFIRMATIONS} confirmations`)
	}
	utxos = filtered

	const totalAvailable = utxos.reduce((sum, u) => sum + u.value, 0)
	console.log(`[zcash-shield] Found ${utxos.length} UTXOs totaling ${totalAvailable} ZAT (after ${MIN_CONFIRMATIONS}-conf filter)`)

	// 3. Coin selection — iteratively add UTXOs and recompute the ZIP-317 fee.
	//
	// The fee depends on how many inputs we end up selecting:
	//   logical_actions = max(transparent_inputs, transparent_outputs=1)
	//                   + max(orchard_spends, orchard_outputs)         // = 2 (BundleType::DEFAULT pad)
	//   fee = 5000 * max(grace_actions=2, logical_actions)
	//
	// So adding inputs can raise the fee, which can require even more inputs
	// to cover the new target. The previous greedy version selected against a
	// fixed (1-input) target and then threw if the recomputed fee outran the
	// selected total — even when more UTXOs were available. Now we recompute
	// after each addition and keep going until the running total covers the
	// running target, only erroring out if the entire set is short.
	const nOrchardActions = 2 // BundleType::DEFAULT pads to a 2-action minimum
	const computeFee = (nInputs: number): number => {
		const transparentActions = Math.max(nInputs, 1) // max(inputs, change_outputs=1)
		const logical = transparentActions + nOrchardActions
		return 5000 * Math.max(2, logical)
	}

	// Cheap fast-path: even with 1 input (cheapest fee shape) we can't cover
	// `amount + fee`, no point selecting.
	const minFee = computeFee(1)
	if (totalAvailable < params.amount + minFee) {
		throw new Error(
			`Insufficient transparent balance: have ${totalAvailable} ZAT, need ≥${params.amount + minFee} ZAT ` +
			`(${params.amount} amount + ${minFee} fee minimum)`
		)
	}

	const sorted = [...utxos].sort((a, b) => b.value - a.value)
	const selected: TransparentUtxo[] = []
	let selectedTotal = 0
	let runningFee = computeFee(0)
	for (const utxo of sorted) {
		selected.push(utxo)
		selectedTotal += utxo.value
		runningFee = computeFee(selected.length)
		if (selectedTotal >= params.amount + runningFee) break
	}

	const finalFee = computeFee(selected.length)
	if (selectedTotal < params.amount + finalFee) {
		throw new Error(
			`Insufficient transparent balance after ZIP-317 fee for ${selected.length} input(s): ` +
			`have ${selectedTotal} ZAT, need ${params.amount + finalFee} ZAT ` +
			`(${params.amount} amount + ${finalFee} fee for ${selected.length + nOrchardActions} logical actions)`
		)
	}

	console.log(`[zcash-shield] Selected ${selected.length} UTXOs totaling ${selectedTotal} ZAT, fee=${finalFee} ZAT`)

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
	opts?.onProgress?.("signing")

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
		const signFn = () => wallet.zcashSignPczt(signingRequest, buildResult.orchard_signing_request.sighash)
		signatures = opts?.signWrap ? await opts.signWrap(signFn) : await signFn()
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
	opts?.onProgress?.("broadcasting")
	await sendCommand("broadcast", { raw_tx })

	console.log(`[zcash-shield] Shield transaction sent: ${txid}`)
	return { txid }
}
