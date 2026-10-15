/**
 * ZIP-320 TEX (transparent-source-only) addresses: pure helpers.
 *
 * A `tex1…` address is a P2PKH hash that only accepts funds from transparent
 * inputs. A shielded wallet pays it in two transactions:
 *   1. shielded → the wallet's own one-time ("ephemeral") transparent
 *      address at m/44'/133'/account'/2/index, for payment + step-2 fee;
 *   2. that ephemeral output → P2PKH to the TEX hash (no shielded actions).
 *
 * Ephemeral indexes are never reused and stay within a gap limit so a
 * restored wallet can find them.
 */

import { createHash } from "crypto"

const H = 0x80000000
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32M_CONST = 0x2bc830a3
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
/** Zcash mainnet P2PKH version bytes (t1…). */
const T1_PREFIX = [0x1c, 0xb8]

/** ZIP-320: at most this many reserved-but-unused ephemeral addresses past
 *  the last one that received funds. */
export const EPHEMERAL_GAP_LIMIT = 5

function polymod(values: number[]): number {
	const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
	let chk = 1
	for (const v of values) {
		const top = chk >>> 25
		chk = ((chk & 0x1ffffff) << 5) ^ v
		for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]
	}
	return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
	const out: number[] = []
	for (const c of hrp) out.push(c.charCodeAt(0) >> 5)
	out.push(0)
	for (const c of hrp) out.push(c.charCodeAt(0) & 31)
	return out
}

/** True for anything shaped like a TEX address, mainnet or testnet. */
export function isTexAddress(addr: string): boolean {
	const s = addr.trim().toLowerCase()
	return s.startsWith("tex1") || s.startsWith("textest1")
}

/** Decode a TEX address to its 20-byte P2PKH hash. Throws on a bad
 *  checksum, a wrong length, or a testnet address on mainnet. */
export function decodeTexAddress(addr: string, network: "main" | "test" = "main"): Uint8Array {
	const raw = addr.trim()
	if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) throw new Error("TEX address mixes upper and lower case")
	const s = raw.toLowerCase()
	const sep = s.lastIndexOf("1")
	if (sep < 1) throw new Error("Not a TEX address")
	const hrp = s.slice(0, sep)
	const expected = network === "main" ? "tex" : "textest"
	if (hrp === "textest" && network === "main") throw new Error("Testnet TEX address (textest1…) cannot be paid on mainnet")
	if (hrp !== expected) throw new Error(`Not a ${network === "main" ? "mainnet" : "testnet"} TEX address`)
	const data: number[] = []
	for (const c of s.slice(sep + 1)) {
		const v = CHARSET.indexOf(c)
		if (v < 0) throw new Error("TEX address has an invalid character")
		data.push(v)
	}
	if (data.length < 6) throw new Error("TEX address is too short")
	if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) throw new Error("TEX address checksum is invalid (bech32m)")
	// 5-bit groups → bytes, no padding allowed.
	let acc = 0
	let bits = 0
	const out: number[] = []
	for (const v of data.slice(0, -6)) {
		acc = ((acc << 5) | v) & 0xfff
		bits += 5
		if (bits >= 8) {
			bits -= 8
			out.push((acc >> bits) & 0xff)
		}
	}
	if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) throw new Error("TEX address has invalid padding")
	if (out.length !== 20) throw new Error(`TEX address must carry a 20-byte hash, got ${out.length}`)
	return Uint8Array.from(out)
}

export function hash160(data: Uint8Array): Uint8Array {
	const sha = createHash("sha256").update(data).digest()
	return new Uint8Array(createHash("ripemd160").update(sha).digest())
}

export function p2pkhScript(hash: Uint8Array): string {
	return "76a914" + Buffer.from(hash).toString("hex") + "88ac"
}

/** Mainnet t1… address for a P2PKH hash. */
export function encodeTransparentP2pkh(hash: Uint8Array): string {
	const payload = Buffer.from([...T1_PREFIX, ...hash])
	const check = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4)
	const bytes = Buffer.concat([payload, check])
	let num = BigInt("0x" + bytes.toString("hex"))
	let out = ""
	while (num > 0n) {
		out = BASE58[Number(num % 58n)] + out
		num /= 58n
	}
	for (const b of bytes) {
		if (b !== 0) break
		out = "1" + out
	}
	return out
}

