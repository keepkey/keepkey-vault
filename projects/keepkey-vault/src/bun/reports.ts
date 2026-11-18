/**
 * Report generator for KeepKey Vault v11.
 *
 * Always generates LOD 5 (maximum detail). Includes:
 *   1. Device Information (from device_snapshot DB)
 *   2. Portfolio Overview (from cached balances)
 *   3. Chain Balances Table
 *   4. Cached Pubkeys / XPUBs (from cached_pubkeys DB)
 *   5. Token Details (per-chain)
 *   6. BTC Detailed Report (from Pioneer server)
 *   7. Address Flow Analysis (computed from per-tx inputs/outputs, see report-btc-flow.ts)
 */

import type { ReportData, ReportSection, ChainBalance } from '../shared/types'
import { getLatestDeviceSnapshot, getCachedPubkeys, getSetting } from './db'
import { getPioneer } from './pioneer'
import { CHAINS } from '../shared/chains'
import { utxoDiscoveryKey } from './btc-backend/types'
import { getBtcBackend } from './btc-backend'
import { createReportFonts, reportText as sanitize } from './report-fonts'
import { embedBitcoinComLogo } from './report-branding'
import { buildFlowTx, withRunningBalance, flowTotals, describeOwnPath, type BtcFlowTx } from './report-btc-flow'

const BTC_NETWORK_ID = CHAINS.find(c => c.id === 'bitcoin')!.networkId

/** Section title prefixes — shared with tax-export.ts for reliable extraction. */
export const SECTION_TITLES = {
	TX_DETAILS: 'Transaction Details',
	TX_HISTORY: 'Transaction History',
} as const

/** Safely round a satoshi string/number to integer, guarding against values beyond Number.MAX_SAFE_INTEGER. */
function safeRoundSats(value: unknown): number {
	if (value === undefined || value === null) return 0
	const n = Number(value)
	if (!Number.isFinite(n)) return 0
	if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
		console.warn(`[Report] safeRoundSats: value ${value} exceeds MAX_SAFE_INTEGER, clamping`)
		return n > 0 ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER
	}
	return Math.round(n)
}

// ── Pioneer API Helpers (via SDK client) ─────────────────────────────

async function fetchPubkeyInfo(xpub: string, scriptType?: string): Promise<any> {
	const backend = getBtcBackend()
	if (backend.kind !== 'pioneer') {
		if (!backend.accountInfo) throw new Error(`${backend.kind} does not provide indexed account summaries`)
		return backend.accountInfo({ network: BTC_NETWORK_ID, xpub, scriptType })
	}
	const pioneer = await getPioneer()
	const resp = await pioneer.GetPubkeyInfo({ network: BTC_NETWORK_ID, xpub: utxoDiscoveryKey(xpub, scriptType) })
	const result = resp?.data || resp
	if (typeof result !== 'object' || result === null) {
		console.warn('[Report] fetchPubkeyInfo: unexpected response shape, returning empty object')
		return {}
	}
	return result
}

async function fetchTxHistory(xpub: string, caip: string, scriptType?: string): Promise<any[]> {
	const backend = getBtcBackend()
	if (backend.kind !== 'pioneer') {
		if (!backend.transactionHistory) throw new Error(`${backend.kind} does not provide indexed transaction history`)
		return backend.transactionHistory({ network: BTC_NETWORK_ID, xpub, scriptType })
	}
	const pioneer = await getPioneer()
	const discoveryKey = utxoDiscoveryKey(xpub, scriptType)

	// Pioneer's tx history is async: first call triggers a background worker and
	// returns { transactions: [], loading: true }. We poll up to 3 times (5s apart)
	// to wait for the worker to finish fetching from Blockbook.
	const MAX_RETRIES = 3
	const RETRY_DELAY = 5000

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const resp = await pioneer.GetTransactionHistory({ queries: [{ pubkey: discoveryKey, caip }] })
		const data = resp?.data || resp
		if (typeof data !== 'object' || data === null) {
			console.warn('[Report] fetchTxHistory: unexpected response shape:', typeof data)
			return []
		}

		const histories = data.histories || data?.data?.histories || []
		const hist = histories[0]
		const candidate = hist?.transactions
			|| data.transactions
			|| data?.data?.transactions
		const txs = Array.isArray(candidate) ? candidate : []

		// If we got transactions, return them
		if (txs.length > 0) {
			console.log(`[Report] fetchTxHistory: ${txs.length} txs for xpub=${xpub.substring(0, 20)}... (attempt ${attempt + 1})`)
			return txs
		}

		// If Pioneer says it's still loading, wait and retry
		const isLoading = hist?.loading || hist?.cached === false
		if (isLoading && attempt < MAX_RETRIES) {
			console.log(`[Report] fetchTxHistory: loading (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${RETRY_DELAY / 1000}s...`)
			await new Promise(r => setTimeout(r, RETRY_DELAY))
			continue
		}

		// Not loading, just no transactions
		console.warn(`[Report] fetchTxHistory: 0 transactions for xpub=${xpub.substring(0, 20)}... cached=${hist?.cached} loading=${hist?.loading}`)
		return txs
	}

	return []
}

async function fetchTxDetail(txid: string): Promise<any> {
	const backend = getBtcBackend()
	if (!backend.txDetail) throw new Error(`${backend.kind} does not provide transaction details`)
	return backend.txDetail({ network: BTC_NETWORK_ID, txid })
}

// ── Section Builders ─────────────────────────────────────────────────

