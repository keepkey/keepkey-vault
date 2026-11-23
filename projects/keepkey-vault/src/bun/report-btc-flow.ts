/**
 * Per-transaction Bitcoin money flow for reports. Pure — no network, no DB.
 *
 * Input: a Blockbook-shaped tx (vin/vout with addresses + values, as returned by
 * Pioneer LookupUtxoTx or Blockbook /api/v2/tx) and the wallet's own addresses
 * (address -> BIP32 path, from the xpub "used addresses" list).
 *
 * Output: every input/output marked YOURS or NOT YOURS, the net movement to the
 * wallet, and a plain-language label. Why this exists: a tx total counts every
 * output, including the sender's own change, so a 0.008 BTC payment from an
 * exchange once showed as a 1.58 BTC "receive". Only outputs to the wallet's own
 * addresses count.
 *
 * Shared transactions can contain inputs and outputs that belong to other
 * participants. The wallet's net change is known from its inputs and outputs.
 * Its payment and fee split require information outside the transaction.
 */

import type { ReportSection } from '../shared/types'

export type FlowDir = 'received' | 'sent' | 'internal'

export interface FlowRow {
	side: 'IN' | 'OUT'
	address: string
	sats: number
	whose: string
}

export interface BtcFlowTx {
	txid: string
	blockHeight: number
	timestamp: number
	/** The wallet fee when known. Shared transactions do not reveal the split. */
	fee: number | null
	dir: FlowDir
	label: string
	/** Signed change to the wallet balance, fee included (ownOut - ownIn). */
	net: number
	/** Amount moved, or the magnitude of the wallet net change for a shared transaction. */
	amount: number
	/** The wallet spent inputs alongside inputs it cannot identify as its own. */
	shared: boolean
	balanceAfter: number
	from: string[]
	to: string[]
	rows: FlowRow[]
}

export type SwapMemo =
	| { kind: 'swap'; asset: string; dest: string }
	| { kind: 'refund'; txid: string }
	| { kind: 'payout'; txid: string }

/** THORChain/Maya memo grammar: `=:ASSET:DEST:…` (also `s:`, `SWAP:`), `REFUND:<txid>`, `OUT:<txid>`. */
export function parseSwapMemo(memo: string): SwapMemo | null {
	const parts = memo.trim().split(':')
	const op = parts[0].toUpperCase()
	if ((op === '=' || op === 'S' || op === 'SWAP') && parts[1]) return { kind: 'swap', asset: parts[1], dest: parts[2] || '' }
	if (op === 'REFUND' && parts[1]) return { kind: 'refund', txid: parts[1].toLowerCase() }
	if (op === 'OUT' && parts[1]) return { kind: 'payout', txid: parts[1].toLowerCase() }
	return null
}

/** m/44'/0'/1'/1/2 -> "account 1, change #2". */
export function describeOwnPath(path: string): string {
	const m = path.match(/^m\/\d+'\/\d+'\/(\d+)'\/(\d+)\/(\d+)$/)
	if (!m) return path
	return `account ${m[1]}, ${m[2] === '1' ? 'change' : 'receive'} #${m[3]}`
}

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s)

function memoOf(row: any): string | null {
	const a = Array.isArray(row?.addresses) ? String(row.addresses[0] || '') : ''
	const m = a.match(/^OP_RETURN \((.*)\)$/)
	return m ? m[1] : null
}

export function buildFlowTx(tx: any, own: Map<string, string>): BtcFlowTx {
	const vin: any[] = Array.isArray(tx?.vin) ? tx.vin : []
	const vout: any[] = Array.isArray(tx?.vout) ? tx.vout : []
	const addr = (r: any) => (Array.isArray(r?.addresses) ? String(r.addresses[0] || '') : '') || '(unknown)'
	const sats = (r: any) => parseInt(r?.value, 10) || 0
	const isOwn = (r: any) => own.has(addr(r))

	const ownIn = vin.filter(isOwn).reduce((s, r) => s + sats(r), 0)
	const ownOut = vout.filter(isOwn).reduce((s, r) => s + sats(r), 0)
	const memo = vout.map(memoOf).find((m): m is string => m !== null) ?? null
	const swap = memo ? parseSwapMemo(memo) : null
	const payouts = vout.filter(r => !isOwn(r) && memoOf(r) === null)
	const txFee = parseInt(tx?.fees, 10) || 0
	const net = ownOut - ownIn
	const othersIn = ownIn > 0 && vin.some(r => !isOwn(r))
	const fee = othersIn ? null : txFee

	const dir: FlowDir = ownIn === 0 ? 'received'
		: payouts.length === 0 && !othersIn ? 'internal'
		: net < 0 ? 'sent' : 'received'

	let label = dir === 'received' ? 'Received' : dir === 'sent' ? 'Sent' : 'Moved between your own addresses (fee only)'
	if (swap?.kind === 'swap' && dir === 'sent') label = `Swap BTC -> ${swap.asset}${swap.dest ? ` (to ${short(swap.dest)})` : ''}`
	if (swap?.kind === 'refund' && dir === 'received') label = `Swap refund (for tx ${short(swap.txid)})`
	if (swap?.kind === 'payout' && dir === 'received') label = `Swap payout (for tx ${short(swap.txid)})`
	if (othersIn) label += ' - shared transaction, net change shown; fee share unavailable'

	const ownWhose = (r: any, side: 'IN' | 'OUT') => {
		const where = describeOwnPath(own.get(addr(r))!)
		if (side === 'OUT' && dir === 'sent') return `YOURS - change back to you (${where})`
		return `YOURS (${where})`
	}
	const otherWhose = (side: 'IN' | 'OUT') => {
		// Shared tx: another person's input, and outputs to others that may carry it back.
		if (othersIn) return side === 'IN' ? "NOT YOURS - another participant's input"
			: dir === 'received' ? "NOT YOURS - another participant's output"
			: "Paid out - may include another participant's own funds"
		if (side === 'IN') return swap?.kind === 'refund' || swap?.kind === 'payout' ? 'Swap vault (payer)' : 'Sender'
		if (dir === 'received') return "NOT YOURS - sender's change or another payee"
		return swap?.kind === 'swap' ? 'Paid to swap vault' : 'Paid to'
	}

	const rows: FlowRow[] = [
		...vin.map((r): FlowRow => ({ side: 'IN', address: addr(r), sats: sats(r), whose: isOwn(r) ? ownWhose(r, 'IN') : otherWhose('IN') })),
		...vout.map((r): FlowRow => {
			const m = memoOf(r)
			if (m !== null) return { side: 'OUT', address: 'OP_RETURN', sats: 0, whose: `Memo: ${m}` }
			return { side: 'OUT', address: addr(r), sats: sats(r), whose: isOwn(r) ? ownWhose(r, 'OUT') : otherWhose('OUT') }
		}),
	]

	const ownIns = vin.filter(isOwn).map(addr)
	const ownOuts = vout.filter(isOwn).map(addr)
	return {
		txid: String(tx?.txid || ''),
		blockHeight: Number(tx?.blockHeight) || 0,
		timestamp: Number(tx?.blockTime) || 0,
		fee,
		dir,
		label,
		net,
		amount: othersIn ? Math.abs(net) : dir === 'received' ? net : dir === 'sent' ? -net - txFee : 0,
		shared: othersIn,
		balanceAfter: 0,
		from: dir === 'received' ? vin.filter(r => !isOwn(r)).map(addr) : ownIns,
		to: dir === 'sent' ? payouts.map(addr) : ownOuts,
		rows,
	}
}

