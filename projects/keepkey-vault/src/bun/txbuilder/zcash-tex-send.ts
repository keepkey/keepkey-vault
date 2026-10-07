/**
 * ZIP-320 TEX send: shielded funds → the wallet's one-time transparent
 * address (step 1) → the TEX recipient (step 2, transparent only).
 *
 * The ephemeral index is reserved and persisted before it is used, and each
 * step's outcome is persisted as soon as it happens, so a failure after
 * step 1 leaves a pending payment the user can complete or shield back.
 */

import * as ZcashMessages from "@keepkey/device-protocol/lib/messages-zcash_pb"
import { getSetting, setSetting } from "../db"
import { sendCommand, getCachedFvk, beginZcashSend, endZcashSend } from "../zcash-sidecar"
import { MAX_TRANSPARENT_INPUTS, shieldFee } from "./zcash-batching"
import { deshieldZec } from "./zcash-deshield"
import {
	pubkeyFromXpub, signAndBroadcastShield, toHdwalletTransparentInput, txidToDisplayOrder,
	type TxProgressFn,
} from "./zcash-shield"
import type { DeviceSignWrap } from "./zcash-shielded"
import * as tex from "./zcash-tex"

type TexOpts = { signWrap?: DeviceSignWrap; onProgress?: TxProgressFn }

function stateKey(): string {
	const cached = getCachedFvk()
	if (!cached?.address) throw new Error("Zcash wallet not loaded — open the Privacy tab first")
	return tex.texStateKey(cached.address)
}

function loadState(): tex.TexState {
	return tex.parseTexState(getSetting(stateKey()))
}

/** setSetting swallows errors; read back so an unsaved reservation can
 *  never lead to a reused one-time address. */
function saveState(state: tex.TexState): void {
	const key = stateKey()
	const json = JSON.stringify(state)
	setSetting(key, json)
	if (getSetting(key) !== json) throw new Error("Could not save TEX payment state — refusing to continue")
}

function updateRecord(index: number, patch: Partial<Omit<tex.TexRecord, "index">>): void {
	saveState(tex.updateTexRecord(loadState(), index, patch))
}

function findRecord(index: number): tex.TexRecord {
	const record = loadState().records.find(r => r.index === index)
	if (!record) throw new Error(`No TEX payment with one-time address #${index}`)
	return record
}

/** Pubkey, P2PKH script and t1 address of the one-time key at `path`. */
async function ephemeralKey(wallet: any, path: number[]): Promise<{ pubkey: string; script: string; address: string }> {
	const result = await wallet.getPublicKeys([{
		addressNList: path, coin: "Zcash", scriptType: "p2pkh", curve: "secp256k1",
	}])
	const xpub = result?.[0]?.xpub
	if (!xpub) throw new Error("Device did not return the one-time address key")
	const pubkey = pubkeyFromXpub(xpub)
	const hash = tex.hash160(Buffer.from(pubkey, "hex"))
	return { pubkey, script: tex.p2pkhScript(hash), address: tex.encodeTransparentP2pkh(hash) }
}

/** The device can only show the step-2 output as `tex1…` with a
 *  device-protocol build that has ZcashTransparentOutput.is_tex. */
export function texSigningSupported(): boolean {
	return typeof (ZcashMessages.ZcashTransparentOutput.prototype as any).setIsTex === "function"
}

/** Step 2 spends a mempool output; a node that has not seen step 1 yet
 *  rejects it as missing inputs, so retry for a short while. */
async function broadcastWithRetry(rawTx: string): Promise<void> {
	const delays = [0, 5_000, 15_000, 30_000]
	let last: unknown
	for (const delay of delays) {
		if (delay) await new Promise(r => setTimeout(r, delay))
		try {
			await sendCommand("broadcast", { raw_tx: rawTx })
			return
		} catch (e) {
			last = e
			console.warn("[zcash-tex] step-2 broadcast failed, retrying:", (e as any)?.message ?? e)
		}
	}
	throw last
}

export function listTexPayments(): tex.TexRecord[] {
	return loadState().records
}

/** Pay a TEX address from shielded funds. */
export async function sendTex(
	wallet: any,
	params: { recipient: string; amount: number; account?: number },
	opts?: TexOpts,
): Promise<{ txid: string; fundingTxids: string[]; ephemeralIndex: number }> {
	const account = params.account ?? 0
	const recipient = params.recipient.trim()
	tex.decodeTexAddress(recipient)
	if (!Number.isInteger(params.amount) || params.amount <= 0) {
		throw new Error("Amount must be a positive integer (zatoshis)")
	}
	if (!texSigningSupported()) {
		throw new Error(
			"Paying a TEX address needs a KeepKey Desktop build whose device protocol can show tex1 outputs on the device. No funds were moved."
		)
	}

	// Size step 1 so step 2 can pay its fee: one step-2 input per step-1
	// transaction (each spends at most 16 notes).
	let nInputs = 1
	for (;;) {
		const plan = await sendCommand("plan_spend", {
			amount: params.amount + tex.texStep2Fee(nInputs), kind: "deshield",
		})
		const n = plan.steps.length
		if (n <= nInputs) break
		if (n > MAX_TRANSPARENT_INPUTS) {
			throw new Error(`This payment needs ${n} funding transactions; a TEX payment can use at most ${MAX_TRANSPARENT_INPUTS}. Send a smaller amount.`)
		}
		nInputs = n
	}

	// Reserve the one-time address and persist it before it is used.
	const reserved = tex.reserveEphemeral(loadState(), {
		tex: recipient, amount: params.amount, account, now: Date.now(),
	})
	saveState(reserved.state)
	const index = reserved.record.index
	const path = tex.ephemeralPath(account, index)
	console.log(`[zcash-tex] Paying ${recipient} via one-time address #${index}`)

	try {
		const eph = await ephemeralKey(wallet, path)
		const funded = await deshieldZec(wallet, {
			recipient: eph.address,
			amount: params.amount + tex.texStep2Fee(nInputs),
			account,
		}, {
			signWrap: opts?.signWrap,
			onProgress: (step, d) => opts?.onProgress?.(step, { ...(d ?? { index: 1, total: 1 }), phase: "tex-fund" }),
			outputAddressN: path,
			onBroadcast: f => updateRecord(index, { status: "funded", funding: [...findRecord(index).funding, f] }),
		})
		const paid = await payTex(wallet, index, opts)
		return { txid: paid.txid, fundingTxids: funded.txids, ephemeralIndex: index }
	} catch (e: any) {
		if (findRecord(index).status === "reserved") updateRecord(index, { error: e?.message ?? String(e) })
		throw e
	}
}