function buildDeviceFeaturesSection(): ReportSection {
	const snapshot = getLatestDeviceSnapshot()
	if (!snapshot) {
		return { title: '1. Device Information', type: 'text', data: 'No device snapshot available.' }
	}

	let features: any = {}
	try { features = JSON.parse(snapshot.featuresJson) } catch {}

	const items: string[] = [
		`Label: ${snapshot.label || 'KeepKey'}`,
		`Firmware Version: ${snapshot.firmwareVer || 'Unknown'}`,
		`Device ID: ${snapshot.deviceId}`,
	]

	if (features.bootloaderHash) items.push(`Bootloader Hash: ${features.bootloaderHash}`)
	if (features.initialized !== undefined) items.push(`Initialized: ${features.initialized ? 'Yes' : 'No'}`)
	if (features.pinProtection !== undefined) items.push(`PIN Protection: ${features.pinProtection ? 'Enabled' : 'Disabled'}`)
	if (features.passphraseProtection !== undefined) items.push(`Passphrase Protection: ${features.passphraseProtection ? 'Enabled' : 'Disabled'}`)
	if (features.model) items.push(`Model: ${features.model}`)
	if (features.deviceId) items.push(`Hardware ID: ${features.deviceId}`)
	items.push(`Snapshot Date: ${new Date(snapshot.updatedAt).toISOString()}`)

	return { title: '1. Device Information', type: 'summary', data: items }
}

function buildPortfolioOverviewSection(balances: ChainBalance[]): ReportSection {
	const totalUsd = balances.reduce((s, b) => s + (b.balanceUsd || 0), 0)
	const totalTokens = balances.reduce((s, b) => s + (b.tokens?.length || 0), 0)
	return {
		title: '2. Portfolio Overview',
		type: 'summary',
		data: [
			`Total Chains: ${balances.length}`,
			`Total USD Value: $${totalUsd.toFixed(2)}`,
			`Total Tokens: ${totalTokens}`,
			`Generated: ${new Date().toISOString()}`,
		],
	}
}

function buildChainBalancesSection(balances: ChainBalance[]): ReportSection {
	const sorted = [...balances].sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0))
	return {
		title: '3. Chain Balances',
		type: 'table',
		data: {
			headers: ['Chain', 'Symbol', 'Balance', 'USD Value', 'Address', 'Tokens'],
			widths: ['15%', '10%', '20%', '15%', '30%', '10%'],
			rows: sorted.map(b => [
				b.chainId, b.symbol, b.balance,
				`$${(b.balanceUsd || 0).toFixed(2)}`,
				b.address, (b.tokens?.length || 0).toString(),
			]),
		},
	}
}

function buildCachedPubkeysSection(
	deviceId: string,
	btcXpubs?: Array<{ xpub: string; scriptType: string; path: number[] }>,
): ReportSection[] {
	const sections: ReportSection[] = []

	// BTC xpubs from BtcAccountManager (always have full xpub + scriptType)
	if (btcXpubs && btcXpubs.length > 0) {
		const scriptTypeMap: Record<string, string> = {
			'p2pkh': 'Legacy (P2PKH)', 'p2sh-p2wpkh': 'SegWit (P2SH-P2WPKH)', 'p2wpkh': 'Native SegWit (P2WPKH)', 'p2tr': 'Taproot (P2TR)',
		}
		sections.push({
			title: `4. BTC XPUBs (${btcXpubs.length})`,
			type: 'table',
			data: {
				headers: ['Script Type', 'Path', 'XPUB'],
				widths: ['20%', '20%', '60%'],
				rows: btcXpubs.map(x => [
					scriptTypeMap[x.scriptType] || x.scriptType,
					`m/${x.path.map((p, j) => j < 3 ? `${p & 0x7FFFFFFF}'` : String(p)).join('/')}`,
					x.xpub,
				]),
			},
		})
	}

	// Cached addresses from DB (all chains)
	const pubkeys = getCachedPubkeys(deviceId)
	if (pubkeys.length > 0) {
		// Group by chain
		const byChain = new Map<string, typeof pubkeys>()
		for (const pk of pubkeys) {
			const list = byChain.get(pk.chainId) || []
			list.push(pk)
			byChain.set(pk.chainId, list)
		}

		for (const [chainId, pks] of byChain) {
			sections.push({
				title: `Cached Addresses — ${chainId} (${pks.length})`,
				type: 'table',
				data: {
					headers: ['Path', 'Address'],
					widths: ['30%', '70%'],
					rows: pks.map(pk => [
						pk.path || 'N/A',
						pk.address || 'N/A',
					]),
				},
			})
		}
	}

	if (sections.length === 0) {
		return [{ title: '4. Cached Pubkeys / Addresses', type: 'text', data: 'No cached pubkeys or addresses found.' }]
	}

	return sections
}

function buildTokenDetailsSections(balances: ChainBalance[]): ReportSection[] {
	const sections: ReportSection[] = []
	let first = true
	for (const b of balances) {
		if (!b.tokens || b.tokens.length === 0) continue
		const sorted = [...b.tokens].sort((a, c) => (c.balanceUsd || 0) - (a.balanceUsd || 0))
		sections.push({
			title: first ? `5. Token Details — ${b.symbol} (${sorted.length})` : `Token Details — ${b.symbol} (${sorted.length})`,
			type: 'table',
			data: {
				headers: ['Symbol', 'Name', 'Balance', 'USD Value', 'Price', 'Contract'],
				widths: ['10%', '20%', '20%', '15%', '15%', '20%'],
				rows: sorted.map(t => [
					t.symbol, t.name, t.balance,
					`$${(t.balanceUsd || 0).toFixed(2)}`,
					`$${(t.priceUsd || 0).toFixed(4)}`,
					t.contractAddress || 'N/A',
				]),
			},
		})
		first = false
	}
	return sections
}

// ── BTC Report Builder (uses /utxo/pubkey-info + /tx/history) ────────

const BTC_CAIP = 'bip122:000000000019d6689c085ae165831e93/slip44:0'

interface BtcReportXpub {
	xpub: string
	scriptType: string
	label: string
	balance: number       // satoshis
	totalReceived: number // satoshis
	totalSent: number     // satoshis
	txCount: number
	usedAddresses: Array<{ name: string; path: string; transfers: number }>
}

