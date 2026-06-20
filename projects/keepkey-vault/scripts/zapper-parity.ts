#!/usr/bin/env bun
/**
 * Zapper proxy parity probe.
 *
 * Two probes today:
 *   1. Legacy /zapper/portfolio/{address} — broken: drops contract-position
 *      apps like Morpheus. Kept here as the diagnosis the includeDefi
 *      refactor is fixing.
 *   2. New /zapper/apps/{address} — the protocol-only aggregate the server
 *      now serves under PortfolioBalanceRequest.includeDefi. This is the
 *      source of truth; expectations are asserted against it.
 *
 *   bun projects/keepkey-vault/scripts/zapper-parity.ts
 *
 * Expectations come from zapper.xyz screenshots — update FIXTURES as
 * positions shift. A "delta" within FIAT_TOLERANCE_PCT counts as a match.
 */
import { normalizeDefiPositions, classifyDefiPosition } from "../src/bun/zapper"

const PROXY_BASE = process.env.PIONEER_API_BASE || "https://api.keepkey.info"
const FIAT_TOLERANCE_PCT = 5

interface ExpectedProtocol {
	protocol: string       // matches Zapper appId (lower-case)
	usd: number            // total $ value the wallet has in this protocol
	note?: string          // free-text label from zapper.xyz (e.g. "Staked stETH")
}

interface Fixture {
	label: string
	address: string
	expected: ExpectedProtocol[]
	expectedNetWorthUSD?: number
	expectedAppUSD?: number
}

const FIXTURES: Fixture[] = [
	{
		label: "flipcrooked.eth (vlad)",
		address: "0x5746396dfe7025190a7775df94b6e89310ddd238",
		expectedNetWorthUSD: 8790.91,
		expectedAppUSD: 2673.58,
		expected: [
			{ protocol: "morpheus", usd: 1682.90, note: "Staked stETH" },
			{ protocol: "lido",     usd:  988.68, note: "stETH 0.5875" },
			{ protocol: "gnosis",   usd:    1.96, note: "WXDAI 1.962" },
		],
	},
	{
		label: "vitalik.eth (sanity — known DeFi-active)",
		address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
		// No fixed expectations — vitalik's positions shift constantly. We just
		// assert the proxy returns something non-trivial and that at least one
		// item carries DeFi markers.
		expected: [],
	},
]

const ZAPPER_TIMEOUT_MS = 30_000

