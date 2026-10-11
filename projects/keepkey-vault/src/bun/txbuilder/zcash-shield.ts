/**
 * Zcash transparent → Ironwood shielding transaction builder.
 *
 * Orchestrates the flow:
 *   1. Fetch transparent UTXOs (via Pioneer)
 *   2. Coin selection
 *   3. Sidecar builds hybrid PCZT (transparent inputs + Orchard output)
 *   4. Device signs transparent inputs (ECDSA) + Orchard actions (RedPallas)
 *   5. Sidecar finalizes + serializes hybrid v5 tx
 *   6. Broadcast via lightwalletd
 */

import { sendCommand, isSidecarReady, startSidecar, getCachedFvk, getScanState, beginZcashSend, endZcashSend } from "../zcash-sidecar"
import { initializeOrchardFromDevice } from "./zcash-shielded"
import { summarizeZcashMaturity, filterSpendableZcashUtxos, zcashUtxoValueZat, ZCASH_MIN_CONFIRMATIONS } from "../../shared/zcash-maturity"
import { maxShieldable, planShieldBatches } from "./zcash-batching"

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
export function pubkeyFromXpub(xpub: string): string {
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
	address_path: number[]
	amount: number
	prevout_txid: string    // hex 32 bytes LE
	prevout_index: number
	sequence: number
	script_pubkey: string   // hex scriptPubKey of UTXO being spent
}

interface ShieldBuildResult {
	transparent_inputs: TransparentSigningInput[]
	transparent_outputs?: Array<{ index: number; value: number; script_pubkey: string }>
	orchard_signing_request: any
	digests: { header: string; transparent: string; orchard: string; ironwood: string }
	display: { amount: string; fee: string; action: string }
}

/**
 * Full shield flow: transparent ZEC → Ironwood shielded pool.
 *
 * @param wallet - hdwallet instance with zcashSignPczt + Pioneer access
 * @param pioneer - Pioneer API client for UTXO lookup
 * @param params - Shield parameters
 * @returns Transaction ID
 */
let shieldInProgress = false

export type TxProgressStep = "building" | "signing" | "broadcasting" | "complete"
/** `detail` carries the batch position when an operation takes several
 *  transactions ("Shielding 3 of 5"). */
export type TxProgressFn = (step: TxProgressStep, detail?: { index: number; total: number; fee?: number; phase?: string }) => void

/** Re-exported alias — the shield gate is the same 10-conf rule the send/swap
 *  builder now enforces, so there is one definition of "spendable". */
export const SHIELD_MIN_CONFIRMATIONS = ZCASH_MIN_CONFIRMATIONS

/** UTXO totals at a single transparent ZEC address, split by maturity.
 *
 *  - `matureZat` is the only thing shieldZec can actually spend right now;
 *    the builder enforces the same 10-conf filter (reorgs can move recent
 *    transparent inputs, so signing against them produces a doomed tx).
 *  - `pendingZat` covers UTXOs still under 10 conf — exposed so the UI can
 *    surface "X ZEC pending, available in Y blocks" instead of a silent gap
 *    between displayed balance and shieldable amount.
 *
 *  Uses Pioneer ListUnspent (same source the shield builder uses) scoped to
 *  one address — chain-level getBalance returns the whole xpub which is the
 *  wrong frame for the shield flow. */
export async function getShieldableTransparentBalance(
	pioneer: any,
	transparentAddress: string,
	tipHeight?: number | null,
): Promise<{ matureZat: number; pendingZat: number; matureCount: number; pendingCount: number; nextUnlockConfirmations: number | null; maxShieldZat: number }> {
	const result = await pioneer.ListUnspent({ network: "ZEC", xpub: transparentAddress })
	const utxoArray = Array.isArray(result) ? result
		: Array.isArray(result?.data) ? result.data
		: Array.isArray(result?.data?.data) ? result.data.data
		: Array.isArray(result?.utxos) ? result.utxos
		: []

	// Same helper the send/swap builder uses, so Available + Max here cannot
	// drift from what a transaction will actually be allowed to spend.
	const summary = summarizeZcashMaturity(utxoArray, tipHeight)
	return {
		matureZat: summary.spendableZat,
		pendingZat: summary.lockedZat,
		matureCount: summary.spendableCount,
		pendingCount: summary.lockedCount,
		nextUnlockConfirmations: summary.nextUnlockConfirmations,
		// Max button: every mature UTXO, after the fee of each 8-input batch.
		maxShieldZat: maxShieldable(
			filterSpendableZcashUtxos(utxoArray, tipHeight).map((u: any) => ({ value: zcashUtxoValueZat(u) })),
		),
	}
}