/** Oldest first, with the wallet balance after each tx. Unconfirmed (height 0) sort last. */
export function withRunningBalance(txs: BtcFlowTx[]): BtcFlowTx[] {
	const key = (t: BtcFlowTx) => (t.blockHeight || Number.MAX_SAFE_INTEGER)
	const sorted = [...txs].sort((a, b) => key(a) - key(b) || a.timestamp - b.timestamp)
	let bal = 0
	for (const t of sorted) { bal += t.net; t.balanceAfter = bal }
	return sorted
}

export interface FlowTotals {
	received: number
	sent: number
	fees: number
	sharedNet: number
	internal: number
	computedBalance: number
	peak: { sats: number; timestamp: number }
}

/** Keep ambiguous shared flows apart from the known payment and fee totals. */
export function flowTotals(sorted: BtcFlowTx[]): FlowTotals {
	const t: FlowTotals = { received: 0, sent: 0, fees: 0, sharedNet: 0, internal: 0, computedBalance: 0, peak: { sats: 0, timestamp: 0 } }
	for (const x of sorted) {
		if (x.shared) {
			t.sharedNet += x.net
		} else {
			if (x.dir === 'received') t.received += x.amount
			if (x.dir === 'sent') t.sent += x.amount
			if (x.dir === 'internal') t.internal++
			if (x.dir !== 'received') t.fees += x.fee ?? 0
		}
		if (x.balanceAfter > t.peak.sats) t.peak = { sats: x.balanceAfter, timestamp: x.timestamp }
	}
	t.computedBalance = sorted.at(-1)?.balanceAfter ?? 0
	return t
}

/** Section 7: who the wallet sent to and received from. */
export function buildAddressFlow(flows: BtcFlowTx[]): ReportSection[] {
	const sentTo = new Map<string, { amount: number; count: number }>()
	const recvFrom = new Map<string, { amount: number; count: number }>()
	const add = (m: typeof sentTo, k: string, sats: number) => {
		const e = m.get(k) || { amount: 0, count: 0 }
		e.amount += sats; e.count++; m.set(k, e)
	}
	for (const f of flows) {
		if (f.shared) continue
		if (f.dir === 'sent') for (const r of f.rows) if (r.side === 'OUT' && r.whose.startsWith('Paid to')) add(sentTo, r.address, r.sats)
		if (f.dir === 'received') add(recvFrom, [...new Set(f.from)].join(', ') || '(unknown)', f.amount)
	}
	const rank = (m: typeof sentTo) => [...m].sort((a, b) => b[1].amount - a[1].amount)
	const sum = (m: typeof sentTo) => [...m.values()].reduce((s, e) => s + e.amount, 0)
	const table = (title: string, m: typeof sentTo): ReportSection => ({
		title: `${title} (${m.size})`,
		type: 'table',
		data: {
			headers: ['#', 'Address', 'Amount (BTC)', 'TX Count'],
			widths: ['6%', '54%', '25%', '15%'],
			rows: rank(m).slice(0, 100).map(([a, e], i) => [(i + 1).toString(), a, (e.amount / 1e8).toFixed(8), e.count.toString()]),
		},
	})

	const sections: ReportSection[] = [{
		title: '7. Address Flow Analysis',
		type: 'summary',
		data: [
			`BTC Sent to: ${(sum(sentTo) / 1e8).toFixed(8)} BTC (${sentTo.size} unique addresses)`,
			`BTC Received from: ${(sum(recvFrom) / 1e8).toFixed(8)} BTC (${recvFrom.size} unique senders)`,
		],
	}]
	if (sentTo.size) sections.push(table('Sent To', sentTo))
	if (recvFrom.size) sections.push(table('Received From', recvFrom))
	return sections
}
