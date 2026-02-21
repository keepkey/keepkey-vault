/**
 * Parse cryptocurrency QR URI schemes into structured data.
 *
 * Supports:
 * - BIP-21:  bitcoin:bc1q...?amount=0.001&label=...
 * - EIP-681: ethereum:0x...@1?value=1000000000000000
 * - Cosmos:  cosmos:cosmos1...?memo=hello
 * - XRP:     ripple:rN7... or xrp:rN7...?dt=12345
 * - Plain addresses (no scheme) pass through as-is
 */

export interface QrParseResult {
	address: string
	amount?: string
	memo?: string
}

const SCHEME_MAP: Record<string, true> = {
	bitcoin: true,
	ethereum: true,
	cosmos: true,
	osmosis: true,
	thorchain: true,
	mayachain: true,
	bnb: true,
	ripple: true,
	xrp: true,
	litecoin: true,
	dogecoin: true,
	dash: true,
	bitcoincash: true,
}

export function parseQrValue(raw: string): QrParseResult {
	const trimmed = raw.trim()

	// Try URI scheme  "scheme:address?params"
	const colonIdx = trimmed.indexOf(":")
	if (colonIdx > 0) {
		const scheme = trimmed.slice(0, colonIdx).toLowerCase()
		if (SCHEME_MAP[scheme]) {
			return parseUri(trimmed.slice(colonIdx + 1))
		}
	}

	// EIP-681 style with pay- prefix:  "ethereum:pay-0x..."
	if (trimmed.toLowerCase().startsWith("ethereum:pay-")) {
		return parseUri(trimmed.slice("ethereum:pay-".length))
	}

	// Plain address — no scheme
	return { address: trimmed }
}

function parseUri(rest: string): QrParseResult {
	// Strip optional "//" prefix
	if (rest.startsWith("//")) rest = rest.slice(2)

	// Split address from query params
	const qIdx = rest.indexOf("?")
	let addressPart = qIdx >= 0 ? rest.slice(0, qIdx) : rest
	const queryStr = qIdx >= 0 ? rest.slice(qIdx + 1) : ""

	// EIP-681: address may have @chainId suffix — strip it
	const atIdx = addressPart.indexOf("@")
	if (atIdx > 0) addressPart = addressPart.slice(0, atIdx)

	const result: QrParseResult = { address: addressPart }

	if (!queryStr) return result

	const params = new URLSearchParams(queryStr)

	// BIP-21 amount
	const amount = params.get("amount")
	if (amount) result.amount = amount

	// EIP-681 value (in wei) → convert to ETH
	const value = params.get("value")
	if (value && !amount) {
		try {
			const wei = BigInt(value)
			const eth = Number(wei) / 1e18
			if (eth > 0) result.amount = eth.toString()
		} catch {
			// non-numeric value param — ignore
		}
	}

	// Memo / destination tag
	const memo = params.get("memo") || params.get("dt") || params.get("message") || params.get("tag")
	if (memo) result.memo = memo

	return result
}