/** Convert a sidecar-returned txid to explorer/display order.
 *
 *  The sidecar (modules/keepkey-zcash) emits txids in the raw blake2b
 *  internal byte order — Zcash explorers (Blockchair, ZecRocks, etc.)
 *  show the byte-reversed form, like Bitcoin. There's an upstream fix
 *  in keepkey-zcash that reverses inside the Rust code before hex-encoding,
 *  but that lives in a separate repo with its own release cycle. Until
 *  every shipping vault has a sidecar with the fix baked in, we reverse
 *  here as the single defensive choke point. Once we can guarantee the
 *  sidecar emits display order, drop this helper and the call sites. */
export function txidToDisplayOrder(internalHex: string): string {
	if (!internalHex || internalHex.length !== 64 || !/^[0-9a-f]+$/i.test(internalHex)) {
		// Don't silently mangle — surface bad input rather than producing a plausible-looking wrong txid
		return internalHex
	}
	const bytes = internalHex.match(/.{2}/g)!
	return bytes.reverse().join("").toLowerCase()
}

export async function shieldZec(
	wallet: any,
	pioneer: any,
	params: ShieldParams,
	opts?: { signWrap?: import("./zcash-shielded").DeviceSignWrap; onProgress?: TxProgressFn },
): Promise<{ txid: string; txids: string[] }> {
	if (shieldInProgress) {
		throw new Error("A shield transaction is already in progress")
	}
	shieldInProgress = true
	beginZcashSend()
	try {
		return await _shieldZecInner(wallet, pioneer, params, opts)
	} finally {
		endZcashSend()
		shieldInProgress = false
	}
}

async function _shieldZecInner(
	wallet: any,
	pioneer: any,
	params: ShieldParams,
	opts?: { signWrap?: import("./zcash-shielded").DeviceSignWrap; onProgress?: TxProgressFn },
): Promise<{ txid: string; txids: string[] }> {
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

	// 3. Split into transactions of at most 8 inputs each (firmware 7.15
	// limit). They spend disjoint UTXOs, so each one is built, signed and
	// broadcast in turn without waiting for the previous to confirm.
	const batches = planShieldBatches(utxos, params.amount)
	console.log(`[zcash-shield] Shielding ${params.amount} ZAT in ${batches.length} transaction(s): fees ${batches.map(b => b.fee).join(", ")} ZAT`)

	// Derive scriptPubKey from pubkey if UTXOs don't have it (Pioneer often omits it)
	const derivedScriptPubKey = await p2pkhScriptPubKey(compressedPubkey!)

	const txids: string[] = []
	for (const [i, batch] of batches.entries()) {
		const progress = { index: i + 1, total: batches.length, fee: batch.fee }
		opts?.onProgress?.("building", progress)
		try {
			const { txid } = await signAndBroadcastShield(wallet, {
				inputs: batch.inputs.map(u => ({ ...u, scriptPubKey: u.scriptPubKey || derivedScriptPubKey })),
				amount: batch.amount,
				fee: batch.fee,
				account,
				addressPath: zcashPath,
				compressedPubkey: compressedPubkey!,
			}, { ...opts, progress })
			txids.push(txid)
		} catch (e: any) {
			if (txids.length === 0) throw e
			throw new Error(
				`Shielded ${txids.length} of ${batches.length} transactions (${txids.join(", ")}); ` +
				`transaction ${i + 1} failed: ${e?.message ?? e}. Shield the rest again.`
			)
		}
	}
	return { txid: txids[txids.length - 1], txids }
}

/** One shield transaction: build, sign on the device, finalize, broadcast.
 *  Every input sits at `addressPath` and is signed with `compressedPubkey`. */
