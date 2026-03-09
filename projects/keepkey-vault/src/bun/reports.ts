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
 *   7. Address Flow Analysis (computed from BTC TX data)
 */

import type { ReportData, ReportSection, ChainBalance } from '../shared/types'
import { getLatestDeviceSnapshot, getCachedPubkeys } from './db'
import { getPioneerApiBase } from './pioneer'

const REPORT_TIMEOUT_MS = 60_000

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

function getPioneerQueryKey(): string {
	return process.env.PIONEER_API_KEY || `key:public-${Date.now()}`
}

function getPioneerBase(): string {
	return getPioneerApiBase()
}

// ── Pioneer API Helpers ──────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		return await fetch(url, { ...init, signal: controller.signal })
	} finally {
		clearTimeout(timer)
	}
}

async function fetchPubkeyInfo(baseUrl: string, xpub: string): Promise<any> {
	const resp = await fetchWithTimeout(
		`${baseUrl}/api/v1/utxo/pubkey-info/BTC/${xpub}`,
		{ method: 'GET', headers: { 'Authorization': getPioneerQueryKey() } },
		REPORT_TIMEOUT_MS,
	)
	if (!resp.ok) throw new Error(`PubkeyInfo ${resp.status}`)
	const json = await resp.json()
	const result = json.data || json
	if (typeof result !== 'object' || result === null) {
		console.warn('[Report] fetchPubkeyInfo: unexpected response shape, returning empty object')
		return {}
	}
	return result
}

async function fetchTxHistory(baseUrl: string, xpub: string, caip: string): Promise<any[]> {
	const resp = await fetchWithTimeout(
		`${baseUrl}/api/v1/tx/history`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': getPioneerQueryKey() },
			body: JSON.stringify({ queries: [{ pubkey: xpub, caip }] }),
		},
		REPORT_TIMEOUT_MS,
	)
	if (!resp.ok) throw new Error(`TxHistory ${resp.status}`)
	const json = await resp.json()
	if (typeof json !== 'object' || json === null) {
		console.warn('[Report] fetchTxHistory: unexpected response shape, returning empty array')
		return []
	}
	const histories = json.histories || json.data?.histories || []
	return histories[0]?.transactions || []
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
			'p2pkh': 'Legacy (P2PKH)', 'p2sh-p2wpkh': 'SegWit (P2SH-P2WPKH)', 'p2wpkh': 'Native SegWit (P2WPKH)',
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

interface BtcTx {
	txid: string
	direction: string  // 'sent' | 'received'
	blockHeight: number
	timestamp: number
	confirmations: number
	from: string[]
	to: string[]
	value: number      // satoshis
	fee: number        // satoshis
	status: string
}