/** Step 2: pay the TEX address from the funded one-time address. Also the
 *  retry when an earlier step 2 failed. */
export async function payTex(wallet: any, index: number, opts?: TexOpts): Promise<{ txid: string; fee: number }> {
	const record = findRecord(index)
	if (record.status !== "funded") throw new Error(`TEX payment #${index} is ${record.status}, not waiting to be paid`)
	if (!texSigningSupported()) throw new Error("This build cannot show tex1 outputs on the device")
	const hash = tex.decodeTexAddress(record.tex)
	const path = tex.ephemeralPath(record.account, index)
	const { value, fee } = tex.texPayout(record)

	beginZcashSend()
	try {
		const eph = await ephemeralKey(wallet, path)
		const progress = { index: 1, total: 1, fee, phase: "tex-pay" }
		opts?.onProgress?.("building", progress)
		const build = await sendCommand("build_transparent_pczt", {
			transparent_inputs: record.funding.map(f => ({ txid: f.txid, vout: f.vout, value: f.value, script_pubkey: eph.script })),
			transparent_outputs: [{ value, script_pubkey: tex.p2pkhScript(hash) }],
			address_path: path,
			account: record.account,
		})
		const signingRequest = {
			...build,
			display: { ...build.display, to: record.tex },
			transparent_inputs: build.transparent_inputs.map(toHdwalletTransparentInput),
			// The device renders this output as the tex1 address the user typed.
			transparent_outputs: build.transparent_outputs.map((o: any) => ({ ...o, is_tex: true })),
		}
		opts?.onProgress?.("signing", progress)
		const signFn = () => wallet.zcashSignPczt(signingRequest, "")
		const signatures = opts?.signWrap ? await opts.signWrap(signFn) : await signFn()
		const transparentSigs: string[] = (signatures as any)?._transparentSignatures ?? []
		const { raw_tx, txid } = await sendCommand("finalize_transparent", {
			transparent_signatures: transparentSigs,
			compressed_pubkey: eph.pubkey,
		})
		opts?.onProgress?.("broadcasting", progress)
		await broadcastWithRetry(raw_tx)
		const display = txidToDisplayOrder(txid)
		updateRecord(index, { status: "paid", finalTxid: display, error: undefined })
		console.log(`[zcash-tex] Paid ${record.tex}: ${display}`)
		return { txid: display, fee }
	} catch (e: any) {
		const msg = e?.message ?? String(e)
		updateRecord(index, { error: msg })
		throw new Error(
			`The payment is waiting at your one-time address #${index}: ${msg}. ` +
			`Complete it or shield it back from the pending TEX payments list.`
		)
	} finally {
		endZcashSend()
	}
}

/** Recovery: shield a funded one-time address back into Ironwood instead of
 *  paying the TEX address. */
export async function shieldBackTex(wallet: any, index: number, opts?: TexOpts): Promise<{ txid: string }> {
	const record = findRecord(index)
	if (record.status !== "funded") throw new Error(`TEX payment #${index} is ${record.status}, nothing to shield back`)
	const path = tex.ephemeralPath(record.account, index)
	const total = record.funding.reduce((s, f) => s + f.value, 0)
	const fee = shieldFee(record.funding.length)
	if (total <= fee) throw new Error("One-time address holds less than the shielding fee")

	beginZcashSend()
	try {
		const eph = await ephemeralKey(wallet, path)
		const progress = { index: 1, total: 1, fee, phase: "tex-return" }
		opts?.onProgress?.("building", progress)
		const { txid } = await signAndBroadcastShield(wallet, {
			inputs: record.funding.map(f => ({ txid: f.txid, vout: f.vout, value: f.value, scriptPubKey: eph.script })),
			amount: total - fee,
			fee,
			account: record.account,
			addressPath: path,
			compressedPubkey: eph.pubkey,
		}, { ...opts, progress })
		updateRecord(index, { status: "returned", finalTxid: txid, error: undefined })
		return { txid }
	} catch (e: any) {
		updateRecord(index, { error: e?.message ?? String(e) })
		throw e
	} finally {
		endZcashSend()
	}
}