export async function signAndBroadcastShield(
	wallet: any,
	tx: {
		inputs: Array<{ txid: string; vout: number; value: number; scriptPubKey: string }>
		amount: number
		fee: number
		account: number
		addressPath: number[]
		compressedPubkey: string
	},
	opts?: {
		signWrap?: import("./zcash-shielded").DeviceSignWrap
		onProgress?: TxProgressFn
		progress?: { index: number; total: number; fee?: number }
	},
): Promise<{ txid: string }> {
	console.log(`[zcash-shield] Building shield PCZT: ${tx.inputs.length} inputs, ${tx.amount} ZAT, fee ${tx.fee} ZAT...`)
	const buildResult: ShieldBuildResult = await sendCommand("build_shield_pczt", {
		transparent_inputs: tx.inputs.map(u => ({
			txid: u.txid,
			vout: u.vout,
			value: u.value,
			script_pubkey: u.scriptPubKey,
		})),
		amount: tx.amount,
		fee: tx.fee,
		account: tx.account,
		address_path: tx.addressPath,
	}, 600000) // Halo2 proof can take a while

	console.log(`[zcash-shield] Shield PCZT built: ${buildResult.transparent_inputs.length} transparent inputs, ${buildResult.orchard_signing_request.n_actions} Ironwood actions`)

	// Device signs — Ironwood plus transparent authorization.
	opts?.onProgress?.("signing", opts.progress)
	const hasTransparentInputs = buildResult.transparent_inputs.length > 0
	const signingRequest = {
		...buildResult.orchard_signing_request,
		header_fields: buildResult.orchard_signing_request.header_fields,
		transparent_outputs: buildResult.transparent_outputs,
		transparent_inputs: hasTransparentInputs
			? buildResult.transparent_inputs.map(toHdwalletTransparentInput)
			: undefined,
	}

	let signatures: any
	try {
		const signFn = () => wallet.zcashSignPczt(signingRequest, buildResult.orchard_signing_request.sighash)
		signatures = opts?.signWrap ? await opts.signWrap(signFn) : await signFn()
	} catch (e: any) {
		console.error("[zcash-shield] zcashSignPczt threw:", typeof e, JSON.stringify(e), e?.message)
		if (String(e?.message ?? e ?? "").includes("Unknown message") && hasTransparentInputs) {
			throw new Error(
				"Shielding requires firmware with transparent input signing support (ZcashTransparentInput). " +
				"Your firmware does not implement this message type yet. " +
				"Please update to firmware >= 7.15.0 when available."
			)
		}
		throw e
	}

	// Transparent signatures are attached by the hdwallet adapter
	const transparentSigs: string[] = (signatures as any)._transparentSignatures || []
	const orchardSigs: string[] = signatures
	console.log(`[zcash-shield] Got ${transparentSigs.length} transparent sigs, ${orchardSigs.length} Ironwood sigs`)

	const { raw_tx, txid } = await sendCommand("finalize_shield", {
		transparent_signatures: transparentSigs,
		orchard_signatures: orchardSigs,
		compressed_pubkey: tx.compressedPubkey,
	})

	console.log(`[zcash-shield] raw_tx length: ${raw_tx?.length / 2} bytes`)
	opts?.onProgress?.("broadcasting", opts.progress)
	await sendCommand("broadcast", { raw_tx })

	const displayTxid = txidToDisplayOrder(txid)
	console.log(`[zcash-shield] Shield transaction sent: ${displayTxid}`)
	return { txid: displayTxid }
}

/** hdwallet's TransparentInput is camelCase; the sidecar speaks snake_case.
 *  A silent mismatch reaches the device as an input with no prevout/script
 *  and fails as "Invalid transparent input data", so validate first. */
export function toHdwalletTransparentInput(ti: any) {
	if (!ti.prevout_txid || ti.prevout_index === undefined || !ti.script_pubkey) {
		throw new Error(`Sidecar transparent input ${ti.index} missing prevout_txid/prevout_index/script_pubkey`)
	}
	return {
		index: ti.index,
		addressNList: ti.address_path,
		amount: ti.amount,
		prevoutTxid: ti.prevout_txid,
		prevoutIndex: ti.prevout_index,
		sequence: ti.sequence,
		scriptPubkey: ti.script_pubkey,
	}
}