/** ZIP-317 fee for the transparent-only step 2 (P2PKH in, one P2PKH out). */
export function texStep2Fee(nInputs: number): number {
	return 5000 * Math.max(2, Math.max(nInputs, 1))
}

export function ephemeralPath(account: number, index: number): number[] {
	return [H + 44, H + 133, H + account, 2, index]
}

// ── Ephemeral address state ──────────────────────────────────────────

/**
 * reserved → funded (step 1 broadcast) → paid (step 2 broadcast)
 *                                     ↘ returned (shielded back)
 * A reservation whose step 1 never broadcast stays `reserved`: its index is
 * spent for good, never handed out again.
 */
export type TexStatus = "reserved" | "funded" | "paid" | "returned"

export interface TexFunding {
	/** Step-1 txid, display order */
	txid: string
	vout: number
	value: number
}

export interface TexRecord {
	index: number
	account: number
	tex: string
	/** What the user asked to pay the TEX address */
	amount: number
	status: TexStatus
	funding: TexFunding[]
	/** Final transaction (step 2 or shield-back), display order */
	finalTxid?: string
	error?: string
	createdAt: number
}

export interface TexState {
	nextIndex: number
	records: TexRecord[]
}

export function emptyTexState(): TexState {
	return { nextIndex: 0, records: [] }
}

/** Reserve the next ephemeral index. Persist the returned state before
 *  using the index so it can never be handed out twice. */
export function reserveEphemeral(
	state: TexState,
	params: { tex: string; amount: number; account: number; now: number },
): { state: TexState; record: TexRecord } {
	const used = state.records.filter(r => r.status !== "reserved").map(r => r.index)
	const lastUsed = used.length ? Math.max(...used) : -1
	if (state.nextIndex > lastUsed + EPHEMERAL_GAP_LIMIT) {
		throw new Error(
			`${EPHEMERAL_GAP_LIMIT} one-time addresses were reserved without being funded. ` +
			`Complete or return a pending TEX payment before starting another.`
		)
	}
	const record: TexRecord = {
		index: state.nextIndex,
		account: params.account,
		tex: params.tex,
		amount: params.amount,
		status: "reserved",
		funding: [],
		createdAt: params.now,
	}
	return { state: { nextIndex: state.nextIndex + 1, records: [...state.records, record] }, record }
}

export function updateTexRecord(state: TexState, index: number, patch: Partial<Omit<TexRecord, "index">>): TexState {
	if (!state.records.some(r => r.index === index)) throw new Error(`No TEX payment with one-time address #${index}`)
	return { ...state, records: state.records.map(r => (r.index === index ? { ...r, ...patch } : r)) }
}

/** Payments whose funds sit at a one-time address: the user can complete
 *  them (step 2) or shield the funds back. */
export function pendingTexRecords(state: TexState): TexRecord[] {
	return state.records.filter(r => r.status === "funded")
}

/** What step 2 pays the TEX address from the funded one-time outputs. */
export function texPayout(record: Pick<TexRecord, "funding">): { value: number; fee: number } {
	const total = record.funding.reduce((s, f) => s + f.value, 0)
	const fee = texStep2Fee(record.funding.length)
	if (total <= fee) throw new Error("One-time address holds less than the step-2 fee")
	return { value: total - fee, fee }
}

/** State is stored per wallet (Orchard address) as one JSON blob. */
export function texStateKey(walletKey: string): string {
	return `zcash_tex_v1:${walletKey}`
}

export function parseTexState(raw: string | null): TexState {
	if (!raw) return emptyTexState()
	const parsed = JSON.parse(raw)
	if (!Number.isInteger(parsed?.nextIndex) || !Array.isArray(parsed?.records)) {
		throw new Error("Stored TEX state is corrupt — refusing to reuse one-time addresses")
	}
	return parsed as TexState
}