async function buildBtcSections(
	btcXpubs: Array<{ xpub: string; scriptType: string; path: number[] }>,
	onProgress?: (msg: string, pct: number) => void,
	headline: string[] = [],
): Promise<ReportSection[]> {
	const sections: ReportSection[] = []

	// 1. Fetch pubkey info for each xpub
	onProgress?.('Fetching BTC xpub info...', 20)
	const xpubInfos: BtcReportXpub[] = []
	for (const x of btcXpubs) {
		if (!x.xpub) continue
		try {
			const info = await fetchPubkeyInfo(x.xpub, x.scriptType)
			const tokens = info.tokens || []
			const used = tokens.filter((t: any) => (t.transfers || 0) > 0)
			xpubInfos.push({
				xpub: x.xpub,
				scriptType: x.scriptType,
				label: x.path.length >= 3 ? `${x.scriptType} account ${x.path[2] & 0x7FFFFFFF}` : x.scriptType,
				balance: safeRoundSats(info.balance),
				totalReceived: safeRoundSats(info.totalReceived),
				totalSent: safeRoundSats(info.totalSent),
				txCount: info.txs || 0,
				usedAddresses: used.map((t: any) => ({
					name: t.name, path: t.path, transfers: t.transfers,
				})),
			})
			console.log(`[Report] PubkeyInfo ${x.scriptType}: balance=${info.balance} sats, txs=${info.txs}, used addrs=${used.length}`)
		} catch (e: any) {
			console.warn(`[Report] PubkeyInfo failed for ${x.scriptType}:`, e.message)
		}
	}

	// BTC Overview section
	const totalBalSats = xpubInfos.reduce((s, x) => s + x.balance, 0)
	const totalRecvSats = xpubInfos.reduce((s, x) => s + x.totalReceived, 0)
	const totalSentSats = xpubInfos.reduce((s, x) => s + x.totalSent, 0)
	const totalTxCount = xpubInfos.reduce((s, x) => s + x.txCount, 0)

	sections.push({
		title: '6. BTC Overview',
		type: 'summary',
		data: [
			`Total Balance: ${(totalBalSats / 1e8).toFixed(8)} BTC`,
			`Address Activity In (includes your own change): ${(totalRecvSats / 1e8).toFixed(8)} BTC`,
			`Address Activity Out (includes your own change): ${(totalSentSats / 1e8).toFixed(8)} BTC`,
			`Total Transactions: ${totalTxCount}`,
			`XPUBs Queried: ${xpubInfos.length}`,
		],
	})

	// XPUB summaries table
	if (xpubInfos.length > 0) {
		sections.push({
			title: 'XPUB Summaries',
			type: 'table',
			data: {
				headers: ['Account', 'XPUB', 'Balance (BTC)', 'Received', 'Sent', 'TXs', 'Addrs'],
				widths: ['12%', '38%', '12%', '12%', '12%', '7%', '7%'],
				rows: xpubInfos.map(x => [
					x.label,
					x.xpub,
					(x.balance / 1e8).toFixed(8),
					(x.totalReceived / 1e8).toFixed(8),
					(x.totalSent / 1e8).toFixed(8),
					x.txCount.toString(),
					x.usedAddresses.length.toString(),
				]),
			},
		})
	}

	// Used addresses per xpub — these are the wallet's own addresses for the flow analysis.
	const own = new Map<string, string>()
	for (const x of xpubInfos) {
		for (const a of x.usedAddresses) if (a.name && a.path) own.set(a.name, a.path)
		if (x.usedAddresses.length > 0) {
			sections.push({
				title: `${x.label} -- Used Addresses (${x.usedAddresses.length})`,
				type: 'table',
				data: {
					headers: ['Address', 'Path', 'Role', 'Transfers'],
					widths: ['42%', '22%', '26%', '10%'],
					rows: x.usedAddresses.map(a => [a.name, a.path, describeOwnPath(a.path), a.transfers.toString()]),
				},
			})
		}
	}

	// 2. Transaction ids (from history), then the full inputs/outputs of each.
	onProgress?.('Fetching BTC transaction history...', 40)
	const txids = new Set<string>()
	for (const x of btcXpubs) {
		if (!x.xpub) continue
		if (xpubInfos.find(i => i.xpub === x.xpub)?.txCount === 0) continue
		try {
			const txs = await fetchTxHistory(x.xpub, BTC_CAIP, x.scriptType)
			for (const tx of txs) if (tx?.txid) txids.add(String(tx.txid))
			console.log(`[Report] TxHistory ${x.scriptType}: ${txs.length} txs (${txids.size} unique total)`)
		} catch (e: any) {
			console.warn(`[Report] TxHistory failed for ${x.scriptType}:`, e.message)
		}
	}

	const ids = [...txids]
	const flows: BtcFlowTx[] = []
	const missing: string[] = []
	const detailSources = new Map<string, number>()
	for (let i = 0; i < ids.length; i += 5) { // ponytail: 5 lookups at a time; raise if large wallets are slow
		const batch = ids.slice(i, i + 5)
		const got = await Promise.allSettled(batch.map(fetchTxDetail))
		got.forEach((g, j) => {
			if (g.status === 'rejected') { missing.push(batch[j]); return }
			flows.push(buildFlowTx(g.value, own))
			const source = g.value.explorer?.provider === 'bitcoin.com' ? 'Bitcoin.com' : getBtcBackend().kind
			detailSources.set(source, (detailSources.get(source) || 0) + 1)
		})
		onProgress?.(`Loading transaction details ${Math.min(i + 5, ids.length)}/${ids.length}...`, 40 + Math.round(20 * Math.min(i + 5, ids.length) / ids.length))
	}
	if (missing.length) console.warn(`[Report] ${missing.length} tx details failed to load`)

	onProgress?.('Building transaction sections...', 60)
	if (ids.length === 0) {
		sections.push({ title: SECTION_TITLES.TX_HISTORY, type: 'text', data: 'No transactions found' })
		return sections
	}

	const sorted = withRunningBalance(flows)
	const t = flowTotals(sorted)
	const btc = (sats: number) => (sats / 1e8).toFixed(8)
	const signed = (sats: number) => `${sats > 0 ? '+' : sats < 0 ? '-' : ''}${btc(Math.abs(sats))}`
	const date = (ts: number) => ts ? new Date(ts * 1000).toISOString().replace('T', ' ').substring(0, 19) : 'Pending'
	const count = (dir: string) => sorted.filter(f => f.dir === dir).length
	const matches = missing.length === 0 && t.computedBalance === totalBalSats
	const partial = missing.length ? ' (incomplete)' : ''
	headline.push(
		`BTC In from others${partial}: ${btc(t.received)} BTC`,
		`BTC Out to others${partial}: ${btc(t.sent)} BTC`,
		`BTC Fees Paid${partial}: ${btc(t.fees)} BTC`,
		`BTC Balance: ${btc(totalBalSats)} BTC`,
	)

	sections.push({
		title: 'How to Read the Bitcoin Section',
		type: 'text',
		data: 'Amounts are what moved into or out of THIS wallet. One Bitcoin transaction often has several outputs. ' +
			'When someone pays you, their wallet usually sends its own leftover (change) back to itself in the same transaction. ' +
			'Those outputs are marked NOT YOURS below and are never counted as yours. When you send, your leftover comes back to one ' +
			'of your own change addresses (marked YOURS - change). The running balance column shows what the wallet held after each transaction.',
	})

	sections.push({
		title: 'BTC Money Flow',
		type: 'summary',
		data: [
			`Received from others: ${btc(t.received)} BTC (${count('received')} transactions)`,
			`Sent to others (including swaps): ${btc(t.sent)} BTC (${count('sent')} transactions)`,
			`Network fees you paid: ${btc(t.fees)} BTC`,
			`Moves between your own addresses: ${t.internal}`,
			`Balance from history (received - sent - fees): ${btc(t.computedBalance)} BTC`,
			`Balance reported by the blockchain indexer: ${btc(totalBalSats)} BTC - ${matches ? 'MATCHES' : `DOES NOT MATCH${missing.length ? ` (${missing.length} transactions could not be loaded)` : ''}`}`,
			`Highest balance ever held: ${btc(t.peak.sats)} BTC${t.peak.timestamp ? ` (${date(t.peak.timestamp)})` : ''}`,
			`Transaction detail sources: ${[...detailSources].map(([source, count]) => `${source} (${count})`).join(', ')}`,
		],
	})

	// Column order of TX_HISTORY and TX_DETAILS is read positionally by tax-export.ts — append only.
	sections.push({
		title: `${SECTION_TITLES.TX_HISTORY} (${sorted.length})`,
		type: 'table',
		data: {
			headers: ['#', 'Dir', 'TXID', 'Block', 'Date', 'Amount (BTC)', 'Fee (BTC)', 'Balance After', 'What Happened'],
			widths: ['4%', '7%', '17%', '6%', '12%', '10%', '9%', '10%', '25%'],
			rows: sorted.map((f, i) => [
				(i + 1).toString(), f.dir.toUpperCase(), f.txid, f.blockHeight.toString(), date(f.timestamp),
				btc(f.amount), f.dir === 'received' ? '-' : btc(f.fee), btc(f.balanceAfter), f.label,
			]),
		},
	})

	const list = (a: string[]) => a.length > 3 ? `${a.slice(0, 3).join(', ')} +${a.length - 3} more` : (a.join(', ') || 'N/A')
	sections.push({
		title: `${SECTION_TITLES.TX_DETAILS} (${sorted.length})`,
		type: 'table',
		data: {
			headers: ['TXID', 'Dir', 'Block', 'Date', 'Amount (BTC)', 'Fee (BTC)', 'From', 'To', 'What Happened'],
			widths: ['14%', '6%', '6%', '11%', '9%', '8%', '15%', '15%', '16%'],
			rows: sorted.map(f => [
				f.txid, f.dir.toUpperCase(), f.blockHeight.toString(), date(f.timestamp),
				btc(f.amount), f.dir === 'received' ? '-' : btc(f.fee), list(f.from), list(f.to), f.label,
			]),
		},
	})

	// Every input and output, flagged. Newest 50 — a long history would be hundreds of pages.
	const MAX_FLOWS = 50
	const shown = sorted.slice(-MAX_FLOWS).reverse()
	sections.push({
		title: `Transaction Flows - Inputs and Outputs (${shown.length}${sorted.length > MAX_FLOWS ? ` newest of ${sorted.length}` : ''})`,
		type: 'text',
		data: 'Each transaction below lists every input and output. YOURS = an address of this wallet. NOT YOURS = belongs to someone else and is not counted.',
	})
	for (const f of shown) {
		sections.push({
			title: `${date(f.timestamp)} | ${f.label} | ${signed(f.net)} BTC | tx ${f.txid.slice(0, 8)}`,
			type: 'table',
			data: {
				headers: ['In/Out', 'Address', 'Amount (BTC)', 'Whose'],
				widths: ['7%', '43%', '13%', '37%'],
				rows: f.rows.map(r => [r.side, r.address, r.address === 'OP_RETURN' ? '-' : btc(r.sats), r.whose]),
			},
		})
	}

	if (missing.length) {
		sections.push({
			title: `Transactions Not Loaded (${missing.length})`,
			type: 'table',
			data: { headers: ['TXID'], widths: ['100%'], rows: missing.map(id => [id]) },
		})
	}

	// 3. Address flow analysis
	onProgress?.('Computing address flow...', 70)
	sections.push(...buildAddressFlow(sorted))

	return sections
}