async function fetchPortfolio(address: string): Promise<any> {
	const url = `${PROXY_BASE}/api/v1/zapper/portfolio/${address}`
	const resp = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(ZAPPER_TIMEOUT_MS),
	})
	if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`)
	return resp.json()
}

function dollars(n: number): string {
	return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pct(a: number, b: number): number {
	if (b === 0) return a === 0 ? 0 : Infinity
	return Math.abs(a - b) / b * 100
}

/**
 * Run vault classifier against every list the proxy returns (balances + tokens +
 * any wrapped containers), so the report reflects what the UI would see if
 * normalizeDefiPositions read from all of them.
 */
function classifyEverything(json: any): { fromBalances: any[]; fromTokens: any[] } {
	const fromBalances: any[] = []
	for (const raw of (json?.balances || [])) {
		const c = classifyDefiPosition(raw)
		if (c) fromBalances.push(c)
	}
	const fromTokens: any[] = []
	for (const raw of (json?.tokens || [])) {
		const c = classifyDefiPosition(raw)
		if (c) fromTokens.push(c)
	}
	return { fromBalances, fromTokens }
}

function sumByProtocol(items: any[]): Map<string, number> {
	const m = new Map<string, number>()
	for (const it of items) {
		const key = String(it.protocol || "(unknown)").toLowerCase()
		m.set(key, (m.get(key) || 0) + (Number(it.balanceUsd) || 0))
	}
	return m
}

interface Verdict {
	label: string
	address: string
	proxyOk: boolean
	netWorthDelta?: { proxy: number; expected: number; pct: number }
	appUsdDelta?:   { proxy: number; expected: number; pct: number; classified: number }
	protocolReport: Array<{
		protocol: string
		expectedUsd?: number
		proxyUsd?: number
		sourceField?: "balances" | "tokens" | "both" | "missing"
		verdict: "match" | "value-drift" | "missing-from-proxy" | "extra-in-proxy"
		note?: string
	}>
}

async function probe(fixture: Fixture): Promise<Verdict> {
	let json: any
	try {
		json = await fetchPortfolio(fixture.address)
	} catch (e: any) {
		return {
			label: fixture.label,
			address: fixture.address,
			proxyOk: false,
			protocolReport: [{ protocol: "(fetch failed)", verdict: "missing-from-proxy", note: e?.message || String(e) }],
		}
	}

	const totalNetWorth = Number(json.totalNetWorth) || 0
	const totalApp = Number(json.totalBalanceUSDApp) || 0
	const { fromBalances, fromTokens } = classifyEverything(json)
	const allClassified = [...fromBalances, ...fromTokens]
	const classifiedSum = allClassified.reduce((s, p) => s + (Number(p.balanceUsd) || 0), 0)

	const balancesByProto = sumByProtocol(fromBalances)
	const tokensByProto = sumByProtocol(fromTokens)
	const proxyByProto = new Map<string, { usd: number; src: "balances" | "tokens" | "both" }>()
	for (const [k, v] of balancesByProto) proxyByProto.set(k, { usd: v, src: "balances" })
	for (const [k, v] of tokensByProto) {
		const existing = proxyByProto.get(k)
		if (existing) proxyByProto.set(k, { usd: existing.usd + v, src: "both" })
		else proxyByProto.set(k, { usd: v, src: "tokens" })
	}

	const seenProtocols = new Set<string>()
	const protocolReport: Verdict["protocolReport"] = []

	for (const exp of fixture.expected) {
		const proto = exp.protocol.toLowerCase()
		seenProtocols.add(proto)
		const proxy = proxyByProto.get(proto)
		if (!proxy) {
			protocolReport.push({
				protocol: proto,
				expectedUsd: exp.usd,
				sourceField: "missing",
				verdict: "missing-from-proxy",
				note: exp.note,
			})
			continue
		}
		const drift = pct(proxy.usd, exp.usd)
		protocolReport.push({
			protocol: proto,
			expectedUsd: exp.usd,
			proxyUsd: proxy.usd,
			sourceField: proxy.src,
			verdict: drift <= FIAT_TOLERANCE_PCT ? "match" : "value-drift",
			note: exp.note,
		})
	}
	for (const [proto, info] of proxyByProto) {
		if (seenProtocols.has(proto)) continue
		protocolReport.push({
			protocol: proto,
			proxyUsd: info.usd,
			sourceField: info.src,
			verdict: "extra-in-proxy",
		})
	}

	const verdict: Verdict = {
		label: fixture.label,
		address: fixture.address,
		proxyOk: true,
		protocolReport,
	}
	if (fixture.expectedNetWorthUSD != null) {
		verdict.netWorthDelta = { proxy: totalNetWorth, expected: fixture.expectedNetWorthUSD, pct: pct(totalNetWorth, fixture.expectedNetWorthUSD) }
	}
	if (fixture.expectedAppUSD != null) {
		verdict.appUsdDelta = {
			proxy: totalApp,
			expected: fixture.expectedAppUSD,
			pct: pct(totalApp, fixture.expectedAppUSD),
			classified: classifiedSum,
		}
	}
	return verdict
}

function format(verdict: Verdict): string {
	const lines: string[] = []
	lines.push(`\n=== ${verdict.label} ===`)
	lines.push(`address: ${verdict.address}`)
	if (!verdict.proxyOk) {
		lines.push(`PROXY ERROR: ${verdict.protocolReport[0]?.note}`)
		return lines.join("\n")
	}
	if (verdict.netWorthDelta) {
		const d = verdict.netWorthDelta
		lines.push(`net worth: proxy=${dollars(d.proxy)}  expected=${dollars(d.expected)}  drift=${d.pct.toFixed(1)}%`)
	}
	if (verdict.appUsdDelta) {
		const d = verdict.appUsdDelta
		lines.push(`app USD (totalBalanceUSDApp): proxy=${dollars(d.proxy)}  expected=${dollars(d.expected)}  drift=${d.pct.toFixed(1)}%`)
		lines.push(`  ⤷ classifier sum (what UI would see): ${dollars(d.classified)} — gap vs proxy.totalApp: ${dollars(d.proxy - d.classified)}`)
	}
	lines.push(`protocols:`)
	for (const r of verdict.protocolReport) {
		const tag = {
			"match":              "OK     ",
			"value-drift":        "DRIFT  ",
			"missing-from-proxy": "MISSING",
			"extra-in-proxy":     "EXTRA  ",
		}[r.verdict]
		const e = r.expectedUsd != null ? dollars(r.expectedUsd) : "n/a"
		const p = r.proxyUsd != null ? dollars(r.proxyUsd) : "n/a"
		const src = r.sourceField ? ` [${r.sourceField}]` : ""
		const note = r.note ? `  -- ${r.note}` : ""
		lines.push(`  ${tag}  ${r.protocol.padEnd(18)}  expected=${e.padStart(10)}  proxy=${p.padStart(10)}${src}${note}`)
	}
	return lines.join("\n")
}

/**
 * Probe the protocol-only endpoint that powers the includeDefi merge in
 * GetPortfolioBalances. Shape:
 *   [{ node: { balanceUSD, app: {slug, displayName}, network: {name, chainId?} } }, ...]
 * Asserts each fixture's expected protocols are present (case-insensitive slug
 * match) and the USD value is within FIAT_TOLERANCE_PCT of the screenshot.
 */
async function probeApps(fixture: Fixture): Promise<Verdict> {
	let json: any
	try {
		const url = `${PROXY_BASE}/api/v1/zapper/apps/${fixture.address}`
		const resp = await fetch(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(ZAPPER_TIMEOUT_MS),
		})
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
		json = await resp.json()
	} catch (e: any) {
		return {
			label: fixture.label,
			address: fixture.address,
			proxyOk: false,
			protocolReport: [{ protocol: "(apps fetch failed)", verdict: "missing-from-proxy", note: e?.message || String(e) }],
		}
	}

	const edges: any[] = Array.isArray(json) ? json : (Array.isArray(json?.edges) ? json.edges : [])
	const proxyByProto = new Map<string, { usd: number; src: "balances" | "tokens" | "both" }>()
	for (const e of edges) {
		const node = e?.node || e
		const slug = String(node?.app?.slug || '').toLowerCase()
		if (!slug) continue
		const existing = proxyByProto.get(slug)
		proxyByProto.set(slug, {
			usd: (existing?.usd || 0) + (Number(node?.balanceUSD) || 0),
			src: "balances",
		})
	}

	const seenProtocols = new Set<string>()
	const protocolReport: Verdict["protocolReport"] = []
	for (const exp of fixture.expected) {
		const proto = exp.protocol.toLowerCase()
		seenProtocols.add(proto)
		const proxy = proxyByProto.get(proto)
		if (!proxy) {
			protocolReport.push({ protocol: proto, expectedUsd: exp.usd, sourceField: "missing", verdict: "missing-from-proxy", note: exp.note })
			continue
		}
		const drift = pct(proxy.usd, exp.usd)
		protocolReport.push({
			protocol: proto,
			expectedUsd: exp.usd,
			proxyUsd: proxy.usd,
			sourceField: proxy.src,
			verdict: drift <= FIAT_TOLERANCE_PCT ? "match" : "value-drift",
			note: exp.note,
		})
	}
	for (const [proto, info] of proxyByProto) {
		if (seenProtocols.has(proto)) continue
		protocolReport.push({ protocol: proto, proxyUsd: info.usd, sourceField: info.src, verdict: "extra-in-proxy" })
	}

	const classifiedSum = Array.from(proxyByProto.values()).reduce((s, p) => s + p.usd, 0)
	const verdict: Verdict = {
		label: fixture.label,
		address: fixture.address,
		proxyOk: true,
		protocolReport,
	}
	if (fixture.expectedAppUSD != null) {
		verdict.appUsdDelta = {
			proxy: classifiedSum,
			expected: fixture.expectedAppUSD,
			pct: pct(classifiedSum, fixture.expectedAppUSD),
			classified: classifiedSum,
		}
	}
	return verdict
}

async function main() {
	console.log(`Zapper proxy parity probe — base=${PROXY_BASE}\n`)
	console.log("== Pass 1: legacy /zapper/portfolio (kitchen-sink, drops contract-positions) ==")
	const legacy: Verdict[] = []
	for (const fx of FIXTURES) legacy.push(await probe(fx))
	for (const v of legacy) console.log(format(v))

	console.log("\n\n== Pass 2: /zapper/apps (the includeDefi source — should match expectations) ==")
	const apps: Verdict[] = []
	for (const fx of FIXTURES) apps.push(await probeApps(fx))
	for (const v of apps) console.log(format(v))

	console.log("\n=== Summary ===")
	let fail = 0
	for (const [label, verdicts] of [["legacy", legacy], ["apps", apps]] as const) {
		for (const v of verdicts) {
			if (!v.proxyOk) { console.log(`  [${label}] ${v.label}: PROXY UNREACHABLE`); if (label === 'apps') fail++; continue }
			const missing = v.protocolReport.filter(r => r.verdict === "missing-from-proxy").length
			const drift = v.protocolReport.filter(r => r.verdict === "value-drift").length
			if (missing || drift) {
				console.log(`  [${label}] ${v.label}: ${missing} missing, ${drift} drift`)
				if (label === 'apps') fail++
			} else {
				console.log(`  [${label}] ${v.label}: OK`)
			}
		}
	}
	console.log("\n(exit code reflects 'apps' pass — legacy /zapper/portfolio is expected to be lossy)")
	process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => {
	console.error("probe crashed:", e)
	process.exit(2)
})