async function buildBtcSections(
	baseUrl: string,
	btcXpubs: Array<{ xpub: string; scriptType: string; path: number[] }>,
	onProgress?: (msg: string, pct: number) => void,
): Promise<ReportSection[]> {
	const sections: ReportSection[] = []

	// 1. Fetch pubkey info for each xpub
	onProgress?.('Fetching BTC xpub info...', 20)
	const xpubInfos: BtcReportXpub[] = []
	for (const x of btcXpubs) {
		if (!x.xpub) continue
		try {
			const info = await fetchPubkeyInfo(baseUrl, x.xpub)
			const tokens = info.tokens || []
			const used = tokens.filter((t: any) => (t.transfers || 0) > 0)
			xpubInfos.push({
				xpub: x.xpub,
				scriptType: x.scriptType,
				label: `${x.scriptType}`,
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
			`Total Received: ${(totalRecvSats / 1e8).toFixed(8)} BTC`,
			`Total Sent: ${(totalSentSats / 1e8).toFixed(8)} BTC`,
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
				headers: ['Script Type', 'XPUB', 'Balance (BTC)', 'Received (BTC)', 'Sent (BTC)', 'TXs', 'Used Addrs'],
				widths: ['10%', '30%', '14%', '14%', '14%', '8%', '10%'],
				rows: xpubInfos.map(x => [
					x.scriptType,
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

	// Used addresses per xpub
	for (const x of xpubInfos) {
		if (x.usedAddresses.length > 0) {
			sections.push({
				title: `${x.label} -- Used Addresses (${x.usedAddresses.length})`,
				type: 'table',
				data: {
					headers: ['Address', 'Path', 'Transfers'],
					widths: ['50%', '30%', '20%'],
					rows: x.usedAddresses.map(a => [a.name, a.path, a.transfers.toString()]),
				},
			})
		}
	}

	// 2. Fetch transaction history
	onProgress?.('Fetching BTC transaction history...', 40)
	const allTxs: BtcTx[] = []
	const seenTxids = new Set<string>()

	for (const x of btcXpubs) {
		if (!x.xpub) continue
		try {
			const txs = await fetchTxHistory(baseUrl, x.xpub, BTC_CAIP)
			for (const tx of txs) {
				if (!seenTxids.has(tx.txid)) {
					seenTxids.add(tx.txid)
					allTxs.push({
						txid: tx.txid,
						direction: tx.direction || 'unknown',
						blockHeight: tx.blockHeight || 0,
						timestamp: tx.timestamp || 0,
						confirmations: tx.confirmations || 0,
						from: tx.from || [],
						to: tx.to || [],
						value: Math.round(Number(tx.value || 0)),
						fee: Math.round(Number(tx.fee || 0)),
						status: tx.status || 'confirmed',
					})
				}
			}
			console.log(`[Report] TxHistory ${x.scriptType}: ${txs.length} txs (${allTxs.length} unique total)`)
		} catch (e: any) {
			console.warn(`[Report] TxHistory failed for ${x.scriptType}:`, e.message)
		}
	}

	// Sort newest first
	allTxs.sort((a, b) => b.blockHeight - a.blockHeight)

	onProgress?.('Building transaction sections...', 60)

	// Transaction History table
	if (allTxs.length > 0) {
		const rows = allTxs.map((tx, idx) => {
			const date = tx.timestamp
				? new Date(tx.timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19)
				: 'Pending'
			return [
				(idx + 1).toString(),
				tx.direction.toUpperCase(),
				tx.txid,
				tx.blockHeight.toString(),
				date,
				(tx.value / 1e8).toFixed(8),
				(tx.fee / 1e8).toFixed(8),
			]
		})

		sections.push({
			title: `${SECTION_TITLES.TX_HISTORY} (${allTxs.length})`,
			type: 'table',
			data: {
				headers: ['#', 'Dir', 'TXID', 'Block', 'Date', 'Value (BTC)', 'Fee (BTC)'],
				widths: ['5%', '8%', '17%', '10%', '20%', '20%', '20%'],
				rows,
			},
		})

		// Transaction Statistics
		const blocks = allTxs.map(t => t.blockHeight).filter(b => b > 0)
		const totalValueIn = allTxs.filter(t => t.direction === 'received').reduce((s, t) => s + t.value, 0)
		const totalValueOut = allTxs.filter(t => t.direction === 'sent').reduce((s, t) => s + t.value, 0)
		const totalFees = allTxs.reduce((s, t) => s + t.fee, 0)

		sections.push({
			title: 'Transaction Statistics',
			type: 'summary',
			data: [
				`Total Transactions: ${allTxs.length}`,
				`Received: ${allTxs.filter(t => t.direction === 'received').length} txs (${(totalValueIn / 1e8).toFixed(8)} BTC)`,
				`Sent: ${allTxs.filter(t => t.direction === 'sent').length} txs (${(totalValueOut / 1e8).toFixed(8)} BTC)`,
				`Total Fees Paid: ${(totalFees / 1e8).toFixed(8)} BTC`,
				blocks.length > 0 ? `Block Range: ${Math.min(...blocks)} - ${Math.max(...blocks)}` : '',
			].filter(Boolean),
		})

		// Per-transaction details as a single table (capped at 50 rows)
		const MAX_TX_DETAILS = 50
		const detailTxs = allTxs.slice(0, MAX_TX_DETAILS)
		if (detailTxs.length > 0) {
			sections.push({
				title: `${SECTION_TITLES.TX_DETAILS} (${Math.min(allTxs.length, MAX_TX_DETAILS)}${allTxs.length > MAX_TX_DETAILS ? ` of ${allTxs.length}` : ''})`,
				type: 'table',
				data: {
					headers: ['TXID', 'Dir', 'Block', 'Date', 'Value (BTC)', 'Fee (BTC)', 'From', 'To'],
					widths: ['14%', '6%', '8%', '14%', '12%', '10%', '18%', '18%'],
					rows: detailTxs.map(tx => {
						const date = tx.timestamp
							? new Date(tx.timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19)
							: 'Pending'
						return [
							tx.txid,
							tx.direction.toUpperCase(),
							tx.blockHeight.toString(),
							date,
							(tx.value / 1e8).toFixed(8),
							(tx.fee / 1e8).toFixed(8),
							tx.from.slice(0, 3).join(', ') || 'N/A',
							tx.to.slice(0, 3).join(', ') || 'N/A',
						]
					}),
				},
			})
		}

		if (allTxs.length > MAX_TX_DETAILS) {
			sections.push({ title: 'Note', type: 'text', data: `Showing ${MAX_TX_DETAILS} of ${allTxs.length} transactions.` })
		}
	} else {
		sections.push({ title: SECTION_TITLES.TX_HISTORY, type: 'text', data: 'No transactions found' })
	}

	// 3. Address flow analysis from tx data
	onProgress?.('Computing address flow...', 70)
	sections.push(...buildAddressFlowFromTxs(allTxs))

	return sections
}

// ── Address Flow Analysis ────────────────────────────────────────────

function buildAddressFlowFromTxs(txs: BtcTx[]): ReportSection[] {
	const sections: ReportSection[] = []

	// Collect unique external addresses we sent to / received from
	const sentToMap = new Map<string, { amount: number; count: number }>()
	const recvFromMap = new Map<string, { amount: number; count: number }>()

	for (const tx of txs) {
		if (tx.direction === 'sent') {
			for (const addr of tx.to) {
				const e = sentToMap.get(addr) || { amount: 0, count: 0 }
				e.amount += tx.value
				e.count += 1
				sentToMap.set(addr, e)
			}
		} else if (tx.direction === 'received') {
			for (const addr of tx.from) {
				const e = recvFromMap.get(addr) || { amount: 0, count: 0 }
				e.amount += tx.value
				e.count += 1
				recvFromMap.set(addr, e)
			}
		}
	}

	const sentTo = Array.from(sentToMap.entries())
		.map(([addr, d]) => ({ address: addr, amount: d.amount, count: d.count }))
		.sort((a, b) => b.amount - a.amount)

	const recvFrom = Array.from(recvFromMap.entries())
		.map(([addr, d]) => ({ address: addr, amount: d.amount, count: d.count }))
		.sort((a, b) => b.amount - a.amount)

	const totalSent = sentTo.reduce((s, a) => s + a.amount, 0)
	const totalRecv = recvFrom.reduce((s, a) => s + a.amount, 0)

	sections.push({
		title: '7. Address Flow Analysis',
		type: 'summary',
		data: [
			`BTC Sent to: ${(totalSent / 1e8).toFixed(8)} BTC (${sentTo.length} unique addresses)`,
			`BTC Received from: ${(totalRecv / 1e8).toFixed(8)} BTC (${recvFrom.length} unique addresses)`,
		],
	})

	if (sentTo.length > 0) {
		sections.push({
			title: `Sent To (${sentTo.length})`,
			type: 'table',
			data: {
				headers: ['#', 'Address', 'Amount (BTC)', 'TX Count'],
				widths: ['6%', '54%', '25%', '15%'],
				rows: sentTo.slice(0, 100).map((a, i) => [
					(i + 1).toString(), a.address,
					(a.amount / 1e8).toFixed(8), a.count.toString(),
				]),
			},
		})
	}

	if (recvFrom.length > 0) {
		sections.push({
			title: `Received From (${recvFrom.length})`,
			type: 'table',
			data: {
				headers: ['#', 'Address', 'Amount (BTC)', 'TX Count'],
				widths: ['6%', '54%', '25%', '15%'],
				rows: recvFrom.slice(0, 100).map((a, i) => [
					(i + 1).toString(), a.address,
					(a.amount / 1e8).toFixed(8), a.count.toString(),
				]),
			},
		})
	}

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
	const baseUrl = getPioneerBase()
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
					const info = await fetchPubkeyInfo(baseUrl, x.xpub)
					totalSats += Math.round(Number(info.balance || 0))
				}
				if (totalSats > 0) {
					const btcBalance = totalSats / 1e8
					// Fetch BTC price from Pioneer market endpoint
					let btcUsd = 0
					try {
						const priceResp = await fetchWithTimeout(
							`${baseUrl}/api/v1/market/info`,
							{
								method: 'POST',
								headers: { 'Content-Type': 'application/json', 'Authorization': getPioneerQueryKey() },
								body: JSON.stringify([BTC_CAIP]),
							},
							10_000,
						)
						if (priceResp.ok) {
							const priceData = await priceResp.json()
							const price = priceData?.data?.[0] || priceData?.[0] || 0
							btcUsd = btcBalance * (typeof price === 'number' ? price : parseFloat(String(price)) || 0)
						}
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

	// 2. Portfolio Overview (now includes corrected BTC balance)
	sections.push(buildPortfolioOverviewSection(balances))

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
			const btcSections = await buildBtcSections(baseUrl, btcXpubs, onProgress)
			sections.push(...btcSections)
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

/**
 * Sanitize text for pdf-lib StandardFonts (WinAnsi encoding only).
 * Strips characters outside the printable ASCII + Latin-1 Supplement range.
 */
function sanitize(text: string): string {
	if (!text) return ''
	// Replace common unicode with ASCII equivalents, then strip anything outside WinAnsi
	return text
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\u2026/g, '...')
		.replace(/\u2014/g, '--')
		.replace(/\u2013/g, '-')
		.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

export async function reportToPdfBuffer(data: ReportData): Promise<Buffer> {
	const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib')

	console.log('[reports] Starting PDF generation...')

	const doc = await PDFDocument.create()
	const font = await doc.embedFont(StandardFonts.Helvetica)
	const bold = await doc.embedFont(StandardFonts.HelveticaBold)

	// Landscape Letter: 792 x 612
	const pageW = 792
	const pageH = 612
	const contentW = pageW - MARGIN_LEFT - MARGIN_RIGHT

	let page = doc.addPage([pageW, pageH])
	let pageNum = 1
	let y = pageH - MARGIN_TOP

	function newPage() {
		page.drawText(`Page ${pageNum}`, {
			x: pageW / 2 - 20, y: 25,
			font, size: 9, color: rgb(MUTED_COLOR.r, MUTED_COLOR.g, MUTED_COLOR.b),
		})
		page = doc.addPage([pageW, pageH])
		pageNum++
		y = pageH - MARGIN_TOP
	}

	function needSpace(needed: number) {
		if (y - needed < MARGIN_BOTTOM) newPage()
	}

	function safeDrawText(text: string, x: number, yPos: number, f: any, s: number, c: { r: number; g: number; b: number }, maxW?: number) {
		let t = sanitize(text)
		if (maxW && maxW > 0 && t.length > 0 && f.widthOfTextAtSize(t, s) > maxW) {
			// Binary search for the longest string that fits
			let lo = 0, hi = t.length
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1
				if (f.widthOfTextAtSize(t.slice(0, mid), s) <= maxW) lo = mid
				else hi = mid - 1
			}
			if (lo < t.length && lo > 2) {
				t = t.slice(0, lo - 2) + '..'
			} else if (lo < t.length) {
				t = t.slice(0, lo)
			}
		}
		if (!t) return
		try {
			page.drawText(t, { x, y: yPos, font: f, size: s, color: rgb(c.r, c.g, c.b) })
		} catch (e: any) {
			console.warn('[reports] PDF drawText failed for:', JSON.stringify(t.slice(0, 40)), e.message)
		}
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
	const titleW = bold.widthOfTextAtSize(title, 22)
	safeDrawText(title, (pageW - titleW) / 2, y, bold, 22, { r: 0.15, g: 0.15, b: 0.15 })
	y -= 26

	const subtitle = sanitize(data.subtitle)
	const subW = font.widthOfTextAtSize(subtitle, 13)
	safeDrawText(subtitle, (pageW - subW) / 2, y, font, 13, { r: 0.4, g: 0.4, b: 0.4 })
	y -= 18

	const dateStr = sanitize(`Generated on ${data.generatedDate}`)
	const dateW = font.widthOfTextAtSize(dateStr, 10)
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
	const totalStr = `$${totalPortfolioUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
	const totalLabel = 'Total Portfolio Value'
	const totalLabelW = font.widthOfTextAtSize(totalLabel, 11)
	const totalValW = bold.widthOfTextAtSize(totalStr, 28)
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
		const ccW = bold.widthOfTextAtSize(chainCountStr, 12)
		safeDrawText(chainCountStr, pieCenterX - ccW / 2, pieCenterY - 4, bold, 12, { r: 0.3, g: 0.3, b: 0.3 })

		// ── Legend (right side) ──
		let legendY = y - 10
		safeDrawText('Asset Allocation', legendX, legendY, bold, 13, { r: 0.2, g: 0.2, b: 0.2 })
		legendY -= 24

		for (const slice of slices.slice(0, 12)) {
			const pct = ((slice.usd / totalPortfolioUsd) * 100).toFixed(1)
			const usdStr = `$${slice.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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
			safeDrawText(`... and ${slices.length - 12} more`, legendX + 18, legendY, font, 9, MUTED_COLOR)
		}

		y = pieCenterY - pieRadius - 30
	}

	// ── Dashboard Summary Stats ──
	if (overviewSection && Array.isArray(overviewSection.data)) {
		needSpace(100)
		y -= 10
		page.drawRectangle({
			x: MARGIN_LEFT, y: y - 70,
			width: contentW, height: 70,
			color: rgb(0.96, 0.96, 0.96),
		})
		// Render overview items in a row
		const items = overviewSection.data.filter((s: string) => typeof s === 'string')
		const colW = contentW / Math.min(items.length, 4)
		let statX = MARGIN_LEFT + 15
		for (let i = 0; i < Math.min(items.length, 4); i++) {
			const parts = String(items[i]).split(':')
			const label = sanitize(parts[0]?.trim() || '')
			const value = sanitize(parts.slice(1).join(':').trim() || '')
			safeDrawText(label, statX, y - 22, font, 9, MUTED_COLOR)
			safeDrawText(value, statX, y - 40, bold, 13, { r: 0.15, g: 0.15, b: 0.15 })
			statX += colW
		}
		y -= 90
	}

	// Page 1 footer
	page.drawText(`Page ${pageNum}`, {
		x: pageW / 2 - 20, y: 25,
		font, size: 9, color: rgb(MUTED_COLOR.r, MUTED_COLOR.g, MUTED_COLOR.b),
	})

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

				// Data rows
				for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
					needSpace(ROW_HEIGHT)
					if (rowIdx % 2 === 0) {
						page.drawRectangle({
							x: MARGIN_LEFT - 2, y: y - 4,
							width: contentW + 4, height: ROW_HEIGHT,
							color: rgb(ALT_ROW.r, ALT_ROW.g, ALT_ROW.b),
						})
					}
					colX = MARGIN_LEFT
					const row = rows[rowIdx]
					for (let i = 0; i < row.length && i < headers.length; i++) {
						safeDrawText(String(row[i] ?? ''), colX + 2, y, font, 7, TEXT_COLOR, colWidths[i] - 4)
						colX += colWidths[i]
					}
					y -= ROW_HEIGHT
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
					if (font.widthOfTextAtSize(test, 9) > contentW - 20) {
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

	// Footer on last page
	page.drawText(`Page ${pageNum}`, {
		x: pageW / 2 - 20, y: 25,
		font, size: 9, color: rgb(MUTED_COLOR.r, MUTED_COLOR.g, MUTED_COLOR.b),
	})

	const bytes = await doc.save()
	console.log(`[reports] PDF generated: ${bytes.length} bytes, ${pageNum} pages`)
	return Buffer.from(bytes)
}