// ── Address Flow Analysis ────────────────────────────────────────────

function buildAddressFlow(flows: BtcFlowTx[]): ReportSection[] {
	const sentTo = new Map<string, { amount: number; count: number }>()
	const recvFrom = new Map<string, { amount: number; count: number }>()
	const add = (m: typeof sentTo, k: string, sats: number) => {
		const e = m.get(k) || { amount: 0, count: 0 }
		e.amount += sats; e.count++; m.set(k, e)
	}
	for (const f of flows) {
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

// ── Main Report Generator ────────────────────────────────────────────

export interface GenerateReportOptions {
	balances: ChainBalance[]
	btcXpubs?: Array<{ xpub: string; scriptType: string; path: number[] }>
	deviceId?: string
	deviceLabel?: string
	onProgress?: (message: string, percent: number) => void
}

export async function generateReport(opts: GenerateReportOptions): Promise<ReportData> {
	const { btcXpubs, deviceId, deviceLabel, onProgress } = opts
	// Clone balances to avoid mutating the caller's data
	const balances = opts.balances.map(b => ({ ...b }))
	// Pioneer client handles routing internally — no base URL needed
	const sections: ReportSection[] = []
	const now = new Date()

	onProgress?.('Starting report generation...', 5)

	// ── Pre-flight: Ensure BTC balance is in the balances array ──
	// The cached balances may have BTC at $0 because GetPortfolio (charts/portfolio)
	// doesn't return BTC data. Fetch it directly before building overview sections.
	let btcSectionsResult: ReportSection[] = []
	if (btcXpubs && btcXpubs.length > 0) {
		const btcEntry = balances.find(b => b.chainId === 'bitcoin' || b.symbol === 'BTC')
		const btcHasBalance = btcEntry && parseFloat(btcEntry.balance) > 0

		if (!btcHasBalance) {
			console.log('[reports] BTC missing/zero in cached balances — fetching from Pioneer directly')
			try {
				let totalSats = 0
				for (const x of btcXpubs) {
					if (!x.xpub) continue
					const info = await fetchPubkeyInfo(x.xpub, x.scriptType)
					totalSats += Math.round(Number(info.balance || 0))
				}
				if (totalSats > 0) {
					const btcBalance = totalSats / 1e8
					// Fetch BTC price via Pioneer client
					let btcUsd = 0
					try {
						const pioneer = await getPioneer()
						const priceResp = await pioneer.GetMarketInfo([BTC_CAIP])
						const priceData = priceResp?.data || priceResp
						const price = Array.isArray(priceData) ? priceData[0] : priceData?.data?.[0] || 0
						btcUsd = btcBalance * (typeof price === 'number' ? price : parseFloat(String(price)) || 0)
					} catch (e: any) {
						console.warn('[reports] BTC price fetch failed:', e.message)
					}

					// Inject or update BTC in balances array
					if (btcEntry) {
						btcEntry.balance = btcBalance.toFixed(8)
						btcEntry.balanceUsd = btcUsd
						console.log(`[reports] Updated BTC in balances: ${btcBalance.toFixed(8)} BTC, $${btcUsd.toFixed(2)}`)
					} else {
						balances.push({
							chainId: 'bitcoin', symbol: 'BTC',
							balance: btcBalance.toFixed(8),
							balanceUsd: btcUsd,
							address: btcXpubs[0]?.xpub || '',
						})
						console.log(`[reports] Injected BTC into balances: ${btcBalance.toFixed(8)} BTC, $${btcUsd.toFixed(2)}`)
					}
				}
			} catch (e: any) {
				console.warn('[reports] BTC balance pre-fetch failed:', e.message)
			}
		}
	}

	// 1. Device Information
	sections.push(buildDeviceFeaturesSection())

	// 2. Portfolio Overview (now includes corrected BTC balance; BTC in/out headline added below)
	const overview = buildPortfolioOverviewSection(balances) as { data: string[] }
	sections.push(overview as ReportSection)

	// 3. Chain Balances (now includes corrected BTC balance)
	sections.push(buildChainBalancesSection(balances))

	// 4. Cached Pubkeys & XPUBs
	if (deviceId) {
		sections.push(...buildCachedPubkeysSection(deviceId, btcXpubs))
	} else if (btcXpubs && btcXpubs.length > 0) {
		// No deviceId but have xpubs — still include them
		sections.push(...buildCachedPubkeysSection('unknown', btcXpubs))
	}

	// 5. Token Details
	sections.push(...buildTokenDetailsSections(balances))

	// 6 & 7. BTC Detailed Report + Address Flow (via /utxo/pubkey-info + /tx/history)
	console.log(`[reports] BTC section check: btcXpubs=${btcXpubs?.length ?? 0}`)
	if (btcXpubs && btcXpubs.length > 0) {
		try {
			const headline: string[] = []
			const btcSections = await buildBtcSections(btcXpubs, onProgress, headline)
			sections.push(...btcSections)
			overview.data.unshift(...headline) // first row of the page-1 dashboard
			onProgress?.('BTC report complete', 80)
		} catch (e: any) {
			console.warn('[reports] BTC report failed:', e.message)
			sections.push({
				title: '6. BTC Detailed Report',
				type: 'text',
				data: `Failed to fetch BTC data: ${e.message}. Cached balance data is included above.`,
			})
			onProgress?.('BTC report failed, using cached data', 80)
		}
	}

	onProgress?.('Finalizing report...', 90)

	console.log(`[reports] Report generated: ${sections.length} sections`)
	for (const s of sections) {
		const count = s.type === 'table' ? ` (${s.data?.rows?.length || 0} rows)` : ''
		console.log(`  - [${s.type}] ${s.title}${count}`)
	}

	return {
		title: `${deviceLabel || 'KeepKey'} Portfolio Report`,
		subtitle: `Full Wallet Analysis — ${balances.length} Chains`,
		generatedDate: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
		chain: 'all',
		sections,
	}
}

// ── CSV Export ────────────────────────────────────────────────────────

/** Escape a cell value for CSV: quote wrapping + formula injection prevention */
function csvCell(value: any): string {
	let s = String(value ?? '').replace(/"/g, '""')
	// Prevent formula injection: trim leading whitespace then prefix dangerous chars
	const trimmed = s.trimStart()
	if (/^[=+\-@\t\r\n]/.test(trimmed)) s = `'${s}`
	return `"${s}"`
}

export function reportToCsv(data: ReportData): string {
	const lines: string[] = []

	lines.push(csvCell(data.title))
	lines.push(csvCell(data.subtitle))
	lines.push(csvCell(`Generated: ${data.generatedDate}`))
	lines.push('')

	for (const section of data.sections) {
		lines.push(csvCell(section.title))

		switch (section.type) {
			case 'table': {
				const headers = section.data.headers || []
				const rows = section.data.rows || []
				lines.push(headers.map((h: string) => csvCell(h)).join(','))
				for (const row of rows) {
					lines.push(row.map((cell: any) => csvCell(cell)).join(','))
				}
				break
			}
			case 'summary':
			case 'list': {
				const items = Array.isArray(section.data) ? section.data : [section.data]
				for (const item of items) {
					lines.push(csvCell(item))
				}
				break
			}
			case 'text': {
				lines.push(csvCell(section.data))
				break
			}
		}

		lines.push('')
	}

	return lines.join('\n')
}

// ── PDF Export (pdf-lib — Bun-compatible) ────────────────────────────

const MARGIN_LEFT = 40
const MARGIN_RIGHT = 40
const MARGIN_TOP = 50
const MARGIN_BOTTOM = 50
const ROW_HEIGHT = 14
const SECTION_GAP = 20
const GOLD = { r: 1, g: 0.843, b: 0 }
const ALT_ROW = { r: 0.94, g: 0.94, b: 0.94 }
const TEXT_COLOR = { r: 0.2, g: 0.2, b: 0.2 }
const MUTED_COLOR = { r: 0.6, g: 0.6, b: 0.6 }

export async function reportToPdfBuffer(data: ReportData): Promise<Buffer> {
	const { PDFDocument, rgb, degrees } = await import('pdf-lib')
	const reportLocale = getSetting('number_locale') || 'en-US'
	// Stored values are always USD — use USD currency label with user's number locale for separators
	const reportCurrency = 'USD'

	console.log('[reports] Starting PDF generation...')

	const doc = await PDFDocument.create()
	const fonts = await createReportFonts(doc, JSON.stringify(data))
	const { regular: font, bold } = fonts
	const bitcoinComLogo = await embedBitcoinComLogo(doc)

	// Landscape Letter: 792 x 612
	const pageW = 792
	const pageH = 612
	const contentW = pageW - MARGIN_LEFT - MARGIN_RIGHT

	let page = doc.addPage([pageW, pageH])
	let pageNum = 1
	let y = pageH - MARGIN_TOP

	function newPage() {
		page = doc.addPage([pageW, pageH])
		pageNum++
		y = pageH - MARGIN_TOP
	}

	function needSpace(needed: number) {
		if (y - needed < MARGIN_BOTTOM) newPage()
	}

	/** Break text into lines that each fit within maxW pixels. */
	function wrapText(text: string, f: any, s: number, maxW: number): string[] {
		if (!text || !maxW || maxW <= 0) return [text || '']
		if (fonts.width(text, f, s) <= maxW) return [text]
		const lines: string[] = []
		let remaining = Array.from(text)
		while (remaining.length > 0) {
			let lo = 0, hi = remaining.length
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1
				if (fonts.width(remaining.slice(0, mid).join(''), f, s) <= maxW) lo = mid
				else hi = mid - 1
			}
			if (lo === 0) lo = 1 // at least one char per line
			lines.push(remaining.slice(0, lo).join(''))
			remaining = remaining.slice(lo)
		}
		return lines
	}

	function safeDrawText(text: string, x: number, yPos: number, f: any, s: number, c: { r: number; g: number; b: number }, maxW?: number) {
		let t = sanitize(text)
		if (maxW && maxW > 0 && t.length > 0 && fonts.width(t, f, s) > maxW) {
			// Truncate to fit — no ellipsis, no dots. Used for single-line contexts.
			const chars = Array.from(t)
			let lo = 0, hi = chars.length
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1
				if (fonts.width(chars.slice(0, mid).join(''), f, s) <= maxW) lo = mid
				else hi = mid - 1
			}
			t = chars.slice(0, lo).join('')
		}
		if (!t) return
		fonts.draw(page, t, { x, y: yPos, font: f, size: s, color: rgb(c.r, c.g, c.b) })
	}

	// ── Page 1: Dashboard + Pie Chart ────────────────────────────

	// Extract chain balance data for pie chart
	const balancesSection = data.sections.find(s => s.title?.includes('Chain Balances') && s.type === 'table')
	const overviewSection = data.sections.find(s => s.title?.includes('Portfolio Overview') && s.type === 'summary')

	// Parse chain balances for pie chart
	interface ChainSlice { symbol: string; usd: number; color: { r: number; g: number; b: number } }
	const slices: ChainSlice[] = []
	let totalPortfolioUsd = 0

	if (balancesSection?.data?.rows) {
		const PIE_COLORS = [
			{ r: 1.0, g: 0.843, b: 0.0 },   // Gold (BTC)
			{ r: 0.29, g: 0.33, b: 0.91 },   // Blue (ETH)
			{ r: 0.15, g: 0.78, b: 0.47 },   // Green
			{ r: 0.91, g: 0.30, b: 0.24 },   // Red
			{ r: 0.58, g: 0.29, b: 0.91 },   // Purple
			{ r: 0.95, g: 0.61, b: 0.07 },   // Orange
			{ r: 0.20, g: 0.71, b: 0.83 },   // Cyan
			{ r: 0.83, g: 0.21, b: 0.51 },   // Pink
			{ r: 0.44, g: 0.73, b: 0.27 },   // Lime
			{ r: 0.60, g: 0.60, b: 0.60 },   // Gray (Other)
		]
		// balancesSection rows: [Chain, Symbol, Balance, USD, Address, Tokens]
		for (const row of balancesSection.data.rows) {
			const usdStr = String(row[3] || '0').replace(/[$,]/g, '')
			const usd = parseFloat(usdStr) || 0
			if (usd > 0) {
				slices.push({ symbol: String(row[1] || '?'), usd, color: PIE_COLORS[Math.min(slices.length, PIE_COLORS.length - 1)] })
				totalPortfolioUsd += usd
			}
		}
	}

	// Title
	const title = sanitize(data.title)
	const titleW = fonts.width(title, bold, 22)
	safeDrawText(title, (pageW - titleW) / 2, y, bold, 22, { r: 0.15, g: 0.15, b: 0.15 })
	y -= 26

	const subtitle = sanitize(data.subtitle)
	const subW = fonts.width(subtitle, font, 13)
	safeDrawText(subtitle, (pageW - subW) / 2, y, font, 13, { r: 0.4, g: 0.4, b: 0.4 })
	y -= 18

	const dateStr = sanitize(`Generated on ${data.generatedDate}`)
	const dateW = fonts.width(dateStr, font, 10)
	safeDrawText(dateStr, (pageW - dateW) / 2, y, font, 10, MUTED_COLOR)
	y -= 30

	// Gold divider line
	page.drawRectangle({
		x: MARGIN_LEFT, y: y,
		width: contentW, height: 2,
		color: rgb(GOLD.r, GOLD.g, GOLD.b),
	})
	y -= 30

	// ── Total Portfolio Value (big number) ──
	const totalStr = new Intl.NumberFormat(reportLocale, { style: 'currency', currency: reportCurrency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(totalPortfolioUsd)
	const totalLabel = 'Total Portfolio Value'
	const totalLabelW = fonts.width(totalLabel, font, 11)
	const totalValW = fonts.width(totalStr, bold, 28)
	safeDrawText(totalLabel, (pageW - totalLabelW) / 2, y, font, 11, MUTED_COLOR)
	y -= 34
	safeDrawText(totalStr, (pageW - totalValW) / 2, y, bold, 28, { r: 0.15, g: 0.15, b: 0.15 })
	y -= 40

	// ── Layout: Pie chart (left), Legend (right) ──
	if (slices.length > 0) {
		const pieRadius = 110
		const pieCenterX = MARGIN_LEFT + pieRadius + 40
		const pieCenterY = y - pieRadius - 10
		const legendX = pieCenterX + pieRadius + 60

		// Draw pie chart using thick radial lines (optimized: ~4x fewer draw ops)
		let startAngle = -Math.PI / 2 // start from top
		for (const slice of slices) {
			const fraction = slice.usd / totalPortfolioUsd
			const sweepAngle = fraction * 2 * Math.PI
			// Use thicker lines with wider steps to reduce draw operations
			const fillSteps = Math.max(8, Math.ceil(sweepAngle / 0.04))
			const fillStep = sweepAngle / fillSteps
			for (let i = 0; i <= fillSteps; i++) {
				const a = startAngle + i * fillStep
				const ex = pieCenterX + pieRadius * Math.cos(a)
				const ey = pieCenterY + pieRadius * Math.sin(a)
				page.drawLine({
					start: { x: pieCenterX, y: pieCenterY },
					end: { x: ex, y: ey },
					thickness: 4,
					color: rgb(slice.color.r, slice.color.g, slice.color.b),
				})
			}
			startAngle += sweepAngle
		}

		// Draw white circle in center for donut effect (optimized: wider step)
		const innerR = pieRadius * 0.45
		for (let a = 0; a < Math.PI * 2; a += 0.03) {
			page.drawLine({
				start: { x: pieCenterX, y: pieCenterY },
				end: { x: pieCenterX + innerR * Math.cos(a), y: pieCenterY + innerR * Math.sin(a) },
				thickness: 4,
				color: rgb(1, 1, 1),
			})
		}

		// Center text in donut hole
		const chainCountStr = `${slices.length} Chains`
		const ccW = fonts.width(chainCountStr, bold, 12)
		safeDrawText(chainCountStr, pieCenterX - ccW / 2, pieCenterY - 4, bold, 12, { r: 0.3, g: 0.3, b: 0.3 })

		// ── Legend (right side) ──
		let legendY = y - 10
		safeDrawText('Asset Allocation', legendX, legendY, bold, 13, { r: 0.2, g: 0.2, b: 0.2 })
		legendY -= 24

		for (const slice of slices.slice(0, 12)) {
			const pct = ((slice.usd / totalPortfolioUsd) * 100).toFixed(1)
			const usdStr = new Intl.NumberFormat(reportLocale, { style: 'currency', currency: reportCurrency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(slice.usd)

			// Color swatch
			page.drawRectangle({
				x: legendX, y: legendY - 2,
				width: 12, height: 12,
				color: rgb(slice.color.r, slice.color.g, slice.color.b),
			})

			safeDrawText(slice.symbol, legendX + 18, legendY, bold, 10, { r: 0.2, g: 0.2, b: 0.2 })
			safeDrawText(`${pct}%`, legendX + 70, legendY, font, 10, MUTED_COLOR)
			safeDrawText(usdStr, legendX + 110, legendY, font, 10, TEXT_COLOR)
			legendY -= 18
		}

		if (slices.length > 12) {
			safeDrawText(`+ ${slices.length - 12} more chains`, legendX + 18, legendY, font, 9, MUTED_COLOR)
		}

		y = pieCenterY - pieRadius - 30
	}

	// ── Dashboard Summary Stats ──
	if (overviewSection && Array.isArray(overviewSection.data)) {
		// Overview items in rows of 4 (BTC in/out/fees/balance first when present)
		const items = overviewSection.data.filter((s: string) => typeof s === 'string')
		for (let r = 0; r < items.length; r += 4) {
			const row = items.slice(r, r + 4)
			needSpace(100)
			y -= 10
			page.drawRectangle({
				x: MARGIN_LEFT, y: y - 70,
				width: contentW, height: 70,
				color: rgb(0.96, 0.96, 0.96),
			})
			const colW = contentW / 4
			let statX = MARGIN_LEFT + 15
			for (const item of row) {
				const parts = String(item).split(':')
				const label = sanitize(parts[0]?.trim() || '')
				const value = sanitize(parts.slice(1).join(':').trim() || '')
				safeDrawText(label, statX, y - 22, font, 9, MUTED_COLOR)
				safeDrawText(value, statX, y - 40, bold, 13, { r: 0.15, g: 0.15, b: 0.15 })
				statX += colW
			}
			y -= 80
		}
		y -= 10
	}

	// ── Page 2+: Detail Sections ─────────────────────────────────
	newPage()

	// ── Sections ─────────────────────────────────────────────────
	for (const section of data.sections) {
		needSpace(ROW_HEIGHT * 3)
		safeDrawText(sanitize(section.title), MARGIN_LEFT, y, bold, 13, { r: 0.2, g: 0.2, b: 0.2 })
		y -= ROW_HEIGHT + 4

		switch (section.type) {
			case 'table': {
				const headers: string[] = section.data.headers || []
				const rows: string[][] = section.data.rows || []
				const widthPcts: string[] = section.data.widths || []
				if (headers.length === 0 || rows.length === 0) break

				const colWidths = widthPcts.map((w: string) => {
					const pct = parseFloat(w)
					return isNaN(pct) ? contentW / headers.length : (pct / 100) * contentW
				})
				while (colWidths.length < headers.length) colWidths.push(contentW / headers.length)

				// Gold header row
				needSpace(ROW_HEIGHT + 4)
				page.drawRectangle({
					x: MARGIN_LEFT - 2, y: y - 4,
					width: contentW + 4, height: ROW_HEIGHT + 2,
					color: rgb(GOLD.r, GOLD.g, GOLD.b),
				})
				let colX = MARGIN_LEFT
				for (let i = 0; i < headers.length; i++) {
					safeDrawText(headers[i], colX + 2, y, bold, 8, { r: 0, g: 0, b: 0 }, colWidths[i] - 4)
					colX += colWidths[i]
				}
				y -= ROW_HEIGHT + 2

				// Data rows — with text wrapping for cells that overflow
				const LINE_HEIGHT = 9 // line height within wrapped cells
				for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
					const row = rows[rowIdx]
					// Pre-calculate wrapped lines for each cell to determine row height
					const cellLines: string[][] = []
					let maxLines = 1
					for (let i = 0; i < row.length && i < headers.length; i++) {
						const cellText = sanitize(String(row[i] ?? ''))
						const lines = wrapText(cellText, font, 7, colWidths[i] - 4)
						cellLines.push(lines)
						if (lines.length > maxLines) maxLines = lines.length
					}
					const rowH = Math.max(ROW_HEIGHT, maxLines * LINE_HEIGHT + 4)
					needSpace(rowH)
					if (rowIdx % 2 === 0) {
						page.drawRectangle({
							x: MARGIN_LEFT - 2, y: y - (rowH - ROW_HEIGHT) - 4,
							width: contentW + 4, height: rowH,
							color: rgb(ALT_ROW.r, ALT_ROW.g, ALT_ROW.b),
						})
					}
					colX = MARGIN_LEFT
					for (let i = 0; i < cellLines.length; i++) {
						let lineY = y
						for (const line of cellLines[i]) {
							safeDrawText(line, colX + 2, lineY, font, 7, TEXT_COLOR)
							lineY -= LINE_HEIGHT
						}
						colX += colWidths[i]
					}
					y -= rowH
				}
				y -= 6
				break
			}

			case 'summary':
			case 'list': {
				const items: string[] = Array.isArray(section.data) ? section.data : [section.data]
				for (const item of items) {
					needSpace(ROW_HEIGHT)
					safeDrawText('- ' + sanitize(String(item)), MARGIN_LEFT + 10, y, font, 9, TEXT_COLOR)
					y -= ROW_HEIGHT
				}
				y -= 4
				break
			}

			case 'text': {
				const fullText = sanitize(String(section.data))
				const words = fullText.split(' ')
				let line = ''
				for (const word of words) {
					const test = line ? `${line} ${word}` : word
					if (fonts.width(test, font, 9) > contentW - 20) {
						needSpace(ROW_HEIGHT)
						safeDrawText(line, MARGIN_LEFT + 10, y, font, 9, TEXT_COLOR)
						y -= ROW_HEIGHT
						line = word
					} else {
						line = test
					}
				}
				if (line) {
					needSpace(ROW_HEIGHT)
					safeDrawText(line, MARGIN_LEFT + 10, y, font, 9, TEXT_COLOR)
					y -= ROW_HEIGHT
				}
				y -= 4
				break
			}
		}

		y -= SECTION_GAP / 2
	}

	// Draw every footer once, after pagination is complete.
	for (const [index, reportPage] of doc.getPages().entries()) {
		reportPage.drawImage(bitcoinComLogo, { x: MARGIN_LEFT, y: 18, width: 96, height: 96 * bitcoinComLogo.height / bitcoinComLogo.width })
		reportPage.drawText('Bitcoin transaction data', { x: MARGIN_LEFT + 108, y: 25, font, size: 8, color: rgb(MUTED_COLOR.r, MUTED_COLOR.g, MUTED_COLOR.b) })
		reportPage.drawText(`Page ${index + 1}`, {
			x: pageW / 2 - 20, y: 25,
			font, size: 9, color: rgb(MUTED_COLOR.r, MUTED_COLOR.g, MUTED_COLOR.b),
		})
	}

	const bytes = await doc.save()
	console.log(`[reports] PDF generated: ${bytes.length} bytes, ${pageNum} pages`)
	return Buffer.from(bytes)
}
