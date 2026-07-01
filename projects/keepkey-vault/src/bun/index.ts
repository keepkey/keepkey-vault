// ── File logger ──────────────────────────────────────────────────────────
// NOTE: This logger captures runtime errors AFTER the module graph loads.
// It does NOT catch import-time crashes — static ESM imports (below) are
// resolved before module body execution. The real guard against missing
// modules is the build-time check in collect-externals.ts which fails hard
// if device-protocol/lib/messages_pb.js is absent. This logger is for
// diagnosing runtime issues (uncaught exceptions, startup hangs, etc.).
//
// CRITICAL: Writes are synchronous and fsync'd. The previous implementation
// used createWriteStream(...).write() which is buffered — when the process
// crashed in native code (libusb segfault, etc.) the last several log lines
// never reached disk, causing entire days of investigation to be misled by a
// log that "ended" several function calls before the actual death point.
// Synchronous appendFileSync + fsync makes the log a faithful record of
// what code executed, at the cost of a per-call sync. The throughput hit is
// negligible for our log volume (~10–100 lines/sec at peak boot).
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/**
 * hdwallet returns signature/pubkey fields as `Uint8Array | string`
 * depending on transport path. RPC clients want hex, so collapse the
 * union here. Used by the message-signing handlers; pre-existing
 * tx-signing handlers still inline the same pattern (left untouched).
 */
const bytesToHex = (v: Uint8Array | string): string =>
	v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v

const LOG_DIR = (process.platform === 'win32' ? process.env.LOCALAPPDATA : (process.env.HOME + "/Library/Application Support")) + "/com.keepkey.vault"
const LOG_FILE = LOG_DIR + "/vault-backend.log"
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}

// Synchronous append-per-call. appendFileSync opens, writes, and closes the
// file on every call — slower than a held fd, but immune to fd-state weirdness
// in worker contexts and easier to reason about. Throughput is fine for our
// log volume (~10–100 lines/sec at peak boot).
//
// NOTE: an earlier attempt used fs.openSync + held fd + fs.writeSync, but the
// bundled context silently null'd the fd (still investigating root cause —
// possibly a Bun bundler interaction with the destructured fs namespace) and
// every log call became a no-op. appendFileSync is the boring reliable path.
function _writeLogSync(line: string): void {
  try {
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // If write fails (disk full, etc.), don't crash the app — drop the line.
  }
}

const _ts = () => new Date().toISOString()
const _fmt = (...args: any[]) => args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')
const _origLog = console.log, _origWarn = console.warn, _origError = console.error
console.log = (...args: any[]) => { _writeLogSync(`[${_ts()}] ${_fmt(...args)}\n`); _origLog(...args) }
console.warn = (...args: any[]) => { _writeLogSync(`[${_ts()}] WARN: ${_fmt(...args)}\n`); _origWarn(...args) }
console.error = (...args: any[]) => { _writeLogSync(`[${_ts()}] ERR: ${_fmt(...args)}\n`); _origError(...args) }
_writeLogSync(`\n=== New session: ${_ts()} ===\n`)
console.log(`[Boot] Log file: ${LOG_FILE}`)

// ── Boot environment dump ────────────────────────────────────────────────
// Capture the launch context so post-mortem analysis can distinguish between
// shell-launched (terminal, has TTY), Explorer-launched (no TTY, parent =
// explorer.exe), installer-launched (parent = setup .tmp), and dev launches
// (parent = bun/node). The "dies at Merged manifest only when launched from
// Explorer" class of bug is invisible without this.
try {
  const stdinTty = !!(process.stdin && (process.stdin as any).isTTY)
  const stdoutTty = !!(process.stdout && (process.stdout as any).isTTY)
  const stderrTty = !!(process.stderr && (process.stderr as any).isTTY)
  console.log(`[Boot] platform=${process.platform} arch=${process.arch} pid=${process.pid} ppid=${(process as any).ppid ?? 'unknown'}`)
  console.log(`[Boot] cwd=${process.cwd()}`)
  console.log(`[Boot] argv=${JSON.stringify(process.argv)}`)
  console.log(`[Boot] stdio: stdin.isTTY=${stdinTty} stdout.isTTY=${stdoutTty} stderr.isTTY=${stderrTty}`)
  console.log(`[Boot] env: PATH.length=${(process.env.PATH || '').length} LANG=${process.env.LANG || ''} LC_ALL=${process.env.LC_ALL || ''}`)
  if (process.platform === 'win32') {
    console.log(`[Boot] win: USERNAME=${process.env.USERNAME || ''} SESSIONNAME=${process.env.SESSIONNAME || ''} APPDATA=${process.env.APPDATA || ''} LOCALAPPDATA=${process.env.LOCALAPPDATA || ''}`)
  }
} catch (err: any) {
  console.warn(`[Boot] Failed to dump boot environment: ${err?.message || err}`)
}

import Electrobun, { BrowserView, BrowserWindow, Updater, Utils, ApplicationMenu } from "electrobun/bun"
import pkg from "../../package.json"

// ── Global error handlers (MUST be first — prevents silent crashes) ──
// Register before any top-level-await-capable import can throw; early failures
// would otherwise die silently. The RPC forwarder is installed later (after
// defineRPC()) via sendFatal — until then, the UI only gets the console log.
type FatalSource = 'uncaught-exception' | 'unhandled-rejection'
let sendFatal: (source: FatalSource, err: unknown) => void = (source, err) => {
	const msg = (err as any)?.message ?? String(err)
	console.error(`[Vault] FATAL (${source}) [rpc not ready]: ${msg}`)
}
process.on('uncaughtException', (err) => {
	console.error('[Vault] UNCAUGHT EXCEPTION:', err)
	try { sendFatal('uncaught-exception', err) } catch {}
})
process.on('unhandledRejection', (reason) => {
	// Suppress noise from pioneer-client's internal 60s timer (customHttpClient) racing
	// against our withTimeout(45s). The promise is always handled — this is a Bun timing
	// artifact where the rejection registers before the .catch() propagates.
	const msg = (reason as any)?.message || String(reason)
	if (msg === 'Request timed out') return
	console.error('[Vault] UNHANDLED REJECTION:', reason)
	try { sendFatal('unhandled-rejection', reason) } catch {}
})

import { EngineController, withTimeout } from "./engine-controller"
import { runUsbDiagnostic as runUsbDiagnosticProbe } from "./windows-usb-probe"
import { startRestApi, clearFeaturesCache, setUiActive, uiHeartbeat, type RestApiCallbacks } from "./rest-api"
import { parseSolanaTx, SolanaTxParseError, solanaMessageSlice } from "./solana-tx"
import { AuthStore } from "./auth"
import { getPioneer, getPioneerApiBase, resetPioneer, DEFAULT_API_BASE, getQueryKey as getPioneerQueryKey } from "./pioneer"
import { fetchDefiPositions } from "./zapper"
import { loadSupportedChains } from "../shared/swap-support-matrix"
import { PioneerSocket } from "./pioneer-socket"
import { startEventStream, stopEventStream, type AddressEntry } from "./event-stream"
import { rebuildActivityHistory } from "./activity-history"
import { addSessionActivity, getSessionActivity, clearSessionActivity } from "./session-activity"
import { buildTx, broadcastTx } from "./txbuilder"
import { buildCosmosStakingTx, buildCosmosNameRegTx } from "./txbuilder/cosmos"
import { initializeOrchardFromDevice, scanOrchardNotes, getShieldedBalance, sendShielded, ensureFvkLoaded, displayOrchardAddressOnDevice } from "./txbuilder/zcash-shielded"
import { isSidecarReady, startSidecar, stopSidecar, wipeSidecarWalletDb, hasFvkLoaded, getCachedFvk, onScanProgress, getScanState, updateSyncedTo, beginZcashSend, endZcashSend, isZcashSendInFlight } from "./zcash-sidecar"
import { CHAINS, customChainToChainDef, isChainSupported, hiveRolePath } from "../shared/chains"
import { versionCompare } from "../shared/firmware-versions"
import type { ChainDef } from "../shared/chains"
import { BtcAccountManager } from "./btc-accounts"
import { EvmAddressManager, evmAddressPath } from "./evm-addresses"
import { shouldResetManagersOnReady, nextReadyDeviceId } from "../shared/device-switch"
import { isManagerSeedStale } from "../shared/seed-reconcile"
import { WalletConnectManager } from "./walletconnect"
import { initDb, factoryResetDb, getCustomTokens, addCustomToken as dbAddCustomToken, removeCustomToken as dbRemoveCustomToken, setCustomTokenIcon as dbSetCustomTokenIcon, getCustomChains, addCustomChainDb, removeCustomChainDb, getSetting, setSetting, setTokenVisibility as dbSetTokenVisibility, removeTokenVisibility as dbRemoveTokenVisibility, getAllTokenVisibility, insertApiLog, getApiLogs, clearApiLogs, setCachedBalances, getCachedBalances, updateCachedBalance, clearBalances, saveCachedPubkey, getLatestDeviceSnapshot, getCachedPubkeys, saveReport, getReportsList, getReportById, deleteReport, reportExists, getSwapHistory, getSwapHistoryStats, getSwapHistoryByTxid, getBip85Seeds, saveBip85Seed, deleteBip85Seed, clearCachedPubkeys, getRecentActivityFromLog, getPioneerServers, addPioneerServerDb, removePioneerServerDb, syncOwnAddressBook, recordOutbound, getAddressBookList, updateAddressBookEntry, deleteAddressBookEntry, getAddressBookHistory, getDeviceLabelMap, getBalancesForOwnSeed, addExternalEntry, matchAddressBook } from "./db"
import type { OwnAddressSeed } from "./db"
import { rectifyWallet, getLedgerSummary, getLedgerJournals } from "./ledger"
import { generateReport, reportToPdfBuffer, reportToCsv } from "./reports"
import { startAudit, startBtcScan, getAudit, getAuditBtcRaw, getAuditEntry, dismissAudit, markAuditsStale, type AuditDeps } from "./audit-engine"
import { chainSupportsDeepScan, chainSupportsLevelScan, chainLevelPath, deriveAddressParams, extractAddress, parseNativeScanResult, parseEvmScanResult, utxoAccountScriptPaths, explorerAddressUrl, pathToBip32 } from "./chain-scan"
import { extractTransactionsFromReport, toCoinTrackerCsv, toZenLedgerCsv } from "./tax-export"
import * as os from "os"
import * as path from "path"
import { EVM_RPC_URLS, getTokenMetadata, broadcastEvmTx } from "./evm-rpc"
import type { ChainBalance, TokenBalance, CustomToken, SigningRequestInfo, ApiLogEntry, PioneerChainInfo, EvmAddressSet, Bip85SeedMeta, StakingPosition, SwapAsset, AuditToken, DefiPosition } from "../shared/types"
import type { VaultRPCSchema } from "../shared/rpc-schema"

// L3 fix: withTimeout imported from engine-controller (was duplicated here)
const PIONEER_TIMEOUT_MS = 60_000
const PIONEER_PORTFOLIO_CHUNK_SIZE = 8
const PIONEER_PORTFOLIO_CHUNK_TIMEOUT_MS = 45_000
const PIONEER_PORTFOLIO_MAX_CONCURRENCY = 4
const PIONEER_PORTFOLIO_TOTAL_TIMEOUT_MS = 120_000

function getPioneerPortfolioErrorMessage(err: any): string {
	const fields = err?.response?.body?.fields || err?.responseError?.fields
	const extraContractsMessage = fields?.['body.extraContracts']?.message
	const responseMessage = err?.response?.body?.message || err?.responseError?.message
	const responseText = typeof err?.response?.text === 'string'
		? err.response.text
		: typeof err?.response?.data === 'string'
			? err.response.data
			: ''
	return extraContractsMessage || responseMessage || responseText || err?.message || String(err)
}

function isExtraContractsSchemaError(err: any): boolean {
	const msg = getPioneerPortfolioErrorMessage(err)
	const responseText = typeof err?.response?.text === 'string' ? err.response.text : ''
	const haystack = `${msg} ${responseText}`.toLowerCase()
	return haystack.includes('extracontracts') && (haystack.includes('excess property') || haystack.includes('not allowed'))
}

function chunkArray<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
	return chunks
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let nextIndex = 0
	const workerCount = Math.min(Math.max(1, concurrency), items.length)
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = nextIndex++
			if (index >= items.length) return
			results[index] = await fn(items[index], index)
		}
	})
	await Promise.all(workers)
	return results
}

interface PortfolioMeta {
	degraded: boolean
	degradedCount: number
	failures: Array<{ caip: string; reason: string }>
	staleChains: Array<{ caip: string; pubkey: string; ageMs: number; fetchedAtISO: string }>
}

// Server-side DeFi position shape from GetPortfolioBalances (includeDefi=true).
// Shape mirrors DefiPositionEntry in pioneer-server's balance.controller.ts.
interface ServerDefiPosition {
	pubkey: string
	protocol: string
	displayName: string
	network: string
	networkId: string
	balanceUsd: number
	icon?: string
	// Per-token amount/symbol/USD when the server reports it. Older servers may
	// only include {networkId, address, symbol}; balance/balanceUsd stay
	// undefined and the UI degrades to USD-only.
	tokens?: Array<{ networkId: string; address: string; symbol?: string; balance?: string | number; balanceUsd?: number }>
}

// Pioneer v1.3.115+ returns { balances, meta } where meta reports which chains
// served degraded (fresh fetch failed) or stale (>5min old cache) data. The old
// unwrap discarded meta entirely, so the vault could never explain a $0/stale row.
//
// v1.4+ also surfaces { defiPositions } when the request set includeDefi=true.
// We return null (not []) when the field is absent so callers can distinguish
// "DeFi wasn't requested" (and thus skip the merge step) from "no positions."
function unwrapPortfolioResponse(resp: any): {
	entries: any[];
	meta: PortfolioMeta | null;
	defiPositions: ServerDefiPosition[] | null;
} {
	const rawData = resp?.data?.data || resp?.data || {}
	const entries = rawData.balances || (Array.isArray(rawData) ? rawData : [])
	const meta: PortfolioMeta | null = rawData.meta ?? null
	const defiPositions: ServerDefiPosition[] | null = Array.isArray(rawData.defiPositions) ? rawData.defiPositions : null
	return { entries, meta, defiPositions }
}

// Native balance for a single derived address on ANY family, via the
// cross-family GetPortfolioBalances path (what the dashboard uses for every
// chain). Replaces the audit's former GetBalanceAddressByNetwork calls, which
// were EVM-only (route /evm/balance → ETH JSON-RPC) and 500'd for any non-EVM
// networkId (bip122/cosmos/ripple), so BTC/DOGE/XRP/Cosmos balances read 0.
async function auditNativeBalance(
  chain: { caip: string; id: string },
  address: string,
): Promise<{ native: string; hasBalance: boolean; balanceError: boolean }> {
  try {
    const pioneer = await getPioneer()
    const resp = await withTimeout(
      pioneer.GetPortfolioBalances({ pubkeys: [{ caip: chain.caip, pubkey: address }] }, { forceRefresh: true }),
      PIONEER_TIMEOUT_MS, `audit balance ${chain.id}`,
    )
    const { entries, meta } = unwrapPortfolioResponse(resp)
    const { native, hasBalance } = parseNativeScanResult(entries, chain.caip)
    // degraded + nothing found = unverified, not a confident zero (honesty rule).
    if (!hasBalance && meta?.degraded) return { native: '0', hasBalance: false, balanceError: true }
    return { native, hasBalance, balanceError: false }
  } catch (e: any) {
    console.warn(`[audit] balance ${chain.id} failed: ${e?.message}`)
    return { native: '0', hasBalance: false, balanceError: true }
  }
}

// Balance for one derived address, EVM-token-aware. EVM addresses are read via
// GetPortfolioBalances + parseEvmScanResult so a token-only account ($0 native
// but e.g. $500 USDC) is surfaced as FUNDED — not a false "empty". Non-EVM falls
// back to the native-only path. The single shared entry point for every audit
// address scan (levels, known-paths grid, custom-path search) so they can't
// disagree the way the native-only path silently dropped token-only EVM funds.
async function auditBalanceForAddress(
  chain: { caip: string; id: string; chainFamily?: string },
  address: string,
): Promise<{ native: string; hasBalance: boolean; balanceError: boolean; tokens?: AuditToken[] }> {
  if (chain.chainFamily !== 'evm') return await auditNativeBalance(chain, address)
  try {
    const pioneer = await getPioneer()
    // GetPortfolioBalances can return 200 with DEGRADED data — for a single-caip
    // query meta.degraded means THIS chain's fresh fetch failed, so an empty
    // result is "couldn't verify", NOT a clean $0 (honesty rule).
    const resp = await withTimeout(
      pioneer.GetPortfolioBalances({ pubkeys: [{ caip: chain.caip, pubkey: address }] }, { forceRefresh: true }),
      PIONEER_TIMEOUT_MS, `audit EVM balance ${chain.id}`,
    )
    const { entries, meta } = unwrapPortfolioResponse(resp)
    const parsed = parseEvmScanResult(entries)
    if (!parsed.hasBalance && meta?.degraded) return { native: '0', hasBalance: false, balanceError: true }
    return { native: parsed.native, hasBalance: parsed.hasBalance, balanceError: false, tokens: parsed.tokens.length ? parsed.tokens : undefined }
  } catch (e: any) {
    console.warn(`[audit] EVM balance ${chain.id} failed: ${e?.message}`)
    return { native: '0', hasBalance: false, balanceError: true }
  }
}

function mergeMetas(metas: PortfolioMeta[]): PortfolioMeta {
	return {
		degraded: metas.some(m => m.degraded),
		degradedCount: metas.reduce((n, m) => n + (m.degradedCount || 0), 0),
		failures: metas.flatMap(m => m.failures || []),
		staleChains: metas.flatMap(m => m.staleChains || []),
	}
}

// ── Desktop update — open keepkey.com "update your app" page ──
// In-app auto-update is unreliable on both platforms:
// - macOS: zig-zstd has different CLI flags than zstd, stock macOS has no zstd
// - Windows: in-app exe download + spawn had process lock issues
// Both platforms now open the keepkey.com update page, which serves the correct
// download for the user's OS/arch and explains how to update.
const GITHUB_REPO = 'keepkey/keepkey-vault'
const UPDATE_PAGE = 'https://keepkey.com/update'
// Cached version from pre-release GitHub check (Updater.updateInfo() doesn't have it)
let pendingUpdateVersion: string | null = null
let pioneerSocket: PioneerSocket | null = null
// True from the moment a device becomes ready until the background bulk history
// scan finishes. Exposed via getActivityScanState so the activity UI can show
// "Syncing…" when it mounts mid-scan instead of a false "no activity".
let activityScanRunning = false

function openUpdatePage() {
	// Target version the user should upgrade to (latest available).
	const target = pendingUpdateVersion || Updater.updateInfo()?.version
	// os: mac | windows | linux ; arch: arm64 | x64 — keepkey.com serves the right build.
	const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
	const params = new URLSearchParams({ os, arch: process.arch })
	if (target) params.set('version', target)
	if (appVersionCache) params.set('current', appVersionCache)
	const url = `${UPDATE_PAGE}?${params.toString()}`
	console.log(`[Update] Opening update page: ${url}`)
	// On Windows `&` is a cmd command separator; `start` would split the query string
	// into separate commands. Quote the URL so it stays a single argument.
	const cmd = process.platform === 'win32' ? ['cmd', '/c', 'start', '', `"${url}"`] : ['open', url]
	Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] })
}

// ── Pioneer chain discovery catalog (lazy-loaded, 30-min cache) ──────
const CATALOG_TTL = 30 * 60 * 1000 // 30 minutes
let chainCatalog: PioneerChainInfo[] = []
let catalogLoadedAt = 0
let catalogLoading: Promise<void> | null = null

/** Built-in EVM chainIds that should be excluded from discovery results */
const BUILTIN_EVM_CHAIN_IDS = new Set(
	CHAINS.filter(c => c.chainFamily === 'evm' && c.chainId).map(c => Number(c.chainId))
)

function parseRawEntry(entry: any): PioneerChainInfo | null {
	if (!entry.chainId?.startsWith('eip155:')) return null
	if (!entry.assetId?.endsWith('/slip44:60')) return null
	const numericId = parseInt(entry.chainId.replace('eip155:', ''), 10)
	if (isNaN(numericId) || numericId < 1) return null
	if (BUILTIN_EVM_CHAIN_IDS.has(numericId)) return null
	return {
		chainId: numericId,
		name: entry.name || `Chain ${numericId}`,
		symbol: entry.symbol || 'ETH',
		icon: entry.icon || '',
		explorer: entry.explorer || '',
		explorerAddressLink: entry.explorerAddressLink || '',
		explorerTxLink: entry.explorerTxLink || '',
		color: entry.color || '#627EEA',
		decimals: entry.decimals ?? 18,
		rpcUrl: entry.rpcUrl || '',
		rpcUrls: Array.isArray(entry.rpcUrls) ? entry.rpcUrls : [],
	}
}

// Queries to build a comprehensive EVM chain catalog.
// 'mainnet' catches most chains; the others fill in major chains whose names don't contain 'mainnet'.
const CATALOG_QUERIES = ['mainnet', 'ethereum', 'polygon', 'avalanche', 'arbitrum', 'optimism', 'base', 'fantom', 'gnosis', 'celo', 'cronos', 'bsc', 'linea', 'zksync', 'scroll', 'mantle', 'blast']

async function loadChainCatalog(): Promise<void> {
	if (chainCatalog.length > 0 && Date.now() - catalogLoadedAt < CATALOG_TTL) return
	if (catalogLoading) return catalogLoading
	catalogLoading = (async () => {
		try {
			const pioneer = await getPioneer()
			const results: PioneerChainInfo[] = []

			// Fetch all queries in parallel via Pioneer client
			const fetches = CATALOG_QUERIES.map(async (q) => {
				try {
					const resp = await pioneer.SearchAssets({ q, limit: 2000 })
					return resp?.data || resp || []
				} catch { return [] }
			})
			const batches = await Promise.all(fetches)

			const byChainId = new Map<number, PioneerChainInfo>()
			for (const raw of batches) {
				const entries = Array.isArray(raw) ? raw : []
				for (const entry of entries) {
					const parsed = parseRawEntry(entry)
					if (!parsed) continue
					const existing = byChainId.get(parsed.chainId)
					// Prefer entries that have richer metadata (explorer, rpcUrls)
					if (!existing || (!existing.explorer && parsed.explorer) || (!existing.rpcUrls?.length && parsed.rpcUrls?.length)) {
						byChainId.set(parsed.chainId, parsed)
					}
				}
			}
			results.push(...byChainId.values())

			results.sort((a, b) => a.chainId - b.chainId)
			chainCatalog = results
			catalogLoadedAt = Date.now()
			console.log(`[discovery] Loaded ${results.length} EVM chains into catalog (from ${CATALOG_QUERIES.length} queries)`)
		} catch (e: any) {
			console.warn('[discovery] Failed to load chain catalog:', e.message)
			// Keep stale data if we have it
		}
	})()
	try { await catalogLoading } finally { catalogLoading = null }
}

/** Browse chains: paginated, optionally filtered by query */
function browseChains(query: string, page: number, pageSize: number): { chains: PioneerChainInfo[]; total: number; page: number; pageSize: number } {
	let list = chainCatalog
	if (query.length >= 2) {
		const q = query.toLowerCase()
		list = chainCatalog.filter(c =>
			c.name.toLowerCase().includes(q) ||
			c.symbol.toLowerCase().includes(q) ||
			String(c.chainId).includes(q)
		)
	}
	const start = page * pageSize
	return {
		chains: list.slice(start, start + pageSize),
		total: list.length,
		page,
		pageSize,
	}
}

/** Fire-and-forget: cache a derived address for watch-only mode.
 *  PRIVACY: Never persist addresses from a passphrase wallet — doing so
 *  leaks the existence and contents of the hidden wallet to disk. */
function cacheAddress(chainId: string, path: string, address: string) {
	if (engine.isPassphraseWallet) return
	try {
		const deviceId = engine.getDeviceState().deviceId || 'unknown'
		saveCachedPubkey(deviceId, chainId, path, '', address, '')
	} catch { /* never block on cache failure */ }
}

const DEV_SERVER_PORT = 5177
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`
const REST_API_PORT = 1646

// ── Startup performance tracking ─────────────────────────────────────
const BOOT_START = Date.now()
const perf = (label: string) => console.log(`[PERF] +${Date.now() - BOOT_START}ms: ${label}`)

// ── Engine Controller (constructors are lightweight — no I/O) ────────
const engine = new EngineController()
const btcAccounts = new BtcAccountManager()
const evmAddresses = new EvmAddressManager()
// Last deviceId we saw reach 'ready'. The managers above are kept across
// disconnect for the watch-only UI, so a device-to-device swap (deviceId
// changes, but `seed-changed` can't fire — it keys on the per-device
// seed_eth_${id}) would otherwise reuse the previous device's xpubs/addresses.
// We reset on the edge where a *different* deviceId reaches 'ready'. Declared
// once here, at process-lifetime scope alongside the singletons it guards, and
// — unlike rest-api.ts:lastDeviceId — NEVER nulled on disconnect (a swap always
// passes through 'disconnected', so nulling there would skip the reset). See
// src/shared/device-switch.ts for the pure decision + invariants.
let lastReadyDeviceId: string | null = null

function attachSigningPolicySnapshot(info: SigningRequestInfo): SigningRequestInfo {
	const features = engine.getCachedFeaturesSnapshot()
	if (features) {
		const policies: any[] = features.policiesList || features.policies || []
		const advPol = policies.find((p: any) => (p.policyName || p.policy_name) === 'AdvancedMode')
		if (advPol) info.advancedModeEnabled = !!advPol.enabled
		if (!info.firmwareVersion && features.majorVersion) {
			info.firmwareVersion = `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
		}
	}
	if (!info.firmwareVersion) {
		info.firmwareVersion = engine.getDeviceState().firmwareVersion
	}
	return info
}

// Whether the device's AdvancedMode (blind-signing) policy is enabled, read
// from cached features. Returns undefined when unknown (no cached features /
// policy not reported) so callers can distinguish "off" from "can't tell".
function getAdvancedModeEnabled(): boolean | undefined {
	const features = engine.getCachedFeaturesSnapshot()
	if (!features) return undefined
	const policies: any[] = features.policiesList || features.policies || []
	const p = policies.find((x: any) => (x.policyName || x.policy_name) === 'AdvancedMode')
	return p ? !!p.enabled : undefined
}

// PRIVACY: Wire persistence gate — prevents hidden-wallet EVM indices
// from being read/written to disk during passphrase sessions.
evmAddresses.canPersist = () => !engine.isPassphraseWallet

// ── Deferred: DB + chains loaded AFTER window is created ─────────────
let customChainDefs: ChainDef[] = []
let dbReady = false

function deferredInit() {
	perf('deferredInit start')
	initDb()
	dbReady = true
	try {
		const stored = getCustomChains()
		customChainDefs = stored.map(customChainToChainDef)
		if (stored.length) console.log(`[Vault] Loaded ${stored.length} custom chains from DB`)
	} catch {}
	perf('db + chains loaded')

	// Settings + tracker init MUST run after initDb. Without this, tracker won't
	// rehydrate pending swaps from history on cold boot — they'd stall until
	// executeSwap lazy-init kicks in.
	loadSettings()
	loadSupportedChains(getPioneerApiBase()).catch(() => { /* static fallback handles it */ })
	import('./swap-tracker').then(async ({ initSwapTracker }) => {
		await initSwapTracker((msg: string, data: any) => {
			try {
				if (msg === 'swap-update') rpc.send['swap-update'](data)
				else if (msg === 'swap-complete') rpc.send['swap-complete'](data)
				else console.error(`[swap-tracker] Unknown message: ${msg}`)
			} catch (e: any) {
				console.warn(`[swap-tracker] Failed to send '${msg}':`, e.message)
			}
		}, { getDeviceId: () => getWalletDbScope()?.deviceId, getWalletId: () => getWalletDbScope()?.walletId })
	}).catch((e) => {
		console.error('[swap-tracker] Failed to initialize swap tracker (swaps will be unavailable):', e.message || e)
	})
}

/** All chains: built-in + user-added custom chains */
function getAllChains(): ChainDef[] {
	return [...CHAINS, ...customChainDefs]
}

/** Lookup RPC URL for a chain (custom chains from DB on miss, built-in chains from EVM_RPC_URLS) */
function getRpcUrl(chain: ChainDef): string | undefined {
	// Custom chains: query DB only for custom chain IDs (avoids per-call overhead for built-in chains)
	if (chain.id.startsWith('evm-custom-')) {
		const stored = getCustomChains().find(c => `evm-custom-${c.chainId}` === chain.id)
		if (stored) return stored.rpcUrl
	}
	// Built-in chains: lookup from EVM_RPC_URLS
	return chain.chainId ? EVM_RPC_URLS[chain.chainId] : undefined
}

// ── REST API Server (on by default, can be disabled in Settings) ───────
const auth = new AuthStore()
// Settings loaded lazily after DB init — defaults used until then
let restApiEnabled = false
let walletConnectEnabled = false
let bip85Enabled = false
let zcashPrivacyEnabled = false
let hiveEnabled = false
// True after the per-session incremental scan has caught the wallet up to
// chain tip. The `verified` field on `zcashShieldedStatus` reports this so
// API clients (and any future UI gating) get an honest answer about whether
// validation has actually completed.
let zcashVerifiedThisSession = false
// True while the background scan is in flight. Separate flag so concurrent
// status polls don't each kick their own scan, but the public `verified`
// field above doesn't lie about completion. Cleared after the scan resolves
// (whether successfully or not).
let zcashBackgroundVerifyInFlight = false
// True once the cached Orchard FVK has been PROVEN to belong to the connected
// device this session (its `ak` matches a fresh device derivation). The FVK
// store (~/.keepkey/zcash_wallet.db) carries no device identity, so without
// this a stale FVK from a previous device/seed/passphrase would show a phantom
// balance and produce an unspendable (wrong-signer) transaction. This is the
// hard gate for showing the shielded balance and for sending. Reset whenever
// the wallet identity could have changed (seed/device switch, FVK re-derive).
let zcashDeviceVerified = false
// Coalesces the sidecar purge (stop→wipe→start→init) so a forced spend-path
// re-derive and a background verify can't run two overlapping cycles (FIXB-02).
let zcashPurgeInFlight: Promise<void> | null = null
let emulatorEnabled = false
let preReleaseUpdates = false
let alphaFirmware = false
let privateModeEnabled = false

function loadSettings() {
	restApiEnabled = getSetting('rest_api_enabled') === '1'
	walletConnectEnabled = getSetting('walletconnect_enabled') === '1'
	bip85Enabled = getSetting('bip85_enabled') === '1'
	zcashPrivacyEnabled = getSetting('zcash_privacy_enabled') === '1'
	hiveEnabled = getSetting('hive_enabled') === '1'
	emulatorEnabled = getSetting('emulator_enabled') === '1'
	preReleaseUpdates = getSetting('pre_release_updates') === '1'
	alphaFirmware = getSetting('alpha_firmware') === '1'
	privateModeEnabled = getSetting('private_mode_enabled') === '1'

	// Normalize emulator flag on platforms with no emulator support. The
	// emulator runs on macOS (Keychain + libkkemu.dylib) and Windows (DPAPI +
	// libkkemu.dll); Linux has no key store wired up. A copied or migrated DB
	// carrying emulator_enabled=1 would otherwise re-expose a broken surface on
	// Linux with no in-app way to turn it back off. Do NOT reset on Windows —
	// that would wipe the flag set by a dropped .dll on every relaunch.
	if (emulatorEnabled && process.platform !== 'darwin' && process.platform !== 'win32') {
		console.warn(`[settings] Forcing emulator_enabled=0 on unsupported platform (${process.platform})`)
		emulatorEnabled = false
		setSetting('emulator_enabled', '0')
	}
}
let appVersionCache = ''
let restServer: ReturnType<typeof startRestApi> | null = null
// WalletConnect manager — lazily initialized when user pairs
let wcManager: WalletConnectManager | null = null

// SwapDialog UI state mirror — published fire-and-forget by the WebView on
// each meaningful state change so REST callers (and other Bun internals) can
// observe what the user sees. Cleared when the dialog closes.
let swapUiState: import('../shared/types').SwapUiState = {
	phase: 'closed',
	fromAsset: null,
	toAsset: null,
	amount: '',
	fiatAmount: '',
	inputMode: 'crypto',
	isMax: false,
	slippageBps: 100,
	fromAddress: '',
	toAddress: '',
	useCustomAddress: false,
	customToAddress: '',
	quote: null,
	previewBuild: null,
	error: null,
	txid: null,
	trackingStatus: null,
	confirmations: 0,
	outboundConfirmations: undefined,
	outboundRequiredConfirmations: undefined,
	outboundTxid: null,
	relayRequestId: null,
	refundReason: null,
}
let swapUiUpdatedAt = 0
export function getSwapUiState(): { state: import('../shared/types').SwapUiState; updatedAt: number } {
	return { state: swapUiState, updatedAt: swapUiUpdatedAt }
}
// Force the cached snapshot back to a clean 'closed' state. Called by REST
// `/api/v2/swap/close` so a stale 'submitted' snapshot from a prior failed
// swap doesn't survive into the next REST-driven session if no SwapDialog
// instance happens to be mounted (and therefore no unmount publishes 'closed').
export function resetSwapUiState(): void {
	swapUiState = {
		phase: 'closed',
		fromAsset: null, toAsset: null,
		amount: '', fiatAmount: '',
		inputMode: 'crypto', isMax: false, slippageBps: 100,
		fromAddress: '', toAddress: '',
		useCustomAddress: false, customToAddress: '',
		quote: null, previewBuild: null, error: null, txid: null,
		trackingStatus: null, confirmations: 0,
		outboundConfirmations: undefined, outboundRequiredConfirmations: undefined,
		outboundTxid: null, relayRequestId: null, refundReason: null,
	}
	swapUiUpdatedAt = Date.now()
}

// Refcounted setAlwaysOnTop. Multiple sources (WC pair approval, signing
// approval, device pairing approval) can independently want the window
// elevated; using the raw API per-event drops the window prematurely when
// any one source dismisses while another is still pending.
let _alwaysOnTopRefs = 0
function _emitWindowFocusChanged() {
	try { rpc.send['window-focus-changed']({ refs: _alwaysOnTopRefs, alwaysOnTop: _alwaysOnTopRefs > 0 }) } catch { /* webview not ready */ }
}
function acquireWindowFocus() {
	_alwaysOnTopRefs++
	if (_alwaysOnTopRefs === 1) {
		try { mainWindow.setAlwaysOnTop(true); mainWindow.focus() } catch { /* window not ready */ }
	}
	_emitWindowFocusChanged()
}
function releaseWindowFocus() {
	if (_alwaysOnTopRefs === 0) return // defensive: never go negative
	_alwaysOnTopRefs--
	if (_alwaysOnTopRefs === 0) {
		try { mainWindow.setAlwaysOnTop(false) } catch { /* ignore */ }
	}
	_emitWindowFocusChanged()
}
function getOrCreateWcManager(): WalletConnectManager {
	if (wcManager) return wcManager
	wcManager = new WalletConnectManager({
		getEvmAddressInfo: () => {
			const sel = evmAddresses.getSelectedAddress()
			return sel ? { address: sel.address, addressIndex: sel.addressIndex } : null
		},
		ensureEvmAddressInfo: async () => {
			if (!engine.wallet) return null
			if (!evmAddresses.isInitialized) {
				try { await evmAddresses.initialize(engine.wallet) }
				catch (e: any) { console.warn('[WC] EVM init failed:', e.message); return null }
			}
			const sel = evmAddresses.getSelectedAddress()
			return sel ? { address: sel.address, addressIndex: sel.addressIndex } : null
		},
		ethSignTx: (params) => { if (!engine.wallet) throw new Error('Device disconnected'); return engine.wallet.ethSignTx(params) },
		ethSignMessage: (params) => { if (!engine.wallet) throw new Error('Device disconnected'); return engine.wallet.ethSignMessage(params) },
		ethSignTypedData: (params) => { if (!engine.wallet) throw new Error('Device disconnected'); return engine.wallet.ethSignTypedData(params) },
		getCosmosAccountInfo: async (caipChain) => {
			if (!engine.wallet) return null
			// Only cosmoshub-4 supported in v1; THOR/Maya/Osmosis use the cosmos
			// namespace too but need different signers and bech32 prefixes — follow-up.
			if (caipChain !== 'cosmos:cosmoshub-4') return null
			const addressNList = [0x8000002C, 0x80000076, 0x80000000, 0, 0] // m/44'/118'/0'/0/0
			try {
				const addrResult = await engine.wallet.cosmosGetAddress({ addressNList, showDisplay: false })
				const address = typeof addrResult === 'string' ? addrResult : addrResult?.address
				if (!address) return null
				// Derive raw 33-byte compressed pubkey from BIP32 xpub via ethers HDNode.
				const pubkeys = await engine.wallet.getPublicKeys([{ addressNList, curve: 'secp256k1', coin: 'Atom' }])
				const xpub = pubkeys?.[0]?.xpub
				if (!xpub) return null
				const { ethers } = await import('ethers')
				const node = ethers.utils.HDNode.fromExtendedKey(xpub)
				const pubkeyHex = node.publicKey.replace(/^0x/, '')
				const pubkeyBase64 = Buffer.from(pubkeyHex, 'hex').toString('base64')
				return { address, pubkeyBase64, addressNList }
			} catch (e: any) {
				console.warn('[WC] getCosmosAccountInfo failed:', e.message)
				return null
			}
		},
		cosmosSignAmino: async ({ addressNList, signDoc }) => {
			if (!engine.wallet) throw new Error('Device disconnected')
			// Translate WC StdSignDoc → hdwallet CosmosSignTx.
			// StdSignDoc: { chain_id, account_number, sequence, fee, msgs, memo }
			// hdwallet:   { addressNList, tx: { msg, fee, signatures, memo }, chain_id, account_number, sequence }
			const result = await engine.wallet.cosmosSignTx({
				addressNList,
				tx: {
					msg: signDoc.msgs ?? [],
					fee: signDoc.fee,
					signatures: [],
					memo: signDoc.memo ?? '',
				},
				chain_id: signDoc.chain_id,
				account_number: String(signDoc.account_number ?? '0'),
				sequence: String(signDoc.sequence ?? '0'),
			})
			const sig = result?.signatures?.[0]
			if (!sig) throw new Error('Device returned no signature')
			// hdwallet may return hex; WC requires base64.
			const sigStripped = sig.startsWith('0x') ? sig.slice(2) : sig
			const signatureBase64 = /^[0-9a-f]+$/i.test(sigStripped)
				? Buffer.from(sigStripped, 'hex').toString('base64')
				: sigStripped
			return { signatureBase64 }
		},
		getSolanaAccountInfo: async (caipChain) => {
			if (!engine.wallet) return null
			if (caipChain !== 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') return null
			// Solana uses ed25519 with a 4-element fully hardened path m/44'/501'/0'/0'
			// (NOT extended to a 5th index — see rest-api.ts:2441).
			const addressNList = [0x8000002C, 0x800001F5, 0x80000000, 0x80000000]
			try {
				const r = await engine.wallet.solanaGetAddress({ addressNList, showDisplay: false })
				const address = typeof r === 'string' ? r : (r as any)?.address
				if (!address) return null
				return { address, addressNList }
			} catch (e: any) {
				console.warn('[WC] getSolanaAccountInfo failed:', e.message)
				return null
			}
		},
		solanaSignMessageRaw: async ({ addressNList, messageBase58 }) => {
			if (!engine.wallet) throw new Error('Device disconnected')
			const bs58 = (await import('bs58')).default
			const messageBytes = Buffer.from(bs58.decode(messageBase58))
			const result = await engine.wallet.solanaSignMessage({
				addressNList,
				message: messageBytes,
				showDisplay: true,
			})
			const sig = result?.signature
			if (!sig) throw new Error('Device returned no signature')
			const sigBytes = sig instanceof Uint8Array ? sig : Buffer.from(sig, 'base64')
			return { signatureBase64: Buffer.from(sigBytes).toString('base64') }
		},
		broadcastViaPioneer: async ({ networkId, serialized }) => {
			const pioneer = await getPioneer()
			const resp = await pioneer.Broadcast({ networkId, serialized })
			const data = resp?.data ?? resp
			const txid = data?.txid || data?.tx_hash || data?.hash
			if (!txid) throw new Error(`Broadcast failed: ${JSON.stringify(data).slice(0, 200)}`)
			return String(txid)
		},
		solanaSignTransactionRaw: async ({ addressNList, signerAddress, transactionBase64 }) => {
			if (!engine.wallet) throw new Error('Device disconnected')
			const { parseSolanaTx, solanaMessageSlice, parseSolanaMessage } = await import('./solana-tx')
			const bs58 = (await import('bs58')).default
			const fullTx = Buffer.from(transactionBase64, 'base64')
			const parsed = parseSolanaTx(fullTx)
			const messageBytes = solanaMessageSlice(fullTx, parsed)

			// Find which signer slot belongs to our account. Required signers are
			// the first `numRequiredSignatures` entries of `staticAccounts`. If our
			// pubkey isn't among them, this tx isn't ours to sign and writing to
			// any slot would produce an invalid signed transaction.
			const message = parseSolanaMessage(messageBytes)
			const ourPubkey = bs58.decode(signerAddress)
			if (ourPubkey.length !== 32) {
				throw new Error(`Invalid signer address: bs58-decoded length ${ourPubkey.length} (expected 32)`)
			}
			let signerIdx = -1
			for (let i = 0; i < message.header.numRequiredSignatures; i++) {
				const acct = message.staticAccounts[i]
				if (acct && acct.length === ourPubkey.length && Buffer.from(acct).equals(Buffer.from(ourPubkey))) {
					signerIdx = i
					break
				}
			}
			if (signerIdx < 0) {
				throw new Error(`Wallet account ${signerAddress} is not a required signer for this transaction`)
			}

			let sigBytes: Uint8Array
			if (parsed.isVersioned) {
				const msgRes = await engine.wallet.solanaSignMessage({ addressNList, message: messageBytes, showDisplay: true })
				const sig = msgRes?.signature
				if (!sig) throw new Error('Device returned no signature for v0 tx')
				sigBytes = sig instanceof Uint8Array ? sig : Buffer.from(sig, 'base64')
			} else {
				const result = await engine.wallet.solanaSignTx({
					addressNList,
					rawTx: Buffer.from(fullTx.subarray(parsed.messageStart)).toString('base64'),
				})
				if (!result?.signature) throw new Error('Device returned no signature for legacy tx')
				sigBytes = result.signature instanceof Uint8Array ? result.signature : Buffer.from(result.signature, 'base64')
			}
			if (sigBytes.length !== 64) throw new Error(`Unexpected signature length ${sigBytes.length}`)

			const slotOffset = parsed.sigStart + signerIdx * 64
			if (fullTx.length < slotOffset + 64) {
				throw new Error('Raw tx too short to hold our signer slot')
			}
			const out = Buffer.from(fullTx)
			for (let i = 0; i < 64; i++) out[slotOffset + i] = sigBytes[i]
			return {
				transactionBase64: out.toString('base64'),
				signatureBase64: Buffer.from(sigBytes).toString('base64'),
			}
		},
		requestSigningApproval: async (info) => {
			attachSigningPolicySnapshot(info)
			try { rpc.send['signing-request'](info) } catch { /* webview not ready */ }
			acquireWindowFocus()
			try {
				return await auth.requestSigningApproval(info.id)
			} finally {
				releaseWindowFocus()
			}
		},
		dismissSigning: (id) => {
			try { rpc.send['signing-dismissed']({ id }) } catch {}
		},
		log: (msg) => console.log(msg),
		onSessionsChanged: (sessions) => {
			try { rpc.send['wc-sessions'](sessions) } catch {}
		},
		onPairApprovalRequest: (info) => {
			try { rpc.send['wc-pair-request'](info) } catch {}
			acquireWindowFocus()
		},
		onPairApprovalDismiss: (id) => {
			try { rpc.send['wc-pair-dismiss']({ id }) } catch {}
			releaseWindowFocus()
		},
	})
	return wcManager
}

function getAppSettings() {
	const servers = getPioneerServers()
	const activeBase = getPioneerApiBase()
	// If the active URL matches a server in the list, use it; otherwise fall back to the first server
	const activePioneerServer = servers.find(s => s.url === activeBase)?.url || servers[0]?.url || activeBase
	return {
		restApiEnabled,
		pioneerApiBase: activeBase,
		pioneerServers: servers,
		activePioneerServer,
		fiatCurrency: getSetting('fiat_currency') || 'USD',
		numberLocale: getSetting('number_locale') || 'en-US',
		walletConnectEnabled,
		bip85Enabled,
		zcashPrivacyEnabled,
		hiveEnabled,
		emulatorEnabled,
		preReleaseUpdates,
		alphaFirmware,
		privateModeEnabled,
		passphraseIntroShown: getSetting('passphrase_intro_shown') === '1',
	}
}

/** Scope for wallet-scoped DB rows.
 *  INVARIANT: a non-null scope does NOT imply persistence is allowed. Hidden
 *  (passphrase) sessions also get an in-memory scope (sendPassphrase derives
 *  seedEthAddress RAM-only), so every consumer that WRITES to disk must ALSO
 *  gate on !engine.isPassphraseWallet. Scoped READS are safe as-is: a hidden
 *  walletId never has persisted rows (the write gates guarantee it), so
 *  wallet-scoped queries return empty rather than leaking standard-wallet data. */
function getWalletDbScope(): { deviceId: string; walletId: string } | null {
	const deviceId = engine.getDeviceState().deviceId
	if (!deviceId) return null
	const seedId = engine.currentSeedEthAddress?.toLowerCase()
	if (!seedId) return null
	return { deviceId, walletId: `${deviceId}:${seedId}` }
}

/** The seed identity (lowercased ETH idx0) under which the in-memory account
 *  managers' CURRENT data was derived. This is the staleness anchor that works
 *  even when only the BTC manager is initialized — BTC xpubs have no cheap
 *  identity to compare to the device, but the stamp records which seed they
 *  belong to, so a later consumer can detect a change. null = unknown (cold,
 *  or just reset); the next fresh init re-stamps it. */
let managersSeedOwner: string | null = null

/** Reset BOTH in-memory account managers and drop the seed stamp. Single choke
 *  point so every reset path (device swap, needs_passphrase, seed-changed, the
 *  staleness purge) keeps managersSeedOwner in lock-step with the managers. */
function resetSeedManagers(): void {
	btcAccounts.reset()
	evmAddresses.reset()
	managersSeedOwner = null
	// The Zcash sidecar's device-verified flag is per-wallet. A same-handle
	// passphrase / hidden-wallet toggle changes the active wallet WITHOUT firing
	// seed-changed, but DOES route through a resetSeedManagers() path (the
	// needs_passphrase handler and the result-based reconcile). Drop the sticky
	// flag here so the next balance / scan / send re-derives the device FVK and
	// fail-closes instead of bleeding the previous wallet's shielded balance
	// (FS-1). The lazy purge in ensureZcashDeviceMatch then rebuilds the sidecar
	// for the active wallet on first access.
	zcashDeviceVerified = false
	zcashVerifiedThisSession = false
}

/** Seed-staleness guard — the single authority for "do the in-memory account
 *  managers belong to the seed currently on the device?".
 *
 *  Staleness is detected two ways (either triggers a purge):
 *   1. STAMP: the seed the managers were derived under (managersSeedOwner)
 *      differs from `truth`. Works for ANY initialized manager — critically the
 *      BTC-only case, where getBtcAccounts can initialize BTC independently and
 *      there is no EVM index-0 to compare.
 *   2. EVM index-0 proof: evmAddressPath(0) IS the seed-identity path, so the
 *      EVM manager's index-0 address MUST equal `truth`. Direct, stamp-free
 *      proof (defense-in-depth; pinned by __tests__/seed-reconcile.test.ts).
 *
 *  A mismatch means the managers (and everything derived from them: displayed
 *  addresses, BTC xpubs, balances, and tx-build inputs) belong to a previous
 *  wallet — passphrase toggled, hidden→standard transition, reconnect with a
 *  cached passphrase — none of which reliably fire the event-based resets (see
 *  src/shared/seed-reconcile.ts for the full blind-spot inventory).
 *
 *  On purge: reset both managers (the next init re-derives from the device),
 *  push empty sets so the UI drops stale addresses immediately, wipe the
 *  deviceId-scoped DB cache, and tell the frontend to clear + force-refresh.
 *
 *  Never purges on uncertainty: truth==null or no initialized manager no-op. */
function reconcileSeedManagers(truth: string | null | undefined, source: string): boolean {
	if (!truth) return false
	const t = truth.toLowerCase()
	if (!evmAddresses.isInitialized && !btcAccounts.isInitialized) {
		// Nothing populated yet — the next init stamps. Drop any orphan stamp.
		managersSeedOwner = null
		return false
	}
	const evmIdx0 = evmAddresses.isInitialized ? (evmAddresses.getAddressByIndex(0)?.address ?? null) : null
	const stampStale = isManagerSeedStale(t, managersSeedOwner)
	const evmStale = isManagerSeedStale(t, evmIdx0)
	if (!stampStale && !evmStale) {
		// Fresh. Adopt the stamp if managers were initialized via a path that
		// didn't set one (keeps the BTC-only anchor populated).
		if (managersSeedOwner == null) managersSeedOwner = t
		return false
	}
	console.warn(`[Vault] STALE WALLET PURGE (${source}): owner=${managersSeedOwner} evmIdx0=${evmIdx0} device=${t} — resetting account managers`)
	resetSeedManagers()
	try { rpc.send['btc-accounts-update'](btcAccounts.toAccountSet()) } catch { /* webview not ready */ }
	try { rpc.send['evm-addresses-update'](evmAddresses.toAddressSet()) } catch { /* webview not ready */ }
	// A fetch that ran with the stale managers may have persisted the WRONG
	// wallet's pubkeys/balances under this deviceId — wipe so the next fetch
	// rebuilds. Run this UNCONDITIONALLY (not gated on !isPassphraseWallet):
	// clearing only REMOVES rows — it never writes hidden-wallet data to disk —
	// so it's privacy-safe even mid-passphrase-probe. The old gate let stale
	// rows survive the conservative cached-passphrase reconnect window (skipped
	// on the hidden leg, then matched on the standard re-emit so no second purge
	// ever cleared them).
	const devId = engine.getDeviceState().deviceId
	if (devId) {
		try {
			clearCachedPubkeys(devId)
			clearBalances(devId)
			console.warn(`[Vault] STALE WALLET PURGE (${source}): cleared cached pubkeys + balances for ${devId}`)
		} catch { /* non-fatal */ }
	}
	try { rpc.send['wallet-data-purged']({ reason: source }) } catch { /* webview not ready */ }
	// An open Audit wizard's findings are no longer authoritative once the seed
	// changed underneath it — mark its run stale so the UI prompts a re-run.
	markAuditsStale(source)
	return true
}

/** Shared seed-freshness boundary for ALL manager consumers (balances, signing,
 *  account views). Derives the seed identity FRESH from the device and purges
 *  the managers if they belong to a different seed, BEFORE the caller reads or
 *  initializes them. Returns the live identity (null if underivable) and whether
 *  a purge happened. Callers that (re)POPULATE the managers must stampManagers()
 *  with the returned truth afterward so a later consumer can detect the next
 *  seed change — especially on the BTC-only path. */
async function ensureManagersForSeed(source: string): Promise<{ truth: string | null; purged: boolean }> {
	const truth = await engine.deriveSeedIdentity()
	const purged = reconcileSeedManagers(truth, source)
	return { truth, purged }
}

/** Record the seed identity the managers' data now belongs to. Call AFTER a
 *  successful (re)initialize so reconcileSeedManagers' stamp check is armed. */
function stampManagers(truth: string | null | undefined): void {
	if (truth) managersSeedOwner = truth.toLowerCase()
}

/** Seed own-wallet Address Book entries for EVERY known device from the persisted
 *  watch-only balance cache — so the book shows all the user's wallets (not just
 *  the connected one), each attributable to its device. Cheap, idempotent (INSERT
 *  OR IGNORE), no device calls. Caller must gate on !engine.isPassphraseWallet.
 *  walletId is reconstructed as `${deviceId}:${ethAddr}` (matching getWalletDbScope)
 *  so the connected device's cache-seed dedupes against its live getBalances seed. */
function seedOwnFromCache(): void {
	try {
		const rows = getBalancesForOwnSeed()
		if (rows.length === 0) return
		const labels = getDeviceLabelMap()
		const chainById = new Map(getAllChains().map(c => [c.id, c]))
		const byDevice = new Map<string, Array<{ chainId: string; address: string }>>()
		for (const r of rows) {
			if (!labels[r.deviceId]) continue // only registered devices (skip 'unknown'/unlabeled)
			const list = byDevice.get(r.deviceId) || []
			list.push({ chainId: r.chainId, address: r.address })
			byDevice.set(r.deviceId, list)
		}
		for (const [deviceId, drows] of byDevice) {
			const ethAddr = drows.find(r => r.chainId === 'ethereum')?.address
			const walletId = ethAddr ? `${deviceId}:${ethAddr.toLowerCase()}` : deviceId
			const seeds: OwnAddressSeed[] = []
			for (const r of drows) {
				const ch = chainById.get(r.chainId)
				if (!ch) continue
				seeds.push({ address: r.address, networkId: ch.networkId, chainId: ch.id, chainFamily: ch.chainFamily, symbol: ch.symbol, label: ch.symbol })
			}
			if (seeds.length) syncOwnAddressBook({ deviceId, walletId }, seeds)
		}
	} catch (e: any) {
		console.warn('[seedOwnFromCache] failed:', e?.message)
	}
}

const pendingScopedApiLogs: ApiLogEntry[] = []

function flushPendingScopedApiLogs() {
	const scope = getWalletDbScope()
	if (!scope || engine.isPassphraseWallet || pendingScopedApiLogs.length === 0) return
	const pending = pendingScopedApiLogs.splice(0)
	for (const entry of pending) {
		const scopedEntry = { ...entry, ...scope }
		try { insertApiLog(scopedEntry) } catch { /* db not ready */ }
		try { rpc.send['api-log'](scopedEntry) } catch { /* webview not ready */ }
	}
}

// Swap assets the connected device can actually sign — Pioneer's swappable
// list minus any chain whose minFirmware the device doesn't meet (e.g. ZEC on
// firmware < 7.15.0). Single source shared by the RPC handler and the REST
// callback so both surfaces gate identically.
async function deviceSwapAssets() {
	const { getSwapAssets } = await import('./swap')
	const assets = await getSwapAssets()
	const fw = engine.getDeviceState().firmwareVersion
	const chainMap = new Map(getAllChains().map(c => [c.id, c]))
	return assets.filter(a => {
		const chain = chainMap.get(a.chainId)
		return chain ? isChainSupported(chain, fw) : false
	})
}

// Callbacks bridge REST → RPC UI
const restCallbacks: RestApiCallbacks = {
	onApiLog: (entry: ApiLogEntry) => {
		const scope = getWalletDbScope()
		const scopedEntry = scope ? { ...entry, ...scope } : entry
		try { rpc.send['api-log'](scopedEntry) } catch { /* webview not ready */ }
		// PRIVACY: Don't persist API activity from passphrase wallets to disk.
		if (!engine.isPassphraseWallet && scope) {
			try { insertApiLog(scopedEntry) } catch { /* db not ready */ }
		} else if (!engine.isPassphraseWallet && !scope) {
			pendingScopedApiLogs.push(entry)
			if (pendingScopedApiLogs.length > 100) pendingScopedApiLogs.shift()
		}
	},
	onSigningRequest: async (info: SigningRequestInfo) => {
		attachSigningPolicySnapshot(info)
		try { rpc.send['signing-request'](info) } catch { /* webview not ready */ }
		acquireWindowFocus()
		try {
			return await auth.requestSigningApproval(info.id)
		} finally {
			releaseWindowFocus()
		}
	},
	onSigningDismissed: (id: string) => {
		try { rpc.send['signing-dismissed']({ id }) } catch { /* webview not ready */ }
	},
	onPairRequest: (info) => {
		try { rpc.send['pair-request'](info) } catch { /* webview not ready */ }
		acquireWindowFocus()
	},
	onPairDismissed: () => {
		releaseWindowFocus()
		try { rpc.send['pair-dismissed']({}) } catch { /* webview not ready */ }
	},
	getVersion: () => appVersionCache,
	emuSigningOp: (fn, details) => emuSigningOp(fn, details),
	getSwapUiState: () => getSwapUiState(),
	getDeviceSwapAssets: () => deviceSwapAssets(),
	sendSwapCmd: (cmd) => {
		try { rpc.send['swap-cmd'](cmd) } catch { /* webview not ready */ }
	},
	// Headless swap (BEX swap epic): same engine as the in-app dialog, no GUI in
	// the loop. The device still gates every signature. NOOP substage push.
	getSwapQuoteHeadless: (params) => headlessSwapQuote(params),
	executeSwapHeadless: (params) => headlessExecuteSwap(params, () => { /* headless: no WebView substage */ }),
	zcashPreSendGate: async (account: number) => {
		// Same fail-closed preflight the RPC send path runs: prove the FVK belongs
		// to the connected device (purges stale state on mismatch) THEN catch the
		// note set up to tip. A device-comms failure throws and aborts the send.
		// `force` re-derives every send so a same-handle passphrase/hidden-wallet
		// toggle can't slip through the session-sticky verified flag (P2-E).
		await ensureZcashDeviceMatch(account, true)
		await ensureZcashScanFresh()
	},
	zcashVerifyWallet: async (account: number) => {
		// Read-only REST balance still exposes local shielded state, so prove the
		// sidecar DB belongs to the connected device before returning it.
		await ensureZcashDeviceMatch(account)
	},
	getPioneer: () => getPioneer(),
	getPioneerApiBase: () => getPioneerApiBase(),
	setPioneerApiBase: async (url: string) => {
		const { url: trimmed } = { url: url.trim() }
		setSetting('pioneer_api_base', trimmed)
		resetPioneer()
		chainCatalog = []
		catalogLoadedAt = 0
		const { clearSwapCache } = await import('./swap')
		clearSwapCache()
		console.log('[rest-api] Pioneer URL set to:', trimmed || '(default)')
	},
}

/** Check if a port is already in use by trying to connect to it */
async function isPortInUse(port: number): Promise<boolean> {
	try {
		const resp = await fetch(`http://localhost:${port}/api/v1/health/fast`, { signal: AbortSignal.timeout(2000) })
		return resp.ok
	} catch {
		return false
	}
}

/** Start or stop the REST API server based on the persisted setting */
async function applyRestApiState() {
	if (restApiEnabled && !restServer) {
		// Check if another instance is already bound to the port
		const inUse = await isPortInUse(REST_API_PORT)
		if (inUse) {
			console.error(`[Vault] FATAL: port ${REST_API_PORT} is already in use by another Vault instance. Exiting.`)
			process.exit(1)
		}
		try {
			restServer = startRestApi(engine, auth, REST_API_PORT, restCallbacks)
			console.log(`[Vault] REST API started on port ${REST_API_PORT}`)
		} catch (err) {
			console.error(`[Vault] FATAL: failed to bind REST API on port ${REST_API_PORT}:`, err)
			process.exit(1)
		}
	} else if (!restApiEnabled && restServer) {
		restServer.stop()
		restServer = null
		console.log('[Vault] REST API stopped')
	}
}

// REST API started in deferredInit() after DB is ready

// ── Swap quote cache (last 10 quotes for tracker data) ───────────────
import type { SwapQuote, SwapQuoteParams, ExecuteSwapParams, SwapResult, SwapSubStage } from '../shared/types'
import { isThorchainBankToken, thorchainBankTokenFirmwareOK, THORCHAIN_BANK_TOKEN_MIN_FW } from '../shared/swap-support-matrix'
const swapQuoteCache = new Map<string, SwapQuote>()

// ── Emulator confirm helper ──────────────────────────────────────────
// Setup-op confirm (wipe / loadDevice / applySettings): the firmware shows
// confirmation screens; on the emulator we auto-press through them via the same
// reactive gate as signing (emuGatedConfirm), but in AUTO mode — each firmware
// ButtonRequest gets an immediate approve, no user click. The confirmCount
// argument is now legacy/ignored (the gate reacts per ButtonRequest instead of
// pre-writing a fixed count).
async function emuConfirmOp(fn: () => Promise<any>, _confirmCount = 2): Promise<any> {
	const { emuGatedConfirm } = await import('./emulator-window')
	return emuGatedConfirm(fn, engine.emuDelegate, { interactive: false })
}

// ── Emulator interactive signing helper ─────────────────────────────
// Wraps signing/address-display operations that need user confirmation
// on the emulator window. Setup ops (loadDevice, wipe) keep using
// emuConfirmOp for auto-confirm.
async function emuSigningOp(
	fn: () => Promise<any>,
	details: { operation: string; opLabel?: string; chain?: string; to?: string; toLabel?: string; value?: string; fee?: string; memo?: string },
): Promise<any> {
	const { emuInteractiveConfirm } = await import('./emulator-window')
	return emuInteractiveConfirm(fn, details, engine.emuDelegate)
}

// F5: best-effort confirm fields for the Cosmos-family tx shape (Cosmos/THOR/
// Maya/Osmosis). All accesses are guarded — a missing/odd field just omits that
// row; it never throws or changes signing. Amounts are shown in raw base units
// (no fake decimal conversion — the device shows what it shows).
function cosmosConfirmDetails(operation: string, chain: string, params: any) {
	const tx = params?.tx ?? params
	const msg = tx?.msg?.[0]?.value ?? tx?.msg?.[0]
	const feeAmt = tx?.fee?.amount?.[0]?.amount
	const memo = tx?.memo || undefined

	// Recipient: a real payee (MsgSend) vs a validator (MsgDelegate/Undelegate).
	// NEVER fall back to delegator_address — that is the user's OWN address and
	// would read as a self-transfer while the funds actually bond to a validator.
	const payee = msg?.to_address ?? msg?.recipient ?? msg?.receiver
	const validator = msg?.validator_address
	let to: string | undefined
	let toLabel: string | undefined
	if (typeof payee === 'string') to = payee
	else if (typeof validator === 'string') { to = validator; toLabel = 'Validator' }

	// Amount + denom across the message shapes:
	//   MsgSend            → amount[]  (array of {denom, amount})
	//   MsgDelegate/Undel. → amount    (single {denom, amount} object)
	//   MsgDeposit (THOR/  → coins[]   ({asset, amount}, no `amount` field)
	//     Maya swaps + name registration)
	// Pick the right object so neither the amount nor the denom is dropped.
	const amtAny = msg?.amount
	const amtObj = (Array.isArray(amtAny) ? amtAny[0]
		: (amtAny && typeof amtAny === 'object' ? amtAny : undefined))
		?? msg?.coins?.[0]
	const amtRaw = amtObj?.amount ?? (typeof amtAny !== 'object' ? amtAny : undefined)
	const denom = amtObj?.denom ?? amtObj?.asset
	const value = amtRaw != null && typeof amtRaw !== 'object'
		? String(amtRaw) + (denom ? ' ' + denom : '')
		: undefined

	return {
		operation, chain, to, toLabel, value,
		fee: feeAmt != null ? String(feeAmt) : undefined,
		memo,
	}
}

// Zcash amounts are zatoshi (1 ZEC = 1e8 zatoshi). Show a unit-labeled value so
// "50000000" doesn't read as a huge ZEC magnitude. Display-only; the device
// renders its own base-unit view. Zatoshi stays well within Number's safe range
// (max supply 21M ZEC * 1e8 ≈ 2.1e15 < 9e15).
function zecAmount(zatoshi: any): string | undefined {
	const n = Number(zatoshi)
	if (!Number.isFinite(n)) return undefined
	return (n / 1e8).toFixed(8).replace(/\.?0+$/, '') + ' ZEC'
}

// Race engine.getEmulatorMnemonic() against a 3s deadline. The DebugLink
// read can hang on the dylib path (documented in emu-7.15-debugging.md),
// and a hung verify must NOT block create/import/loadDevice forever — but
// a timeout is a verification failure, not silently OK, since shipping a
// wallet without confirming the firmware really holds the seed leads to
// users backing up unrecoverable phrases.
async function raceVerifyMnemonic(expected: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	return Promise.race<{ ok: true } | { ok: false; reason: string }>([
		engine.getEmulatorMnemonic()
			.then(actual => {
				if (!actual) return { ok: false, reason: 'firmware returned no mnemonic via DebugLink' }
				if (actual.trim() !== expected.trim()) {
					return { ok: false, reason: 'firmware mnemonic does not match expected seed' }
				}
				return { ok: true }
			})
			.catch(err => ({ ok: false, reason: `verify error: ${err?.message || err}` })),
		new Promise<{ ok: false; reason: string }>(resolve =>
			setTimeout(() => resolve({ ok: false, reason: 'verify timed out after 3s' }), 3000)
		),
	])
}

/**
 * Run a fresh Orchard scan before any Zcash send/shield/deshield. The sidecar's
 * note set is whatever was true at `synced_to`; if that's behind the chain tip,
 * an "unspent" note may already be nullified on-chain and the broadcast will
 * be rejected with `orchard double-spend: duplicate nullifier` after the user
 * has already approved on the device. Calling scan first costs ~tens of ms
 * when at tip and a few seconds when behind — strictly better than burning a
 * device confirm + Halo2 proof on a doomed tx.
 *
 * Failure here is fatal — we'd rather surface "scan failed" than silently
 * proceed with stale data.
 */
async function ensureZcashScanFresh(): Promise<void> {
	try {
		// Always incremental — picks up blocks since synced_to. Cheap (<1s when
		// at tip, a few seconds when behind). NEVER trigger full rescan from
		// here: a fresh wallet's first scan from release block is one thing,
		// but a months-old wallet would take hours and lock the user out of
		// every send. Full rescan must be a deliberate user action.
		const result = await scanOrchardNotes()
		if (result?.synced_to != null) updateSyncedTo(result.synced_to)
		zcashVerifiedThisSession = true
		console.log(
			`[zcash-presend] Incremental scan complete: synced_to=${result?.synced_to ?? '?'}, ` +
			`new_notes=${result?.notes_found ?? 0}`,
		)
	} catch (e: any) {
		throw new Error(`Pre-send chain scan failed: ${e?.message || e}. Retry after the network is reachable.`)
	}
}

/**
 * Background incremental scan kicked off once per session on first Privacy tab
 * access. Catches the wallet up to chain tip from `synced_to` — typically a
 * few seconds even on long-running wallets. Frontend gets `scan-progress`
 * events. Failure is silently logged; the next send-time scan will retry.
 *
 * Does NOT do a full rescan. Full rescans take hours on real wallets and
 * must be a deliberate user action (the manual "Repair wallet" / "Full scan"
 * controls in the UI).
 */
/**
 * Prove the cached Orchard FVK actually belongs to the CONNECTED device before
 * we trust its balance or let it spend. The on-disk FVK store has no device
 * identity, and the only existing invalidation — the `seed-changed` event —
 * does not fire reliably on device-to-device swaps. So derive the FVK fresh
 * from the device (silent; no button, seed never leaves) and compare `ak`.
 *
 *  - match            → mark verified, keep the cache + scanned notes.
 *  - no cache / mismatch → the cache belongs to a DIFFERENT wallet (bleed):
 *    purge the stale FVK + scanned notes and re-init from the connected device.
 *
 * Returns true when the cache is device-verified (matched or freshly re-derived
 * to the connected device). Throws if the device can't be reached — callers on
 * the send path MUST treat a throw as fail-closed.
 */
async function ensureZcashDeviceMatch(account: number = 0, force: boolean = false): Promise<boolean> {
	if (!zcashPrivacyEnabled || !engine.wallet) return false
	if (typeof (engine.wallet as any).zcashGetOrchardFVK !== 'function') return false
	// `force` bypasses the session-sticky verified flag on the SPEND path: a
	// same-handle passphrase / hidden-wallet toggle never fires `seed-changed`,
	// so a sticky `true` would let a send build against the PREVIOUS wallet's
	// cached FVK/notes. Re-derive + compare the device ak every send (cheap,
	// silent — no button press). The display path keeps the sticky short-circuit.
	if (zcashDeviceVerified && !force) return true

	const deviceFvk = await (engine.wallet as any).zcashGetOrchardFVK(account)
	if (!deviceFvk?.ak) throw new Error('Device returned no Orchard ak — cannot verify wallet identity')
	const deviceAk = Buffer.from(deviceFvk.ak).toString('hex').toLowerCase()

	const cached = getCachedFvk()
	if (cached && cached.fvk.ak.toLowerCase() === deviceAk) {
		zcashDeviceVerified = true
		return true
	}

	// No cache, or the cache belongs to a DIFFERENT wallet (device-bleed).
	console.warn(
		`[zcash] Cached FVK does not match connected device ` +
		`(cached ak=${cached?.fvk.ak.slice(0, 12) ?? 'none'}…, device ak=${deviceAk.slice(0, 12)}…) — ` +
		`purging stale wallet state and re-deriving from the device`,
	)
	// Coalesce concurrent purges (FIXB-02): a forced spend-path re-derive and a
	// fire-and-forget background verify can both reach here; running two
	// stop/wipe/start/init cycles concurrently corrupts the sidecar. Share one
	// in-flight purge — a second caller awaits it instead of starting its own.
	if (zcashPurgeInFlight) {
		await zcashPurgeInFlight
	} else {
		const purge = (async () => {
			// Mark the sidecar busy so a background verify can't START another purge
			// concurrently while this one runs (P2-B).
			beginZcashSend()
			try {
				stopSidecar()
				wipeSidecarWalletDb()
				await startSidecar()
				await initializeOrchardFromDevice(engine.wallet as any, account)
			} finally {
				endZcashSend()
			}
		})()
		zcashPurgeInFlight = purge
		try {
			await purge
		} finally {
			zcashPurgeInFlight = null
		}
	}
	// Notes from the previous wallet are gone; the next scan rebuilds the
	// unspent set for the real device. Caller is responsible for scanning.
	zcashVerifiedThisSession = false
	zcashDeviceVerified = true
	return true
}

function maybeStartBackgroundWalletVerification(): void {
	// `isZcashSendInFlight()` (P2-B): never kick off a background device-verify —
	// which stop/wipe/restart-s the sidecar on FVK mismatch — while a send is
	// mid build→sign→broadcast; it would delete the sidecar's in-memory PCZT
	// state underneath the build. The next Privacy-tab refresh re-fires it.
	if (zcashDeviceVerified || zcashBackgroundVerifyInFlight || !hasFvkLoaded() || isZcashSendInFlight()) return
	zcashBackgroundVerifyInFlight = true
	;(async () => {
		try {
			// Prove the cached FVK belongs to the connected device FIRST (purges
			// stale state on mismatch), THEN catch the unspent set up to tip.
			await ensureZcashDeviceMatch(0)
			const result = await scanOrchardNotes()
			if (result?.synced_to != null) updateSyncedTo(result.synced_to)
			zcashVerifiedThisSession = true
			console.log(`[zcash] Device-verified + scan caught up: synced_to=${result?.synced_to ?? '?'}, new_notes=${result?.notes_found ?? 0}`)
		} catch (e: any) {
			console.warn('[zcash] Background device-verify/scan failed (non-fatal):', e?.message || e)
		} finally {
			zcashBackgroundVerifyInFlight = false
		}
	})()
}

// ── Shared swap engine entrypoints ───────────────────────────────────
// Lifted out of the RPC handlers so the headless REST routes (BEX swap epic)
// call the exact same logic — getSwapQuote + reserve/net-amount re-quote, and
// executeSwap + device signing + trackSwap. `pushSubStage` is parametrized:
// the in-app RPC path pushes to the WebView; the REST path passes NOOP.
// The device still gates every signature in both paths.
async function headlessSwapQuote(params: SwapQuoteParams): Promise<SwapQuote> {
	const { getSwapQuote } = await import('./swap')

	// Firmware gate (see buildTx): selling a THORChain/Maya bank token (TCY,
	// RUJI) requires firmware 7.15+. Refuse the quote on older firmware — the
	// single chokepoint for both in-app and REST swaps — so the flow can't
	// reach signing. Buying these (toCaip) is fine: the user only receives.
	if (params.fromCaip && isThorchainBankToken(params.fromCaip)) {
		const fw = engine.getDeviceState().firmwareVersion
		if (!thorchainBankTokenFirmwareOK(params.fromCaip, fw)) {
			throw new Error(`TCY / RUJI swaps require KeepKey firmware ${THORCHAIN_BANK_TOKEN_MIN_FW}+ (device has ${fw || 'unknown'}). Update your firmware.`)
		}
	}

	// Resolve xpub addresses to real receive addresses for UTXO chains.
	// ChainBalance.address can be an xpub when Pioneer doesn't return
	// an address field — THORChain rejects xpubs as destination addresses.
	// Detect extended pubkeys: xpub/ypub/zpub (BTC), dgub (DOGE), Ltub/Mtub (LTC), drkp (DASH), tpub (testnet)
	const isXpub = (addr: string) => /^(xpub|ypub|zpub|dgub|Ltub|Mtub|drkp|drks|tpub|upub|vpub)/.test(addr)

	if (engine.wallet) {
		// CAIP-driven: find vault chain by matching CAIP-19 directly.
		const resolveAddr = async (caip: string, addr: string): Promise<string> => {
			if (!isXpub(addr)) return addr
			const chainDef = getAllChains().find(c => c.caip === caip)
			if (!chainDef || chainDef.chainFamily !== 'utxo') return addr
			try {
				const selected = chainDef.id === 'bitcoin' && btcAccounts.isInitialized
					? btcAccounts.getSelectedXpub() : undefined
				// selected.path is account-level (3 elements: m/purpose'/0'/account')
				// btcGetAddress needs full 5-element path — append /0/0 (first receive address)
				const acctPath = selected?.path || chainDef.defaultPath
				const addressNList = acctPath.length === 3 ? [...acctPath, 0, 0] : acctPath
				const scriptType = selected?.scriptType || chainDef.scriptType
				const result = await engine.wallet.btcGetAddress({
					addressNList,
					coin: chainDef.coin,
					scriptType,
					showDisplay: false,
				})
				const resolved = typeof result === 'string' ? result : result?.address
				if (resolved) {
					console.log(`[swap] Resolved xpub → ${resolved} for ${caip}`)
					return resolved
				}
			} catch (e: any) {
				console.warn(`[swap] Failed to resolve xpub for ${caip}: ${e.message}`)
			}
			return addr
		}
		params = {
			...params,
			fromAddress: await resolveAddr(params.fromCaip, params.fromAddress),
			toAddress: await resolveAddr(params.toCaip, params.toAddress),
		}
	}

	// Fail fast if addresses are still xpubs after resolution attempt
	if (isXpub(params.fromAddress)) {
		throw new Error(`Could not resolve source address for ${params.fromCaip} — device may be locked or disconnected`)
	}
	if (isXpub(params.toAddress)) {
		throw new Error(`Could not resolve destination address for ${params.toCaip} — device may be locked or disconnected`)
	}

	let quote = await getSwapQuote(params)

	// NEAR Intents sendMax fix for all bip122 chains: the first quote commits
	// NEAR Intents to receiving `params.amount` (full balance), but the UTXO tx
	// only delivers `balance - miner_fee`. NEAR Intents hard-fails on any
	// shortfall. Fix: re-quote with the actual net delivery amount.
	if (
		quote.swapper === 'NEAR Intents'
		&& params.isMax
		&& params.fromCaip.startsWith('bip122:')
		&& engine.wallet
	) {
		try {
			const { estimateUtxoFee } = await import('./txbuilder/utxo')
			const { getPioneer: getPio } = await import('./pioneer')
			const pio = await getPio()
			const fromChain = getAllChains().find(c => c.caip === params.fromCaip)
			let estXpubs: Array<{ xpub: string; scriptType: string; accountPath: number[] }> | undefined
			let estXpub: string | undefined
			let estAccountPath: number[] | undefined
			if (fromChain?.id === 'bitcoin') {
				estXpubs = btcAccounts.isInitialized ? btcAccounts.getFundedXpubs() : []
			} else if (fromChain) {
				const results = await (engine.wallet as any).getPublicKeys([{
					addressNList: fromChain.defaultPath.slice(0, 3),
					coin: fromChain.coin,
					scriptType: fromChain.scriptType || 'p2pkh',
					curve: 'secp256k1',
				}])
				estXpub = results?.[0]?.xpub
				estAccountPath = fromChain.defaultPath.slice(0, 3)
			}
			const hasXpub = (estXpubs && estXpubs.length > 0) || estXpub
			if (fromChain && hasXpub) {
				const est = await estimateUtxoFee(pio, fromChain, {
					to: quote.inboundAddress || params.fromAddress,
					amount: params.amount,
					isMax: true,
					feeLevel: params.feeLevel,
					...(estXpubs && estXpubs.length > 0
						? { allXpubs: estXpubs }
						: { xpub: estXpub, accountPath: estAccountPath }),
				})
				if (est && est.feeSat > 0) {
					const netAmount = (est.netSat / 1e8).toFixed(8)
					console.log(`[swap] NEAR Intents sendMax: re-quoting ${fromChain.symbol} with net ${netAmount} (fee=${est.feeSat} sat)`)
					quote = { ...await getSwapQuote({ ...params, amount: netAmount, isMax: false }), netFromAmount: netAmount }
				}
			}
		} catch (e: any) {
			console.warn(`[swap] NEAR Intents fee estimation failed, using original quote: ${e.message}`)
		}
	}

	// Cache quote so executeSwap can pass real data to the tracker
	const cacheKey = `${params.fromCaip}-${params.toCaip}-${params.amount}-${params.slippageBps || 300}-${params.fromAddress}-${params.toAddress}`
	swapQuoteCache.delete(cacheKey) // delete+set for LRU ordering
	swapQuoteCache.set(cacheKey, quote)
	// Keep cache small (last 10 quotes)
	if (swapQuoteCache.size > 10) {
		const oldest = swapQuoteCache.keys().next().value
		if (oldest) swapQuoteCache.delete(oldest)
	}
	return quote
}

async function headlessExecuteSwap(params: ExecuteSwapParams, pushSubStage: (stage: SwapSubStage) => void): Promise<SwapResult> {
	if (!engine.wallet) throw new Error('No device connected')

	// Firmware gate ENFORCED at execute time, not just quote time: /api/v2/swap/
	// execute (rest-swap.ts) calls this directly, so a stale or crafted execute
	// payload must not bypass the quote-time check and reach signing on firmware
	// that would sign the wrong asset. Mirrors headlessSwapQuote + buildTx.
	if (params.fromCaip && isThorchainBankToken(params.fromCaip)) {
		const fw = engine.getDeviceState().firmwareVersion
		if (!thorchainBankTokenFirmwareOK(params.fromCaip, fw)) {
			throw new Error(`TCY / RUJI swaps require KeepKey firmware ${THORCHAIN_BANK_TOKEN_MIN_FW}+ (device has ${fw || 'unknown'}). Update your firmware.`)
		}
	}

	const { executeSwap } = await import('./swap')
	const { trackSwap, isTrackerInitialized, initSwapTracker } = await import('./swap-tracker')
	// Ensure tracker is initialized before tracking (guards against race/init failure)
	if (!isTrackerInitialized()) {
		await initSwapTracker((msg: string, data: any) => {
			try {
				if (msg === 'swap-update') rpc.send['swap-update'](data)
				else if (msg === 'swap-complete') rpc.send['swap-complete'](data)
				else console.error(`[swap-tracker] Unknown message: ${msg}`)
			} catch (e: any) {
				console.warn(`[swap-tracker] Failed to send '${msg}':`, e.message)
			}
		}, { getDeviceId: () => getWalletDbScope()?.deviceId, getWalletId: () => getWalletDbScope()?.walletId })
	}
	// Look up cached quote BEFORE executing so we can use netFromAmount to
	// override the send amount for NEAR Intents bip122 sendMax swaps.
	let cachedQuote: SwapQuote | undefined
	for (const [key, val] of swapQuoteCache) {
		// Key format: fromCaip-toCaip-amount-slippageBps-fromAddress-toAddress
		const keyPrefix = `${params.fromCaip}-${params.toCaip}-${params.amount}-`
		if (key.startsWith(keyPrefix) && val.inboundAddress === params.inboundAddress) {
			cachedQuote = val
			break
		}
	}
	if (!cachedQuote) console.warn('[index] No cached quote for swap tracker — using fallback data')

	// For NEAR Intents bip122 sendMax: the re-quote stored netFromAmount
	// (balance - estimated fee). Use it with isMax=false so buildTx's
	// coinSelectSplit outputs exactly that amount instead of (balance - actualFee),
	// which may diverge from estimatedFee and cause INCOMPLETE_DEPOSIT.
	let execParams = params
	if (
		cachedQuote?.netFromAmount
		&& params.isMax
		&& params.fromCaip.startsWith('bip122:')
		&& (params.swapper === 'NEAR Intents' || params.integration === 'nearIntents')
	) {
		execParams = { ...params, amount: cachedQuote.netFromAmount, isMax: false }
		console.log(`[swap] NEAR Intents sendMax: net amount ${cachedQuote.netFromAmount} (was ${params.amount}), isMax→false`)
	}

	const result = await executeSwap(execParams, {
		wallet: engine.wallet,
		getAllChains,
		getRpcUrl,
		getBtcXpub: () => {
			if (btcAccounts.isInitialized) {
				const selected = btcAccounts.getSelectedXpub()
				if (selected) return { xpub: selected.xpub, accountPath: selected.path }
			}
			return undefined
		},
		getAllBtcXpubs: () => {
			if (btcAccounts.isInitialized) return btcAccounts.getFundedXpubs()
			return []
		},
		wrapSign: engine.isEmulator
			? (fn, details) => emuSigningOp(fn, details)
			: (fn) => fn(),
		pushSubStage,
		isAdvancedModeEnabled: getAdvancedModeEnabled,
	})
	const scope = getWalletDbScope()
	// Register swap for tracking (non-blocking)
	try {
		const trackParams = cachedQuote?.netFromAmount
			? { ...execParams, amount: cachedQuote.netFromAmount }
			: execParams
		trackSwap(result, trackParams, {
			expectedOutput: cachedQuote?.expectedOutput || params.expectedOutput,
			minimumOutput: cachedQuote?.minimumOutput || '0',
			inboundAddress: cachedQuote?.inboundAddress || params.inboundAddress,
			router: cachedQuote?.router || params.router,
			memo: cachedQuote?.memo || params.memo,
			expiry: cachedQuote?.expiry || params.expiry,
			fees: cachedQuote?.fees || { affiliate: '0', outbound: '0', totalBps: 0 },
			estimatedTime: cachedQuote?.estimatedTime || 600,
			slippageBps: cachedQuote?.slippageBps || 300,
			integration: cachedQuote?.integration || 'thorchain',
			swapper: cachedQuote?.swapper,
			nearIntentsDepositAddress: cachedQuote?.nearIntentsDepositAddress,
		}, { skipPersist: engine.isPassphraseWallet || !scope, deviceId: scope?.deviceId, walletId: scope?.walletId })
	} catch (e: any) {
		console.warn('[index] Failed to register swap for tracking:', e.message)
	}
	// Track swap in api_log. PRIVACY: Skip DB write for passphrase wallets.
	if (!engine.isPassphraseWallet && scope) {
		const fromChain = getAllChains().find(c => c.id === params.fromChainId)
		insertApiLog({ ...scope, method: 'RPC', route: 'executeSwap', timestamp: Date.now(), durationMs: 0, status: 200, appName: 'vault', txid: result.txid, chain: fromChain?.symbol || params.fromChainId, activityType: 'swap' })
	}
	return result
}

// ── RPC Bridge (Electrobun UI ↔ Bun) ─────────────────────────────────
const rpc = BrowserView.defineRPC<VaultRPCSchema>({
	maxRequestTime: 1_800_000, // 30 minutes — generous for device-interactive ops, but not infinite
	handlers: {
		requests: {
			// ── Device lifecycle ──────────────────────────────────────
			getDeviceState: async () => engine.getDeviceState(),
			retryConnect: async () => { await engine.retryConnect() },
			startBootloaderUpdate: async () => { await engine.startBootloaderUpdate() },
			startFirmwareUpdate: async () => { await engine.startFirmwareUpdate() },
			flashFirmware: async () => { await engine.flashFirmware() },
			analyzeFirmware: async (params) => {
				if (params.data.length > 10_000_000) throw new Error('Firmware data too large (max ~7.5MB)')
				const buf = Buffer.from(params.data, 'base64')
				if (buf.length > 7_500_000) throw new Error('Decoded firmware exceeds 7.5MB limit')
				return engine.analyzeFirmware(buf)
			},
			flashCustomFirmware: async (params) => {
				if (params.data.length > 10_000_000) throw new Error('Firmware data too large (max ~7.5MB)')
				const buf = Buffer.from(params.data, 'base64')
				if (buf.length > 7_500_000) throw new Error('Decoded firmware exceeds 7.5MB limit')
				await engine.flashCustomFirmware(buf)
			},
			resetDevice: async (params) => { await engine.resetDevice(params) },
			recoverDevice: async (params) => { await engine.recoverDevice(params) },
			loadDevice: async (params) => {
				if (engine.isEmulator) {
					const { saveMnemonic, deleteMnemonic } = await import('./emulator-keychain')
					const { getActiveFlashName, deleteFlash, stopEmulator } = await import('./emulator')
					const { deleteEmulatorWalletMeta, deleteDeviceSnapshot } = await import('./db')
					const flashName = getActiveFlashName()

					// Save mnemonic FIRST — connectEmulator's auto-reload (stale
					// storage key recovery) will pick up the NEW seed instead of
					// the previously saved one.
					if (params.mnemonic) {
						console.log('[Vault] Saving new mnemonic before load (flash=%s)', flashName)
						saveMnemonic(flashName, params.mnemonic)
					}

					try {
						// Firmware rejects loadDevice on an already-initialized device.
						// Wipe first so the new mnemonic actually takes effect.
						if (engine.cachedFeatures?.initialized) {
							console.log('[Vault] Emulator already initialized — wiping before loadDevice')
							await emuConfirmOp(() => engine.wallet!.wipe())
							const { flushRingBuffers } = await import('./emulator')
							flushRingBuffers()
							// connectEmulator may auto-reload our just-saved mnemonic
							// via the stale-storage-key recovery path.
							await engine.connectEmulator()
						}

						// If auto-reload already initialized the device with the new
						// seed, skip the manual loadDevice — firmware would reject it.
						if (!engine.cachedFeatures?.initialized) {
							await emuConfirmOp(() => engine.loadDevice({ ...params, skipRefresh: true }))
						} else {
							console.log('[Vault] Device already initialized after reconnect — skipping manual loadDevice')
						}

						// Drain stale ButtonAck + reconnect for clean transport
						const { flushRingBuffers: flush } = await import('./emulator')
						flush()
						await engine.connectEmulator()

						// Verify the firmware actually holds the mnemonic we loaded.
						// MUST be fatal — same contract as create/import. Wrap in a
						// 3s race so a stuck DebugLink doesn't block the RPC, but
						// treat the timeout as a verification failure so the wizard
						// doesn't silently advance with an unverified wallet.
						if (params.mnemonic) {
							const expected = params.mnemonic
							const verifyResult = await raceVerifyMnemonic(expected)
							if (!verifyResult.ok) {
								throw new Error(`Seed verification failed — ${verifyResult.reason}`)
							}
							console.log('[Vault] SEED VERIFY OK — firmware mnemonic matches loaded seed')
						}
						return
					} catch (err) {
						// Rollback the saved mnemonic + persisted metadata so
						// connectEmulator's auto-reload can't silently resurrect a
						// wallet the wizard reported as failed.
						console.error('[Vault] loadDevice failed, rolling back:', (err as Error).message)
						const deviceId = engine.cachedFeatures?.deviceId
						try {
							const { closeEmulatorWindow } = await import('./emulator-window')
							closeEmulatorWindow()
						} catch {}
						try { engine.disconnectEmulator() } catch {}
						try { stopEmulator() } catch {}
						try { deleteMnemonic(flashName) } catch {}
						try { deleteFlash(flashName) } catch {}
						try { deleteEmulatorWalletMeta(flashName) } catch {}
						if (deviceId) { try { deleteDeviceSnapshot(deviceId) } catch {} }
						throw err
					}
				}
				await engine.loadDevice(params)
			},
			verifySeed: async (params) => { return await engine.verifySeed(params) },
			verifySeedChallenge: async () => {
				if (!engine.isEmulator) throw new Error('Challenge-based verify is emulator-only')
				const { loadMnemonic } = await import('./emulator-keychain')
				const { getActiveFlashName } = await import('./emulator')
				const mnemonic = loadMnemonic(getActiveFlashName())
				if (!mnemonic) throw new Error('No saved mnemonic found for this emulator')
				const words = mnemonic.trim().split(/\s+/)
				const wordCount = words.length
				// Pick 3 random unique positions (1-indexed)
				const all = Array.from({ length: wordCount }, (_, i) => i + 1)
				for (let i = all.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[all[i], all[j]] = [all[j], all[i]]
				}
				const positions = all.slice(0, 3).sort((a, b) => a - b)
				return { positions, wordCount }
			},
			verifySeedSubmit: async (params) => {
				if (!engine.isEmulator) throw new Error('Challenge-based verify is emulator-only')
				const { loadMnemonic } = await import('./emulator-keychain')
				const { getActiveFlashName } = await import('./emulator')
				const mnemonic = loadMnemonic(getActiveFlashName())
				if (!mnemonic) return { success: false, message: 'No saved mnemonic — cannot verify' }
				const words = mnemonic.trim().split(/\s+/)
				for (const { position, word } of params.answers) {
					if (position < 1 || position > words.length) {
						return { success: false, message: `Invalid word position: ${position}` }
					}
					if (word.trim().toLowerCase() !== words[position - 1].toLowerCase()) {
						return { success: false, message: `Word #${position} is incorrect` }
					}
				}
				return { success: true, message: 'Seed verified successfully' }
			},
			applySettings: async (params) => {
				if (engine.isEmulator) {
					await emuConfirmOp(() => engine.applySettings({ ...params, skipRefresh: true }))
					const { flushRingBuffers } = await import('./emulator')
					flushRingBuffers()
					await engine.connectEmulator()
					return
				}
				await engine.applySettings(params)
			},
			changePin: async () => { await engine.changePin() },
			removePin: async () => { await engine.removePin() },
			sendPin: async (params) => { await engine.sendPin(params.pin) },
			sendPassphrase: async (params) => { await engine.sendPassphrase(params.passphrase) },
			sendCharacter: async (params) => { await engine.sendCharacter(params.character) },
			sendCharacterDelete: async () => { await engine.sendCharacterDelete() },
			sendCharacterDone: async () => { await engine.sendCharacterDone() },

			// ── BIP-85 Derived Seeds ──────────────────────────────────
			// Seed is displayed on device screen only — never sent over USB.
			getBip85Mnemonic: async (params) => {
				const result = await engine.getBip85Mnemonic(params)

				// Save metadata when label is provided.
				// PRIVACY: Don't persist BIP-85 derivation metadata for passphrase wallets —
				// it links the device fingerprint to derivation operations under the hidden wallet.
				if (params.label !== undefined && !engine.isPassphraseWallet) {
					try {
						const fp = await engine.getWalletFingerprint()
						const meta: Bip85SeedMeta = {
							walletFingerprint: fp,
							wordCount: params.wordCount as 12 | 18 | 24,
							index: params.index,
							derivationPath: result.derivationPath,
							label: params.label || '',
							createdAt: Date.now(),
						}
						const saved = saveBip85Seed(meta)
						console.log('[bip85] seed meta saved:', saved, 'wc:', params.wordCount, 'idx:', params.index, 'fp:', fp.slice(0, 8))
						return { ...result, saved }
					} catch (e: any) {
						console.warn('[bip85] metadata save failed:', e?.message)
						return { ...result, saved: false }
					}
				}
				return result
			},
			getWalletFingerprint: async () => {
				const fingerprint = await engine.getWalletFingerprint()
				return { fingerprint }
			},
			// DB read — uses fingerprint to isolate per-wallet when device is available
			listBip85Seeds: async () => {
				// PRIVACY: Don't expose standard-wallet BIP-85 metadata during hidden sessions.
				if (engine.isPassphraseWallet) return []
				let fp: string | undefined
				try { fp = await engine.getWalletFingerprint() } catch { /* device not connected */ }
				const seeds = getBip85Seeds(fp)
				console.log('[bip85] listBip85Seeds — found:', seeds.length, fp ? `fp: ${fp.slice(0, 8)}` : '(no device, showing all)')
				return seeds
			},
			// DB write — requires device for fingerprint (cannot save without wallet identity)
			saveBip85SeedMeta: async (params) => {
				// PRIVACY: Don't persist BIP-85 metadata for passphrase wallets.
				if (engine.isPassphraseWallet) {
					throw new Error('BIP-85 seed metadata cannot be saved for passphrase-protected wallets (privacy).')
				}
				const fp = await engine.getWalletFingerprint()
				const meta: Bip85SeedMeta = {
					walletFingerprint: fp,
					wordCount: params.wordCount as 12 | 18 | 24,
					index: params.index,
					derivationPath: `m/83696968'/39'/0'/${params.wordCount}'/${params.index}'`,
					label: params.label || '',
					createdAt: Date.now(),
				}
				const saved = saveBip85Seed(meta)
				if (!saved) throw new Error('Failed to persist seed metadata to database')
				return meta
			},
			// DB delete — requires device fingerprint to prevent cross-wallet deletion
			deleteBip85SeedMeta: async (params) => {
				const fp = await engine.getWalletFingerprint()
				deleteBip85Seed(params.wordCount, params.index, fp)
			},

			// ── Wallet operations (hdwallet pass-through) ─────────────
			getFeatures: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.getFeatures()
			},
			applyPolicy: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				// applyPolicy raises an "ENABLE/DISABLE POLICY" confirm on the device
				// and blocks on a button press. On the emulator that needs the
				// interactive Accept/Reject affordance or it hangs until timeout.
				const apply = () => engine.wallet!.applyPolicy({ policyName: params.policyName, enabled: params.enabled })
				if (engine.isEmulator) {
					await emuSigningOp(apply, {
						operation: 'applyPolicy',
						opLabel: `${params.enabled ? 'Enable' : 'Disable'} ${params.policyName} policy`,
					})
				} else {
					await apply()
				}
				clearFeaturesCache()
				try {
					await engine.refreshFeaturesSnapshot()
				} catch (e: any) {
					engine.invalidateFeaturesSnapshot()
					console.warn('[policy] Applied policy but failed to refresh features:', e?.message || e)
				}
			},
			ping: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.ping({ msg: params.msg || 'pong', passphrase: false })
			},
			openExternal: async (params) => {
				// Validate up front — only open http(s) URLs, never local file://
				// or javascript: schemes. The WebView passes user-visible URLs
				// (explorer / docs links) so this is more defense-in-depth than
				// hardening against the user.
				const url = String(params?.url || "")
				if (!/^https?:\/\//i.test(url)) {
					throw new Error("openExternal: only http(s) URLs are allowed")
				}
				const cmd = process.platform === "win32" ? ["cmd", "/c", "start", "", url]
					: process.platform === "darwin" ? ["open", url]
					: ["xdg-open", url]
				try {
					Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] })
				} catch (e: any) {
					throw new Error(`Failed to open URL: ${e?.message || e}`)
				}
				return { ok: true as const }
			},
			cancelDeviceSigning: async () => {
				// User backed out of an in-flight confirm/PIN/passphrase prompt.
				// Sends a Cancel message to the device, which dismisses the on-
				// screen prompt and releases the transport lock. The pending
				// signing promise inside hdwallet rejects with a "Cancelled"
				// error — the swap dialog catches it and resets to 'review'.
				if (!engine.wallet) return { ok: false }
				await engine.wallet.cancel().catch(() => {})
				return { ok: true }
			},
			wipeDevice: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				// Cancel any pending PIN/passphrase request before wiping —
				// the transport lock is held while waiting for PIN input,
				// so wipe() would deadlock without this.
				await engine.wallet.cancel().catch(() => {})
				if (engine.isEmulator) {
					await emuConfirmOp(() => engine.wallet!.wipe())
					const { flushRingBuffers } = await import('./emulator')
					flushRingBuffers()
					await engine.connectEmulator()
				} else {
					await engine.wallet.wipe()
					await engine.syncState()
				}
				return { success: true }
			},
			getPublicKeys: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.getPublicKeys(params.paths)
			},

			// ── Address derivation ────────────────────────────────────
			btcGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				// btcGetAddress is shared by every UTXO chain (Litecoin, Dash, Dogecoin, …),
				// so resolve the cache key from params.coin instead of hardcoding bitcoin —
				// otherwise an altcoin address overwrites bitcoin's cache and never persists
				// under its own chain.
				const chainId = CHAINS.find(c => c.coin === params.coin)?.id || 'bitcoin'
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.btcGetAddress(params), { operation: 'btcGetAddress', chain: params.coin || 'Bitcoin' })
					: await engine.wallet.btcGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress(chainId, JSON.stringify(params.addressNList || []), addr)
				return result
			},
			ethGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.ethGetAddress(params), { operation: 'ethGetAddress', chain: 'Ethereum' })
					: await engine.wallet.ethGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('ethereum', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			cosmosGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.cosmosGetAddress(params), { operation: 'cosmosGetAddress', chain: 'Cosmos' })
					: await engine.wallet.cosmosGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('cosmos', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			thorchainGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.thorchainGetAddress(params), { operation: 'thorchainGetAddress', chain: 'THORChain' })
					: await engine.wallet.thorchainGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('thorchain', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			mayachainGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.mayachainGetAddress(params), { operation: 'mayachainGetAddress', chain: 'Maya' })
					: await engine.wallet.mayachainGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('mayachain', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			osmosisGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.osmosisGetAddress(params), { operation: 'osmosisGetAddress', chain: 'Osmosis' })
					: await engine.wallet.osmosisGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('osmosis', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			xrpGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.rippleGetAddress(params), { operation: 'xrpGetAddress', chain: 'XRP' })
					: await engine.wallet.rippleGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('ripple', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			solanaGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.solanaGetAddress(params), { operation: 'solanaGetAddress', chain: 'Solana' })
					: await engine.wallet.solanaGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('solana', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			tronGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.tronGetAddress(params), { operation: 'tronGetAddress', chain: 'Tron' })
					: await engine.wallet.tronGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('tron', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			tonGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				// Default to non-bounceable (UQ) — bounceable (EQ) bounces funds if wallet is uninitialized
				const bounceable = params.bounceable ?? false
				const addrParams = { ...params, bounceable }
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.tonGetAddress(addrParams), { operation: 'tonGetAddress', chain: 'TON' })
					: await engine.wallet.tonGetAddress(addrParams)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('ton', JSON.stringify(params.addressNList || []), addr)
				return result
			},

			// ── Transaction signing ───────────────────────────────────
			btcSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) {
					// The single UTXO handler serves BTC/LTC/DOGE/DASH/BCH/ZEC/DGB — use the
					// real coin (params.coin) for the chain + base-unit label, not hardcoded
					// Bitcoin/sats (which falsely asserts the wrong network/denomination).
					const coin = (params as any).coin || 'Bitcoin'
					const unit = coin === 'Bitcoin' ? ' sats' : '' // only BTC's base unit is "sats"
					// fee = sum(inputs) - sum(outputs), only if inputs carry their value
					// (they often don't in params — omit rather than show a wrong number).
					const outs: any[] = (params as any).outputs || []
					const ins: any[] = (params as any).inputs || []
					const sumOut = outs.reduce((s, o) => s + Number(o?.amount || 0), 0)
					const sumIn = ins.reduce((s, i) => s + Number(i?.amount ?? i?.value ?? 0), 0)
					const fee = sumIn > sumOut ? String(sumIn - sumOut) + unit : undefined
					const amt = outs[0]?.amount
					return emuSigningOp(
						() => engine.wallet!.btcSignTx(params),
						{ operation: 'btcSignTx', chain: coin, to: outs[0]?.address, value: amt != null ? String(amt) + unit : undefined, fee },
					)
				}
				return await engine.wallet.btcSignTx(params)
			},
			ethSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) {
					// Honest dialog: decode params.data so a token transfer shows the real
					// recipient+amount (not the contract + 0x0), an approval is labeled, and
					// a contract call isn't forged as a "To:" recipient. Display-only.
					const { evmConfirmDetails } = await import('./emulator-confirm-details')
					return emuSigningOp(
						() => engine.wallet!.ethSignTx(params),
						evmConfirmDetails('ethSignTx', 'Ethereum', params),
					)
				}
				return await engine.wallet.ethSignTx(params)
			},
			ethSignMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) {
					// hdwallet requires the message as a hex string; the device OLED renders
					// the decoded text, so decode hex→UTF-8 for the memo (fall back to raw if
					// it isn't printable text). Display-only.
					const raw = params.message?.toString() ?? ''
					let memo = raw.slice(0, 64)
					if (/^0x[0-9a-fA-F]*$/.test(raw)) {
						try {
							const txt = Buffer.from(raw.slice(2), 'hex').toString('utf8')
							if (txt && /^[\t\n\r\x20-\x7e]*$/.test(txt)) memo = txt.slice(0, 64)
						} catch { /* not valid UTF-8 — keep raw hex */ }
					}
					return emuSigningOp(
						() => engine.wallet!.ethSignMessage(params),
						{ operation: 'ethSignMessage', chain: 'Ethereum', memo },
					)
				}
				return await engine.wallet.ethSignMessage(params)
			},
			ethSignTypedData: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.ethSignTypedData(params),
					{ operation: 'ethSignTypedData', chain: 'Ethereum' },
				)
				return await engine.wallet.ethSignTypedData(params)
			},
			ethVerifyMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				// Verify shows the message + address on device and waits for a button
				// press — on the emulator that needs the Confirm/Reject affordance, same
				// as tronVerifyMessage. Without the gate it hangs until the 120s timeout.
				return engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.ethVerifyMessage(params), { operation: 'ethVerifyMessage', chain: 'Ethereum' })
					: await engine.wallet.ethVerifyMessage(params)
			},
			cosmosSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.cosmosSignTx(params),
					cosmosConfirmDetails('cosmosSignTx', 'Cosmos', params),
				)
				return await engine.wallet.cosmosSignTx(params)
			},
			thorchainSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.thorchainSignTx(params),
					cosmosConfirmDetails('thorchainSignTx', 'THORChain', params),
				)
				return await engine.wallet.thorchainSignTx(params)
			},
			mayachainSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.mayachainSignTx(params),
					cosmosConfirmDetails('mayachainSignTx', 'Maya', params),
				)
				return await engine.wallet.mayachainSignTx(params)
			},
			osmosisSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.osmosisSignTx(params),
					cosmosConfirmDetails('osmosisSignTx', 'Osmosis', params),
				)
				return await engine.wallet.osmosisSignTx(params)
			},
			xrpSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) {
					const tx: any = (params as any).tx ?? params
					return emuSigningOp(
						() => engine.wallet!.rippleSignTx(params),
						{
							operation: 'xrpSignTx', chain: 'XRP',
							to: typeof tx?.destination === 'string' ? tx.destination : undefined,
							value: tx?.amount != null ? String(tx.amount) + ' drops' : undefined,
							fee: tx?.fee != null ? String(tx.fee) + ' drops' : undefined,
						},
					)
				}
				return await engine.wallet.rippleSignTx(params)
			},
			solanaSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')

				console.debug(`[solanaSignTx] RPC call received`)

				// Pioneer returns full serialized tx: [compact-u16:sigCount][sig0(64)]...[sigN(64)][message]
				// See solana-tx.ts for the wire-format contract + malformed-input rejection rules.
				if (!params.rawTx) {
					throw new Error('[solanaSignTx] rawTx is required')
				}
				const fullTx = Buffer.from(
					typeof params.rawTx === 'string' ? params.rawTx : Buffer.from(params.rawTx).toString('base64'),
					'base64',
				)
				let parsed
				try {
					parsed = parseSolanaTx(fullTx)
				} catch (err) {
					if (err instanceof SolanaTxParseError) throw new Error(`[solanaSignTx] ${err.message}`)
					throw err
				}

				// KeepKey firmware message type 752 (SolanaSignTx) parses legacy
				// messages only. Versioned (v0) messages are signed via type
				// 754 (SolanaSignMessage) over the exact message bytes — the
				// 0x80 prefix and v0 payload are preserved, producing an
				// Ed25519 signature valid for the original v0 transaction.
				// The device shows a generic "sign message" prompt; users
				// review the parsed tx in the Vault approval dialog.
				let sigBytes: Uint8Array
				if (parsed.isVersioned) {
					const messageBytes = solanaMessageSlice(fullTx, parsed)
					console.debug(`[solanaSignTx] v0 tx detected — routing through solanaSignMessage (${messageBytes.length}B message incl. 0x80 prefix)`)
					const msgRes = engine.isEmulator
						? await emuSigningOp(() => engine.wallet!.solanaSignMessage({ addressNList: params.addressNList, message: messageBytes, showDisplay: true }), { operation: 'solanaSignTx', opLabel: 'Solana Sign Transaction (v0)', chain: 'Solana' })
						: await engine.wallet.solanaSignMessage({ addressNList: params.addressNList, message: messageBytes, showDisplay: true })
					const sig = msgRes?.signature
					if (!sig) throw new Error('[solanaSignTx] v0: device returned no signature')
					sigBytes = sig instanceof Uint8Array ? sig : Buffer.from(sig, 'base64')
				} else {
					const deviceParams = {
						...params,
						rawTx: Buffer.from(fullTx.subarray(parsed.messageStart)).toString('base64'),
					}
					console.debug(`[solanaSignTx] legacy — fullTx=${fullTx.length}B sigCount=${parsed.sigCount} messageStart=${parsed.messageStart}`)
					const result = engine.isEmulator
						? await emuSigningOp(() => engine.wallet!.solanaSignTx(deviceParams), { operation: 'solanaSignTx', chain: 'Solana' })
						: await engine.wallet.solanaSignTx(deviceParams)
					if (!result?.signature) return result
					sigBytes = result.signature instanceof Uint8Array
						? result.signature
						: Buffer.from(result.signature, 'base64')
				}

				// Assemble signed tx: write sig into the first sig slot
				// (starts at `parsed.sigStart`, 64 bytes).
				if (sigBytes.length !== 64) {
					throw new Error(`[solanaSignTx] Unexpected signature length ${sigBytes.length}`)
				}
				const rawBytes = Buffer.from(fullTx)
				if (rawBytes.length < parsed.sigStart + 64) {
					throw new Error('[solanaSignTx] Raw tx too short to hold signature')
				}
				for (let i = 0; i < 64; i++) rawBytes[parsed.sigStart + i] = sigBytes[i]
				const assembled = rawBytes.toString('base64')
				console.debug(`[solanaSignTx] Assembled signed tx: ${rawBytes.length}B (versioned=${parsed.isVersioned})`)
				return { signature: sigBytes, serializedTx: assembled }
			},
			solanaSignMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.solanaSignMessage(params), { operation: 'solanaSignMessage', chain: 'Solana' })
					: await engine.wallet.solanaSignMessage(params)
				if (!result) throw new Error('solanaSignMessage returned no result')
				return {
					signature: result.signature instanceof Uint8Array
						? Buffer.from(result.signature).toString('base64')
						: result.signature,
					publicKey: result.publicKey instanceof Uint8Array
						? Buffer.from(result.publicKey).toString('base64')
						: result.publicKey,
				}
			},
			tronSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.tronSignTx(params), { operation: 'tronSignTx', chain: 'Tron' })
					: await engine.wallet.tronSignTx(params)
				if (!result) throw new Error('tronSignTx returned no result')
				return {
					signature: result.signature instanceof Uint8Array
						? Buffer.from(result.signature).toString('hex')
						: result.signature,
					// Pass rawTx + tronGridTx through for broadcast
					rawTx: typeof params.rawTx === 'string' ? params.rawTx
						: params.rawTx instanceof Uint8Array ? Buffer.from(params.rawTx).toString('hex')
						: undefined,
					tronGridTx: (params as any).tronGridTx,
				}
			},
			tonSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.tonSignTx(params), { operation: 'tonSignTx', chain: 'TON' })
					: await engine.wallet.tonSignTx(params)
				if (!result) throw new Error('tonSignTx returned no result')
				return {
					signature: result.signature instanceof Uint8Array
						? Buffer.from(result.signature).toString('hex')
						: result.signature,
					// Pass tonBuildResult through for BOC assembly in broadcastTx
					tonBuildResult: (params as any).tonBuildResult,
				}
			},

			// ── TRON TIP-191 personal_sign ────────────────────────────────
			tronSignMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.tronSignMessage(params), { operation: 'tronSignMessage', chain: 'Tron' })
					: await engine.wallet.tronSignMessage(params)
				if (!result) throw new Error('tronSignMessage returned no result')
				return { address: result.address, signature: bytesToHex(result.signature) }
			},
			tronVerifyMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const ok = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.tronVerifyMessage(params), { operation: 'tronVerifyMessage', chain: 'Tron' })
					: await engine.wallet.tronVerifyMessage(params)
				return { verified: !!ok }
			},

			// ── TRON TIP-712 typed-data hash mode ─────────────────────────
			tronSignTypedHash: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.tronSignTypedHash(params), { operation: 'tronSignTypedHash', chain: 'Tron' })
					: await engine.wallet.tronSignTypedHash(params)
				if (!result) throw new Error('tronSignTypedHash returned no result')
				return { address: result.address, signature: bytesToHex(result.signature) }
			},

			// ── TON Ed25519 SignMessage (AdvancedMode-gated firmware-side) ─
			tonSignMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.tonSignMessage(params), { operation: 'tonSignMessage', chain: 'TON' })
					: await engine.wallet.tonSignMessage(params)
				if (!result) throw new Error('tonSignMessage returned no result')
				return { publicKey: bytesToHex(result.publicKey), signature: bytesToHex(result.signature) }
			},

			// ── Solana off-chain message (domain-separated envelope) ─────
			solanaSignOffchainMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.solanaSignOffchainMessage(params), { operation: 'solanaSignOffchainMessage', chain: 'Solana' })
					: await engine.wallet.solanaSignOffchainMessage(params)
				if (!result) throw new Error('solanaSignOffchainMessage returned no result')
				return { publicKey: bytesToHex(result.publicKey), signature: bytesToHex(result.signature) }
			},

			// ── Hive (Graphene) ───────────────────────────────────────────
			hiveGetPublicKey: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await (engine.wallet as any).hiveGetPublicKey(params)
				if (!result) throw new Error('hiveGetPublicKey returned no result')
				return result
			},
			// Derive all four SLIP-0048 role keys (owner/active/posting/memo) for an
			// account index, for the Hive onboarding panel (account creation needs all 4).
			hiveGetRoleKeys: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const accountIndex = params?.accountIndex ?? 0
				const roles = ['owner', 'active', 'posting', 'memo'] as const
				const out: Record<string, string> = {}
				for (const role of roles) {
					const r = await (engine.wallet as any).hiveGetPublicKey({
						addressNList: hiveRolePath(role, accountIndex),
						showDisplay: false,
					})
					if (!r?.publicKey) throw new Error(`hiveGetPublicKey(${role}) returned no key`)
					out[role] = r.publicKey
				}
				return out as { owner: string; active: string; posting: string; memo: string }
			},
			// Resolve a Hive account from a device public key via Pioneer. Returns
			// { noAccount: true } when the key controls no account yet (onboarding
			// case), or { account: {...} } with balances/RC when it does.
			hiveGetAccount: async (params) => {
				const pubkey = params?.pubkey
				if (!pubkey) throw new Error('hiveGetAccount requires a pubkey')
				const base = getPioneerApiBase()
				const resp = await fetch(`${base}/api/v1/hive/account/${encodeURIComponent(pubkey)}`)
				if (!resp.ok) throw new Error(`Pioneer hive/account ${resp.status}`)
				return await resp.json()
			},
			// Live username availability (format + on-chain), for the onboarding wizard.
			hiveUsernameAvailable: async (params) => {
				const name = params?.name
				if (!name) return { success: false, available: false, reason: 'empty' }
				const base = getPioneerApiBase()
				const resp = await fetch(`${base}/api/v1/hive/username-available/${encodeURIComponent(name)}`)
				return await resp.json()
			},
			// Full sponsor-backed account creation: derive the 4 device keys, get a
			// device attestation (owner-signed account_create, op 9), POST to Pioneer's
			// sponsor endpoint. The sponsor (@keepkey) pays; no user key leaves the device.
			hiveCreateAccount: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const username = params?.username
				if (!username) throw new Error('hiveCreateAccount requires a username')
				const wallet = engine.wallet as any
				const accountIndex = params?.accountIndex ?? 0

				// 1. Derive the four SLIP-0048 role keys.
				const roles = ['owner', 'active', 'posting', 'memo'] as const
				const keys: Record<string, string> = {}
				for (const role of roles) {
					const r = await wallet.hiveGetPublicKey({ addressNList: hiveRolePath(role, accountIndex), showDisplay: false })
					if (!r?.publicKey) throw new Error(`hiveGetPublicKey(${role}) returned no key`)
					keys[role] = r.publicKey
				}

				// 2. Device attestation — owner-signed account_create (op 9). The device
				//    re-derives the keys itself; ref_block/expiration are unchecked by the
				//    server (attestation only, not broadcast). On the emulator, route
				//    through emuSigningOp so the interactive Confirm/Reject gate appears;
				//    a real device uses its physical button (calling emuSigningOp there
				//    would pop the emulator window).
				const signAccountCreate = () => wallet.hiveSignAccountCreate({
					addressNList: hiveRolePath('owner', accountIndex),
					refBlockNum: 0, refBlockPrefix: 0, expiration: 0,
					creator: 'keepkey',
					newAccountName: username,
					ownerKey: keys.owner, activeKey: keys.active,
					postingKey: keys.posting, memoKey: keys.memo,
					feeAmount: 3000,
				})
				const signed = engine.isEmulator
					? await emuSigningOp(signAccountCreate, { operation: 'hiveSignAccountCreate', chain: 'Hive' })
					: await signAccountCreate()
				if (!signed?.signature || !signed?.serializedTx) {
					throw new Error('Device did not return an attestation')
				}
				const toHex = (v: any) => v instanceof Uint8Array ? Buffer.from(v).toString('hex') : String(v)

				// 3. ETH gate (anti-sponsor-drain). Sign a fixed EIP-191 message bound to
				//    username+ownerKey with the device ETH key (m/44'/60'/0'/0/0). The
				//    server recovers the address, requires it to hold mainnet ETH, and
				//    allows one sponsored account per address. Message bytes are pinned by
				//    a server unit test — do NOT reformat (no trailing newline).
				const gateMessage = `KeepKey Hive onboarding\nusername:${username}\nowner:${keys.owner}`
				const gateMessageHex = '0x' + Buffer.from(gateMessage, 'utf8').toString('hex')
				const signEthGate = () => wallet.ethSignMessage({ addressNList: evmAddressPath(0), message: gateMessageHex })
				const ethSigned = engine.isEmulator
					? await emuSigningOp(signEthGate, { operation: 'ethSignMessage', chain: 'Ethereum', memo: gateMessage.slice(0, 64) })
					: await signEthGate()
				// hdwallet returns { address: eip55 0x…, signature: 0x…+65-byte r||s||v } —
				// exactly the form ethers.verifyMessage expects.
				if (!ethSigned?.address || !ethSigned?.signature) {
					throw new Error('Device did not return an ETH gate signature')
				}

				// 4. POST to the sponsor endpoint.
				const base = getPioneerApiBase()
				const resp = await fetch(`${base}/api/v1/hive/create-account`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						username,
						ownerKey: keys.owner, activeKey: keys.active,
						postingKey: keys.posting, memoKey: keys.memo,
						attestation: { serializedTx: toHex(signed.serializedTx), signature: toHex(signed.signature) },
						ethAddress: ethSigned.address,
						ethSignature: ethSigned.signature,
					}),
				})
				const body = await resp.json().catch(() => ({}))
				return { status: resp.status, ...body }
			},
			hiveSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				// Route through emuSigningOp on the emulator so the interactive
				// Confirm/Reject gate appears (a real device uses its button).
				const signTx = () => (engine.wallet as any).hiveSignTx(params)
				const result = engine.isEmulator
					? await emuSigningOp(signTx, { operation: 'hiveSignTx', chain: 'Hive', to: params?.to, value: params?.amount != null ? String(params.amount) : undefined })
					: await signTx()
				if (!result) throw new Error('hiveSignTx returned no result')
				return {
					signature: result.signature instanceof Uint8Array
						? Buffer.from(result.signature).toString('hex')
						: result.signature,
					serializedTx: result.serializedTx instanceof Uint8Array
						? Buffer.from(result.serializedTx).toString('hex')
						: result.serializedTx,
				}
			},

			// ── Pioneer integration (batch portfolio API) ────────────────
			getBalances: async ({ forceRefresh = false } = {}) => {
				if (!engine.wallet) throw new Error('No device connected')

				// Initialize Pioneer client — isolate failure so device derivation still works
				let pioneer: any = null
				let pioneerInitError: Error | null = null
				try {
					pioneer = await getPioneer()
				} catch (e: any) {
					pioneerInitError = e instanceof Error ? e : new Error(e?.message || String(e))
					console.warn('[getBalances] Pioneer init failed (will return zero balances):', e.message)
					// Notify UI so user can change server or get support
					try { rpc.send['pioneer-error']({ message: e.message, url: getPioneerApiBase() }) } catch { /* webview not ready */ }
				}

				const wallet = engine.wallet as any

				// Seed-staleness boundary (shared by all manager consumers): verify
				// the in-memory managers against the DEVICE — not cached session
				// state — and purge them if they belong to a previous wallet
				// (passphrase toggled, hidden↔standard transition, cached-passphrase
				// reconnect) so the init guards below re-derive from the current
				// seed. Result-based on purpose: the event-based resets each have
				// blind spots (see src/shared/seed-reconcile.ts) and customers kept
				// seeing the previous wallet's addresses/balances. `truth` is stamped
				// onto the managers after init so the BTC-only path stays detectable.
				const { truth: liveSeedIdentity } = await ensureManagersForSeed('getBalances')

				// Initialize BTC multi-account on first balance fetch
				if (!btcAccounts.isInitialized) {
					try { await btcAccounts.initialize(wallet) } catch (e: any) {
						console.warn('[getBalances] BTC accounts init failed:', e.message)
					}
				}

				// Filter chains by firmware version — don't derive addresses for unsupported chains
				// Zcash (transparent + shielded) gated behind feature flag
				const fwVersion = engine.getDeviceState().firmwareVersion
				const allChains = getAllChains().filter(c => {
					if (!isChainSupported(c, fwVersion)) return false
					if ((c.id === 'zcash' || c.id === 'zcash-shielded') && !zcashPrivacyEnabled) return false
					if (c.id === 'hive' && !hiveEnabled) return false
					return true
				})
				const utxoChains = allChains.filter(c => c.chainFamily === 'utxo' && c.id !== 'bitcoin')
				const nonUtxoChains = allChains.filter(c => c.chainFamily !== 'utxo')

				// 1. Batch-fetch non-BTC UTXO xpubs in a single device call.
				// LTC supports multiple script types (p2pkh, p2sh-p2wpkh, p2wpkh) — derive
				// all so Pioneer reports balances from every address type.
				const utxoPubKeyPaths: Array<{ chain: typeof utxoChains[0]; scriptType: string; path: number[] }> = []
				for (const c of utxoChains) {
					for (const sp of utxoAccountScriptPaths(c, 0)) {
						utxoPubKeyPaths.push({ chain: c, scriptType: sp.scriptType, path: sp.path })
					}
				}
				let xpubResults: any[] = []
				try {
					if (utxoPubKeyPaths.length > 0) {
						xpubResults = await wallet.getPublicKeys(utxoPubKeyPaths.map(p => ({
							addressNList: p.path,
							coin: p.chain.coin,
							scriptType: p.scriptType,
							curve: 'secp256k1',
						}))) || []
					}
				} catch (e: any) {
					console.warn('[getBalances] UTXO xpub batch failed:', e.message)
				}

				// 2. Derive non-UTXO addresses (one device call per chain — unavoidable)
				const pubkeys: Array<{ caip: string; pubkey: string; chainId: string; symbol: string; networkId: string }> = []

				for (let i = 0; i < utxoPubKeyPaths.length; i++) {
					const xpub = xpubResults?.[i]?.xpub
					const c = utxoPubKeyPaths[i].chain
					if (xpub) pubkeys.push({ caip: c.caip, pubkey: xpub, chainId: c.id, symbol: c.symbol, networkId: c.networkId })
				}

				// Initialize EVM multi-address manager
				const evmChains = nonUtxoChains.filter(c => c.chainFamily === 'evm')
				const nonEvmChains = nonUtxoChains.filter(c => c.chainFamily !== 'evm')

				if (!evmAddresses.isInitialized) {
					try { await evmAddresses.initialize(wallet) } catch (e: any) {
						console.warn('[getBalances] EVM addresses init failed:', e.message)
					}
				}

				// Managers now reflect the current seed — stamp it so the next
				// consumer (getBalance / buildTx / getBtcAccounts) can detect a
				// subsequent change even before another full getBalances runs.
				stampManagers(liveSeedIdentity)

				// Reset EVM balances before aggregation
				evmAddresses.resetBalances()

				// Add N addresses × M EVM chains to pubkeys
				const evmPubkeyEntries = evmAddresses.getAllPubkeyEntries(evmChains)
				const evmAddressSet = new Set(evmAddresses.toAddressSet().addresses.map(a => a.address.toLowerCase()))
				for (const entry of evmPubkeyEntries) {
					pubkeys.push({ caip: entry.caip, pubkey: entry.pubkey, chainId: entry.chainId, symbol: entry.symbol, networkId: entry.networkId })
				}

				// Non-EVM, non-UTXO chains (cosmos, xrp, etc.) — skip hidden chains (e.g. zcash-shielded has dedicated RPC)
				console.log(`[getBalances] nonEvmChains to derive: ${nonEvmChains.filter(c => !c.hidden).map(c => c.id).join(', ')}`)
				for (const chain of nonEvmChains) {
					if (chain.hidden) continue
					const t0 = Date.now()
					try {
						const addrParams: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.coin }
						if (chain.scriptType) addrParams.scriptType = chain.scriptType
						// TON: always non-bounceable (UQ) — bounceable (EQ) bounces if wallet uninitialized
						if (chain.chainFamily === 'ton') addrParams.bounceable = false
						const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
						const result = await wallet[method](addrParams)
						const address = typeof result === 'string' ? result : result?.address || result?.publicKey || ''
						const ms = Date.now() - t0
						if (address) {
							console.log(`[getBalances] ${chain.id} address derived in ${ms}ms: ${address.substring(0, 20)}... caip=${chain.caip}`)
							pubkeys.push({ caip: chain.caip, pubkey: address, chainId: chain.id, symbol: chain.symbol, networkId: chain.networkId })
						} else {
							console.warn(`[getBalances] ${chain.id} address empty after ${ms}ms! method=${method} result=${JSON.stringify(result)}`)
						}
					} catch (e: any) {
						console.warn(`[getBalances] ${chain.id} address THREW (${Date.now() - t0}ms): ${e.message}`)
					}
				}
				console.log(`[getBalances] pubkeys after nonEVM derivation: ${pubkeys.length} total (nonEVM added: ${pubkeys.filter(p => !['bitcoin','litecoin','dogecoin','bitcoincash','dash','digibyte','zcash'].includes(p.chainId) && !p.chainId.startsWith('evm')).length})`)

				// 3. Add ALL BTC xpubs from multi-account manager
				const btcChain = allChains.find(c => c.id === 'bitcoin')!
				let btcPubkeyEntries = btcAccounts.getAllPubkeyEntries(btcChain.caip)

				// Fallback: if btcAccounts didn't initialize, try cached pubkeys from DB
				if (btcPubkeyEntries.length === 0) {
					const devId = engine.getDeviceState().deviceId
					if (devId) {
						const cachedPks = getCachedPubkeys(devId)
						const btcPks = cachedPks.filter(p => p.chainId === 'bitcoin' && p.xpub)
						if (btcPks.length > 0) {
							btcPubkeyEntries = btcPks.map(p => ({ caip: btcChain.caip, pubkey: p.xpub }))
							console.log(`[getBalances] BTC xpubs from cached_pubkeys DB fallback: ${btcPubkeyEntries.length}`)
						}
					}
				}

				// Track BTC entries separately for per-xpub balance update
				const btcPubkeySet = new Set(btcPubkeyEntries.map(e => e.pubkey))
				for (const entry of btcPubkeyEntries) {
					pubkeys.push({ caip: entry.caip, pubkey: entry.pubkey, chainId: 'bitcoin', symbol: 'BTC', networkId: btcChain.networkId })
				}

				// ── Address Book: mirror own-wallet addresses (R2) ──────────────
				// Fire-and-forget, fully guarded — must never break the balance path.
				// Runs here (not on 'ready') because addresses only exist once the
				// managers have derived them above. evmPubkeyEntries is the N×M
				// cartesian, so own EVM rows are stored one-per-network for the
				// exact-networkId Send picker (decision: own addresses are pickable).
				try {
					const abScope = getWalletDbScope()
					if (abScope && !engine.isPassphraseWallet) {
						const chainById = new Map(allChains.map(c => [c.id, c]))
						const own: OwnAddressSeed[] = []
						for (const e of evmPubkeyEntries) {
							own.push({
								address: e.pubkey, networkId: e.networkId, chainId: e.chainId, chainFamily: 'evm',
								symbol: e.symbol, addressIndex: e.addressIndex,
								derivationPath: `m/44'/60'/${e.addressIndex}'/0/0`,
								label: `${e.symbol} #${e.addressIndex}`,
							})
						}
						for (const m of btcAccounts.getAllXpubMeta()) {
							own.push({
								address: m.xpub, networkId: btcChain.networkId, chainId: 'bitcoin', chainFamily: 'utxo',
								symbol: 'BTC', scriptType: m.scriptType, addressIndex: m.accountIndex,
								derivationPath: 'm/' + m.path.map(n => n >= 0x80000000 ? `${n - 0x80000000}'` : `${n}`).join('/'),
								label: `BTC ${m.scriptType} #${m.accountIndex}`,
							})
						}
						for (const p of pubkeys) {
							const ch = chainById.get(p.chainId)
							if (!ch || ch.chainFamily === 'evm' || p.chainId === 'bitcoin') continue
							const isXpub = ch.chainFamily === 'utxo'
							own.push({
								address: p.pubkey, networkId: p.networkId, chainId: p.chainId, chainFamily: ch.chainFamily,
								symbol: p.symbol, label: isXpub ? `${p.symbol} (xpub)` : `My ${p.symbol}`,
							})
						}
						const insertedOwn = syncOwnAddressBook(abScope, own)
						if (insertedOwn > 0) { try { rpc.send['addressbook-changed']({}) } catch { /* webview not ready */ } }
					}
				} catch (e: any) {
					console.warn('[getBalances] addressbook own-sync failed:', e?.message)
				}

				console.log(`[getBalances] ${pubkeys.length} pubkeys (${btcPubkeyEntries.length} BTC xpubs) → chunked GetPortfolioBalances calls`)

				// Build networkId → chainId lookup for token grouping (lowercase keys — Pioneer may return different casing)
				const networkToChain = new Map<string, string>()
				for (const chain of allChains) {
					if (!chain.networkId) continue
					// Non-hidden chains take priority (zcash vs zcash-shielded share the same networkId)
					if (chain.hidden && networkToChain.has(chain.networkId.toLowerCase())) continue
					networkToChain.set(chain.networkId.toLowerCase(), chain.id)
				}

				// 3. Chunked API calls — GetPortfolioBalances returns natives + tokens in one flat array
				const results: ChainBalance[] = []
				try {
					if (!pioneer) throw (pioneerInitError || new Error('Pioneer client not available'))
					const extraContracts = getCustomTokens().map(ct => ({
						networkId: ct.networkId,
						contractAddress: ct.contractAddress,
						decimals: ct.decimals,
						symbol: ct.symbol,
						name: ct.name,
						icon: ct.iconUrl,
					}))
					const pubkeyChunks = chunkArray(pubkeys, PIONEER_PORTFOLIO_CHUNK_SIZE)
					const chunkResults = await withTimeout(
						mapWithConcurrency(pubkeyChunks, PIONEER_PORTFOLIO_MAX_CONCURRENCY, async (chunk, i) => {
							// Opt the dashboard refresh into the server's DeFi merge. Server-side
							// is cached, so the per-pubkey Zapper lookup is typically a Redis
							// read; misses degrade to [] without blocking balances. Pre-v1.4
							// servers ignore the field and return the legacy shape unchanged.
							const chunkBody: any = { pubkeys: chunk.map(p => ({ caip: p.caip, pubkey: p.pubkey })), includeDefi: true }
							if (extraContracts.length > 0) chunkBody.extraContracts = extraContracts
							try {
								let resp: any
								try {
									resp = await withTimeout(
										pioneer.GetPortfolioBalances(chunkBody, { forceRefresh }),
										PIONEER_PORTFOLIO_CHUNK_TIMEOUT_MS,
										`GetPortfolioBalances chunk ${i + 1}/${pubkeyChunks.length}`
									)
								} catch (err: any) {
									if (!extraContracts.length || !isExtraContractsSchemaError(err)) throw err
									console.warn('[getBalances] Pioneer rejected extraContracts; retrying portfolio chunk without custom tokens')
									resp = await withTimeout(
										pioneer.GetPortfolioBalances(
											{ pubkeys: chunkBody.pubkeys, includeDefi: true },
											{ forceRefresh }
										),
										PIONEER_PORTFOLIO_CHUNK_TIMEOUT_MS,
										`GetPortfolioBalances chunk ${i + 1}/${pubkeyChunks.length}`
									)
								}
								const { entries, meta, defiPositions } = unwrapPortfolioResponse(resp)
								return { entries, meta, defiPositions, error: null as string | null }
							} catch (err: any) {
								const sampleChains = chunk.map((p: any) => String(p.caip || '').split('/')[0]).join(', ')
								const error = getPioneerPortfolioErrorMessage(err)
								console.warn(`[getBalances] Portfolio chunk ${i + 1}/${pubkeyChunks.length} failed (${sampleChains}):`, error)
								return { entries: [] as any[], meta: null as PortfolioMeta | null, defiPositions: null as ServerDefiPosition[] | null, error }
							}
						}),
						PIONEER_PORTFOLIO_TOTAL_TIMEOUT_MS,
						'GetPortfolioBalances chunks'
					)
					const failedChunkCount = chunkResults.filter(r => r.error).length
					let hadChunkFailures = false
					// effectivePubkeys: pubkeys whose chunk succeeded — chains from failed chunks show 0
					let effectivePubkeys = pubkeys
					if (failedChunkCount > 0) {
						hadChunkFailures = true
						const succeeded = pubkeyChunks.length - failedChunkCount
						console.warn(`[getBalances] Partial portfolio response: ${succeeded}/${pubkeyChunks.length} chunks succeeded — failed chains will show 0`)
						for (let i = 0; i < chunkResults.length; i++) {
							if (chunkResults[i].error) {
								const chains = pubkeyChunks[i].map((p: any) => p.chainId || String(p.caip).split(':')[0]).join(', ')
								console.warn(`[getBalances] Chunk ${i + 1} failed — excluded chains: ${chains}`)
							}
						}
						if (failedChunkCount === pubkeyChunks.length) {
							throw new Error(`All ${pubkeyChunks.length} portfolio chunks failed`)
						}
						// Key by caip:pubkey so a failed Hyperliquid entry (which shares the
						// ETH address as pubkey) doesn't exclude all other EVM chains.
						const failedPubkeySet = new Set<string>()
						for (let i = 0; i < chunkResults.length; i++) {
							if (chunkResults[i].error) {
								for (const p of pubkeyChunks[i]) failedPubkeySet.add(`${p.caip}:${p.pubkey}`)
							}
						}
						effectivePubkeys = pubkeys.filter(p => !failedPubkeySet.has(`${p.caip}:${p.pubkey}`))
					}
					// failedPubkeySet used below to gate DB writes — results always use all pubkeys
					// so chains from failed chunks still appear (with 0) rather than vanishing entirely.
					const failedPubkeySetForDb = new Set(
						effectivePubkeys.length < pubkeys.length
							? pubkeys.filter(p => !effectivePubkeys.includes(p)).map(p => `${p.caip}:${p.pubkey}`)
							: []
					)
					console.log(`[getBalances] effectivePubkeys: ${effectivePubkeys.length}/${pubkeys.length} — chains: ${[...new Set(effectivePubkeys.map(p => p.chainId))].join(', ')}`)
					const allEntries = chunkResults.flatMap(r => r.entries)
					const portfolioMeta = mergeMetas(chunkResults.map(r => r.meta).filter(Boolean) as PortfolioMeta[])

					// Aggregate server-merged DeFi positions across chunks and group by
					// chainId. The networkId on each position (eip155:N) maps cleanly
					// into the existing networkToChain table; positions on networks the
					// vault doesn't know about are dropped on the floor with a log.
					// NOTE: we deliberately do NOT suppress wallet tokens that share a
					// contract with a position's `tokens[]`. Those are the protocol's
					// *underlyings* (e.g. an LP's WETH, or the native-ETH zero address),
					// not wallet-held duplicates, and the server sends no position type
					// to tell an app-token (stETH = the position) from a contract/LP
					// position. Address-only suppression hid real, sendable balances, so
					// DeFi is purely additive: own panel + folded USD.
					// Pioneer chunks pubkeys, and one EVM address is reused across every
					// EVM chain (Account #0 on Ethereum, Optimism, Base, Arbitrum, …), so
					// it lands in multiple chunks. Each chunk response carries the FULL
					// DeFi list for that address, so flat-merging would add every position
					// once per chunk that contained the pubkey. Dedupe by
					// (pubkey, protocol, networkId) — first occurrence wins — before grouping.
					const rawDefiPositions: ServerDefiPosition[] = chunkResults.flatMap(r => r.defiPositions || [])
					const allDefiPositions: ServerDefiPosition[] = []
					const seenDefiKey = new Set<string>()
					for (const sp of rawDefiPositions) {
						const key = `${String(sp.pubkey || '').toLowerCase()}|${sp.protocol || ''}|${(sp.networkId || '').toLowerCase()}`
						if (seenDefiKey.has(key)) continue
						seenDefiKey.add(key)
						allDefiPositions.push(sp)
					}
					if (rawDefiPositions.length !== allDefiPositions.length) {
						console.log(`[getBalances] DeFi dedup: ${rawDefiPositions.length} raw → ${allDefiPositions.length} unique (chunked duplicates collapsed)`)
					}
					const defiByChain = new Map<string, DefiPosition[]>()
					const defiByChainAndOwner = new Map<string, Map<string, DefiPosition[]>>()
					let droppedDefi = 0
					for (const sp of allDefiPositions) {
						const networkId = (sp.networkId || '').toLowerCase()
						const chainId = networkId ? (networkToChain.get(networkId) || null) : null
						if (!chainId) { droppedDefi++; continue }
						const ownerAddr = String(sp.pubkey || '').toLowerCase()
						const dp: DefiPosition = {
							protocol: sp.protocol || null,
							displayName: sp.displayName,
							name: sp.displayName || sp.protocol || 'DeFi Position',
							network: sp.network,
							networkId: sp.networkId,
							balanceUsd: Number(sp.balanceUsd) || 0,
							icon: sp.icon,
							tokens: Array.isArray(sp.tokens) ? sp.tokens.map(t => ({
								networkId: t.networkId,
								address: String(t.address || '').toLowerCase(),
								symbol: t.symbol,
								balance: t.balance != null ? String(t.balance) : undefined,
								balanceUsd: typeof t.balanceUsd === 'number' ? t.balanceUsd : undefined,
							})).filter(t => !!t.address) : [],
						}
						// Chain-level (dashboard chain row)
						const chainList = defiByChain.get(chainId) || []
						chainList.push(dp)
						defiByChain.set(chainId, chainList)
						// Owner-level (per-account drilldown)
						if (ownerAddr) {
							let perOwner = defiByChainAndOwner.get(chainId)
							if (!perOwner) { perOwner = new Map(); defiByChainAndOwner.set(chainId, perOwner) }
							const list = perOwner.get(ownerAddr) || []
							list.push(dp)
							perOwner.set(ownerAddr, list)
						}
					}
					if (allDefiPositions.length > 0) {
						console.log(`[getBalances] DeFi: ${allDefiPositions.length} positions across ${defiByChain.size} chain(s)${droppedDefi ? ` (${droppedDefi} dropped: unknown networkId)` : ''}`)
					}

					console.log(`[getBalances] GetPortfolioBalances response: ${allEntries.length} entries`)
					// Log TRON-specific entries for debugging
					const tronEntries = allEntries.filter((d: any) => d.caip?.includes('tron') || d.networkId?.includes('tron'))
					if (tronEntries.length > 0) {
						console.log(`[getBalances] TRON entries from Pioneer: ${tronEntries.length}`)
						for (const t of tronEntries) console.log(`  TRON: caip=${t.caip}, pubkey=${t.pubkey}, address=${t.address}, balance=${t.balance}, usd=${t.valueUsd}, type=${t.type}`)
					} else {
						console.warn(`[getBalances] TRON: NO entries returned from Pioneer`)
					}
					// Log BTC-specific entries for debugging
					const btcNatives = allEntries.filter((d: any) => d.caip?.includes('bip122') || d.pubkey?.startsWith('xpub') || d.pubkey?.startsWith('ypub') || d.pubkey?.startsWith('zpub'))
					console.log(`[getBalances] BTC entries from Pioneer: ${btcNatives.length}`)
					for (const b of btcNatives) {
						console.log(`  BTC: caip=${b.caip}, pubkey=${String(b.pubkey).substring(0, 24)}..., balance=${b.balance}, valueUsd=${b.valueUsd}, address=${b.address}`)
					}

					// Classify entries into natives vs tokens
					const pureNatives: any[] = []
					const tokenEntries: any[] = []
					for (const entry of allEntries) {
						const caip = entry.caip || ''
						const caipPath = caip.split('/')[1] || ''
						const isTokenByCaip = caipPath && !caipPath.startsWith('slip44:') && !caipPath.startsWith('native:')
						const isTokenByType = entry.type === 'token' || (entry.isNative === false && entry.contract)
						if (isTokenByCaip || isTokenByType) {
							tokenEntries.push(entry)
						} else {
							pureNatives.push(entry)
						}
					}

					console.log(`[getBalances] After classification: ${pureNatives.length} natives, ${tokenEntries.length} tokens`)

					// Log Solana-specific entries for debugging
					const solanaEntries = allEntries.filter((d: any) => d.caip?.includes('solana') || d.networkId?.includes('solana'))
					console.log(`[getBalances] Solana entries from Pioneer: ${solanaEntries.length}`)
					for (const s of solanaEntries) console.log(`  SOL: caip=${s.caip}, type=${s.type}, symbol=${s.symbol}, balance=${s.balance}, usd=${s.valueUsd}, networkId=${s.networkId}, contract=${s.contract}`)

					// Group tokens by their parent chain (via networkId or CAIP prefix)
					// Also log the networkToChain map so we can audit matching
					console.log(`[getBalances] networkToChain map (${networkToChain.size} entries): ${JSON.stringify(Object.fromEntries(networkToChain))}`)

					const tokensByChainId = new Map<string, TokenBalance[]>()
					const evmTokensByOwner = new Map<string, TokenBalance[]>()
					let tokensSkippedZero = 0, tokensSkippedNoChain = 0, tokensGrouped = 0
					// Dedup by (caip, ownerAddress) before accumulation so Pioneer returning the same
					// token multiple times for the same address doesn't inflate the balance.
					const seenByOwnerCaip = new Set<string>()
					for (const tok of tokenEntries) {
						const bal = parseFloat(String(tok.balance ?? '0'))
						if (bal <= 0) { tokensSkippedZero++; continue }
						const ownerAddr = String(tok.address || tok.pubkey || '').toLowerCase()
						const caipNorm = (tok.caip || '').startsWith('eip155:') ? (tok.caip || '').toLowerCase() : (tok.caip || '')
						const ownerCaipKey = `${caipNorm}|${ownerAddr}`
						if (seenByOwnerCaip.has(ownerCaipKey)) { tokensSkippedZero++; continue }
						seenByOwnerCaip.add(ownerCaipKey)

						// Determine parent chainId from networkId or CAIP-2 prefix (lowercase — Pioneer may return different casing)
						const tokNetworkId = (tok.networkId || '').toLowerCase()
						const caipPrefix = ((tok.caip || '').split('/')[0]).toLowerCase() // e.g. "eip155:1"
						const parentChainId = networkToChain.get(tokNetworkId) || networkToChain.get(caipPrefix) || null
						if (!parentChainId) {
							tokensSkippedNoChain++
							console.warn(`[getBalances] Token DROPPED (no parent chain): ${tok.symbol} caip=${tok.caip} networkId=${tokNetworkId} caipPrefix=${caipPrefix} bal=${bal} usd=${tok.valueUsd}`)
							continue
						}

						// Extract contract address from CAIP:
						//   ERC-20: "eip155:1/erc20:0xdac17..." → "0xdac17..."
						//   SPL:    "solana:5eykt4.../spl:TokenMint..." → "TokenMint..."
						//   TRC-20: "tron:27Lqcw/trc20:T..." → "T..."
						//   denom:  "cosmos:thorchain-mainnet-v1/denom:tcy" → "tcy" (cosmos bank denom)
						const contractMatch = (tok.caip || '').match(/\/(erc20|spl|trc20|token|denom|bank):([^\s]+)/)
						const contractAddress = contractMatch?.[2] || tok.contract || undefined

						const rawValueUsd = tok.valueUsd
						const rawPriceUsd = tok.priceUsd
						const parsedBalanceUsd = Number(rawValueUsd ?? 0)
						const parsedPriceUsd = Number(rawPriceUsd ?? 0)

						const token: TokenBalance = {
							symbol: tok.symbol || '???',
							name: tok.name || tok.symbol || 'Unknown Token',
							balance: String(tok.balance ?? '0'),
							balanceUsd: parsedBalanceUsd,
							priceUsd: parsedPriceUsd,
							caip: tok.caip || '',
							contractAddress,
							networkId: tokNetworkId || caipPrefix,
							icon: tok.icon || undefined,
							decimals: tok.decimals ?? tok.precision,
							type: tok.type || 'token',
							dataSource: tok.dataSource,
						}

						const existing = tokensByChainId.get(parentChainId) || []
						existing.push(token)
						tokensByChainId.set(parentChainId, existing)

						const ownerAddress = String(tok.address || tok.pubkey || '').toLowerCase()
						if (ownerAddress && evmAddressSet.has(ownerAddress)) {
							const ownerKey = `${parentChainId}:${ownerAddress}`
							const ownerTokens = evmTokensByOwner.get(ownerKey) || []
							ownerTokens.push(token)
							evmTokensByOwner.set(ownerKey, ownerTokens)
						}
						tokensGrouped++
					}

					console.debug(`[getBalances] Token grouping: ${tokensGrouped} grouped, ${tokensSkippedZero} skipped (zero bal), ${tokensSkippedNoChain} DROPPED (no parent chain)`)

					// Deduplicate tokens within each chain by normalized CAIP.
					// EVM addresses are case-insensitive hex — normalize for dedup only (caip on
					// the object stays canonical). Non-EVM identifiers (Solana base58 mint,
					// Tron base58check) are case-sensitive — keep them exact.
					// When Pioneer returns the same ERC-20 for multiple EVM address indices,
					// sum their balances so portfolio value is not underreported.
					for (const [chainId, chainTokens] of tokensByChainId) {
						const seen = new Map<string, TokenBalance>()
						for (const tok of chainTokens) {
							const key = tok.caip.startsWith('eip155:') ? tok.caip.toLowerCase() : tok.caip
							const existing = seen.get(key)
							if (!existing) {
								seen.set(key, { ...tok })
							} else {
								existing.balance = String(parseFloat(existing.balance) + parseFloat(tok.balance || '0'))
								existing.balanceUsd += tok.balanceUsd
							}
						}
						if (seen.size < chainTokens.length) {
							console.debug(`[getBalances] Deduped ${chainId}: ${chainTokens.length} → ${seen.size} tokens`)
							tokensByChainId.set(chainId, [...seen.values()])
						}
					}

					// EVM AssetPage shows per-address tokens from evmTokensByOwner, not tokensByChainId.
					// Pioneer returns the same token multiple times per address — dedup that map too.
					for (const [ownerKey, ownerTokens] of evmTokensByOwner) {
						const seen = new Map<string, TokenBalance>()
						for (const tok of ownerTokens) {
							const key = tok.caip.startsWith('eip155:') ? tok.caip.toLowerCase() : tok.caip
							const existing = seen.get(key)
							if (!existing) {
								seen.set(key, { ...tok })
							} else {
								existing.balance = String(parseFloat(existing.balance) + parseFloat(tok.balance || '0'))
								existing.balanceUsd += tok.balanceUsd
							}
						}
						if (seen.size < ownerTokens.length) {
							console.debug(`[getBalances] Deduped owner ${ownerKey}: ${ownerTokens.length} → ${seen.size} tokens`)
							evmTokensByOwner.set(ownerKey, [...seen.values()])
						}
					}

					// Aggregate BTC entries into one ChainBalance + update per-xpub balances
					console.debug(`[getBalances] pureNatives count: ${pureNatives.length}`)
					for (const n of pureNatives) {
						if (n.caip?.includes('bip122') || n.pubkey?.startsWith('xpub') || n.pubkey?.startsWith('ypub') || n.pubkey?.startsWith('zpub')) {
							console.debug(`[getBalances] BTC native entry: caip=${n.caip}, pubkey=${n.pubkey?.substring(0, 20)}..., balance=${n.balance}, usd=${n.valueUsd}`)
						}
					}
					let btcTotalBalance = 0
					let btcTotalUsd = 0
					let btcSelectedAddress = '' // address from the user's selected script type
					let btcFallbackAddress = '' // first address from any xpub (fallback)

					// Aggregate EVM entries per-chain (sum across address indices)
					const evmChainAgg = new Map<string, { balance: number; usd: number; address: string; symbol: string }>()

					const selectedXpubStr = btcAccounts.getSelectedXpub()?.xpub
					for (const entry of pubkeys) {
						const isFailedEntry = failedPubkeySetForDb.has(`${entry.caip}:${entry.pubkey}`)
						if (entry.chainId === 'bitcoin') {
							// Find the Pioneer response for this xpub
							const match = pureNatives.find((d: any) => d.pubkey === entry.pubkey)
								|| pureNatives.find((d: any) => d.caip === entry.caip && d.address === entry.pubkey)
							console.debug(`[getBalances] BTC match for ${entry.pubkey?.substring(0, 20)}...: ${match ? `balance=${match.balance}, usd=${match.valueUsd}` : 'NO MATCH'}`)
							const bal = parseFloat(String(match?.balance ?? '0'))
							const usd = Number(match?.valueUsd ?? 0)
							btcTotalBalance += bal
							btcTotalUsd += usd
							// Prefer address from user's selected xpub type for display + swaps
							if (match?.address) {
								if (!btcFallbackAddress) btcFallbackAddress = match.address
								if (selectedXpubStr && entry.pubkey === selectedXpubStr) btcSelectedAddress = match.address
							}
							// Update per-xpub balance in BtcAccountManager + persist to cache.
							// PRIVACY: Skip DB write for hidden passphrase wallets.
							// Skip if this entry came from a failed chunk (don't persist zeros).
							const xpubBal = String(match?.balance ?? '0')
							if (!isFailedEntry) {
								btcAccounts.updateXpubBalance(entry.pubkey, xpubBal, usd)
								try {
									const devId = engine.getDeviceState().deviceId
									// force=true: Pioneer responded for this xpub — write even if balance is 0 to clear stale cache
									if (devId && !engine.isPassphraseWallet) saveCachedPubkey(devId, 'bitcoin', entry.pubkey, entry.pubkey, match?.address || '', '', xpubBal, usd, true)
								} catch { /* non-fatal */ }
							}
							continue
						}

						// EVM multi-address: aggregate per-chain and keep per-address chain balances
						if (evmAddressSet.has(entry.pubkey.toLowerCase())) {
							const match = pureNatives.find((d: any) => d.caip === entry.caip && d.pubkey === entry.pubkey)
								|| pureNatives.find((d: any) => d.caip === entry.caip && d.address?.toLowerCase() === entry.pubkey.toLowerCase())
							const bal = parseFloat(String(match?.balance ?? '0'))
							const usd = Number(match?.valueUsd ?? 0)
							const ownerLower = entry.pubkey.toLowerCase()
							const ownerDefiPositions = defiByChainAndOwner.get(entry.chainId)?.get(ownerLower)
							const entryTokens = evmTokensByOwner.get(`${entry.chainId}:${ownerLower}`) || []
							const entryTokenUsd = entryTokens.reduce((sum, t) => sum + t.balanceUsd, 0)
							const ownerDefiUsd = ownerDefiPositions?.reduce((sum, p) => sum + (p.balanceUsd || 0), 0) || 0
							evmAddresses.setAddressChainBalance(entry.pubkey, entry.chainId, {
								chainId: entry.chainId,
								symbol: entry.symbol,
								balance: bal > 0 ? bal.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') : '0',
								balanceUsd: usd + entryTokenUsd + ownerDefiUsd,
								nativeBalanceUsd: usd,
								tokens: entryTokens.length > 0 ? entryTokens : undefined,
								defiPositions: ownerDefiPositions && ownerDefiPositions.length > 0 ? ownerDefiPositions : undefined,
							})
							// Accumulate per-chain totals
							const existing = evmChainAgg.get(entry.chainId)
							if (existing) {
								existing.balance += bal
								existing.usd += usd
								// Keep the selected index address as display address
								const selectedAddr = evmAddresses.getSelectedAddress()
								if (selectedAddr && entry.pubkey.toLowerCase() === selectedAddr.address.toLowerCase()) {
									existing.address = entry.pubkey
								}
							} else {
								evmChainAgg.set(entry.chainId, { balance: bal, usd, address: entry.pubkey, symbol: entry.symbol })
							}
							continue
						}

						// Match by CAIP, then by networkId prefix (handles slip44 vs native CAIP variants),
						// then pubkey, then address field (Pioneer may use either)
						const entryNetwork = entry.caip.split('/')[0] // e.g. "tron:0x2b6653dc"
						const match = pureNatives.find((d: any) => d.caip === entry.caip)
							|| pureNatives.find((d: any) => d.caip && d.caip.split('/')[0] === entryNetwork)
							|| pureNatives.find((d: any) => d.pubkey === entry.pubkey)
							|| pureNatives.find((d: any) => d.address === entry.pubkey)
						const chainTokens = tokensByChainId.get(entry.chainId)
						// Sum token USD values into the chain total
						const tokenUsdTotal = chainTokens?.reduce((sum, t) => sum + t.balanceUsd, 0) || 0
						const nativeUsd = Number(match?.valueUsd ?? 0)
						results.push({
							chainId: entry.chainId, symbol: entry.symbol,
							balance: String(match?.balance ?? '0'),
							balanceUsd: nativeUsd + tokenUsdTotal,
							nativeBalanceUsd: nativeUsd,
							address: match?.address || entry.pubkey,
							tokens: chainTokens && chainTokens.length > 0 ? chainTokens : undefined,
						})
					}

					// Push aggregated EVM chain entries
					for (const [chainId, agg] of evmChainAgg) {
						const chainTokens = tokensByChainId.get(chainId)
						const tokenUsdTotal = chainTokens?.reduce((sum, t) => sum + t.balanceUsd, 0) || 0
						const chainDefi = defiByChain.get(chainId)
						const defiUsdTotal = chainDefi?.reduce((sum, p) => sum + (p.balanceUsd || 0), 0) || 0
						results.push({
							chainId,
							symbol: agg.symbol,
							balance: agg.balance > 0 ? agg.balance.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') : '0',
							// Chain total folds DeFi in so the dashboard $ keeps parity
							// with zapper.xyz net worth. Wallet tokens are no longer
							// suppressed, so a wallet-held app-token (e.g. stETH) that the
							// position also reports can double-count — accepted as the
							// lesser evil vs hiding sendable balances (see note above).
							balanceUsd: agg.usd + tokenUsdTotal + defiUsdTotal,
							nativeBalanceUsd: agg.usd,
							address: agg.address,
							tokens: chainTokens && chainTokens.length > 0 ? chainTokens : undefined,
							defiPositions: chainDefi && chainDefi.length > 0 ? chainDefi : undefined,
						})
					}

					// Push one aggregated BTC entry — use selected xpub's address so swaps/display match user's chosen script type
					if (btcPubkeyEntries.length > 0) {
						const btcAddress = btcSelectedAddress || btcFallbackAddress
						results.push({
							chainId: 'bitcoin', symbol: 'BTC',
							balance: btcTotalBalance > 0 ? btcTotalBalance.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '0',
							balanceUsd: btcTotalUsd,
							nativeBalanceUsd: btcTotalUsd,
							address: btcAddress || btcAccounts.getSelectedXpub()?.xpub || btcPubkeyEntries[0]?.pubkey || '',
						})
					}

					// Attach shielded ZEC as a synthetic token under native Zcash so the
					// dashboard renders it like an ERC20 sub-row. The Orchard FVK lives
					// in the local sidecar; the seed never left the device.
					// Only surface a shielded balance once the cached FVK has been PROVEN
					// to belong to the connected device. Otherwise a stale FVK from a
					// previous device/seed would show a phantom balance the user can't
					// actually spend. When not yet verified, kick off the device-match
					// check (which purges stale state on mismatch) and skip this round —
					// the balance appears on the next refresh once verified.
					if (zcashPrivacyEnabled && hasFvkLoaded() && !zcashDeviceVerified) {
						maybeStartBackgroundWalletVerification()
					}
					if (zcashPrivacyEnabled && hasFvkLoaded() && zcashDeviceVerified) {
						try {
							const shielded = await Promise.race([
								getShieldedBalance(),
								new Promise<null>(r => setTimeout(() => r(null), 5000)),
							])
							if (shielded && shielded.confirmed > 0) {
								const zcashEntry = results.find(r => r.chainId === 'zcash')
								if (zcashEntry) {
									const zcashCaip = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
									const zcashNative = pureNatives.find((d: any) => d.caip === zcashCaip)
									const zecPrice = parseFloat(zcashNative?.priceUsd ?? '0')
									const zecAmount = shielded.confirmed / 1e8
									const shieldedUsd = zecAmount * zecPrice
									zcashEntry.tokens = zcashEntry.tokens || []
									zcashEntry.tokens.push({
										symbol: 'zZEC',
										name: 'Shielded ZEC',
										balance: zecAmount.toFixed(8),
										balanceUsd: shieldedUsd,
										priceUsd: zecPrice,
										caip: 'bip122:00040fe8ec8471911baa1db1266ea15d/orchard:shielded',
										contractAddress: 'orchard',
										networkId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
										decimals: 8,
										type: 'shielded',
									})
									zcashEntry.balanceUsd = (zcashEntry.balanceUsd || 0) + shieldedUsd
								}
							}
						} catch (e: any) {
							console.warn('[getBalances] Shielded balance fetch failed:', e?.message || e)
						}
					}

					// Push updated BTC accounts to frontend and sync DB cache with aggregate total.
					// The DB entry (used by getCachedBalances → SwapDialog) would otherwise stay
					// as a single-xpub value; the in-memory manager always has the correct sum.
					// Use the real address from Pioneer (btcSelectedAddress/btcFallbackAddress) when
					// available — fall back to xpub only if Pioneer didn't return an address.
					// confirmedChainIds: chains where Pioneer returned a real response (not a failed chunk).
					// These are allowed to write 0 to the cache — genuine empty balance, not a transient failure.
					const confirmedChainIds = new Set(effectivePubkeys.map(p => p.chainId))
					// BTC is aggregated from multiple pubkeys — it's confirmed only if ALL its pubkeys succeeded.
					const btcConfirmed = btcPubkeyEntries.every(e => !failedPubkeySetForDb.has(`${e.caip}:${e.pubkey}`))
					if (btcConfirmed) confirmedChainIds.add('bitcoin')
					else confirmedChainIds.delete('bitcoin')

					// Mark that Pioneer has responded — prevents getBtcAccounts from re-loading stale DB rows
					if (btcPubkeyEntries.length > 0) btcAccounts.markPioneerFetched()

					{
						const btcSet = btcAccounts.toAccountSet()
						try { rpc.send['btc-accounts-update'](btcSet) } catch { /* webview not ready */ }
						try {
							const devId = engine.getDeviceState().deviceId
							if (devId && !engine.isPassphraseWallet && parseFloat(btcSet.totalBalance) >= 0) {
								updateCachedBalance(devId, {
									chainId: 'bitcoin', symbol: 'BTC',
									balance: btcSet.totalBalance,
									balanceUsd: btcSet.totalBalanceUsd,
									nativeBalanceUsd: btcSet.totalBalanceUsd,
									address: btcSelectedAddress || btcFallbackAddress || btcAccounts.getSelectedXpub()?.xpub || '',
								}, btcConfirmed)
							}
						} catch { /* non-fatal */ }
					}
					// Push updated EVM addresses to frontend
					try { rpc.send['evm-addresses-update'](evmAddresses.toAddressSet()) } catch { /* webview not ready */ }

					// Auto-discover EVM addresses with funds (background, non-blocking)
					if (evmChains.length > 0 && wallet) {
						evmAddresses.autoDiscover(wallet, pioneer, evmChains).then(({ discovered }) => {
							if (discovered.length > 0) {
								console.log(`[getBalances] Auto-discovered EVM addresses at indices: ${discovered.join(', ')}`)
								try { rpc.send['evm-addresses-update'](evmAddresses.toAddressSet()) } catch {}
							}
						}).catch(() => {})
					}

					// Cache balances (fire-and-forget).
					// Write partial results even on chunk failures — chains from failed chunks simply
					// won't be in results, so the next getCachedBalances staleness check will flag
					// them as missing and trigger another refresh. Partial is always better than nothing.
					// PRIVACY: Skip for passphrase wallets (hidden wallet data must not hit disk).
					try {
						const deviceId = engine.getDeviceState().deviceId || 'unknown'
						if (results.length > 0 && !engine.isPassphraseWallet) {
							setCachedBalances(deviceId, results, confirmedChainIds)
							rectifyWallet(deviceId, results)
						}
					} catch { /* never block on cache failure */ }

					// ── Fault disclosure ──
					// Surface degraded (fresh fetch failed) + stale (>5min cache) chains to the
					// webview through the existing pioneer-error banner channel. severity 'warning'
					// renders a soft banner (data shown but suspect); 'none' clears it. Hard
					// failures still throw → severity 'error' in the catch below.
					try {
						const caipToChain = (caip: string) => {
							const prefix = (caip.split('/')[0] || '').toLowerCase()
							const chainId = networkToChain.get(prefix)
							return chainId ? allChains.find(c => c.id === chainId) : allChains.find(c => c.networkId?.toLowerCase() === prefix)
						}
						const chainSymbol = (id: string) => allChains.find(c => c.id === id)?.symbol || id
						const caipToName = (caip: string) => {
							const ch = caipToChain(caip)
							return ch?.symbol || ch?.name || (caip.split(':')[0] || caip)
						}
						// Chains whose every pubkey landed in a failed chunk (timeout/error) are
						// degraded from the vault's view even when the server meta is clean.
						const chunkDegradedIds = [...new Set(pubkeys.map(p => p.chainId))].filter(id => !confirmedChainIds.has(id))
						const degradedChains = [...new Set([...chunkDegradedIds.map(chainSymbol), ...portfolioMeta.failures.map(f => caipToName(f.caip))])].filter(Boolean)
						const staleChains = [...new Set(portfolioMeta.staleChains.map(s => caipToName(s.caip)))].filter(Boolean)
						// chainId-granular fault sets for the Audit wizard (symbol arrays above
						// drive the banner; symbols collide across chains so the audit needs ids).
						// unresolvedFaultCount = faults that couldn't be mapped to a known chain,
						// so an unmappable fault still forbids a false "all clear".
						const degradedChainIds = new Set<string>(chunkDegradedIds)
						const staleChainIds = new Set<string>()
						let unresolvedFaultCount = 0
						for (const f of portfolioMeta.failures) { const ch = caipToChain(f.caip); if (ch) degradedChainIds.add(ch.id); else unresolvedFaultCount++ }
						for (const s of portfolioMeta.staleChains) { const ch = caipToChain(s.caip); if (ch) staleChainIds.add(ch.id); else unresolvedFaultCount++ }
						const staleMinutes = portfolioMeta.staleChains.length
							? Math.floor(Math.max(...portfolioMeta.staleChains.map(s => s.ageMs || 0)) / 60000)
							: 0
						if (degradedChains.length > 0 || staleChains.length > 0) {
							console.warn(`[getBalances] Fault: degraded=[${degradedChains.join(', ')}] stale=[${staleChains.join(', ')}] (${staleMinutes}m)`)
							rpc.send['pioneer-error']({ message: '', url: getPioneerApiBase(), severity: 'warning', degradedChains, staleChains, staleMinutes, degradedChainIds: [...degradedChainIds], staleChainIds: [...staleChainIds], unresolvedFaultCount })
						} else {
							rpc.send['pioneer-error']({ message: '', url: getPioneerApiBase(), severity: 'none' })
						}
					} catch { /* webview not ready */ }
				} catch (e: any) {
					const message = getPioneerPortfolioErrorMessage(e)
					console.warn('[getBalances] Portfolio API failed:', message)
					try { rpc.send['pioneer-error']({ message, url: getPioneerApiBase() }) } catch { /* webview not ready */ }
					throw new Error(`Balance server error: ${message}`)
				}

				// ── Final audit log ──
				const totalTokens = results.reduce((n, r) => n + (r.tokens?.length || 0), 0)
				const totalUsd = results.reduce((n, r) => n + (r.balanceUsd || 0), 0)
				console.log(`[getBalances] FINAL: ${results.length} chains, ${totalTokens} tokens, $${totalUsd.toFixed(2)}`)
				for (const r of results) {
					if (r.tokens && r.tokens.length > 0) {
						console.log(`[getBalances]   ${r.chainId}: ${r.tokens.length} tokens attached`)
					}
				}

				// ── Start SSE event stream for real-time tx notifications ──
				// Build address list: EVM individual accounts + non-UTXO non-EVM chains.
				// BTC/LTC/DOGE xpubs are excluded — watchtower derives and watches those server-side.
				const streamAddresses: AddressEntry[] = []
				for (const a of evmAddresses.toAddressSet().addresses) {
					if (a.address && a.networkId) streamAddresses.push({ address: a.address, networkId: a.networkId })
				}
				for (const p of pubkeys) {
					if (p.caip.startsWith('bip122:')) continue // UTXO — skip xpubs
					if (p.pubkey.startsWith('xpub') || p.pubkey.startsWith('ypub') || p.pubkey.startsWith('zpub') ||
					    p.pubkey.startsWith('dgub') || p.pubkey.startsWith('Ltub') || p.pubkey.startsWith('Mtub')) continue
					if (p.networkId && p.pubkey) streamAddresses.push({ address: p.pubkey, networkId: p.networkId })
				}
				if (streamAddresses.length > 0) {
					startEventStream(
						streamAddresses,
						(event) => {
							if (event.type === 'tx:incoming') {
								// event.data.type is the real direction ('incoming' | 'outgoing').
								// Forward it verbatim — frontend resyncs either way (both change the
								// balance) but only shows the "Incoming payment" toast for 'incoming'.
								console.log(`[event-stream] ${event.data.type} tx ${event.data.txid} → ${event.data.address} (${event.data.networkId})`)
								try { rpc.send['tx-push-received']({
									chain: event.data.caip,
									networkId: event.data.networkId,
									address: event.data.address,
									txid: event.data.txid,
									type: event.data.type,
								}) } catch { /* webview not ready */ }
							}
							if (event.type === 'tx:confirmed') {
								console.log(`[event-stream] Confirmed tx ${event.data.txid} (${event.data.confirmations} confs)`)
								try { rpc.send['tx-push-received']({ networkId: event.data.networkId, txid: event.data.txid, type: 'confirmed' }) } catch { /* webview not ready */ }
							}
						},
						(status) => {
							try { rpc.send['stream-status'](status) } catch { /* webview not ready */ }
						},
					)
				}

				return results
			},

			getBalance: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				const pioneer = await getPioneer()
				const wallet = engine.wallet as any

				// Shared seed-staleness boundary — a single-chain refresh (AssetPage,
				// tx-push, post-send) can run before a full getBalances, so it must
				// also verify the managers against the device and purge if stale.
				const { truth: liveSeedIdentity } = await ensureManagersForSeed('getBalance')

				// Build pubkey list — EVM chains send ALL multi-address entries, others send one
				const pubkeys: Array<{ caip: string; pubkey: string }> = []
				let displayAddress = '' // address shown in UI / used for swaps

				if (chain.id === 'bitcoin') {
					// BTC multi-account: send ALL xpubs (mirrors getBalances lines 1065-1086)
					if (!btcAccounts.isInitialized) {
						try { await btcAccounts.initialize(wallet) } catch (e: any) {
							console.warn(`[getBalance] BTC accounts init failed:`, e.message)
						}
					}
					let btcPubkeyEntries = btcAccounts.getAllPubkeyEntries(chain.caip)
					// Fallback: if btcAccounts empty, try cached pubkeys from DB (mirrors getBalances line 1069-1080)
					if (btcPubkeyEntries.length === 0) {
						const devId = engine.getDeviceState().deviceId
						if (devId) {
							const cachedPks = getCachedPubkeys(devId)
							const btcPks = cachedPks.filter(p => p.chainId === 'bitcoin' && p.xpub)
							if (btcPks.length > 0) {
								btcPubkeyEntries = btcPks.map(p => ({ caip: chain.caip, pubkey: p.xpub }))
								console.log(`[getBalance] BTC xpubs from cached_pubkeys DB fallback: ${btcPubkeyEntries.length}`)
							}
						}
					}
					// Last resort: derive single default xpub from device
					if (btcPubkeyEntries.length === 0) {
						const result = await wallet.getPublicKeys([{
							addressNList: chain.defaultPath.slice(0, 3),
							coin: chain.coin, scriptType: chain.scriptType, curve: 'secp256k1',
						}])
						const xpub = result?.[0]?.xpub || ''
						if (!xpub) throw new Error(`Could not derive xpub for ${chain.coin}`)
						btcPubkeyEntries = [{ caip: chain.caip, pubkey: xpub }]
					}
					for (const entry of btcPubkeyEntries) pubkeys.push({ caip: entry.caip, pubkey: entry.pubkey })
					// displayAddress left empty — UTXO: frontend auto-derives from device
				} else if (chain.chainFamily === 'utxo') {
					// Non-BTC UTXO: derive all script-type xpubs (LTC has 3, others have 1)
					const scriptTypes = chain.id === 'litecoin'
						? [{ scriptType: 'p2pkh', purpose: 44 }, { scriptType: 'p2sh-p2wpkh', purpose: 49 }, { scriptType: 'p2wpkh', purpose: 84 }]
						: [{ scriptType: chain.scriptType || 'p2pkh', purpose: 44 }]
					const paths = scriptTypes.map(st => ({
						addressNList: [st.purpose + 0x80000000, chain.defaultPath[1], 0x80000000],
						coin: chain.coin, scriptType: st.scriptType, curve: 'secp256k1',
					}))
					const results = await wallet.getPublicKeys(paths)
					let anyXpub = false
					for (let i = 0; i < scriptTypes.length; i++) {
						const xpub = results?.[i]?.xpub
						if (xpub) { pubkeys.push({ caip: chain.caip, pubkey: xpub }); anyXpub = true }
					}
					if (!anyXpub) throw new Error(`Could not derive xpub for ${chain.coin}`)
				} else if (chain.chainFamily === 'evm') {
					// EVM multi-address: send all tracked addresses (matches getBalances behavior)
					if (!evmAddresses.isInitialized) {
						try { await evmAddresses.initialize(wallet) } catch (e: any) {
							console.warn(`[getBalance] EVM addresses init failed:`, e.message)
						}
					}
					const evmEntries = evmAddresses.getAllPubkeyEntries([chain])
					if (evmEntries.length > 0) {
						for (const entry of evmEntries) pubkeys.push({ caip: entry.caip, pubkey: entry.pubkey })
						const selectedAddr = evmAddresses.getSelectedAddress()
						displayAddress = selectedAddr?.address || evmEntries[0].pubkey
					} else {
						// Fallback: derive single address if multi-address manager not ready
						const result = await wallet.ethGetAddress({ addressNList: chain.defaultPath, showDisplay: false, coin: 'Ethereum' })
						const addr = typeof result === 'string' ? result : result?.address || ''
						if (!addr) throw new Error(`Could not derive address for ${chain.coin}`)
						pubkeys.push({ caip: chain.caip, pubkey: addr })
						displayAddress = addr
					}
				} else {
					const addrParams: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.coin }
					if (chain.scriptType) addrParams.scriptType = chain.scriptType
					if (chain.chainFamily === 'ton') addrParams.bounceable = false
					const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
					const result = await wallet[method](addrParams)
					const addr = typeof result === 'string' ? result : result?.address || ''
					if (!addr) throw new Error(`Could not derive address for ${chain.coin}`)
					pubkeys.push({ caip: chain.caip, pubkey: addr })
					displayAddress = addr
				}

				// Stamp the seed the (possibly just-initialized) managers belong to.
				// Safe even for non-BTC/EVM chains: reconcileSeedManagers nulls an
				// orphan stamp when no manager is initialized.
				stampManagers(liveSeedIdentity)

				// Single portfolio call with all pubkeys for this chain
				const isBtc = chain.id === 'bitcoin'
				const isEvm = chain.chainFamily === 'evm'
				const isUtxo = chain.chainFamily === 'utxo'
				let balance = '0', balanceUsd = 0, address = displayAddress
				let tokens: TokenBalance[] | undefined
				let chainDefiPositions: DefiPosition[] | undefined
				// Snapshot pre-refresh address from cache so we can preserve it on Pioneer failure (Finding 3)
				let cachedAddress = ''
				try {
					const devId = engine.getDeviceState().deviceId
					if (devId) {
						const cached = getCachedBalances(devId)
						cachedAddress = cached?.balances.find(b => b.chainId === chain.id)?.address || ''
					}
				} catch { /* cache lookup failed, non-fatal */ }

				// Reset this chain's per-address balances before single-chain refresh.
				if (isEvm) evmAddresses.resetBalances(chain.id)

				try {
					const extraContracts = getCustomTokens()
						.filter(ct => ct.chainId === chain.id)
						.map(ct => ({
							networkId: ct.networkId,
							contractAddress: ct.contractAddress,
							decimals: ct.decimals,
							symbol: ct.symbol,
							name: ct.name,
							icon: ct.iconUrl,
						}))
					const portfolioBody: any = { pubkeys: pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey })) }
					if (extraContracts.length > 0) portfolioBody.extraContracts = extraContracts
					// Single-chain refresh: only worth fetching DeFi for EVM chains.
					// Other families can't have Zapper apps and the extra round-trip is wasted.
					if (isEvm) portfolioBody.includeDefi = true
					let resp: any
					try {
						resp = await withTimeout(
							pioneer.GetPortfolioBalances(portfolioBody, { forceRefresh: true }),
							PIONEER_TIMEOUT_MS,
							'GetPortfolioBalances'
						)
					} catch (err: any) {
						if (!extraContracts.length || !isExtraContractsSchemaError(err)) throw err
						console.warn(`[getBalance] ${chain.coin}: Pioneer rejected extraContracts; retrying without custom tokens`)
						resp = await withTimeout(
							pioneer.GetPortfolioBalances(
								{ pubkeys: portfolioBody.pubkeys, ...(isEvm ? { includeDefi: true } : {}) },
								{ forceRefresh: true }
							),
							PIONEER_TIMEOUT_MS,
							'GetPortfolioBalances'
						)
					}
					const rawData = resp?.data?.data || resp?.data || {}
					const allEntries: any[] = rawData.balances || (Array.isArray(rawData) ? rawData : [])
					const rawDefiPositions: ServerDefiPosition[] = Array.isArray(rawData.defiPositions) ? rawData.defiPositions : []

					console.log(`[getBalance] ${chain.coin}: ${allEntries.length} entries from Pioneer (${pubkeys.length} pubkeys)`)

					// Pioneer may return cross-chain data with forceRefresh — filter to THIS chain
					// AND to the pubkeys we actually requested (prevents same-network contamination).
					const chainNetworkId = (chain.networkId || '').toLowerCase()
					const chainCaipPrefix = (chain.caip || '').split('/')[0].toLowerCase() // e.g. "eip155:1"
					const pubkeySet = new Set(pubkeys.map(p => p.pubkey.toLowerCase()))

					// Classify entries: filter by chain, separate natives vs tokens
					const pureNatives: any[] = []
					const tokenEntries: any[] = []
					let skippedCrossChain = 0

					for (const entry of allEntries) {
						// Gate 1: entry must belong to THIS chain (networkId or CAIP prefix)
						const entryNetworkId = (entry.networkId || '').toLowerCase()
						const entryCaipPrefix = ((entry.caip || '').split('/')[0]).toLowerCase()
						const belongsToChain = entryNetworkId === chainNetworkId
							|| entryCaipPrefix === chainCaipPrefix
						if (!belongsToChain) { skippedCrossChain++; continue }

						const caip = entry.caip || ''
						const caipPath = caip.split('/')[1] || ''
						const isTokenByCaip = caipPath && !caipPath.startsWith('slip44:') && !caipPath.startsWith('native:')
						const isTokenByType = entry.type === 'token' || (entry.isNative === false && entry.contract)

						if (isTokenByCaip || isTokenByType) {
							// Gate 2 (tokens): owner address must be one we requested
							const ownerAddr = (entry.address || entry.pubkey || '').toLowerCase()
							if (ownerAddr && !pubkeySet.has(ownerAddr)) continue
							tokenEntries.push(entry)
						} else {
							pureNatives.push(entry)
						}
					}

					if (skippedCrossChain > 0) {
						console.log(`[getBalance] ${chain.coin}: filtered ${skippedCrossChain} cross-chain entries`)
					}

					// Aggregate natives: iterate REQUESTED pubkeys, match at most one response per
					// pubkey, zero missing entries explicitly. Mirrors getBalances BTC/EVM aggregation.
					let nativeTotalBalance = 0
					let nativeTotalUsd = 0
					// Address tracking for UTXO chains (BTC + LTC/DOGE/etc.)
					const selectedXpubStr = isBtc ? btcAccounts.getSelectedXpub()?.xpub : undefined
					let selectedPkAddress = ''  // address from selected xpub (BTC) or sole xpub (other UTXO)
					let fallbackPkAddress = ''  // first Pioneer-returned address from any xpub
					const evmNativeByPubkey = new Map<string, { balance: number; usd: number }>()

					for (const pk of pubkeys) {
						// Find ONE matching native entry for this requested pubkey (no double-counting)
						const match = pureNatives.find((d: any) => d.pubkey === pk.pubkey)
							|| pureNatives.find((d: any) => d.caip === pk.caip && d.address === pk.pubkey)
							|| pureNatives.find((d: any) => d.address?.toLowerCase() === pk.pubkey.toLowerCase())
						const bal = parseFloat(String(match?.balance ?? '0'))
						const usd = Number(match?.valueUsd ?? 0)
						nativeTotalBalance += bal
						nativeTotalUsd += usd
						if (isEvm) evmNativeByPubkey.set(pk.pubkey.toLowerCase(), { balance: bal, usd })

						// Capture Pioneer-returned address for this pubkey
						if (match?.address) {
							if (!fallbackPkAddress) fallbackPkAddress = match.address
							// BTC: prefer selected xpub's address; non-BTC UTXO: first (only) xpub
							if (isBtc && selectedXpubStr && pk.pubkey === selectedXpubStr) selectedPkAddress = match.address
							if (!isBtc && isUtxo) selectedPkAddress = match.address
						}

						if (isBtc) {
							const xpubBal = String(match?.balance ?? '0')
							btcAccounts.updateXpubBalance(pk.pubkey, xpubBal, usd)
							// PRIVACY: Skip DB write for hidden passphrase wallets.
							try {
								const devId = engine.getDeviceState().deviceId
								if (devId && !engine.isPassphraseWallet) saveCachedPubkey(devId, 'bitcoin', pk.pubkey, pk.pubkey, match?.address || '', '', xpubBal, usd)
							} catch { /* non-fatal */ }
						}
					}

					if (nativeTotalBalance > 0 || nativeTotalUsd > 0) {
						balance = nativeTotalBalance > 0 ? nativeTotalBalance.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') : '0'
						balanceUsd = nativeTotalUsd
					}
					// UTXO chains: set address from Pioneer response (selected xpub preferred)
					if (isBtc || isUtxo) {
						const pioneerAddr = selectedPkAddress || fallbackPkAddress
						if (pioneerAddr) address = pioneerAddr
					}

					// Process tokens — already filtered to this chain + our pubkeys
					const evmTokensByOwner = new Map<string, TokenBalance[]>()
					if (tokenEntries.length > 0) {
						const parsedTokens: TokenBalance[] = []
						// Dedup by (caip, ownerAddress) — same fix as getBalances path
						const seenByOwnerCaip = new Set<string>()
						for (const tok of tokenEntries) {
							const bal = parseFloat(String(tok.balance ?? '0'))
							if (bal <= 0) continue
							const ownerAddr = String(tok.address || tok.pubkey || '').toLowerCase()
							const caipNorm = (tok.caip || '').startsWith('eip155:') ? (tok.caip || '').toLowerCase() : (tok.caip || '')
							if (seenByOwnerCaip.has(`${caipNorm}|${ownerAddr}`)) continue
							seenByOwnerCaip.add(`${caipNorm}|${ownerAddr}`)
							const contractMatch = (tok.caip || '').match(/\/(erc20|spl|trc20|token):([^\s]+)/)
							const contractAddress = contractMatch?.[2] || tok.contract || undefined
							const token: TokenBalance = {
								symbol: tok.symbol || '???',
								name: tok.name || tok.symbol || 'Unknown Token',
								balance: String(tok.balance ?? '0'),
								balanceUsd: Number(tok.valueUsd ?? 0),
								priceUsd: Number(tok.priceUsd ?? 0),
								caip: tok.caip || '',
								contractAddress,
								networkId: (tok.networkId || '').toLowerCase(),
								icon: tok.icon || undefined,
								decimals: tok.decimals ?? tok.precision,
								type: tok.type || 'token',
								dataSource: tok.dataSource,
							}
							parsedTokens.push(token)
							if (isEvm) {
								const ownerAddress = String(tok.address || tok.pubkey || '').toLowerCase()
								if (ownerAddress) {
									const ownerTokens = evmTokensByOwner.get(ownerAddress) || []
									ownerTokens.push(token)
									evmTokensByOwner.set(ownerAddress, ownerTokens)
								}
							}
						}

						if (parsedTokens.length > 0) {
							// Deduplicate by normalized CAIP — same EVM-only rule as getBalances.
							// EVM: lowercase for dedup; canonical caip on the object stays intact.
							// Non-EVM: exact match (Solana/Tron identifiers are case-sensitive).
							const seen = new Map<string, TokenBalance>()
							for (const tok of parsedTokens) {
								const key = tok.caip.startsWith('eip155:') ? tok.caip.toLowerCase() : tok.caip
								const existing = seen.get(key)
								if (!existing) {
									seen.set(key, { ...tok })
								} else {
									existing.balance = String(parseFloat(existing.balance) + parseFloat(tok.balance || '0'))
									existing.balanceUsd += tok.balanceUsd
								}
							}
							tokens = [...seen.values()]
							const tokenUsdTotal = tokens.reduce((sum, t) => sum + t.balanceUsd, 0)
							balanceUsd += tokenUsdTotal
						}
						console.log(`[getBalance] ${chain.coin}: ${tokens?.length ?? 0} tokens, $${balanceUsd.toFixed(2)} total`)
					}

					// Dedup per-address EVM token lists before writing to evmAddresses.
					// tokensByChainId is already deduped above; evmTokensByOwner feeds AssetPage directly.
					if (isEvm) {
						for (const [addr, addrTokens] of evmTokensByOwner) {
							const seen = new Map<string, TokenBalance>()
							for (const tok of addrTokens) {
								const key = tok.caip.startsWith('eip155:') ? tok.caip.toLowerCase() : tok.caip
								const existing = seen.get(key)
								if (!existing) {
									seen.set(key, { ...tok })
								} else {
									existing.balance = String(parseFloat(existing.balance) + parseFloat(tok.balance || '0'))
									existing.balanceUsd += tok.balanceUsd
								}
							}
							if (seen.size < addrTokens.length) evmTokensByOwner.set(addr, [...seen.values()])
						}
					}

					// Group server-merged DeFi by owner address for per-account attribution.
					// Single-chain refresh: keep ONLY positions on this chain — the server
					// may return multi-network DeFi for the same EVM address, so without
					// this filter a Base/Arbitrum position would leak into an Ethereum
					// refresh. (No token suppression: a position's `tokens[]` are the
					// protocol's underlyings, not wallet-held duplicates, and the server
					// sends no type to tell them apart — see the dashboard-path note.)
					const ownerDefiPositions = new Map<string, DefiPosition[]>()
					const allChainDefi: DefiPosition[] = []
					for (const sp of rawDefiPositions) {
						const spNetworkId = (sp.networkId || '').toLowerCase()
						if (!spNetworkId || networkToChain.get(spNetworkId) !== chain.id) continue
						const dp: DefiPosition = {
							protocol: sp.protocol || null,
							displayName: sp.displayName,
							name: sp.displayName || sp.protocol || 'DeFi Position',
							network: sp.network,
							networkId: sp.networkId,
							balanceUsd: Number(sp.balanceUsd) || 0,
							icon: sp.icon,
							tokens: Array.isArray(sp.tokens) ? sp.tokens.map(t => ({
								networkId: t.networkId,
								address: String(t.address || '').toLowerCase(),
								symbol: t.symbol,
								balance: t.balance != null ? String(t.balance) : undefined,
								balanceUsd: typeof t.balanceUsd === 'number' ? t.balanceUsd : undefined,
							})).filter(t => !!t.address) : [],
						}
						allChainDefi.push(dp)
						const ownerLower = String(sp.pubkey || '').toLowerCase()
						if (ownerLower) {
							const list = ownerDefiPositions.get(ownerLower) || []
							list.push(dp)
							ownerDefiPositions.set(ownerLower, list)
						}
					}
					if (allChainDefi.length > 0) {
						console.log(`[getBalance] ${chain.coin}: ${allChainDefi.length} DeFi positions across ${ownerDefiPositions.size} owner(s)`)
					}

					if (isEvm) {
						for (const pk of pubkeys) {
							const ownerAddress = pk.pubkey.toLowerCase()
							const native = evmNativeByPubkey.get(ownerAddress) || { balance: 0, usd: 0 }
							const ownerTokens = evmTokensByOwner.get(ownerAddress) || []
							const tokenUsdTotal = ownerTokens.reduce((sum, t) => sum + t.balanceUsd, 0)
							const ownerDefi = ownerDefiPositions.get(ownerAddress)
							const ownerDefiUsd = ownerDefi?.reduce((sum, p) => sum + (p.balanceUsd || 0), 0) || 0
							evmAddresses.setAddressChainBalance(pk.pubkey, chain.id, {
								chainId: chain.id,
								symbol: chain.symbol,
								balance: native.balance > 0 ? native.balance.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') : '0',
								balanceUsd: native.usd + tokenUsdTotal + ownerDefiUsd,
								nativeBalanceUsd: native.usd,
								tokens: ownerTokens.length > 0 ? ownerTokens : undefined,
								defiPositions: ownerDefi && ownerDefi.length > 0 ? ownerDefi : undefined,
							})
						}
					}

					if (isEvm && allChainDefi.length > 0) {
						balanceUsd += allChainDefi.reduce((s, p) => s + (p.balanceUsd || 0), 0)
						chainDefiPositions = allChainDefi
					}
				} catch (e: any) {
					const message = getPioneerPortfolioErrorMessage(e)
					console.warn(`[getBalance] ${chain.coin} portfolio failed:`, message)
					try { rpc.send['pioneer-error']({ message, url: getPioneerApiBase() }) } catch { /* webview not ready */ }
					throw new Error(`Balance server error: ${message}`)
				}
				// If Pioneer failed or returned no address, preserve the cached address
				// so we don't wipe a previously good address from the shared cache (Finding 3)
				if (!address && cachedAddress) address = cachedAddress
				const tokensUsd = tokens?.reduce((s, t) => s + (t.balanceUsd || 0), 0) || 0
				const defiUsd = chainDefiPositions?.reduce((s, p) => s + (p.balanceUsd || 0), 0) || 0
				const nativeBalanceUsd = Number(balanceUsd) - tokensUsd - defiUsd
				const result: ChainBalance = {
					chainId: chain.id,
					symbol: chain.symbol,
					balance,
					balanceUsd,
					nativeBalanceUsd,
					address,
					tokens,
					defiPositions: chainDefiPositions,
				}

				// Update single-chain cache + push to frontend so Dashboard stays in sync.
				// PRIVACY: Skip DB write for passphrase wallets.
				try {
					const deviceId = engine.getDeviceState().deviceId || 'unknown'
					if (!engine.isPassphraseWallet) {
						updateCachedBalance(deviceId, result)
						rectifyWallet(deviceId, [result])
					}
				} catch { /* never block on cache failure */ }
				try { rpc.send['balance-updated'](result) } catch { /* webview not ready */ }
				// Push updated EVM per-address balances so address selector stays current
				if (isEvm) {
					try { rpc.send['evm-addresses-update'](evmAddresses.toAddressSet()) } catch { /* webview not ready */ }
				}
				// Push updated BTC per-xpub balances — only if manager is hydrated (Finding 2)
				if (isBtc && btcAccounts.isInitialized && btcAccounts.getAllPubkeyEntries(chain.caip).length > 0) {
					const btcSet = btcAccounts.toAccountSet()
					try { rpc.send['btc-accounts-update'](btcSet) } catch { /* webview not ready */ }
					// Sync DB cache so getCachedBalances returns aggregate (not stale single-xpub)
					try {
						const devId = engine.getDeviceState().deviceId
						if (devId && !engine.isPassphraseWallet) {
							updateCachedBalance(devId, {
								chainId: 'bitcoin', symbol: 'BTC',
								balance: btcSet.totalBalance,
								balanceUsd: btcSet.totalBalanceUsd,
								nativeBalanceUsd: btcSet.totalBalanceUsd,
								address: result.address || btcAccounts.getSelectedXpub()?.xpub || '',
							})
						}
					} catch { /* non-fatal */ }
				}

				return result
			},

			buildTx: async (params) => {
				console.debug(`[buildTx] isMax=${params.isMax} chainId=${params.chainId}`)
				if (!engine.wallet) throw new Error('No device connected')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)

				// Firmware gate (fund safety): a THORChain/Maya bank-token send is a
				// MsgSend whose `denom` field is only honored from 7.15.0. On older
				// firmware the field is ignored and the tx signs as RUNE — refuse to
				// build it rather than sign the wrong asset. Covers TCY/RUJI sends and
				// swaps (both pass the bank-token caip). Native RUNE/ATOM are unaffected.
				if (params.caip && isThorchainBankToken(params.caip)) {
					const fw = engine.getDeviceState().firmwareVersion
					if (!thorchainBankTokenFirmwareOK(params.caip, fw)) {
						throw new Error(`This asset requires KeepKey firmware ${THORCHAIN_BANK_TOKEN_MIN_FW}+ (device has ${fw || 'unknown'}). Update your firmware to send or swap TCY / RUJI.`)
					}
				}

				const pioneer = await getPioneer()

				// Seed-staleness boundary on the SIGNING path. params (xpubOverride,
				// evmAddressIndex, amount, recipient) were prepared against the UI's
				// wallet view; if the device seed has since changed, those inputs
				// belong to a different wallet. Abort rather than build a tx from
				// stale context — the purge clears the managers + notifies the
				// frontend, which refreshes so the user can re-initiate cleanly.
				if ((await ensureManagersForSeed('buildTx')).purged) {
					throw new Error('Wallet changed since this transaction was prepared. Balances were refreshed — please review and try again.')
				}

				// For chains that need fromAddress or xpub, derive them
				const wallet = engine.wallet as any
				let fromAddress: string | undefined
				let xpub: string | undefined
				let allXpubs: Array<{ xpub: string; scriptType: string; accountPath: number[] }> | undefined

				if (chain.chainFamily === 'evm') {
					// EVM multi-address: use evmAddressIndex or selected index
					const idx = params.evmAddressIndex ?? evmAddresses.getSelectedAddress()?.addressIndex ?? 0
					const addrPath = evmAddressPath(idx)
					// Try cached address first (avoids device call)
					const cached = evmAddresses.toAddressSet().addresses.find(a => a.addressIndex === idx)
					if (cached) {
						fromAddress = cached.address
					} else {
						const addrResult = await wallet.ethGetAddress({ addressNList: addrPath, showDisplay: false, coin: 'Ethereum' })
						fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
					}
				} else if (chain.chainFamily !== 'utxo') {
					const addrParams: any = {
						addressNList: chain.defaultPath,
						showDisplay: false,
						coin: chain.coin,
					}
					if (chain.scriptType) addrParams.scriptType = chain.scriptType
					if (chain.chainFamily === 'ton') addrParams.bounceable = false
					const walletMethod = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
					console.debug(`[buildTx] Deriving ${chain.coin} address`)
					const addrResult = await wallet[walletMethod](addrParams)
					fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address || addrResult?.publicKey
					console.debug(`[buildTx] Derived ${chain.coin} address OK`)
				} else if (chain.id === 'bitcoin') {
					// BTC multi-account: resolve xpub, scriptType, and accountPath from the
					// override string itself (not from getSelectedXpub(), which can drift
					// between render and RPC handling). Finding 5 fix.
					const resolvedXpub = params.xpubOverride || btcAccounts.getSelectedXpub()?.xpub
					console.log(`[buildTx] BTC xpub: override=${params.xpubOverride?.slice(0,12)} selected=${btcAccounts.getSelectedXpub()?.xpub?.slice(0,12)} resolved=${resolvedXpub?.slice(0,12)} scriptType=${btcAccounts.getSelectedXpub()?.scriptType}`)
					xpub = resolvedXpub
					// Look up the BtcXpub entry that owns this xpub string for scriptType + path
					let matchedXpubEntry: { scriptType: string; path: number[] } | undefined
					if (resolvedXpub) {
						for (const account of btcAccounts.toAccountSet().accounts) {
							for (const xp of account.xpubs) {
								if (xp.xpub === resolvedXpub) {
									matchedXpubEntry = { scriptType: xp.scriptType, path: xp.path }
									break
								}
							}
							if (matchedXpubEntry) break
						}
					}
					if (matchedXpubEntry) {
						if (!params.scriptTypeOverride) params = { ...params, scriptTypeOverride: matchedXpubEntry.scriptType }
						params = { ...params, accountPath: matchedXpubEntry.path }
					}
					if (!xpub) {
						// Fallback: derive from default path
						const xpubResult = await wallet.getPublicKeys([{
							addressNList: chain.defaultPath.slice(0, 3),
							coin: chain.coin, scriptType: chain.scriptType, curve: 'secp256k1',
						}])
						xpub = xpubResult?.[0]?.xpub
					}
				} else {
					// Non-BTC UTXO: derive all applicable script-type xpubs so buildUtxoTx
					// can aggregate UTXOs from any address type (mirrors BTC multi-xpub logic).
					const scriptTypes = chain.id === 'litecoin'
						? [{ scriptType: 'p2pkh', purpose: 44 }, { scriptType: 'p2sh-p2wpkh', purpose: 49 }, { scriptType: 'p2wpkh', purpose: 84 }]
						: [{ scriptType: chain.scriptType || 'p2pkh', purpose: 44 }]

					const coinType = chain.defaultPath[1] // already hardened (0x80000000 + slip44)
					const pubKeyPaths = scriptTypes.map(st => ({
						addressNList: [st.purpose + 0x80000000, coinType, 0x80000000],
						coin: chain.coin,
						scriptType: st.scriptType,
						curve: 'secp256k1',
					}))
					const pubKeyResults = await wallet.getPublicKeys(pubKeyPaths)

					const derivedXpubs: Array<{ xpub: string; scriptType: string; accountPath: number[] }> = []
					for (let i = 0; i < scriptTypes.length; i++) {
						const xp = pubKeyResults?.[i]?.xpub
						if (xp) {
							derivedXpubs.push({
								xpub: xp,
								scriptType: scriptTypes[i].scriptType,
								accountPath: pubKeyPaths[i].addressNList,
							})
						}
					}
					if (derivedXpubs.length > 0) {
						xpub = derivedXpubs[0].xpub
						if (derivedXpubs.length > 1) {
							allXpubs = derivedXpubs
						}
					}
				}

				const rpcUrl = chain.id.startsWith('evm-custom-') ? getRpcUrl(chain) : undefined
				const evmIdx = chain.chainFamily === 'evm' ? (params.evmAddressIndex ?? evmAddresses.getSelectedAddress()?.addressIndex ?? 0) : undefined

				// TON: derive Ed25519 public key for wallet deployment (StateInit)
				let publicKeyHex: string | undefined
				if (chain.chainFamily === 'ton') {
					try {
						// Bypass hdwallet's getPublicKeys() — it forces a BTC scriptType which
						// firmware rejects for ed25519. Call transport.call() directly instead.
						const Messages = await import('@keepkey/device-protocol/lib/messages_pb')
						const gpk = new Messages.GetPublicKey()
						gpk.setAddressNList(chain.defaultPath)
						gpk.setEcdsaCurveName('ed25519')
						gpk.setShowDisplay(false)
						const resp = await wallet.transport.call(
							Messages.MessageType.MESSAGETYPE_GETPUBLICKEY,
							gpk,
							{ msgTimeout: 10000 }
						)
						const pubKeyProto = resp.proto as any
						// Try node.publicKey first (raw bytes), fall back to xpub decode
						const node = pubKeyProto.getNode?.()
						const rawKey = node?.getPublicKey_asU8?.()
						if (rawKey && (rawKey.length === 32 || rawKey.length === 33)) {
							// ed25519 node key is 33 bytes: 0x00 prefix + 32-byte key
							const keyBytes = rawKey.length === 33 && rawKey[0] === 0x00 ? rawKey.subarray(1) : rawKey.length === 32 ? rawKey : null
							if (!keyBytes || keyBytes.length !== 32) throw new Error(`Unexpected ed25519 key length: ${rawKey.length}`)
							publicKeyHex = Buffer.from(keyBytes).toString('hex')
						} else {
							// Fallback: decode xpub to extract raw key
							const xpubStr = pubKeyProto.getXpub?.()
							if (xpubStr) {
								const bs58check = require('bs58check')
								const decoded: Buffer = bs58check.decode(xpubStr)
								if (decoded.length >= 78 && decoded[45] === 0x00) {
									publicKeyHex = Buffer.from(decoded.subarray(46, 78)).toString('hex')
								}
							}
						}
						if (publicKeyHex) {
							console.debug(`[buildTx] TON ed25519 pubkey derived`)
							// Compute the correct v4r2 wallet address from the public key.
							// The firmware may derive a wrong address (sha256(pubkey) instead of
							// sha256(stateInit)), so always use our vault-computed address.
							const { tonV4R2Address } = await import('./txbuilder/ton')
							fromAddress = tonV4R2Address(publicKeyHex)
							console.debug(`[buildTx] TON v4r2 address derived`)
						} else {
							console.warn(`[buildTx] TON: GetPublicKey returned no usable key`)
						}
					} catch (e: any) {
						console.warn(`[buildTx] TON public key derivation failed:`, e.message)
					}
				}

				const result = await buildTx(pioneer, chain, {
					...params,
					fromAddress,
					xpub,
					allXpubs: allXpubs?.length ? allXpubs : undefined,
					rpcUrl,
					evmAddressIndex: evmIdx,
					publicKeyHex,
					pioneerBaseUrl: getPioneerApiBase(),
				})

				return { unsignedTx: result.unsignedTx, fee: result.fee }
			},

			broadcastTx: async (params) => {
				if (!params.signedTx) throw new Error('Missing signedTx payload')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)

				let result: { txid: string }

				// Custom chains: broadcast via direct RPC
				const rpcUrl = chain.id.startsWith('evm-custom-') ? getRpcUrl(chain) : undefined
				if (rpcUrl) {
					const serialized = params.signedTx?.serializedTx || params.signedTx?.serialized || (typeof params.signedTx === 'string' ? params.signedTx : undefined)
					if (!serialized || typeof serialized !== 'string') throw new Error(`Cannot extract serialized tx from: ${JSON.stringify(params.signedTx).slice(0, 200)}`)
					const txid = await broadcastEvmTx(rpcUrl, serialized)
					result = { txid }
				} else {
					const pioneer = await getPioneer()
					result = await broadcastTx(pioneer, chain, params.signedTx)
				}

				// Track broadcast in api_log + notify frontend.
				// PRIVACY: Skip DB write for passphrase wallets (still push to UI).
				const scope = getWalletDbScope()
				// Persist the send intent (recipient/amount/fee/asset) in response_body so
				// the activity detail panel can show the full record. Without this an in-app
				// send logs only its txid — getRecentActivityFromLog reads these back as meta.
				const txMeta = {
					value: params.amount,
					fee: params.fee,
					to: params.to,
					asset: params.symbol,
					caip: params.caip,
					chainId: chain.id,
					chainSymbol: chain.symbol,
				}
				const logEntry: ApiLogEntry = { ...(scope || {}), method: 'RPC', route: 'broadcastTx', timestamp: Date.now(), durationMs: 0, status: 200, appName: 'vault', txid: result.txid, chain: chain.symbol, activityType: 'broadcast', responseBody: txMeta }
				let abEntry: { entryId: string; isNew: boolean; unsaved: boolean } | null = null
				if (scope) {
					// api_log is part of hidden-wallet deniability — keep it standard-only.
					if (!engine.isPassphraseWallet) insertApiLog(logEntry)
					// Address Book (R3/R4/R7) is wallet-agnostic: capture the recipient +
					// outbound-history row in any session (incl. hidden). Best-effort.
					if (params.to) {
						try {
							abEntry = recordOutbound({
								walletId: scope.walletId, deviceId: scope.deviceId,
								toAddress: params.to, networkId: chain.networkId, chainId: chain.id, chainFamily: chain.chainFamily,
								fromAddress: params.fromAddress ?? null,
								caip: params.caip || chain.caip, symbol: params.symbol || chain.symbol,
								amount: params.amount ?? null, txid: result.txid,
							})
							if (abEntry) { try { rpc.send['addressbook-changed']({}) } catch { /* webview not ready */ } }
						} catch (e: any) { console.warn('[broadcastTx] addressbook recordOutbound failed:', e?.message) }
					}
				}
				try { rpc.send['api-log'](logEntry) } catch { /* webview not ready */ }

				return { ...result, addressBookEntryId: abEntry?.entryId, recipientUnsaved: abEntry?.unsaved }
			},

			getMarketData: async (params) => {
				const pioneer = await getPioneer()
				const resp = await withTimeout(pioneer.GetMarketInfo(params.caips), PIONEER_TIMEOUT_MS, 'GetMarketInfo')
				return resp?.data || []
			},

			getFees: async (params) => {
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				if (chain.chainFamily === 'utxo') {
					const resp = await withTimeout(pioneer.GetFeeRateByNetwork({ networkId: chain.networkId }), PIONEER_TIMEOUT_MS, 'GetFeeRateByNetwork')
					return { feeRate: resp?.data, unit: 'sat/byte' }
				} else if (chain.chainFamily === 'evm') {
					const resp = await withTimeout(pioneer.GetGasPriceByNetwork({ networkId: chain.networkId }), PIONEER_TIMEOUT_MS, 'GetGasPriceByNetwork')
					return { gasPrice: resp?.data, unit: 'gwei' }
				} else {
					return { fee: 'fixed', note: 'Cosmos/XRP chains use fixed fees' }
				}
			},

			// ── DeFi positions (Zapper) ───────────────────────────────
			// Live-fetched per EVM address from the KeepKey Zapper proxy.
			// Display-only and not persisted — supplementary to the Pioneer
			// token list, so failures degrade to an empty section.
			getDefiPositions: async (params) => {
				if (!params?.address) return []
				return fetchDefiPositions(params.address)
			},

			// ── Staking / delegation ──────────────────────────────────
			getStakingPositions: async (params) => {
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (chain.chainFamily !== 'cosmos') throw new Error(`Staking not supported for chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				const resp = await withTimeout(
					pioneer.GetStakingPositions({ network: chain.id, address: params.address }),
					PIONEER_TIMEOUT_MS,
					'GetStakingPositions'
				)

				const raw = resp?.data?.data || resp?.data || []
				const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.balances) ? raw.balances : [])
				const symbol = chain.symbol

				const positions: StakingPosition[] = list.map((pos: any) => ({
					type: pos.type || 'delegation',
					balance: String(pos.balance ?? '0'),
					valueUsd: Number(pos.valueUsd ?? pos.value ?? 0),
					ticker: pos.ticker || pos.symbol || symbol,
					validator: pos.validator || pos.validatorName || 'Unknown Validator',
					validatorAddress: pos.validatorAddress || pos.validator || '',
					status: pos.status || 'active',
				}))

				return positions
			},

			buildDelegateTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (chain.chainFamily !== 'cosmos') throw new Error(`Delegation not supported for chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				const wallet = engine.wallet as any
				const addrParams: any = {
					addressNList: chain.defaultPath,
					showDisplay: false,
					coin: chain.coin,
				}
				if (chain.scriptType) addrParams.scriptType = chain.scriptType
				const walletMethod = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
				const addrResult = await wallet[walletMethod](addrParams)
				const fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
				if (!fromAddress) throw new Error(`Could not derive address for ${chain.coin}`)

				const result = await buildCosmosStakingTx(pioneer, chain, {
					validatorAddress: params.validatorAddress,
					amount: params.amount,
					memo: params.memo,
					fromAddress,
					type: 'delegate',
					isMax: params.isMax,
				})

				const { fee, ...unsignedTx } = result
				return { unsignedTx, fee }
			},

			buildUndelegateTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (chain.chainFamily !== 'cosmos') throw new Error(`Undelegation not supported for chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				const wallet = engine.wallet as any
				const addrParams: any = {
					addressNList: chain.defaultPath,
					showDisplay: false,
					coin: chain.coin,
				}
				if (chain.scriptType) addrParams.scriptType = chain.scriptType
				const walletMethod = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
				const addrResult = await wallet[walletMethod](addrParams)
				const fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
				if (!fromAddress) throw new Error(`Could not derive address for ${chain.coin}`)

				const result = await buildCosmosStakingTx(pioneer, chain, {
					validatorAddress: params.validatorAddress,
					amount: params.amount,
					memo: params.memo,
					fromAddress,
					type: 'undelegate',
				})

				const { fee, ...unsignedTx } = result
				return { unsignedTx, fee }
			},

			// ── THORName / MAYAName registration ──────────────────────
			lookupName: async (params) => {
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (chain.id !== 'thorchain' && chain.id !== 'mayachain') throw new Error(`Name service not supported for chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				const resp = await withTimeout(
					pioneer.GetName({ network: chain.id, name: params.name }),
					PIONEER_TIMEOUT_MS,
					'GetName'
				)
				// Pioneer wraps the payload in a `data` envelope (like GetStakingPositions).
				const data = resp?.data?.data ?? resp?.data ?? {}
				return {
					found: !!data.found,
					name: params.name,
					owner: data.owner,
					expireBlockHeight: data.expireBlockHeight != null ? Number(data.expireBlockHeight) : undefined,
					aliases: Array.isArray(data.aliases) ? data.aliases : undefined,
					preferredAsset: data.preferredAsset || undefined,
				}
			},

			getNameQuote: async (params) => {
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (chain.id !== 'thorchain' && chain.id !== 'mayachain') throw new Error(`Name service not supported for chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				const resp = await withTimeout(
					pioneer.GetNameRegistrationQuote({ network: chain.id }),
					PIONEER_TIMEOUT_MS,
					'GetNameRegistrationQuote'
				)
				const data = resp?.data?.data ?? resp?.data
				if (!data?.registerFeeBase || !data?.feePerBlockBase || !data?.blocksPerYear) {
					throw new Error(`Unexpected name quote format for ${chain.id}: ${JSON.stringify(data)}`)
				}
				return {
					registerFeeBase: String(data.registerFeeBase),
					feePerBlockBase: String(data.feePerBlockBase),
					blocksPerYear: Number(data.blocksPerYear),
					currentBlockHeight: Number(data.currentBlockHeight ?? 0),
				}
			},

			buildNameRegistrationTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (chain.id !== 'thorchain' && chain.id !== 'mayachain') throw new Error(`Name registration not supported for chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				const wallet = engine.wallet as any
				const addrParams: any = {
					addressNList: chain.defaultPath,
					showDisplay: false,
					coin: chain.coin,
				}
				const addrResult = await wallet[chain.rpcMethod](addrParams)
				const fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
				if (!fromAddress) throw new Error(`Could not derive address for ${chain.coin}`)

				const result = await buildCosmosNameRegTx(pioneer, chain, {
					name: params.name,
					years: params.years,
					fromAddress,
				})

				const { fee, ...unsignedTx } = result
				return { unsignedTx, fee }
			},

			// ── Bitcoin multi-account ─────────────────────────────────
			getBtcAccounts: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				// Boundary: BTC can initialize here independently of EVM, so this is
				// the one init site where a stale BTC-only manager could otherwise
				// survive (no EVM index-0 to compare). Reconcile + stamp the seed.
				const { truth } = await ensureManagersForSeed('getBtcAccounts')
				if (!btcAccounts.isInitialized) {
					await btcAccounts.initialize(engine.wallet as any)
				}
				stampManagers(truth)
				// Hydrate per-xpub balances from DB cache only on first load (before Pioneer has responded).
				// Once pioneerFetched=true, the in-memory values are authoritative — don't overwrite with stale DB rows.
				const devId = engine.getDeviceState().deviceId
				if (devId && !btcAccounts.pioneerFetched) {
					const cachedPks = getCachedPubkeys(devId).filter(p => p.chainId === 'bitcoin' && p.xpub)
					for (const pk of cachedPks) {
						if (pk.balance !== '0' || pk.balanceUsd > 0) {
							btcAccounts.updateXpubBalance(pk.xpub, pk.balance, pk.balanceUsd)
						}
					}
				}
				return btcAccounts.toAccountSet()
			},
			addBtcAccount: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				return await btcAccounts.addAccount(engine.wallet as any)
			},
			setBtcSelectedXpub: async (params) => {
				btcAccounts.setSelectedXpub(params.accountIndex, params.scriptType)
			},
			getBtcAddressIndices: async (params) => {
				const { xpub } = params
				if (!xpub) throw new Error('xpub required')
				const pioneer = await getPioneer()
				let receiveIndex = 0
				let changeIndex = 0
				try {
					const btcNetworkId = CHAINS.find(c => c.id === 'bitcoin')!.networkId
					const resp = await withTimeout(pioneer.GetPubkeyInfo({ network: btcNetworkId, xpub }), PIONEER_TIMEOUT_MS, 'GetPubkeyInfo')
					const tokens = resp?.data?.tokens || []
					let maxReceive = -1
					let maxChange = -1
					for (const token of tokens) {
						if (token.path && token.transfers > 0) {
							const parts = token.path.split('/')
							if (parts.length === 6) {
								const idx = parseInt(parts[5], 10)
								if (isNaN(idx)) continue
								if (parts[4] === '0' && idx > maxReceive) maxReceive = idx
								if (parts[4] === '1' && idx > maxChange) maxChange = idx
							}
						}
					}
					receiveIndex = maxReceive + 1
					changeIndex = maxChange + 1
				} catch (e: any) {
					console.warn('[getBtcAddressIndices] GetPubkeyInfo failed:', e.message)
				}
				return { receiveIndex, changeIndex }
			},

			// ── EVM multi-address ────────────────────────────────────
			getEvmAddresses: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				const { truth } = await ensureManagersForSeed('getEvmAddresses')
				if (!evmAddresses.isInitialized) {
					await evmAddresses.initialize(engine.wallet as any)
				}
				stampManagers(truth)
				return evmAddresses.toAddressSet()
			},
			addEvmAddressIndex: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await evmAddresses.addIndex(engine.wallet as any, params.index)
			},
			removeEvmAddressIndex: async (params) => {
				return evmAddresses.removeIndex(params.index)
			},
			setEvmSelectedIndex: async (params) => {
				evmAddresses.setSelectedIndex(params.index)
			},

			// ── Custom tokens ────────────────────────────────────────
			addCustomToken: async (params) => {
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)

				// ── Solana SPL token ──────────────────────────────────────────
				// No EVM chainId / eth_call path — resolve via the Solana RPC +
				// Jupiter and persist with the /token: namespace. Mint case is
				// preserved (base58 is case-sensitive).
				if (chain.chainFamily === 'solana') {
					const mint = params.contractAddress.trim()
					const { SOLANA_MINT_RE, resolveSolanaMint } = await import('./solana-token')
					if (!SOLANA_MINT_RE.test(mint)) throw new Error('Invalid Solana mint address')
					const endpoint = getSetting('solana_rpc_endpoint') || undefined
					const meta = await resolveSolanaMint(mint, endpoint)
					if (!meta) throw new Error('Not a valid SPL token mint')
					const token: CustomToken = {
						chainId: chain.id,
						contractAddress: mint,
						symbol: meta.symbol,
						name: meta.name,
						decimals: meta.decimals,
						networkId: chain.networkId,
						iconUrl: meta.iconUrl,
					}
					dbAddCustomToken(token)
					return token
				}

				if (!chain.chainId) throw new Error('Chain has no EVM chainId')
				const rpcUrl = getRpcUrl(chain) || EVM_RPC_URLS[chain.chainId]
				if (!rpcUrl) throw new Error(`No RPC URL for chain ${chain.coin}`)
				const addr = params.contractAddress.trim()
				if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('Invalid contract address')
				const meta = await getTokenMetadata(rpcUrl, addr)
				// Best-effort logo resolve. Don't block persistence on a slow CDN
				// or rate-limited CoinGecko response — fail open to no icon.
				const { resolveTokenIcon } = await import('./evm-token-icons')
				let iconUrl: string | undefined
				try {
					iconUrl = (await resolveTokenIcon(params.chainId, addr)) || undefined
				} catch (e: any) {
					console.warn(`[addCustomToken] icon resolve threw, persisting without:`, e?.message || e)
				}
				const token: CustomToken = {
					chainId: params.chainId,
					contractAddress: addr,
					symbol: meta.symbol,
					name: meta.name,
					decimals: meta.decimals,
					networkId: chain.networkId,
					iconUrl,
				}
				dbAddCustomToken(token)
				return token
			},
			removeCustomToken: async (params) => {
				dbRemoveCustomToken(params.chainId, params.contractAddress)
			},
			getCustomTokens: async () => {
				return getCustomTokens()
			},
			setCustomTokenIcon: async (params) => {
				// User-supplied icon (data URL or http(s) URL). Cap at ~256KB raw bytes
				// so a long-tail upload doesn't bloat sqlite or the in-memory token list.
				// 256KB ≈ 350K base64 chars. Reject schemes other than data: / http(s):
				// to keep the value renderable from the WebView and to avoid storing
				// random arbitrary protocols.
				const u = (params.iconUrl || '').trim()
				if (!u) throw new Error('iconUrl required')
				if (!/^(data:image\/(png|jpe?g|webp|svg\+xml|gif);base64,|https?:\/\/)/i.test(u)) {
					throw new Error('iconUrl must be a data:image/* (base64) or http(s) URL')
				}
				if (u.length > 350_000) throw new Error('Icon too large (max ~256KB)')
				const ok = dbSetCustomTokenIcon(params.chainId, params.contractAddress, u)
				if (!ok) throw new Error('Token row not found — Add it first')
				const found = getCustomTokens().find(t => t.chainId === params.chainId && t.contractAddress.toLowerCase() === params.contractAddress.toLowerCase())
				if (!found) throw new Error('Token row not found after update')
				return found
			},

			// ── Chain discovery (Pioneer catalog) ────────────────────
			browseChains: async (params) => {
				await loadChainCatalog()
				const q = (params.query || '').trim()
				const page = Math.max(params.page || 0, 0)
				const pageSize = Math.min(Math.max(params.pageSize || 20, 5), 50)
				return browseChains(q, page, pageSize)
			},

			// ── Custom chains ────────────────────────────────────────
			addCustomChain: async (params) => {
				if (!params.chainId || params.chainId < 1) throw new Error('Invalid chainId')
				if (!params.name?.trim()) throw new Error('Chain name required')
				if (!params.symbol?.trim()) throw new Error('Gas token symbol required')
				try {
				const rpcParsed = new URL(params.rpcUrl?.trim() || '')
				if (rpcParsed.protocol !== 'http:' && rpcParsed.protocol !== 'https:') throw new Error()
				// SSRF protection: block private/internal hostnames
				const host = rpcParsed.hostname.toLowerCase()
				const BLOCKED_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\])$/
				const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost']
				if (BLOCKED_HOSTS.test(host) || BLOCKED_SUFFIXES.some(s => host.endsWith(s))) {
					throw new Error('RPC URL must not point to private/internal networks')
				}
				// DNS rebinding protection: resolve hostname and reject if it points to a private IP.
				// Check both IPv4 and IPv6; reject on DNS failure (fail-closed).
				const isPrivateIP = (ip: string) =>
					/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0)/.test(ip) ||
					/^(::1|fe80:|fc00:|fd00:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.))/.test(ip) ||
					ip === '::' || ip === '0:0:0:0:0:0:0:1'
				for (const family of [4, 6] as const) {
					try {
						const resolved = await Bun.dns.lookup(host, { family: family === 4 ? 'IPv4' : 'IPv6' } as any)
						if (resolved && resolved.length > 0) {
							for (const entry of resolved) {
								const ip = typeof entry === 'string' ? entry : entry.address
								if (ip && isPrivateIP(ip)) {
									throw new Error('RPC URL must not point to private/internal networks (DNS resolved to private IP)')
								}
							}
						}
					} catch (dnsErr: any) {
						if (dnsErr.message?.includes('private/internal')) throw dnsErr
						// IPv6 lookup may legitimately fail if no AAAA record; only block if IPv4 also fails
						if (family === 4) {
							throw new Error('RPC URL hostname could not be resolved — cannot verify it is not a private address')
						}
					}
				}
			} catch (e: any) {
				if (e.message?.includes('private/internal')) throw e
				throw new Error('Valid http/https RPC URL required')
			}
				// Prevent duplicate built-in chains
				const existing = getAllChains().find(c => c.chainId === String(params.chainId))
				if (existing) throw new Error(`Chain ${params.chainId} already exists as ${existing.coin}`)
				addCustomChainDb(params)
				customChainDefs = customChainDefs.filter(c => c.id !== `evm-custom-${params.chainId}`)
				customChainDefs.push(customChainToChainDef(params))
			},
			removeCustomChain: async (params) => {
				removeCustomChainDb(params.chainId)
				customChainDefs = customChainDefs.filter(c => c.id !== `evm-custom-${params.chainId}`)
			},
			getCustomChains: async () => {
				return getCustomChains()
			},

			// ── Token visibility (spam filter) ───────────────────────
			setTokenVisibility: async (params) => {
				const caip = params.caip?.trim()
				if (!caip) throw new Error('caip required')
				if (params.status !== 'visible' && params.status !== 'hidden') throw new Error('status must be visible or hidden')
				dbSetTokenVisibility(caip, params.status)
				// Notify any other view (Dashboard, etc.) that visibility changed
				// so it can refetch instead of holding the stale on-mount snapshot.
				try { rpc.send['token-visibility-changed']({ caip, status: params.status }) } catch { /* webview not ready */ }
			},
			removeTokenVisibility: async (params) => {
				const caip = params.caip?.trim()
				if (!caip) throw new Error('caip required')
				dbRemoveTokenVisibility(caip)
				try { rpc.send['token-visibility-changed']({ caip, status: null }) } catch { /* webview not ready */ }
			},
			getTokenVisibilityMap: async () => {
				const map = getAllTokenVisibility()
				return Object.fromEntries(map)
			},

			// ── Zcash Shielded (Orchard) ────────────────────────────
			zcashShieldedStatus: async () => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				// Sidecar readiness doesn't depend on firmware — it runs independently.
				// Firmware check only matters for device operations (FVK export, signing).
				const sidecarReady = isSidecarReady()
				const fvkLoaded = hasFvkLoaded()
				const cached = getCachedFvk()
				const scanState = getScanState()
				// Privacy tab opening is the natural trigger for "validate the local
				// wallet against the chain". Fires once per session, in the background;
				// status response stays fast, scan-progress events drive any UI.
				maybeStartBackgroundWalletVerification()
				const result = {
					ready: sidecarReady,
					fvk_loaded: fvkLoaded,
					address: cached?.address ?? null,
					fvk: cached?.fvk ?? null,
					synced_to: scanState.syncedTo,
					keepkey_release_block: scanState.releaseBlock,
					// `verified` now means the cached FVK was PROVEN to match the
					// connected device — not merely "scanned to tip". `synced` keeps
					// the old scan-freshness signal for clients that want both.
					verified: zcashDeviceVerified,
					synced: zcashVerifiedThisSession,
					verifying: zcashBackgroundVerifyInFlight,
				}
				console.log(`[zcash] zcashShieldedStatus → ready=${result.ready} fvk=${fvkLoaded} verified=${result.verified} synced=${result.synced} verifying=${result.verifying} synced_to=${scanState.syncedTo} addr=${cached?.address?.slice(0, 20) ?? 'none'}`)
				return result
			},
			// Read-only diagnostic: does the cached shielded balance actually belong
			// to the CONNECTED device? Derives the Orchard FVK fresh from the device
			// (silent, no button) and compares its `ak` to the cached one. Does NOT
			// mutate the sidecar/db. `match: false` means the shown balance is from a
			// different/stale wallet and is not spendable here.
			zcashVerifyDevice: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				if (typeof (engine.wallet as any).zcashGetOrchardFVK !== 'function') {
					throw new Error('Device firmware does not support Orchard FVK export')
				}
				const cached = getCachedFvk()
				const deviceFvk = await (engine.wallet as any).zcashGetOrchardFVK(params?.account ?? 0)
				const deviceAk = Buffer.from(deviceFvk.ak).toString('hex')
				const cachedAk = cached?.fvk?.ak ?? null
				const match = !!cachedAk && cachedAk.toLowerCase() === deviceAk.toLowerCase()
				const result = {
					match,
					deviceAk,
					cachedAk,
					cachedAddress: cached?.address ?? null,
					message: cachedAk === null
						? 'No cached FVK — nothing to compare (wallet not initialized).'
						: match
							? 'OK: the cached shielded balance belongs to the connected device.'
							: 'MISMATCH: cached shielded balance is NOT from the connected device — stale/another wallet, not spendable here.',
				}
				console.log(`[zcash] zcashVerifyDevice → match=${match} deviceAk=${deviceAk.slice(0, 12)}… cachedAk=${(cachedAk ?? 'none').slice(0, 12)}…`)
				return result
			},
			zcashShieldedInit: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				// If FVK is already loaded from DB, return it immediately
				const cached = getCachedFvk()
				if (cached) return cached
				// Otherwise get from device — newly-loaded FVK invalidates any prior
				// wallet validation, since notes for a different ak shouldn't carry over.
				if (!engine.wallet) throw new Error('No device connected')
				// initializeOrchardFromDevice updates the in-process FVK cache itself.
				const result = await initializeOrchardFromDevice(engine.wallet as any, params?.account ?? 0)
				// FVK came straight from the connected device → it is device-verified
				// by construction, but the unspent set still needs a fresh scan.
				zcashVerifiedThisSession = false
				zcashDeviceVerified = true
				return result
			},
			zcashShieldedScan: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				// Direct RPC callers (and the REST handler that mirrors this) may not
				// have gone through the Privacy tab's auto-init path, so the sidecar
				// could have no FVK loaded — `scanOrchardNotes` would then fail with
				// "No FVK set". Refresh from device first if needed.
				await ensureFvkLoaded(engine.wallet, 0)
				// Scan returns { balance, notes_found, ... }, so it is a balance-exposing
				// path — prove the cached FVK belongs to the connected device first, or a
				// stale/other-wallet FVK would surface a phantom balance via a scan request
				// (reviewer#2). ensureFvkLoaded only loads-if-absent; it does NOT verify.
				// force=true: the user pressing "Sync" expects a real device round-trip
				// every time, ignoring the sticky session flag — on mismatch this purges
				// the stale FVK + notes and re-derives, repairing a stale wallet from the
				// UI without a manual DB wipe. Reuses the coalesced-purge path instead of
				// mutating the module-global zcashDeviceVerified (which would open a
				// transient window where a concurrent balance read throws "not verified").
				await ensureZcashDeviceMatch(0, true)
				const result = await scanOrchardNotes(params?.startHeight, params?.fullRescan)
				if (result?.synced_to != null) updateSyncedTo(result.synced_to)
				// A successful scan validates the wallet against the chain — even an
				// incremental one from synced_to brings the unspent set up to truth.
				zcashVerifiedThisSession = true
				return result
			},
			zcashShieldedBalance: async () => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (hasFvkLoaded() && !zcashDeviceVerified) {
					maybeStartBackgroundWalletVerification()
					throw new Error('Zcash wallet is not verified against the connected device yet')
				}
				return await getShieldedBalance()
			},
			zcashShieldedSend: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				const account = (params as any)?.account ?? 0
				if (account !== 0) throw new Error('Only account 0 is supported; multi-account shielded sends are not implemented')
				await ensureFvkLoaded(engine.wallet, 0)
				// FAIL-CLOSED: prove the FVK we're about to spend from belongs to the
				// CONNECTED device before building anything. On mismatch this purges
				// the stale wallet and re-derives from the device — so a wrong-signer
				// spend (which consensus rejects with "could not validate orchard
				// proof") can never be built. A device-comms failure throws and
				// aborts the send rather than proceeding on unverified state.
				await ensureZcashDeviceMatch(account, true)
				await ensureZcashScanFresh()
				// FVK already loaded means device supports Orchard — skip version check
				// (version string may not be populated yet at call time)
				// On the emulator, route the device-signing call through emuSigningOp so the
				// confirm UI pops + ButtonAck/DLD get pre-written. Without this the firmware
				// busy-loops in confirm_helper() and the watchdog SIGKILLs the bun process.
				const signWrap = engine.isEmulator
					? <T,>(fn: () => Promise<T>) => emuSigningOp(fn, {
						operation: 'zcashShieldedSend', chain: 'Zcash',
						to: params.recipient, value: zecAmount(params.amount), memo: params.memo,
					}) as Promise<T>
					: undefined
				try { rpc.send['send-progress']({ step: 'building' }) } catch { /* webview not ready */ }
				const onProgress = (step: string) => {
					try { rpc.send['send-progress']({ step }) } catch { /* webview not ready */ }
				}
				const result = await sendShielded(engine.wallet as any, {
					recipient: params.recipient,
					amount: params.amount,
					memo: params.memo,
				}, { signWrap, onProgress })
				try { rpc.send['send-progress']({ step: 'complete', detail: result.txid }) } catch { /* webview not ready */ }
				return result
			},
			zcashTransparentBalance: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				const account = params?.account ?? 0
				const wallet = engine.wallet
				const path = [0x80000000 + 44, 0x80000000 + 133, 0x80000000 + account, 0, 0]
				const addressResult = await wallet.btcGetAddress({
					addressNList: path, coin: "Zcash", scriptType: "p2pkh", showDisplay: false,
				})
				const address = typeof addressResult === 'string' ? addressResult : addressResult?.address
				if (!address) throw new Error("Failed to derive transparent ZEC address from device")
				const { getShieldableTransparentBalance } = await import("./txbuilder/zcash-shield")
				const pioneer = await getPioneer()
				const tipHeight = getScanState().syncedTo
				const totals = await getShieldableTransparentBalance(pioneer, address, tipHeight)
				return {
					address,
					balanceZat: totals.matureZat,
					pendingZat: totals.pendingZat,
					matureCount: totals.matureCount,
					pendingCount: totals.pendingCount,
				}
			},
			zcashShieldZec: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				const account = params.account ?? 0
				if (account !== 0) throw new Error('Only account 0 is supported; multi-account shielded sends are not implemented')
				await ensureFvkLoaded(engine.wallet, account)
				await ensureZcashDeviceMatch(account, true)
				await ensureZcashScanFresh()
				// Transparent shielding uses standard ECDSA (secp256k1) for transparent inputs
				// + Orchard RedPallas for the shielded output. The ECDSA part works on any
				// firmware; the Orchard part needs >= 7.15.0 (checked by zcashShieldedInit).
				const zcashDef = CHAINS.find(c => c.id === 'zcash-shielded')
				if (!zcashDef) {
					throw new Error('Zcash shielded chain definition not found')
				}
				const { shieldZec } = await import("./txbuilder/zcash-shield")
				const pioneer = await getPioneer()
				try { rpc.send['shield-progress']({ step: 'building' }) } catch { /* webview not ready */ }
				const signWrap = engine.isEmulator
					? <T,>(fn: () => Promise<T>) => emuSigningOp(fn, {
						operation: 'zcashShieldZec', chain: 'Zcash', value: zecAmount(params.amount),
					}) as Promise<T>
					: undefined
				const onProgress = (step: string) => {
					try { rpc.send['shield-progress']({ step }) } catch { /* webview not ready */ }
				}
				const result = await shieldZec(engine.wallet as any, pioneer, {
					amount: params.amount,
					account,
				}, { signWrap, onProgress })
				try { rpc.send['shield-progress']({ step: 'complete', detail: result.txid }) } catch { /* webview not ready */ }
				return result
			},

			zcashDeshieldZec: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				const account = params.account ?? 0
				if (account !== 0) throw new Error('Only account 0 is supported; multi-account shielded sends are not implemented')
				await ensureFvkLoaded(engine.wallet, account)
				await ensureZcashDeviceMatch(account, true)
				await ensureZcashScanFresh()
				const { deshieldZec } = await import("./txbuilder/zcash-deshield")
				try { rpc.send['deshield-progress']({ step: 'building' }) } catch { /* webview not ready */ }
				const signWrap = engine.isEmulator
					? <T,>(fn: () => Promise<T>) => emuSigningOp(fn, {
						operation: 'zcashDeshieldZec', chain: 'Zcash',
						to: params.recipient, value: zecAmount(params.amount),
					}) as Promise<T>
					: undefined
				const onProgress = (step: string) => {
					try { rpc.send['deshield-progress']({ step }) } catch { /* webview not ready */ }
				}
				const result = await deshieldZec(engine.wallet as any, {
					recipient: params.recipient,
					amount: params.amount,
					account,
				}, { signWrap, onProgress })
				try { rpc.send['deshield-progress']({ step: 'complete', detail: result.txid }) } catch { /* webview not ready */ }
				return result
			},

			zcashGetTransactions: async () => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				const { getZcashTransactions } = await import("./zcash-sidecar")
				return await getZcashTransactions()
			},
			zcashBackfillMemos: async () => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				const { backfillMemos } = await import("./zcash-sidecar")
				return await backfillMemos()
			},

			zcashDisplayAddress: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				// On the emulator there is no physical button, so wrap the on-device
				// display in emuSigningOp — that installs the ButtonRequest handler that
				// surfaces the Confirm/Reject affordance in the emulator window (same as
				// the other getAddress display flows). Without it the address-verify
				// screen hangs with no button until the 120s confirm timeout.
				return engine.isEmulator
					? await emuSigningOp(
						() => displayOrchardAddressOnDevice(engine.wallet as any, params?.account ?? 0),
						{ operation: 'zcashDisplayAddress', chain: 'Zcash' },
					)
					: await displayOrchardAddressOnDevice(engine.wallet as any, params?.account ?? 0)
			},

			zcashDiagnoseAnchor: async (params: any) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				const { diagnoseAnchor } = await import("./zcash-sidecar")
				return await diagnoseAnchor(params?.shardIndex)
			},

			// ── Pairing & Signing approval ───────────────────────────
			// Window-level release is handled by onPairDismissed (fires from the
			// try/finally on auth.requestPair) — don't double-release here.
			approvePairing: async () => {
				const apiKey = auth.approvePairing()
				if (!apiKey) throw new Error('No pending pairing request')
				return { apiKey }
			},
			rejectPairing: async () => {
				auth.rejectPairing()
			},
			approveSigningRequest: async (params) => {
				if (!auth.approveSigningRequest(params.id)) throw new Error('No pending signing request with that id')
			},
			rejectSigningRequest: async (params) => {
				if (!auth.rejectSigningRequest(params.id)) throw new Error('No pending signing request with that id')
			},
			listPairedApps: async () => {
				return auth.listPairedApps()
			},
			revokePairing: async (params) => {
				if (!params.apiKey) throw new Error('apiKey required')
				auth.revoke(params.apiKey)
			},

			// ── Mobile pairing (relay via vault.keepkey.com) ─────────
			generateMobilePairing: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				const wallet = engine.wallet as any

				// Get device info
				const features = await wallet.getFeatures()
				const deviceId = features?.deviceId || features?.device_id || engine.getDeviceState().deviceId || 'keepkey-device'
				const deviceLabel = features?.label || engine.getDeviceState().label || 'My KeepKey'
				const context = `keepkey:${deviceLabel}.json`

				// Helper: convert hardened BIP44 path array to string
				const pathToString = (p: number[]) => 'm/' + p.map((n: number) => n >= 0x80000000 ? `${n - 0x80000000}'` : String(n)).join('/')
				// Helper: account-level path (first 3 elements)
				const accountPath = (p: number[]) => p.slice(0, 3)

				// Only use built-in CHAINS (not custom chains — those may lack rpc methods)
				const fwVersion = engine.getDeviceState().firmwareVersion
				const builtinChains = CHAINS.filter(c => {
					if (!isChainSupported(c, fwVersion)) return false
					// Zcash: gated by feature flag, not by hidden (hidden keeps it off Dashboard grid)
					if (c.id === 'zcash' || c.id === 'zcash-shielded') return zcashPrivacyEnabled
					if (c.id === 'hive') return hiveEnabled
					if (c.hidden) return false
					return true
				})

				const pubkeys: any[] = []

				// ── BTC: all 3 script types ──
				const btcScripts = [
					{ scriptType: 'p2pkh', purpose: 44, type: 'xpub', note: 'Bitcoin Legacy' },
					{ scriptType: 'p2sh-p2wpkh', purpose: 49, type: 'ypub', note: 'Bitcoin SegWit' },
					{ scriptType: 'p2wpkh', purpose: 84, type: 'zpub', note: 'Bitcoin Native SegWit' },
				]
				const btcChain = builtinChains.find(c => c.id === 'bitcoin')
				const btcNetwork = btcChain?.networkId || 'bip122:000000000019d6689c085ae165831e93'
				for (const s of btcScripts) {
					try {
						const addressNList = [s.purpose + 0x80000000, 0x80000000, 0x80000000]
						const addressNListMaster = [...addressNList, 0, 0]
						const result = await wallet.getPublicKeys([{
							addressNList, coin: 'Bitcoin', scriptType: s.scriptType, curve: 'secp256k1',
						}])
						const xpub = result?.[0]?.xpub
						if (xpub && typeof xpub === 'string') {
							pubkeys.push({
								type: s.type, pubkey: xpub, master: xpub,
								address: xpub, // SDK expects address field
								path: pathToString(addressNList),
								pathMaster: pathToString(addressNListMaster),
								scriptType: s.scriptType,
								available_scripts_types: ['p2pkh', 'p2sh', 'p2wpkh', 'p2sh-p2wpkh'],
								note: s.note, context,
								networks: [btcNetwork],
								addressNList, addressNListMaster,
							})
						}
					} catch (e: any) { console.warn(`[mobilePairing] BTC ${s.scriptType} failed:`, e.message) }
				}

				// ── Non-BTC UTXO chains: batch xpub derivation ──
				const utxoChains = builtinChains.filter(c => c.chainFamily === 'utxo' && c.id !== 'bitcoin')
				if (utxoChains.length > 0) {
					try {
						const xpubResults = await wallet.getPublicKeys(utxoChains.map(c => ({
							addressNList: accountPath(c.defaultPath), coin: c.coin,
							scriptType: c.scriptType, curve: 'secp256k1',
						}))) || []
						for (let i = 0; i < utxoChains.length; i++) {
							const xpub = xpubResults?.[i]?.xpub
							if (xpub && typeof xpub === 'string') {
								const chain = utxoChains[i]
								const addressNList = accountPath(chain.defaultPath)
								const addressNListMaster = [...addressNList, 0, 0]
								pubkeys.push({
									type: 'xpub', pubkey: xpub, master: xpub,
									address: xpub,
									path: pathToString(addressNList),
									pathMaster: pathToString(addressNListMaster),
									scriptType: chain.scriptType,
									available_scripts_types: [chain.scriptType || 'p2pkh'],
									note: `${chain.symbol} Default path`, context,
									networks: [chain.networkId],
									addressNList, addressNListMaster,
								})
							}
						}
					} catch (e: any) { console.warn('[mobilePairing] UTXO xpub batch failed:', e.message) }
				}

				// ── EVM chains: derive ONCE, emit with all EVM networkIds + wildcard ──
				const evmChains = builtinChains.filter(c => c.chainFamily === 'evm')
				if (evmChains.length > 0) {
					try {
						const addressNList = [0x8000002C, 0x8000003C, 0x80000000]
						const addressNListMaster = [0x8000002C, 0x8000003C, 0x80000000, 0, 0]
						const result = await wallet.ethGetAddress({ addressNList: addressNListMaster, showDisplay: false, coin: 'Ethereum' })
						const address = typeof result === 'string' ? result : result?.address
						if (address && typeof address === 'string') {
							const evmNetworks = [...evmChains.map(c => c.networkId), 'eip155:*']
							pubkeys.push({
								type: 'address', pubkey: address, master: address, address,
								path: pathToString(addressNList),
								pathMaster: pathToString(addressNListMaster),
								note: 'ETH primary (default)', context,
								networks: evmNetworks,
								addressNList, addressNListMaster,
							})
						}
					} catch (e: any) { console.warn('[mobilePairing] EVM address failed:', e.message) }
				}

				// ── Non-EVM, non-UTXO chains: individual address derivation ──
				const otherChains = builtinChains.filter(c =>
					c.chainFamily !== 'utxo' && c.chainFamily !== 'evm' && c.chainFamily !== 'zcash-shielded'
				)
				for (const chain of otherChains) {
					try {
						const addrParams: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.coin }
						if (chain.scriptType) addrParams.scriptType = chain.scriptType
						if (chain.chainFamily === 'ton') addrParams.bounceable = false
						const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
						if (typeof wallet[method] !== 'function') {
							console.warn(`[mobilePairing] ${chain.coin}: wallet.${method} not found, skipping`)
							continue
						}
						const result = await wallet[method](addrParams)
						const address = typeof result === 'string' ? result : result?.address
						if (address && typeof address === 'string') {
							pubkeys.push({
								type: 'address', pubkey: address, master: address, address,
								path: pathToString(chain.defaultPath),
								pathMaster: pathToString(chain.defaultPath),
								scriptType: chain.scriptType || chain.chainFamily,
								note: `Default ${chain.symbol} path`, context,
								networks: [chain.networkId],
								addressNList: chain.defaultPath,
								addressNListMaster: chain.defaultPath,
							})
						}
					} catch (e: any) { console.warn(`[mobilePairing] ${chain.coin} address failed:`, e.message) }
				}

				// Final safety: strip any entry with missing required fields
				const validPubkeys = pubkeys.filter(p =>
					p.pubkey && typeof p.pubkey === 'string' &&
					p.pathMaster && typeof p.pathMaster === 'string' &&
					Array.isArray(p.networks) && p.networks.length > 0
				)

				if (validPubkeys.length === 0) throw new Error('No pubkeys could be derived from device')
				console.log(`[mobilePairing] ${validPubkeys.length} valid pubkeys (${pubkeys.length - validPubkeys.length} dropped)`)

				// POST to vault.keepkey.com relay
				const RELAY_URL = 'https://vault.keepkey.com/api/pairing'
				const resp = await fetch(RELAY_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ deviceId, label: deviceLabel, pubkeys: validPubkeys }),
				})
				if (!resp.ok) {
					const body = await resp.text().catch(() => '')
					throw new Error(`Pairing relay returned ${resp.status}: ${body}`)
				}
				const data = await resp.json() as { success: boolean; code: string; expiresAt: number; expiresIn: number }
				if (!data.success || !data.code) throw new Error('Invalid response from pairing relay')

				const qrPayload = JSON.stringify({ code: data.code, url: 'https://vault.keepkey.com' })
				console.log(`[mobilePairing] Code ${data.code} — ${validPubkeys.length} pubkeys sent to relay`)

				return { code: data.code, expiresAt: data.expiresAt, expiresIn: data.expiresIn, qrPayload }
			},

			// ── Window Focus ─────────────────────────────────────────
			getWindowFocusState: async () => {
				return { refs: _alwaysOnTopRefs, alwaysOnTop: _alwaysOnTopRefs > 0 }
			},
			forceReleaseWindowFocus: async () => {
				if (_alwaysOnTopRefs > 0) {
					console.warn(`[window-focus] Force-releasing stuck always-on-top (refs was ${_alwaysOnTopRefs})`)
					_alwaysOnTopRefs = 0
					try { mainWindow.setAlwaysOnTop(false) } catch { /* ignore */ }
					_emitWindowFocusChanged()
				}
			},
			setWindowAlwaysOnTop: async (params) => {
				if (params.enabled) {
					acquireWindowFocus()
				} else {
					// Force-release all refs when manually toggling off
					if (_alwaysOnTopRefs > 0) {
						_alwaysOnTopRefs = 0
						try { mainWindow.setAlwaysOnTop(false) } catch { /* ignore */ }
						_emitWindowFocusChanged()
					}
				}
			},

			// ── App Settings ─────────────────────────────────────────
			getAppSettings: async () => {
				return getAppSettings()
			},
			// One-time: mark the passphrase/hidden-wallet intro dialog as seen so it
			// never shows again (also set when the OOB passphrase card is completed).
			markPassphraseIntroShown: async () => {
				setSetting('passphrase_intro_shown', '1')
				return getAppSettings()
			},
			setRestApiEnabled: async (params) => {
				restApiEnabled = params.enabled
				setSetting('rest_api_enabled', params.enabled ? '1' : '0')
				await applyRestApiState()
				return getAppSettings()
			},
			setPioneerApiBase: async (params) => {
				const url = (params.url || '').trim()
				if (url && !/^https?:\/\//i.test(url)) {
					throw new Error('URL must start with http:// or https://')
				}
				setSetting('pioneer_api_base', url) // empty string = reset to default
				resetPioneer()
				chainCatalog = []
				catalogLoadedAt = 0
				// Flush swap asset cache too — without this, the 5-minute TTL
				// keeps the previous server's asset list (e.g. missing TRON.USDT)
				// sticky after the user repoints to a server that lists more.
				const { clearSwapCache } = await import('./swap')
				clearSwapCache()
				loadSupportedChains(getPioneerApiBase()).catch(() => {})
				console.log('[settings] Pioneer API base set to:', url || '(default)')
				return getAppSettings()
			},
			setFiatCurrency: async (params) => {
				setSetting('fiat_currency', params.currency || 'USD')
				console.log('[settings] Fiat currency set to:', params.currency)
				return getAppSettings()
			},
			setNumberLocale: async (params) => {
				setSetting('number_locale', params.locale || 'en-US')
				console.log('[settings] Number locale set to:', params.locale)
				return getAppSettings()
			},
			setWalletConnectEnabled: async (params) => {
				walletConnectEnabled = params.enabled
				setSetting('walletconnect_enabled', params.enabled ? '1' : '0')
				console.log('[settings] WalletConnect enabled:', params.enabled)
				return getAppSettings()
			},
			setBip85Enabled: async (params) => {
				// BIP-85 requires firmware >= 7.16.0
				const fwVer = engine.getDeviceState().firmwareVersion
				if (params.enabled && (!fwVer || versionCompare(fwVer, '7.16.0') < 0)) {
					console.warn(`[settings] BIP-85 blocked — firmware ${fwVer || 'unknown'} < 7.16.0`)
					return getAppSettings()
				}
				bip85Enabled = params.enabled
				setSetting('bip85_enabled', params.enabled ? '1' : '0')
				console.log('[settings] BIP-85 enabled:', params.enabled)
				return getAppSettings()
			},
			setHiveEnabled: async (params) => {
				// Hive requires firmware >= 7.15.0 (matches minFirmware in shared/chains.ts).
				const fwVer = engine.getDeviceState().firmwareVersion
				if (params.enabled && (!fwVer || versionCompare(fwVer, '7.15.0') < 0)) {
					console.warn(`[settings] Hive blocked — firmware ${fwVer || 'unknown'} < 7.15.0`)
					return getAppSettings()
				}
				hiveEnabled = params.enabled
				setSetting('hive_enabled', params.enabled ? '1' : '0')
				console.log('[settings] Hive enabled:', params.enabled)
				return getAppSettings()
			},
			setEmulatorEnabled: async (params) => {
				// Refuse to enable on platforms with no emulator support. The
				// emulator runs on macOS (Keychain) and Windows (DPAPI); Linux
				// has no key store, so enabling there just shows a broken UI.
				if (params.enabled && process.platform !== 'darwin' && process.platform !== 'win32') {
					throw new Error('Emulator is only available on macOS and Windows')
				}
				// When turning the emulator off while it's running, stop it first
				// and fail CLOSED — if shutdown doesn't complete, the flag stays
				// on so the user keeps UI to retry. Hiding a live emulator with
				// no way out is worse than surfacing a shutdown error.
				if (!params.enabled && emulatorEnabled) {
					const { getEmulatorStatus, stopEmulator } = await import('./emulator')
					if (getEmulatorStatus().state === 'running') {
						const { closeEmulatorWindow } = await import('./emulator-window')
						closeEmulatorWindow()
						engine.disconnectEmulator()
						stopEmulator()
						const after = getEmulatorStatus()
						if (after.state !== 'stopped') {
							throw new Error(`Emulator could not be stopped (state=${after.state}); flag unchanged`)
						}
					}
				}
				emulatorEnabled = params.enabled
				setSetting('emulator_enabled', params.enabled ? '1' : '0')
				console.log('[settings] Emulator enabled:', params.enabled)
				return getAppSettings()
			},
			setZcashPrivacyEnabled: async (params) => {
				// Must match shared/chains.ts (zcash + zcash-shielded both at 7.15.0)
				// and the helpers in txbuilder/zcash-shield.ts that require
				// ZcashTransparentInput support (also 7.15.0). Letting users enable
				// the feature on 7.14.0 only to have every action fail downstream is
				// worse than blocking it here.
				const fwVer = engine.getDeviceState().firmwareVersion
				if (params.enabled && (!fwVer || versionCompare(fwVer, '7.15.0') < 0)) {
					console.warn(`[settings] Zcash privacy blocked — firmware ${fwVer || 'unknown'} < 7.15.0`)
					return getAppSettings()
				}
				zcashPrivacyEnabled = params.enabled
				setSetting('zcash_privacy_enabled', params.enabled ? '1' : '0')
				console.log('[settings] Zcash privacy enabled:', params.enabled)
				if (params.enabled) {
					if (!isSidecarReady()) {
						console.log('[zcash] Starting sidecar on feature enable...')
						try { await startSidecar() } catch (e: any) {
							console.error('[zcash] Sidecar failed to start:', e.message)
						}
					}
				} else {
					console.log('[zcash] Stopping sidecar on feature disable...')
					stopSidecar()
				}
				return getAppSettings()
			},
			setPreReleaseUpdates: async (params) => {
				preReleaseUpdates = params.enabled
				setSetting('pre_release_updates', params.enabled ? '1' : '0')
				console.log('[settings] Pre-release updates:', params.enabled)
				return getAppSettings()
			},
			setAlphaFirmware: async (params) => {
				alphaFirmware = params.enabled
				setSetting('alpha_firmware', params.enabled ? '1' : '0')
				console.log('[settings] Alpha firmware channel:', params.enabled)
				engine.setAlphaFirmware(params.enabled)
				// Re-derive device state so needs_firmware_update reflects the new channel
				engine.syncState().catch(e => console.warn('[settings] syncState after alpha toggle failed:', e))
				return getAppSettings()
			},
			setPrivateModeEnabled: async (params) => {
				privateModeEnabled = params.enabled
				setSetting('private_mode_enabled', params.enabled ? '1' : '0')
				console.log('[settings] Private mode:', params.enabled)
				return getAppSettings()
			},
			// ── Factory Reset ─────────────────────────────────────────
			factoryReset: async () => {
				console.log('[factory-reset] Starting full app reset...')
				// Stop zcash sidecar if running
				if (isSidecarReady()) {
					stopSidecar()
				}
				// Nuke all databases (vault + zcash sidecar)
				factoryResetDb()
				console.log('[factory-reset] Complete — quitting app')
				// Give the RPC response a moment to flush, then quit
				setTimeout(() => cleanupAndQuit(), 500)
			},

			addPioneerServer: async (params) => {
				const url = (params.url || '').trim().replace(/\/+$/, '')
				const label = (params.label || '').trim()
				if (!url || !/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://')
				if (!label) throw new Error('Label is required')
				// Health-check the server before adding
				const healthUrl = `${url}/api/v1/health`
				try {
					const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) })
					if (!resp.ok) throw new Error(`${healthUrl} returned HTTP ${resp.status}`)
				} catch (e: any) {
					throw new Error(`Health check failed for ${healthUrl}: ${e.message}`)
				}
				addPioneerServerDb(url, label)
				console.log('[settings] Pioneer server added:', label, url)
				return getAppSettings()
			},
			removePioneerServer: async (params) => {
				const url = (params.url || '').trim()
				if (!url) throw new Error('URL is required')
				removePioneerServerDb(url)
				// If the removed server was the active one, reset to default
				const currentBase = getPioneerApiBase()
				if (currentBase === url) {
					setSetting('pioneer_api_base', '')
					resetPioneer()
					chainCatalog = []
					catalogLoadedAt = 0
					const { clearSwapCache } = await import('./swap')
					clearSwapCache()
					console.log('[settings] Active server removed, reset to default')
				}
				console.log('[settings] Pioneer server removed:', url)
				return getAppSettings()
			},
			setActivePioneerServer: async (params) => {
				const url = (params.url || '').trim().replace(/\/+$/, '')
				if (!url) throw new Error('URL is required')
				// Verify the server exists in our list
				const servers = getPioneerServers()
				if (!servers.find(s => s.url === url)) throw new Error(`Server "${url}" not found in saved list (have: ${servers.map(s => s.url).join(', ')})`)
				// Health-check before switching
				const healthUrl = `${url}/api/v1/health`
				try {
					const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) })
					if (!resp.ok) throw new Error(`${healthUrl} returned HTTP ${resp.status}`)
				} catch (e: any) {
					throw new Error(`Health check failed for ${healthUrl}: ${e.message}`)
				}
				// If switching to the built-in hardcoded default, clear the override so
				// getPioneerApiBase() falls back naturally. Otherwise store the URL.
				// NOTE: do NOT use the DB isDefault flag here — that flag is user-managed
				// (e.g. the user may have marked a custom server as "default") and would
				// cause the wrong URL to be silently cleared.
				if (url === DEFAULT_API_BASE) {
					setSetting('pioneer_api_base', '')
				} else {
					setSetting('pioneer_api_base', url)
				}
				resetPioneer()
				chainCatalog = []
				catalogLoadedAt = 0
				const { clearSwapCache } = await import('./swap')
				clearSwapCache()
				loadSupportedChains(getPioneerApiBase()).catch(() => {})
				console.log('[settings] Active Pioneer server set to:', url)
				return getAppSettings()
			},

			// ── API Audit Log ────────────────────────────────────────
			getApiLogs: async (params) => {
				// PRIVACY: Don't expose standard-wallet activity logs during hidden sessions.
				if (engine.isPassphraseWallet) return []
				const scope = getWalletDbScope()
				if (!scope) return []
				return getApiLogs(params?.limit ?? 200, params?.offset ?? 0, scope.deviceId, scope.walletId)
			},
			clearApiLogs: async () => {
				const scope = getWalletDbScope()
				if (scope) clearApiLogs(scope.deviceId, scope.walletId)
			},

			// ── Address Book ─────────────────────────────────────────
			matchAddress: async (params) => {
				// Instant recipient detection (R5) — wallet-agnostic, read-only.
				const chain = getAllChains().find(c => c.networkId === params.networkId)
				if (!chain) return null
				return matchAddressBook(params.networkId, params.address, chain.chainFamily)
			},
			listAddressBook: async (params) => {
				// The Address Book is wallet-agnostic public data (own = watch-only public
				// addresses; external = saved contacts), so it loads regardless of which
				// wallet is active — including hidden/passphrase sessions. Only the SEED
				// (a write) is gated, since hidden sessions persist nothing new.
				if (!engine.isPassphraseWallet) { try { seedOwnFromCache() } catch { /* never block the read */ } }
				const labels = getDeviceLabelMap()
				const networkId = params?.networkId
				const search = params?.search
				// own = every device's wallets (cross-device); external = all explicitly-saved
				// contacts (cross-wallet; R4 opt-in — history-only recipients stay hidden).
				const own = getAddressBookList({ kind: 'own', networkId, search })
				const external = getAddressBookList({ kind: 'external', networkId, search, savedOnly: true })
				return [...own, ...external].map(e => ({ ...e, deviceLabel: labels[e.deviceId] || e.deviceLabel }))
			},
			addAddressBook: async (params) => {
				// Wallet-agnostic: contacts can be saved from any session (incl. hidden).
				const scope = getWalletDbScope()
				if (!scope) return null
				const chain = getAllChains().find(c => c.networkId === params.networkId)
				if (!chain) { console.warn('[addressbook] addAddressBook: unknown networkId', params.networkId); return null }
				const entry = addExternalEntry({
					walletId: scope.walletId, deviceId: scope.deviceId,
					networkId: chain.networkId, chainId: chain.id, chainFamily: chain.chainFamily,
					address: params.address, label: params.label ?? null,
				})
				if (entry) { try { rpc.send['addressbook-changed']({}) } catch { /* webview not ready */ } }
				return entry
			},
			updateAddressBook: async (params) => {
				// Global (wallet-agnostic) — edit any contact from any session.
				const ok = updateAddressBookEntry(params.id, null, { label: params.label, note: params.note })
				if (ok) { try { rpc.send['addressbook-changed']({}) } catch { /* webview not ready */ } }
				return ok
			},
			deleteAddressBook: async (params) => {
				deleteAddressBookEntry(params.id, null)
				try { rpc.send['addressbook-changed']({}) } catch { /* webview not ready */ }
			},
			getAddressBookHistory: async (params) => {
				return getAddressBookHistory(params.entryId, null)
			},

			// ── Accounting ledger ────────────────────────────────────
			getLedgerSummary: async () => {
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) return []
				return getLedgerSummary(deviceId)
			},
			getLedgerJournals: async ({ limit }: { limit?: number }) => {
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) return []
				return getLedgerJournals(deviceId, limit ?? 50)
			},

			// ── Reports ─────────────────────────────────────────────
			generateReport: async () => {
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')

				// PRIVACY: Reports read from DB cache, which is intentionally empty
				// for passphrase wallets. Generating a report would either fail or
				// create a persistent record of the hidden wallet.
				if (engine.isPassphraseWallet) {
					throw new Error('Reports are not available for passphrase-protected wallets. Hidden wallet data is not stored for privacy.')
				}

				const reportId = `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

				// Get cached balances for report data
				const cached = getCachedBalances(deviceId)
				const balances = cached?.balances || []
				if (balances.length === 0) {
					throw new Error('No cached balances available. Please refresh your portfolio first.')
				}

				// Gather BTC xpubs from BtcAccountManager (try init if needed)
				let btcXpubs: Array<{ xpub: string; scriptType: string; path: number[] }> | undefined
				console.log(`[generateReport] btcAccounts.isInitialized=${btcAccounts.isInitialized}`)
				if (!btcAccounts.isInitialized && engine.wallet) {
					try {
						console.log('[generateReport] Initializing BTC accounts for report...')
						await btcAccounts.initialize(engine.wallet as any)
					} catch (e: any) {
						console.warn('[generateReport] BTC accounts init failed:', e.message)
					}
				}
				if (btcAccounts.isInitialized) {
					const btcSet = btcAccounts.toAccountSet()
					btcXpubs = []
					for (const acct of btcSet.accounts) {
						for (const x of acct.xpubs) {
							if (x.xpub) btcXpubs.push({ xpub: x.xpub, scriptType: x.scriptType, path: x.path })
						}
					}
					console.log(`[generateReport] btcXpubs from BtcAccountManager: ${btcXpubs.length}`)
				}
				// Fallback: check cached_pubkeys DB for BTC xpubs
				if (!btcXpubs || btcXpubs.length === 0) {
					const cachedPks = getCachedPubkeys(deviceId)
					const btcPks = cachedPks.filter(p => p.chainId === 'bitcoin' && p.xpub)
					if (btcPks.length > 0) {
						btcXpubs = btcPks.map(p => ({
							xpub: p.xpub,
							scriptType: p.scriptType || 'p2wpkh',
							path: p.path ? p.path.split('/').filter(Boolean).map(s => parseInt(s.replace("'", ''), 10)) : [],
						}))
						console.log(`[generateReport] btcXpubs from cached_pubkeys DB: ${btcXpubs.length}`)
					} else {
						console.warn('[generateReport] No BTC xpubs found anywhere — BTC sections will be skipped')
					}
				}

				const deviceLabel = engine.getDeviceState().label || 'KeepKey'

				// Save placeholder (lod=5 always)
				saveReport(deviceId, reportId, 'all', 5, 0, 'generating', '{}')

				// Send initial progress
				try { rpc.send['report-progress']({ id: reportId, message: 'Starting...', percent: 0 }) } catch {}

				try {
					const reportData = await generateReport({
						balances,
						btcXpubs,
						deviceId,
						deviceLabel,
						onProgress: (message, percent) => {
							try { rpc.send['report-progress']({ id: reportId, message, percent }) } catch {}
						},
					})

					const totalUsd = balances.reduce((s, b) => s + (b.balanceUsd || 0), 0)
					// M7: Only save final result if report wasn't deleted during generation
					if (reportExists(reportId)) {
						saveReport(deviceId, reportId, 'all', 5, totalUsd, 'complete', JSON.stringify(reportData))
					}

					try { rpc.send['report-progress']({ id: reportId, message: 'Complete', percent: 100 }) } catch {}

					return {
						id: reportId,
						createdAt: Date.now(),
						chain: 'all',
						totalUsd,
						status: 'complete' as const,
					}
				} catch (e: any) {
					// M9: Sanitize error messages — strip auth keys and URLs
					const safeMsg = e.message?.replace(/key:[^\s"',}]+/gi, 'key:***').replace(/https?:\/\/[^\s"',}]+/gi, '<url>') || 'Report generation failed'
					saveReport(deviceId, reportId, 'all', 5, 0, 'error', '{}', safeMsg)
					try { rpc.send['report-progress']({ id: reportId, message: `Error: ${safeMsg}`, percent: 100 }) } catch {}
					throw new Error(safeMsg)
				}
			},

			listReports: async () => {
				// PRIVACY: Don't expose standard-wallet reports during hidden sessions.
				if (engine.isPassphraseWallet) return []
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) return []
				return getReportsList(deviceId)
			},

			// H1: Scope getReport/deleteReport to the current device
			getReport: async (params) => {
				if (engine.isPassphraseWallet) return null
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')
				return getReportById(params.id, deviceId)
			},

			deleteReport: async (params) => {
				if (engine.isPassphraseWallet) return
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')
				deleteReport(params.id, deviceId)
			},

			saveReportFile: async (params) => {
				if (engine.isPassphraseWallet) throw new Error('Reports are not available for passphrase-protected wallets (privacy).')
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')
				const report = getReportById(params.id, deviceId)
				if (!report) throw new Error('Report not found')

				const dateSuffix = new Date(report.meta.createdAt).toISOString().split('T')[0]
				const year = new Date(report.meta.createdAt).getFullYear()
				const downloadsDir = path.join(os.homedir(), 'Downloads')

				console.log(`[reports] saveReportFile: format=${params.format}, id=${params.id}`)

				let filePath: string
				if (params.format === 'csv') {
					const shortId = params.id.slice(-6).replace(/[^a-zA-Z0-9]/g, '')
					filePath = path.join(downloadsDir, `keepkey-report-${dateSuffix}-${shortId}.csv`)
					await Bun.write(filePath, reportToCsv(report.data))
					console.log(`[reports] Full CSV written: ${report.data.sections.length} sections`)
				} else if (params.format === 'cointracker') {
					filePath = path.join(downloadsDir, `keepkey_cointracker_${year}.csv`)
					const txs = extractTransactionsFromReport(report.data)
					console.log(`[reports] CoinTracker: ${txs.length} transactions extracted`)
					await Bun.write(filePath, toCoinTrackerCsv(txs))
				} else if (params.format === 'zenledger') {
					filePath = path.join(downloadsDir, `keepkey_zenledger_${year}.csv`)
					const txs = extractTransactionsFromReport(report.data)
					console.log(`[reports] ZenLedger: ${txs.length} transactions extracted`)
					await Bun.write(filePath, toZenLedgerCsv(txs))
				} else if (params.format === 'pdf') {
					const shortId = params.id.slice(-6).replace(/[^a-zA-Z0-9]/g, '')
					const safeChain = (report.meta.chain || 'all').replace(/[^a-zA-Z0-9_-]/g, '_')
					filePath = path.join(downloadsDir, `keepkey-report-${safeChain}-${dateSuffix}-${shortId}.pdf`)
					console.log(`[reports] Generating PDF to ${filePath}...`)
					const pdfBuffer = await reportToPdfBuffer(report.data)
					console.log(`[reports] PDF buffer ready: ${pdfBuffer.length} bytes`)
					await Bun.write(filePath, pdfBuffer)
					console.log(`[reports] PDF written to disk`)
				} else {
					throw new Error(`Unknown export format: ${params.format}`)
				}

				// L3: Reveal in Finder / file manager (with error handling)
				try {
					const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'linux' ? 'xdg-open' : 'open'
					const args = process.platform === 'darwin' ? ['-R', filePath] : [filePath]
					Bun.spawn([cmd, ...args])
				} catch (e: any) {
					console.warn('[reports] Failed to reveal file:', e.message)
				}

				console.log(`[reports] File saved: ${filePath}`)
				return { filePath }
			},

			// ── Swap (quote cache for tracker) ──────────────────────
			getSwappableChainIds: async () => {
				const { getSwapAssets } = await import('./swap')
				const assets = await getSwapAssets()
				const fw = engine.getDeviceState().firmwareVersion
				const chainMap = new Map(getAllChains().map(c => [c.id, c]))
				const chainIds = new Set(
					assets
						.filter(a => !a.contractAddress)
						.filter(a => { const c = chainMap.get(a.chainId); return c ? isChainSupported(c, fw) : false })
						.map(a => a.chainId)
				)
				return [...chainIds]
			},
			getSwapAssets: async () => deviceSwapAssets(),
			searchSwapAssets: async (params) => {
				const { searchDiscoveryAssets } = await import('./swap')
				return searchDiscoveryAssets(params.query)
			},

			getSwapHealth: async () => {
				const base = await (await import('./pioneer')).getPioneerApiBase()
				try {
					const resp = await fetch(`${base}/api/v1/swap/health`, { signal: AbortSignal.timeout(8000) })
					if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
					const data = await resp.json() as any
					return data as import('../shared/types').SwapHealth
				} catch (e: any) {
					// Pioneer unreachable — return offline for all known integrations
					console.warn('[swap] getSwapHealth failed:', e?.message)
					return {
						fetchedAt: Date.now(),
						integrations: [
							{ key: 'thorchain',  label: 'THORChain', status: 'offline' as const },
							{ key: 'mayachain',  label: 'Mayachain', status: 'offline' as const },
							{ key: 'shapeshift', label: 'ShapeShift', status: 'offline' as const },
							{ key: 'relay',      label: 'Relay',     status: 'offline' as const },
						],
					}
				}
			},

			/** Look up an unknown EVM token by contract address.
			 *  Tries Ethereum + common L2s/sidechains in parallel via Pioneer's
			 *  GetMarketInfo + GetTokenDecimals. Frontend uses this to "add custom
			 *  token" when the user pastes a contract into the picker search and
			 *  nothing matches. */
			lookupTokenContract: async (params) => {
				const raw = (params.contractAddress || '').trim()

				// ── Solana SPL mint (base58, not 0x) ──────────────────────────
				// Only in Solana context (the picker's Solana step) or when no chain
				// was specified — never resolve a base58 mint against Solana while an
				// EVM chainId was passed, which would silently cross chains. Validates
				// on-chain + enriches via Jupiter; returns a single SwapAsset hit.
				const isSolanaCtx = params.chainId === 'solana' || (params.chainId?.startsWith('solana:') ?? false)
				const { SOLANA_MINT_RE, resolveSolanaMint } = await import('./solana-token')
				if (!raw.startsWith('0x') && (isSolanaCtx || !params.chainId) && SOLANA_MINT_RE.test(raw)) {
					const solChain = getAllChains().find(c => c.id === 'solana')
					if (!solChain) return { hits: [] as SwapAsset[], reason: 'solana-not-configured' }
					const endpoint = getSetting('solana_rpc_endpoint') || undefined
					const meta = await resolveSolanaMint(raw, endpoint)
					if (!meta) return { hits: [] as SwapAsset[], reason: 'not-a-solana-mint' }
					const hit: SwapAsset = {
						asset: meta.symbol,
						caip: `${solChain.networkId}/token:${raw}`,
						chainId: solChain.id,
						chainFamily: 'solana',
						contractAddress: raw,
						decimals: meta.decimals,
						symbol: meta.symbol,
						name: meta.name,
						icon: meta.iconUrl,
					}
					return { hits: [hit] }
				}

				if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
					return { hits: [] as SwapAsset[], reason: 'invalid-evm-contract' }
				}
				const lower = raw.toLowerCase()

				/* When the user specifies a chainId, only probe that one. Otherwise
				 * try every EVM RPC we have configured in parallel — direct
				 * on-chain ERC20 reads (name/symbol/decimals) work even for
				 * tokens Pioneer hasn't indexed yet. */
				const chainsToProbe = params.chainId
					? [params.chainId.replace(/^eip155:/, '')]
					: Object.keys(EVM_RPC_URLS)

				const allChains = getAllChains()
				const hits = (await Promise.all(chainsToProbe.map(async (numericId) => {
					const rpcUrl = EVM_RPC_URLS[numericId]
					if (!rpcUrl) return null
					// Resolve vault's internal chain id (e.g. 'base') from the EIP-155
					// network id. SwapAsset.chainId per types.ts is the vault id, NOT
					// CAIP-2 — every downstream consumer (balance lookup, addCustomToken
					// handler, swap-discovery merge) keys on it. Returning the CAIP-2
					// form here previously silently broke the picker's add flow:
					// keepKeyToAddress/balances find returned undefined, canQuote was
					// false, and no quote ever fired.
					const networkId = `eip155:${numericId}`
					const vaultChain = allChains.find(c => c.networkId === networkId)
					if (!vaultChain) return null
					try {
						const meta = await withTimeout(
							getTokenMetadata(rpcUrl, lower),
							8000,
							`getTokenMetadata(${numericId})`,
						)
						/* Reject empty responses — RPCs sometimes return zero-length
						 * strings for EOA addresses or bogus contracts. We need a real
						 * symbol + decimals to safely build a swap. */
						if (!meta.symbol || typeof meta.decimals !== 'number') return null
						const caip = `${networkId}/erc20:${lower}`
						return {
							asset: meta.symbol,
							caip,
							chainId: vaultChain.id,
							chainFamily: 'evm',
							contractAddress: lower,
							decimals: meta.decimals,
							symbol: meta.symbol,
							name: meta.name || meta.symbol,
						} as SwapAsset
					} catch (e: any) {
						/* Per-chain failure is fine — most RPCs will return "execution
						 * reverted" because the contract doesn't exist on that chain. */
						return null
					}
				}))).filter((h): h is SwapAsset => h !== null)

				return { hits }
			},
			getSwapQuote: (params) => headlessSwapQuote(params),
			executeSwap: (params) => headlessExecuteSwap(params, (stage) => {
				try { rpc.send["swap-substage"]({ stage }) } catch { /* webview not ready */ }
			}),
			getPendingSwaps: async () => {
				// Hidden sessions DO get pending swaps: the tracker holds them in RAM
				// (registerSwap with skipPersist → noPersistSwaps), so this exposes only
				// live in-session state. The rehydrate inside swap-tracker reads
				// swap_history scoped to walletId — a hidden walletId has zero persisted
				// rows (write gates), so nothing from the standard wallet can leak here,
				// and the in-memory filter (s.walletId === walletId) keeps the two
				// sessions' swaps apart in both directions.
				const { getPendingSwaps } = await import('./swap-tracker')
				const scope = getWalletDbScope()
				if (!scope) return []
				return getPendingSwaps(scope.deviceId, scope.walletId)
			},
			dismissSwap: async (params) => {
				const { dismissSwap } = await import('./swap-tracker')
				dismissSwap(params.txid)
			},
			previewSwapBuild: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const { previewSwapBuild, NOOP_PUSH_SUBSTAGE } = await import('./swap')
				return previewSwapBuild(params, {
					wallet: engine.wallet,
					getAllChains,
					getRpcUrl,
					getBtcXpub: () => {
						if (btcAccounts.isInitialized) {
							const selected = btcAccounts.getSelectedXpub()
							if (selected) return { xpub: selected.xpub, accountPath: selected.path }
						}
						return undefined
					},
					getAllBtcXpubs: () => {
						if (btcAccounts.isInitialized) return btcAccounts.getFundedXpubs()
						return []
					},
					wrapSign: (fn) => fn(), // unused in preview
					pushSubStage: NOOP_PUSH_SUBSTAGE,
				})
			},

			// ── Swap History (SQLite-persisted) ─────────────────────
			getSwapByTxid: async (params) => {
				// PRIVACY via scoping, NOT a blanket passphrase block. Hidden-wallet
				// swaps are in-memory only (skipPersist) — there is no DB row — so a
				// blanket block left the hidden session unable to read its OWN swap
				// (status stuck "pending" in the detail view). Scope by walletId and
				// fall back to the live tracker copy: a hidden walletId never matches a
				// standard swap (DB lookup is walletId-scoped; in-memory filter too), so
				// standard-wallet swaps stay invisible here.
				const scope = getWalletDbScope()
				if (!scope) return null
				const record = getSwapHistoryByTxid(params.txid, scope.deviceId, scope.walletId)
				const { inferConfirmationsFromStatus, getPendingSwaps } = await import('./swap-tracker')
				// Prefer the in-memory tracker copy when present — it has live
				// outboundConfirmations / required / swapper that the DB row doesn't
				// store, and IS the only source for in-memory-only hidden swaps.
				const live = getPendingSwaps(scope.deviceId, scope.walletId).find(s => s.txid === params.txid)
				if (!record && !live) return null
				// Lazy CAIP backfill for swaps inserted before the from_caip/to_caip
				// columns existed — derive on the fly from the THORChain asset id.
				let fromCaip = record?.fromCaip ?? live?.fromCaip
				let toCaip = record?.toCaip ?? live?.toCaip
				const fromAssetId = record?.fromAsset ?? live?.fromAsset
				const toAssetId = record?.toAsset ?? live?.toAsset
				if (!fromCaip || !toCaip) {
					const { assetToCaip } = await import('./swap-parsing')
					if (!fromCaip && fromAssetId) try { fromCaip = assetToCaip(fromAssetId) } catch { /* unknown chain */ }
					if (!toCaip && toAssetId) try { toCaip = assetToCaip(toAssetId) } catch { /* unknown chain */ }
				}
				const status = record?.status ?? live!.status
				return {
					deviceId: record?.deviceId ?? live?.deviceId,
					walletId: record?.walletId ?? live?.walletId,
					txid: record?.txid ?? live!.txid,
					fromAsset: fromAssetId!,
					toAsset: toAssetId!,
					fromSymbol: record?.fromSymbol ?? live?.fromSymbol,
					toSymbol: record?.toSymbol ?? live?.toSymbol,
					fromChainId: record?.fromChainId ?? live?.fromChainId,
					toChainId: record?.toChainId ?? live?.toChainId,
					fromCaip,
					toCaip,
					fromAmount: record?.fromAmount ?? live?.fromAmount,
					expectedOutput: record ? (record.receivedOutput || record.quotedOutput) : (live?.receivedOutput || live?.expectedOutput),
					receivedOutput: record?.receivedOutput ?? live?.receivedOutput,
					memo: record?.memo ?? live?.memo,
					inboundAddress: record?.inboundAddress ?? live?.inboundAddress,
					router: record?.router ?? live?.router,
					integration: record?.integration ?? live?.integration,
					swapper: record?.swapper || live?.swapper,
					status,
					confirmations: live?.confirmations ?? inferConfirmationsFromStatus(status),
					outboundConfirmations: live?.outboundConfirmations,
					outboundRequiredConfirmations: live?.outboundRequiredConfirmations,
					outboundTxid: record?.outboundTxid ?? live?.outboundTxid,
					error: record?.error ?? live?.error,
					createdAt: record?.createdAt ?? live?.createdAt,
					updatedAt: record?.updatedAt ?? live?.updatedAt,
					completedAt: record?.completedAt ?? live?.completedAt,
					estimatedTime: record?.estimatedTimeSeconds ?? live?.estimatedTime,
					slippageBps: record?.slippageBps ?? live?.slippageBps,
					relayRequestId: live?.relayRequestId ?? record?.relayRequestId,
					nearTxHash: live?.nearTxHash ?? record?.nearTxHash,
					outboundChainId: live?.outboundChainId ?? record?.outboundChainId,
					refundReason: live?.refundReason ?? record?.refundReason,
				}
			},
			refreshSwap: async (params) => {
				// PRIVACY via scoping, NOT a blanket passphrase block. A hidden session
				// must still refresh ITS OWN in-memory swaps (they're skipPersist, so
				// the live poll is the only thing that can advance them to completed —
				// e.g. a NEAR Intents Solana deposit waiting on 1Click). The tracker
				// filters by walletId (live.walletId === walletId, and hydrateFromDb is
				// walletId-scoped), and a hidden walletId (deviceId:hiddenSeedEthAddr)
				// never matches a standard swap's walletId — so standard-wallet swaps
				// remain unreachable from here. Same posture as getPendingSwaps.
				const { refreshSwap } = await import('./swap-tracker')
				const scope = getWalletDbScope()
				if (!scope) return null
				return await refreshSwap(params.txid, scope.deviceId, scope.walletId, params.rescan)
			},
			debugSwapLookup: async (params) => {
				// PRIVACY: Mirror getSwapByTxid / refreshSwap — passphrase sessions
				// must not see standard-wallet diagnostic data. The function-level
				// noPersistSwaps gate inside debugSwapLookup catches passphrase-
				// tagged txids regardless of caller; this is the session-level
				// gate that refuses the call entirely from a hidden session.
				if (engine.isPassphraseWallet) return null
				const { debugSwapLookup } = await import('./swap-tracker')
				const scope = getWalletDbScope()
				if (!scope) return null
				return await debugSwapLookup(params.txid, scope.deviceId, scope.walletId)
			},
			getSwapHistory: async (params) => {
				if (engine.isPassphraseWallet) return []
				const scope = getWalletDbScope()
				if (!scope) return []
				return getSwapHistory({ ...(params || {}), ...scope })
			},
			getSwapHistoryStats: async () => {
				if (engine.isPassphraseWallet) return { totalSwaps: 0, completed: 0, failed: 0, refunded: 0, pending: 0 }
				const scope = getWalletDbScope()
				if (!scope) return { totalSwaps: 0, completed: 0, failed: 0, refunded: 0, pending: 0 }
				return getSwapHistoryStats(scope.deviceId, scope.walletId)
			},
			// Fire-and-forget mirror — SwapDialog calls this on every state change
			// so Bun (and REST) can observe what the user sees. Phase 'closed' on
			// dialog dismount resets the snapshot.
			publishSwapUiState: async (params) => {
				swapUiState = params
				swapUiUpdatedAt = Date.now()
			},

			exportSwapReport: async (params) => {
				if (engine.isPassphraseWallet) throw new Error('Swap reports are not available for passphrase-protected wallets (privacy).')
				const scope = getWalletDbScope()
				if (!scope) throw new Error('No device connected')
				const records = getSwapHistory({
					...scope,
					fromDate: params.fromDate,
					toDate: params.toDate,
					limit: 10000,
				})
				if (records.length === 0) throw new Error('No swap records to export')

				const dir = path.join(os.homedir(), 'Downloads')

				if (params.format === 'csv') {
					const { generateSwapCsv } = await import('./swap-report')
					const csv = generateSwapCsv(records)
					const fileName = `keepkey-swaps-${new Date().toISOString().slice(0, 10)}.csv`
					const filePath = path.join(dir, fileName)
					await Bun.write(filePath, csv)
					return { filePath }
				} else {
					const { generateSwapPdf } = await import('./swap-report')
					const pdfBuffer = await generateSwapPdf(records)
					const fileName = `keepkey-swaps-${new Date().toISOString().slice(0, 10)}.pdf`
					const filePath = path.join(dir, fileName)
					await Bun.write(filePath, pdfBuffer)
					return { filePath }
				}
			},

			// ── Recent Activity (from api_log + swap_history) ────────
			getRecentActivity: async (params) => {
				// PRIVACY: Don't expose standard-wallet activity during hidden sessions.
				// Hidden sessions get the RAM-only session store instead (populated by
				// scanChainHistory's live fetch below) — display without persistence.
				if (engine.isPassphraseWallet) return getSessionActivity(params?.limit || 50, params?.chainId)
				const scope = getWalletDbScope()
				if (!scope) return []
				return getRecentActivityFromLog(params?.limit || 50, params?.chainId, scope.deviceId, scope.walletId)
			},
			getActivityScanState: async () => ({ running: activityScanRunning }),
			scanChainHistory: async (params) => {
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (!engine.wallet) throw new Error('No device connected')

				// PRIVACY: hidden sessions never write api_log — but the server lookup
				// only needs an address. Fetch the same Pioneer history live (dryRun)
				// and hold the rows in RAM only; cleared on needs_passphrase/disconnect.
				if (engine.isPassphraseWallet) {
					const deviceId = engine.getDeviceState().deviceId || 'unknown'
					// Scope is normally set in-memory by sendPassphrase; the fallback covers
					// reconnect-with-cached-passphrase where no identity probe ran. Only used
					// for the (empty-by-invariant) dedup read + result echo — nothing is written.
					const scope = getWalletDbScope() || { deviceId, walletId: `${deviceId}:hidden-session` }
					const result = await rebuildActivityHistory({
						wallet: engine.wallet,
						scope,
						chains: getAllChains().filter(c => c.id !== 'hive' || hiveEnabled),
						firmwareVersion: engine.getDeviceState().firmwareVersion,
						options: { chainId: params.chainId, dryRun: true, collectRows: true },
					})
					const chainResult = result.chains.find(c => c.chainId === params.chainId)
					if (chainResult?.error) throw new Error(chainResult.error)
					const added = addSessionActivity(result.rows || [])
					console.log(`[activity] Live-scanned ${chain.symbol} (hidden session): ${chainResult?.txs || 0} txs, ${added} new — RAM only`)
					return { count: added }
				}
				const scope = getWalletDbScope()
				if (!scope) throw new Error('Wallet scope is not ready. Unlock the device and wait for seed identity.')

				const result = await rebuildActivityHistory({
					wallet: engine.wallet,
					scope,
					chains: getAllChains().filter(c => c.id !== 'hive' || hiveEnabled),
					firmwareVersion: engine.getDeviceState().firmwareVersion,
					options: { chainId: params.chainId },
				})
				const chainResult = result.chains.find(c => c.chainId === params.chainId)
				if (chainResult?.error) throw new Error(chainResult.error)

				console.log(`[activity] Scanned ${chain.symbol}: ${chainResult?.txs || 0} txs, ${chainResult?.inserted || 0} new, ${chainResult?.updated || 0} updated`)
				return { count: chainResult?.inserted || 0 }
			},
			dismissActivity: async (_params) => {
				// No-op: api_log entries are audit records, not dismissible
			},
			clearRecentActivity: async () => {
				// No-op: api_log entries are audit records
			},

			// ── Balance cache (instant portfolio) ────────────────────
			getCachedBalances: async () => {
				// PRIVACY: Hidden wallet sessions must not see standard-wallet cached data.
				if (engine.isPassphraseWallet) return null
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) { console.log('[cache-health] No deviceId — skipping'); return null }
				const result = getCachedBalances(deviceId)
				if (!result) { console.log('[cache-health] No cached balances for device', deviceId); return null }

				// Detect incomplete/stale cache — frontend can auto-refresh when staleReasons is non-empty
				const staleReasons: string[] = []

				// Incomplete: fewer cached chains than supported (e.g. app update added new chains)
				const fwVersion = engine.getDeviceState().firmwareVersion
				// Mirror the user-facing dashboard filter, not the raw `!c.hidden`:
				//   - zcash-shielded never gets its own cache row (rendered as a token of native zcash)
				//   - zcash is hidden by default but visible when the privacy flag is on
				//   - other hidden chains stay internal-only
				// Without this, freshly-enabled chains are never flagged as missing and
				// the dashboard never auto-refreshes them into the cache.
				const supportedChains = getAllChains().filter(c => {
					if (!isChainSupported(c, fwVersion)) return false
					if (c.id === 'zcash-shielded') return false
					if (c.id === 'zcash') return zcashPrivacyEnabled
					if (c.id === 'hive') return hiveEnabled
					return !c.hidden
				})
				const cachedChainIds = new Set(result.balances.map(b => b.chainId))
				const missingChains = supportedChains.filter(c => !cachedChainIds.has(c.id))
				if (missingChains.length > 0) {
					staleReasons.push(`missing_chains:${missingChains.map(c => c.id).join(',')}`)
				}
				console.log(`[cache-health] ${result.balances.length} cached chains, ${supportedChains.length} supported, ${missingChains.length} missing`)

				// Missing BTC xpub balances: BTC has a cached aggregate but no per-xpub breakdown
				const btcCached = result.balances.find(b => b.chainId === 'bitcoin')
				if (btcCached && parseFloat(btcCached.balance || '0') > 0) {
					const allBtcPks = getCachedPubkeys(deviceId).filter(p => p.chainId === 'bitcoin')
					const withXpub = allBtcPks.filter(p => p.xpub)
					const withBalance = withXpub.filter(p => p.balance !== '0' || p.balanceUsd > 0)
					console.log(`[cache-health] BTC: aggregate=${btcCached.balance}, cached_pubkeys=${allBtcPks.length} total, ${withXpub.length} with xpub, ${withBalance.length} with balance`)
					if (withBalance.length === 0) {
						staleReasons.push('btc_xpub_balances_missing')
					}
				}

				if (staleReasons.length > 0) {
					console.log(`[cache-health] STALE: ${staleReasons.join(', ')}`)
				} else {
					console.log('[cache-health] Cache OK — no staleness detected')
				}

				// Strip balances for chains the current firmware doesn't support.
				// Stale cache from a prior 7.14+ session can contain Solana/TRON/TON
				// entries — without this filter they bleed into the swap FROM picker,
				// letting the user select them and then hitting a device signing error.
				const filteredBalances = result.balances.filter(b => {
					const chain = getAllChains().find(c => c.id === b.chainId)
					if (!chain) return true // keep unknowns (tokens)
					if (chain.id === 'hive' && !hiveEnabled) return false // honor feature flag — drop stale Hive rows
					return isChainSupported(chain, fwVersion)
				})
				return { balances: filteredBalances, updatedAt: result.updatedAt, staleReasons: staleReasons.length > 0 ? staleReasons : undefined }
			},

			// ── Watch-only mode ─────────────────────────────────────
			checkWatchOnlyCache: async () => {
				const snap = getLatestDeviceSnapshot()
				if (!snap) return { available: false }
				return { available: true, deviceLabel: snap.label || undefined, lastSynced: snap.updatedAt }
			},
			getWatchOnlyBalances: async (params) => {
				const { getDeviceSnapshotById } = await import('./db')
				const snap = params?.deviceId
					? getDeviceSnapshotById(params.deviceId)
					: getLatestDeviceSnapshot()
				if (!snap) return null
				const result = getCachedBalances(snap.deviceId)
				return result?.balances ?? null
			},
			// Re-fetch watch-only balances from Pioneer using addresses reconstructed
			// from cache — NO device required. Self-contained: deliberately does NOT
			// touch the device getBalances managers.
			// ponytail: display-only simplified parse — no per-owner EVM token map and
			// no addressbook sync (those need device-derived state). Good enough for a
			// read-only snapshot view; do not use this path for signing/sends.
			refreshWatchOnlyBalances: async (params) => {
				const { getDeviceSnapshotById } = await import('./db')
				const snap = params?.deviceId
					? getDeviceSnapshotById(params.deviceId)
					: getLatestDeviceSnapshot()
				if (!snap) return null
				const deviceId = snap.deviceId

				// 1. Reconstruct the pubkey list from cache (no device available)
				const allChains = getAllChains()
				const chainById = new Map(allChains.map(c => [c.id, c]))
				const pubkeys: Array<{ caip: string; pubkey: string; chainId: string; symbol: string; networkId: string }> = []

				const cached = getCachedBalances(deviceId)
				for (const b of cached?.balances ?? []) {
					if (b.chainId === 'bitcoin') continue // cached BTC address isn't the xpub — handled below
					if (!b.address) continue
					const chain = chainById.get(b.chainId)
					if (!chain || !chain.caip) continue
					pubkeys.push({ caip: chain.caip, pubkey: b.address, chainId: chain.id, symbol: chain.symbol, networkId: chain.networkId })
				}
				// BTC: use the cached xpubs (one entry per script-type/account)
				const btcChain = chainById.get('bitcoin')
				if (btcChain) {
					for (const p of getCachedPubkeys(deviceId).filter(p => p.chainId === 'bitcoin' && p.xpub)) {
						pubkeys.push({ caip: btcChain.caip, pubkey: p.xpub, chainId: 'bitcoin', symbol: 'BTC', networkId: btcChain.networkId })
					}
				}

				if (pubkeys.length === 0) return cached?.balances ?? null

				// 2. Pioneer client — let init failure throw so the UI surfaces it
				const pioneer = await getPioneer()

				// 3. networkId → chainId lookup (non-hidden takes priority)
				const networkToChain = new Map<string, string>()
				for (const chain of allChains) {
					if (!chain.networkId) continue
					if (chain.hidden && networkToChain.has(chain.networkId.toLowerCase())) continue
					networkToChain.set(chain.networkId.toLowerCase(), chain.id)
				}

				// 4. Chunked GetPortfolioBalances
				const pubkeyChunks = chunkArray(pubkeys, PIONEER_PORTFOLIO_CHUNK_SIZE)
				const chunkResults = await withTimeout(
					mapWithConcurrency(pubkeyChunks, PIONEER_PORTFOLIO_MAX_CONCURRENCY, async (chunk, i) => {
						try {
							const resp = await withTimeout(
								pioneer.GetPortfolioBalances({ pubkeys: chunk.map(p => ({ caip: p.caip, pubkey: p.pubkey })), includeDefi: true }, { forceRefresh: true }),
								PIONEER_PORTFOLIO_CHUNK_TIMEOUT_MS,
								`watch-only chunk ${i + 1}/${pubkeyChunks.length}`
							)
							return { ...unwrapPortfolioResponse(resp), failed: false }
						} catch (err: any) {
							console.warn(`[refreshWatchOnlyBalances] chunk ${i + 1}/${pubkeyChunks.length} failed:`, err?.message || err)
							return { entries: [] as any[], meta: null, defiPositions: null as ServerDefiPosition[] | null, failed: true }
						}
					}),
					PIONEER_PORTFOLIO_TOTAL_TIMEOUT_MS,
					'watch-only GetPortfolioBalances chunks'
				)
				const allEntries = chunkResults.flatMap(r => r.entries)

				// Chains whose chunk failed must NOT be confirmed below — otherwise a
				// transient Pioneer error would write a 0 over good cached balances.
				const failedChainIds = new Set<string>()
				for (let i = 0; i < chunkResults.length; i++) {
					if (chunkResults[i].failed) for (const p of pubkeyChunks[i]) failedChainIds.add(p.chainId)
				}

				// 5. Classify natives vs tokens (same heuristic as getBalances)
				const pureNatives: any[] = []
				const tokenEntries: any[] = []
				for (const entry of allEntries) {
					const caip = entry.caip || ''
					const caipPath = caip.split('/')[1] || ''
					const isTokenByCaip = caipPath && !caipPath.startsWith('slip44:') && !caipPath.startsWith('native:')
					const isTokenByType = entry.type === 'token' || (entry.isNative === false && entry.contract)
					if (isTokenByCaip || isTokenByType) tokenEntries.push(entry)
					else pureNatives.push(entry)
				}

				// 6. Group tokens by parent chain
				const tokensByChainId = new Map<string, TokenBalance[]>()
				const seenByOwnerCaip = new Set<string>()
				for (const tok of tokenEntries) {
					const bal = parseFloat(String(tok.balance ?? '0'))
					if (bal <= 0) continue
					const ownerAddr = String(tok.address || tok.pubkey || '').toLowerCase()
					const caipNorm = (tok.caip || '').startsWith('eip155:') ? (tok.caip || '').toLowerCase() : (tok.caip || '')
					const ownerCaipKey = `${caipNorm}|${ownerAddr}`
					if (seenByOwnerCaip.has(ownerCaipKey)) continue
					seenByOwnerCaip.add(ownerCaipKey)

					const tokNetworkId = (tok.networkId || '').toLowerCase()
					const caipPrefix = ((tok.caip || '').split('/')[0]).toLowerCase()
					const parentChainId = networkToChain.get(tokNetworkId) || networkToChain.get(caipPrefix) || null
					if (!parentChainId) continue

					const contractMatch = (tok.caip || '').match(/\/(erc20|spl|trc20|token):([^\s]+)/)
					const token: TokenBalance = {
						symbol: tok.symbol || '???',
						name: tok.name || tok.symbol || 'Unknown Token',
						balance: String(tok.balance ?? '0'),
						balanceUsd: Number(tok.valueUsd ?? 0),
						priceUsd: Number(tok.priceUsd ?? 0),
						caip: tok.caip || '',
						contractAddress: contractMatch?.[2] || tok.contract || undefined,
						networkId: tokNetworkId || caipPrefix,
						icon: tok.icon || undefined,
						decimals: tok.decimals ?? tok.precision,
						type: tok.type || 'token',
						dataSource: tok.dataSource,
					}
					const existing = tokensByChainId.get(parentChainId) || []
					existing.push(token)
					tokensByChainId.set(parentChainId, existing)
				}

				// 7. Group DeFi positions by chain (dedup by pubkey|protocol|networkId)
				const rawDefi: ServerDefiPosition[] = chunkResults.flatMap(r => r.defiPositions || [])
				const defiByChain = new Map<string, DefiPosition[]>()
				const seenDefiKey = new Set<string>()
				for (const sp of rawDefi) {
					const key = `${String(sp.pubkey || '').toLowerCase()}|${sp.protocol || ''}|${(sp.networkId || '').toLowerCase()}`
					if (seenDefiKey.has(key)) continue
					seenDefiKey.add(key)
					const chainId = sp.networkId ? networkToChain.get(sp.networkId.toLowerCase()) : null
					if (!chainId) continue
					const dp: DefiPosition = {
						protocol: sp.protocol || null,
						displayName: sp.displayName,
						name: sp.displayName || sp.protocol || 'DeFi Position',
						network: sp.network,
						networkId: sp.networkId,
						balanceUsd: Number(sp.balanceUsd) || 0,
						icon: sp.icon,
						tokens: Array.isArray(sp.tokens) ? sp.tokens.map(t => ({
							networkId: t.networkId,
							address: String(t.address || '').toLowerCase(),
							symbol: t.symbol,
							balance: t.balance != null ? String(t.balance) : undefined,
							balanceUsd: typeof t.balanceUsd === 'number' ? t.balanceUsd : undefined,
						})).filter(t => !!t.address) : [],
					}
					const list = defiByChain.get(chainId) || []
					list.push(dp)
					defiByChain.set(chainId, list)
				}

				// 8. Build ChainBalance[] — sum BTC xpubs into one entry; others 1:1
				const results: ChainBalance[] = []
				let btcBalance = 0, btcUsd = 0, btcAddress = ''
				for (const entry of pubkeys) {
					if (entry.chainId === 'bitcoin') {
						const match = pureNatives.find((d: any) => d.pubkey === entry.pubkey)
							|| pureNatives.find((d: any) => d.caip === entry.caip && d.address === entry.pubkey)
						btcBalance += parseFloat(String(match?.balance ?? '0'))
						btcUsd += Number(match?.valueUsd ?? 0)
						if (match?.address && !btcAddress) btcAddress = match.address
						continue
					}
					const entryNetwork = entry.caip.split('/')[0]
					const match = pureNatives.find((d: any) => d.caip === entry.caip)
						|| pureNatives.find((d: any) => d.caip && d.caip.split('/')[0] === entryNetwork)
						|| pureNatives.find((d: any) => d.pubkey === entry.pubkey)
						|| pureNatives.find((d: any) => d.address === entry.pubkey)
					const chainTokens = tokensByChainId.get(entry.chainId)
					const tokenUsdTotal = chainTokens?.reduce((s, t) => s + t.balanceUsd, 0) || 0
					const chainDefi = defiByChain.get(entry.chainId)
					const defiUsdTotal = chainDefi?.reduce((s, p) => s + (p.balanceUsd || 0), 0) || 0
					const nativeUsd = Number(match?.valueUsd ?? 0)
					results.push({
						chainId: entry.chainId,
						symbol: entry.symbol,
						balance: String(match?.balance ?? '0'),
						balanceUsd: nativeUsd + tokenUsdTotal + defiUsdTotal,
						nativeBalanceUsd: nativeUsd,
						address: match?.address || entry.pubkey,
						tokens: chainTokens && chainTokens.length > 0 ? chainTokens : undefined,
						defiPositions: chainDefi && chainDefi.length > 0 ? chainDefi : undefined,
					})
				}
				if (btcChain && pubkeys.some(p => p.chainId === 'bitcoin')) {
					const chainTokens = tokensByChainId.get('bitcoin')
					const tokenUsdTotal = chainTokens?.reduce((s, t) => s + t.balanceUsd, 0) || 0
					results.push({
						chainId: 'bitcoin',
						symbol: 'BTC',
						balance: String(btcBalance),
						balanceUsd: btcUsd + tokenUsdTotal,
						nativeBalanceUsd: btcUsd,
						address: btcAddress,
						tokens: chainTokens && chainTokens.length > 0 ? chainTokens : undefined,
					})
				}

				// 9. Persist and return. Only chains whose chunk succeeded are "confirmed"
				// (genuine zeros overwrite stale); failed chains keep their cached value.
				const confirmed = new Set(results.map(r => r.chainId).filter(id => !failedChainIds.has(id)))
				setCachedBalances(deviceId, results, confirmed)
				return results
			},
			getWatchOnlyPubkeys: async (params) => {
				const { getDeviceSnapshotById } = await import('./db')
				const snap = params?.deviceId
					? getDeviceSnapshotById(params.deviceId)
					: getLatestDeviceSnapshot()
				if (!snap) return []
				return getCachedPubkeys(snap.deviceId)
			},

			// ── Registered devices (device history) ─────────────────
			getRegisteredDevices: async () => {
				const { getAllDeviceSnapshots } = await import('./db')
				return getAllDeviceSnapshots()
			},
			forgetDevice: async (params) => {
				const { deleteDeviceSnapshot } = await import('./db')
				deleteDeviceSnapshot(params.deviceId)
			},

			// ── Sweep (non-standard BTC path recovery) ──────────────
			sweepScan: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const { startScan, getScan } = await import('./sweep-engine')
				// Capture the signing guard BEFORE starting the scan worker — USB is
				// serial, so deriving the seed identity after startScan would race the
				// worker's device calls. Re-checked in sweepExecute before signing.
				const capturedWallet = engine.wallet
				const seedIdentity = await engine.deriveSeedIdentity().catch(() => null)
				// streamProgress (audit "unusual paths" panel): push each path to the
				// WebView as it's derived/checked so the user sees what's happening.
				const onProgress = params.streamProgress
					? (evt: any) => { try { rpc.send['audit-sweep-progress'](evt) } catch { /* webview not ready */ } }
					: undefined
				const scanId = await startScan(engine.wallet, {
					accountRange: params.accountRange,
					mismatchAccounts: params.mismatchAccounts,
					currentMaxAccount: params.currentMaxAccount,
					higherAccountScanLimit: params.higherAccountScanLimit,
					gapLimitReceive: params.gapLimitReceive,
					gapLimitChange: params.gapLimitChange,
					higherReceiveLimit: params.higherReceiveLimit,
				}, onProgress)
				const scan = getScan(scanId)
				if (scan) { scan.capturedWallet = capturedWallet; scan.seedIdentity = seedIdentity }
				return { scanId }
			},
			sweepGetStatus: async (params) => {
				const { getScan } = await import('./sweep-engine')
				const scan = getScan(params.scanId)
				if (!scan) throw new Error('Scan not found')
				return {
					id: scan.id,
					status: scan.status,
					progress: scan.progress,
					startedAt: scan.startedAt,
					completedAt: scan.completedAt,
					totalFoundSats: scan.totalFoundSats,
					results: scan.results.map(r => ({
						path: r.pathStr,
						scriptType: r.scriptType,
						address: r.address,
						category: r.category,
						accountIndex: r.accountIndex,
						balanceSats: r.balanceSats,
						utxoCount: r.utxos.length,
					})),
					error: scan.error,
				}
			},
			sweepExecute: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const { getScan, buildSweepTx } = await import('./sweep-engine')
				const scan = getScan(params.scanId)
				if (!scan) throw new Error('Scan not found')
				if (scan.status !== 'complete') throw new Error(`Scan status is '${scan.status}', must be 'complete'`)
				if (scan.totalFoundSats === 0) throw new Error('No funds found to sweep')

				let destination = params.destinationAddress
				if (!destination) {
					const result = await engine.wallet.btcGetAddress({
						addressNList: [0x80000054, 0x80000000, 0x80000000, 0, 0],
						coin: 'Bitcoin', scriptType: 'p2wpkh', showDisplay: false,
					})
					destination = typeof result === 'string' ? result : result?.address
					if (!destination) throw new Error('Could not derive standard BTC receive address')
				}

				const sweepResult = await buildSweepTx(scan, destination)

				if (params.dryRun) {
					return { dryRun: true, destination, inputCount: sweepResult.inputCount, totalSweptSats: sweepResult.totalInputSats, fee: sweepResult.fee, outputSats: sweepResult.totalInputSats - sweepResult.fee, unsignedTx: sweepResult.unsignedTx }
				}

				// Gen-guard before signing: never sign UTXOs discovered under a
				// since-replaced wallet/seed (device swap OR a same-handle passphrase
				// toggle, which reuses engine.wallet so the handle check alone misses it).
				if (scan.capturedWallet && scan.capturedWallet !== engine.wallet) {
					throw new Error('Device changed since this scan ran — please re-scan before sweeping')
				}
				// Fail CLOSED if the seed identity couldn't be captured when the scan ran:
				// with no baseline we can't prove the seed is unchanged, and a recovery
				// sweep must never sign what it can't verify (a same-handle passphrase
				// toggle would otherwise pass the handle check above).
				if (!scan.seedIdentity) {
					throw new Error('Could not verify the wallet for this scan — please re-scan before sweeping')
				}
				const liveSeedIdentity = await engine.deriveSeedIdentity().catch(() => null)
				if (!liveSeedIdentity || liveSeedIdentity.toLowerCase() !== scan.seedIdentity.toLowerCase()) {
					throw new Error('Wallet seed changed since this scan ran — please re-scan before sweeping')
				}

				const signedTx = await engine.wallet.btcSignTx(sweepResult.unsignedTx)
				const serializedTx = signedTx?.serializedTx || signedTx?.serialized
				if (!serializedTx) throw new Error('Device signing failed')

				const { getPioneer } = await import('./pioneer')
				const pioneer = await getPioneer()
				const broadcastResp = await pioneer.Broadcast({ networkId: 'bip122:000000000019d6689c085ae165831e93', serialized: serializedTx })
				const bdata = broadcastResp?.data || broadcastResp
				const txid = bdata?.txid || bdata?.tx_hash || bdata?.hash
				if (!txid) throw new Error(`Broadcast failed: ${JSON.stringify(bdata).slice(0, 200)}`)

				return { txid, destination, inputCount: sweepResult.inputCount, totalSweptSats: sweepResult.totalInputSats, fee: sweepResult.fee, outputSats: sweepResult.totalInputSats - sweepResult.fee }
			},

			// ── Balance Audit (multi-chain "where's my money" wizard) ────
			auditStart: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.getDeviceState().state !== 'ready') throw new Error('Device not ready')
				const wallet = engine.wallet
				const fwVersion = engine.getDeviceState().firmwareVersion
				const enabledChains = getAllChains().filter(c => {
					if (!isChainSupported(c, fwVersion)) return false
					if ((c.id === 'zcash' || c.id === 'zcash-shielded') && !zcashPrivacyEnabled) return false
					if (c.id === 'hive' && !hiveEnabled) return false
					return true
				})
				const coverageChains = enabledChains.map(c => ({ chainId: c.id, symbol: c.symbol, chainFamily: c.chainFamily }))
				const btcMax = btcAccounts.isInitialized && btcAccounts.toAccountSet().accounts.length > 0
					? Math.max(...btcAccounts.toAccountSet().accounts.map(a => a.accountIndex))
					: 0
				// Fast: identity + coverage only. BTC paths scan lazily on the Bitcoin
				// page (auditScanBtc); EVM/other accounts scan lazily per page. No up-front sweeps.
				const deps: AuditDeps = {
					wallet,
					currentWallet: () => engine.wallet,
					deriveSeedIdentity: () => engine.deriveSeedIdentity(),
					evmIdx0: () => (evmAddresses.isInitialized ? (evmAddresses.getAddressByIndex(0)?.address ?? null) : null),
					coverageChains,
					btcCurrentMaxAccount: btcMax,
					isHidden: engine.isPassphraseWallet,
					deviceId: engine.getDeviceState().deviceId || 'unknown',
				}
				const snapshot = params?.snapshot || { chains: [], degradedChainIds: [], staleChainIds: [], unresolvedFaultCount: 0 }
				const auditId = startAudit(deps, params?.mode === 'deep' ? 'deep' : 'light', snapshot)
				return { auditId }
			},
			// Lazy Bitcoin path scan — triggered when the user opens the Bitcoin page.
			auditScanBtc: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.getDeviceState().state !== 'ready') throw new Error('Device not ready')
				if (!startBtcScan(params.auditId)) throw new Error('Audit not found')
				return { started: true }
			},
			auditGetStatus: async (params) => {
				const report = getAudit(params.auditId)
				if (!report) throw new Error('Audit not found')
				return report
			},
			// Recover BTC found on non-standard paths / account-level keys (higher
			// accounts are recovered via addBtcAccount, not swept). Gen-guarded so
			// stale-seed UTXOs from a since-replaced wallet are never signed.
			auditSweep: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const entry = getAuditEntry(params.auditId)
				if (!entry) throw new Error('Audit not found')
				// Gen-guard 1: device handle replaced (reconnect/purge).
				if (entry.capturedWallet !== engine.wallet) {
					throw new Error('Device changed since this audit ran — re-run the audit')
				}
				// Gen-guard 2: the audit must have completed cleanly (not stale/aborted).
				if (entry.report.status !== 'complete') {
					throw new Error('Audit is no longer current — re-run the audit')
				}
				// Gen-guard 3: a same-handle seed change (passphrase toggle) reuses
				// engine.wallet, so the object check above can't see it. Re-derive the
				// live seed identity and refuse if it differs from the scan's — never
				// sign UTXOs captured under a since-replaced seed.
				const liveIdentity = await engine.deriveSeedIdentity()
				if (entry.report.seedIdentity && (!liveIdentity || liveIdentity.toLowerCase() !== entry.report.seedIdentity.toLowerCase())) {
					throw new Error('Wallet seed changed since this audit ran — re-run the audit')
				}
				const raw = getAuditBtcRaw(params.auditId)
				if (!raw || raw.length === 0) throw new Error('No funds found to sweep')

				const { buildSweepTx } = await import('./sweep-engine')
				let destination = params.destinationAddress
				if (!destination) {
					const result = await engine.wallet.btcGetAddress({
						addressNList: [0x80000054, 0x80000000, 0x80000000, 0, 0],
						coin: 'Bitcoin', scriptType: 'p2wpkh', showDisplay: false,
					})
					destination = typeof result === 'string' ? result : result?.address
					if (!destination) throw new Error('Could not derive standard BTC receive address')
				}

				// buildSweepTx only reads scan.results — hand it the audit's raw findings.
				const sweepResult = await buildSweepTx({ results: raw } as any, destination)

				if (params.dryRun) {
					return { dryRun: true, destination, inputCount: sweepResult.inputCount, totalSweptSats: sweepResult.totalInputSats, fee: sweepResult.fee, outputSats: sweepResult.totalInputSats - sweepResult.fee }
				}

				const signedTx = await engine.wallet.btcSignTx(sweepResult.unsignedTx)
				const serializedTx = signedTx?.serializedTx || signedTx?.serialized
				if (!serializedTx) throw new Error('Device signing failed')

				const pioneer = await getPioneer()
				const broadcastResp = await pioneer.Broadcast({ networkId: 'bip122:000000000019d6689c085ae165831e93', serialized: serializedTx })
				const bdata = broadcastResp?.data || broadcastResp
				const txid = bdata?.txid || bdata?.tx_hash || bdata?.hash
				if (!txid) throw new Error(`Broadcast failed: ${JSON.stringify(bdata).slice(0, 200)}`)
				return { txid, destination, inputCount: sweepResult.inputCount, totalSweptSats: sweepResult.totalInputSats, fee: sweepResult.fee, outputSats: sweepResult.totalInputSats - sweepResult.fee }
			},
			auditDismiss: async (params) => {
				dismissAudit(params.auditId)
			},

			// Per-chain walkthrough: derive `count` addresses for `chainId` starting
			// at account/index `fromLevel`, balance-check each via Pioneer. Read-only
			// (no signing). Gen-guarded so a mid-scan device swap stops cleanly.
			auditScanLevels: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.getDeviceState().state !== 'ready') throw new Error('Device not ready')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (!chainSupportsLevelScan(chain)) throw new Error(`${chain.symbol} can't be account-scanned`)
				const captured = engine.wallet
				const count = Math.min(Math.max(params.count ?? 3, 1), 10)
				const from = Math.max(params.fromLevel ?? 0, 0)
				const results: any[] = []
				for (let i = 0; i < count; i++) {
					if (engine.wallet !== captured) break // device changed — stop
					const level = from + i
					const path = chainLevelPath(chain, level)
					const { method, params: dp } = deriveAddressParams(chain, path)
					let address = ''
					try { address = extractAddress(await (engine.wallet as any)[method](dp)) } catch (e: any) {
						console.warn(`[audit] scan ${chain.id} L${level} derive failed: ${e?.message}`)
						continue
					}
					if (!address) continue
					const { native, hasBalance, balanceError, tokens } = await auditBalanceForAddress(chain, address)
					results.push({ level, pathStr: pathToBip32(path), address, native, symbol: chain.symbol, hasBalance, balanceError, tokens, explorerUrl: explorerAddressUrl(chain, address) })
				}
				return { results }
			},
			// UTXO multi-account scan: for non-BTC UTXO chains (DOGE/LTC/BCH/DASH/DGB),
			// derive each account's xpub(s) and balance-check via Pioneer's xpub gap
			// scan (GetPortfolioBalances) — the path the dashboard uses for account 0.
			// xpub-based (not single-address), so it correctly reads a UTXO account tree.
			auditScanUtxoAccounts: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.getDeviceState().state !== 'ready') throw new Error('Device not ready')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (chain.chainFamily !== 'utxo') throw new Error(`${chain.symbol} is not a UTXO chain`)
				const captured = engine.wallet
				const count = Math.min(Math.max(params.count ?? 3, 1), 10)
				const from = Math.max(params.fromLevel ?? 0, 0)
				const prefix = (chain.caip || '').split('/')[0]
				const results: any[] = []
				for (let i = 0; i < count; i++) {
					if (engine.wallet !== captured) break // device changed — stop
					const account = from + i
					const sps = utxoAccountScriptPaths(chain, account)
					// Derive every script type's xpub (legacy/segwit/native-segwit) and
					// keep them aligned to their path so the UI can show each as proof.
					let xpubMeta: Array<{ scriptType: string; xpub: string; pathStr: string }> = []
					try {
						const pks = await (engine.wallet as any).getPublicKeys(sps.map(sp => ({ addressNList: sp.path, coin: chain.coin, scriptType: sp.scriptType, curve: 'secp256k1' })))
						xpubMeta = sps
							.map((sp, idx) => ({ scriptType: sp.scriptType, xpub: (pks?.[idx] as any)?.xpub as string, pathStr: pathToBip32(sp.path) }))
							.filter(m => !!m.xpub)
					} catch (e: any) {
						console.warn(`[audit] utxo-acct ${chain.id} #${account} xpub derive failed: ${e?.message}`)
						continue
					}
					if (!xpubMeta.length) continue
					const xpubs = xpubMeta.map(m => m.xpub)
					let native = '0', hasBalance = false, balanceError = false
					try {
						const pioneer = await getPioneer()
						const resp = await withTimeout(
							pioneer.GetPortfolioBalances({ pubkeys: xpubs.map(x => ({ caip: chain.caip, pubkey: x })) }, { forceRefresh: true }),
							PIONEER_TIMEOUT_MS, `audit utxo-acct ${chain.id}`,
						)
						const { entries, meta } = unwrapPortfolioResponse(resp)
						const natives = (Array.isArray(entries) ? entries : []).filter((e: any) => String(e?.caip || '').split('/')[0] === prefix)
						const total = natives.reduce((acc: number, e: any) => acc + (parseFloat(String(e?.balance ?? '0')) || 0), 0)
						native = String(total)
						hasBalance = total > 0
						if (!hasBalance && meta?.degraded) balanceError = true // unverified, not a confident zero
					} catch (e: any) {
						console.warn(`[audit] utxo-acct ${chain.id} #${account} balance failed: ${e?.message}`)
						balanceError = true
					}
					results.push({ level: account, pathStr: xpubMeta[0].pathStr, address: xpubMeta[0].xpub, xpubs: xpubMeta, native, symbol: chain.symbol, hasBalance, balanceError, explorerUrl: null })
				}
				return { results }
			},
			// Derive + balance-check one user-supplied path (custom-path search).
			auditDeriveCustom: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.getDeviceState().state !== 'ready') throw new Error('Device not ready')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (!chainSupportsDeepScan(chain)) throw new Error(`${chain.symbol} doesn't support custom-path search`)
				const path = params.addressNList
				if (!Array.isArray(path) || path.length < 2 || path.length > 10 || path.some(n => !Number.isInteger(n) || n < 0)) {
					throw new Error('Invalid derivation path')
				}
				const { method, params: dp } = deriveAddressParams(chain, path)
				if (params.scriptType) dp.scriptType = params.scriptType
				const address = extractAddress(await (engine.wallet as any)[method](dp))
				if (!address) throw new Error('Device returned no address for that path')
				const { native, hasBalance, balanceError, tokens } = await auditBalanceForAddress(chain, address)
				return { pathStr: pathToBip32(path), address, native, symbol: chain.symbol, hasBalance, balanceError, tokens, explorerUrl: explorerAddressUrl(chain, address) }
			},
			// Batch derive + balance-check a list of explicit paths (EVM known-paths
			// grid). Read-only, gen-guarded.
			auditScanPaths: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.getDeviceState().state !== 'ready') throw new Error('Device not ready')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (!chainSupportsDeepScan(chain)) throw new Error(`${chain.symbol} doesn't support path scanning`)
				const captured = engine.wallet
				const paths = (params.paths || []).slice(0, 40)
				const results: any[] = []
				for (const path of paths) {
					if (engine.wallet !== captured) break
					if (!Array.isArray(path) || path.length < 2 || path.length > 10 || path.some(n => !Number.isInteger(n) || n < 0)) continue
					const { method, params: dp } = deriveAddressParams(chain, path)
					if (params.scriptType) dp.scriptType = params.scriptType
					let address = ''
					try { address = extractAddress(await (engine.wallet as any)[method](dp)) } catch { continue }
					if (!address) continue
					const { native, hasBalance, balanceError, tokens } = await auditBalanceForAddress(chain, address)
					results.push({ pathStr: pathToBip32(path), address, native, symbol: chain.symbol, hasBalance, balanceError, tokens, explorerUrl: explorerAddressUrl(chain, address) })
				}
				return { results }
			},
			// Raw-path inspector: derive an address + its pubkey/xpub + balance for a
			// power user verifying derivations. Read-only.
			auditInspectPath: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.getDeviceState().state !== 'ready') throw new Error('Device not ready')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				if (!chainSupportsDeepScan(chain)) throw new Error(`${chain.symbol} doesn't support path inspection`)
				const path = params.addressNList
				if (!Array.isArray(path) || path.length < 2 || path.length > 10 || path.some(n => !Number.isInteger(n) || n < 0)) {
					throw new Error('Invalid derivation path')
				}
				const { method, params: dp } = deriveAddressParams(chain, path)
				if (params.scriptType) dp.scriptType = params.scriptType
				const address = extractAddress(await (engine.wallet as any)[method](dp))
				if (!address) throw new Error('Device returned no address for that path')
				// Pubkey/xpub via getPublicKeys (best-effort — not all curves/paths return both).
				let pubkey: string | null = null, xpub: string | null = null
				try {
					const pk = await engine.wallet.getPublicKeys([{ addressNList: path, coin: chain.coin, scriptType: chain.scriptType, curve: 'secp256k1' }])
					const entry = pk?.[0]
					xpub = entry?.xpub || null
					const raw = entry?.publicKey
					pubkey = raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : (typeof raw === 'string' ? raw : null)
				} catch (e: any) {
					console.warn(`[audit] inspect ${chain.id} getPublicKeys failed: ${e?.message}`)
				}
				const { native, hasBalance, balanceError } = await auditNativeBalance(chain, address)
				return { pathStr: pathToBip32(path), address, pubkey, xpub, native, symbol: chain.symbol, hasBalance, balanceError, explorerUrl: explorerAddressUrl(chain, address) }
			},

			// ── Emulator (macOS only, feature-flagged off by default) ────
			// Writes throw when the flag is off so stray UI calls surface clearly.
			// Reads return a safe stopped/empty state so any UI path that still
			// polls (e.g. during a toggle transition) renders nothing rather than
			// a toast-worthy error.
			emulatorPair: async () => {
				if (!emulatorEnabled) throw new Error('Emulator is disabled')
				const { pairEmulator, getEmulatorStatus } = await import('./emulator')
				pairEmulator()
				return getEmulatorStatus()
			},
			emulatorInit: async (params) => {
				if (!emulatorEnabled) throw new Error('Emulator is disabled')
				const { initEmulator } = await import('./emulator')
				const status = initEmulator(params?.flashName)
				if (status.state === 'running') {
					// Open the emulator device window
					const { openEmulatorWindow } = await import('./emulator-window')
					openEmulatorWindow()
					// Bridge emulator to engine so UI transitions through onboarding
					await engine.connectEmulator()
				}
				return status
			},
			emulatorStop: async () => {
				if (!emulatorEnabled) throw new Error('Emulator is disabled')
				const { closeEmulatorWindow } = await import('./emulator-window')
				closeEmulatorWindow()
				const { stopEmulator } = await import('./emulator')
				engine.disconnectEmulator()
				return stopEmulator()
			},
			emulatorSave: async () => {
				if (!emulatorEnabled) throw new Error('Emulator is disabled')
				const { saveEmulatorState } = await import('./emulator')
				await saveEmulatorState()
			},
			emulatorStatus: async () => {
				if (!emulatorEnabled) {
					return { state: 'stopped' as const, bridgeReady: false, host: 'not loaded', paired: false, platform: process.platform, flashImages: [], storagePath: '' }
				}
				const { getEmulatorStatus } = await import('./emulator')
				return getEmulatorStatus()
			},
			emulatorInstallDylib: async (params) => {
				// Copy a user-supplied emulator library into ~/.keepkey/emulator/
				// (libkkemu.dylib on macOS, libkkemu.dll on Windows) so subsequent
				// emulatorInit() loads it. Auto-flips emulator_enabled since the user
				// has explicitly opted in by dropping a binary.
				const isWin = process.platform === 'win32'
				if (process.platform !== 'darwin' && !isWin) throw new Error('Emulator is only available on macOS and Windows')
				if (!params?.data) throw new Error('Missing emulator library payload')

				const buf = Buffer.from(params.data, 'base64')
				if (buf.length < 4) throw new Error('Empty emulator library payload')
				// Validate the binary header so we never dlopen() an arbitrary file:
				// PE/'MZ' on Windows, Mach-O (thin or fat) on macOS.
				if (isWin) {
					if (buf.readUInt16BE(0) !== 0x4d5a) {
						throw new Error('File is not a Windows DLL (PE/MZ header expected)')
					}
				} else {
					const magic = buf.readUInt32BE(0)
					const MACHO_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca])
					if (!MACHO_MAGIC.has(magic)) {
						throw new Error('File is not a Mach-O dynamic library')
					}
				}

				// Stop any running emulator before swapping the dylib — replacing
				// a dlopen'd file mid-flight is undefined behavior on macOS.
				const { getEmulatorStatus, stopEmulator, getDylibPath } = await import('./emulator')
				if (getEmulatorStatus().state === 'running') {
					const { closeEmulatorWindow } = await import('./emulator-window')
					closeEmulatorWindow()
					engine.disconnectEmulator()
					stopEmulator()
				}

				// Write to a temp file then atomically rename so a partial copy
				// can never leave a half-written dylib in place.
				const { writeFileSync, renameSync, mkdirSync, statSync } = await import('fs')
				const { dirname } = await import('path')
				const finalPath = getDylibPath()
				const dir = dirname(finalPath)
				mkdirSync(dir, { recursive: true, mode: 0o700 })
				const tmp = `${finalPath}.tmp-${Date.now()}`
				writeFileSync(tmp, buf, { mode: 0o600 })
				renameSync(tmp, finalPath)
				const size = statSync(finalPath).size
				console.log(`[emulator] Installed dylib at ${finalPath} (${size} bytes)`)

				// Auto-enable emulator setting — dropping a dylib is an explicit
				// opt-in to dev features.
				if (!emulatorEnabled) {
					emulatorEnabled = true
					setSetting('emulator_enabled', '1')
					console.log('[settings] Emulator enabled by dylib install')
				}
				return { path: finalPath, size, emulatorEnabled }
			},
			emulatorDeleteFlash: async (params) => {
				if (!emulatorEnabled) throw new Error('Emulator is disabled')
				const { deleteFlash, getEmulatorStatus, getActiveFlashName, stopEmulator } = await import('./emulator')
				const { deleteMnemonic } = await import('./emulator-keychain')
				const { deleteEmulatorWalletMeta, getAllEmulatorWalletMeta, deleteDeviceSnapshot } = await import('./db')

				// Look up the deviceId BEFORE deleting metadata so we can purge
				// all keyed-by-deviceId data (balances, cached_pubkeys, reports,
				// device_snapshot) — the same set physical forgetDevice purges.
				// Without this, deleting an emulator wallet leaves stale balance
				// + xpub cache + report rows on disk keyed by an emulator
				// deviceId that no longer maps to anything.
				const meta = getAllEmulatorWalletMeta().find(m => m.name === params.name)

				// If deleting the active wallet, stop it first so shutdown
				// doesn't re-save the flash we're about to delete
				if (getEmulatorStatus().state === 'running' && getActiveFlashName() === params.name) {
					const { closeEmulatorWindow } = await import('./emulator-window')
					closeEmulatorWindow()
					engine.disconnectEmulator()
					stopEmulator()
				}

				deleteFlash(params.name)
				deleteMnemonic(params.name)
				deleteEmulatorWalletMeta(params.name)
				if (meta?.deviceId) deleteDeviceSnapshot(meta.deviceId)
				return getEmulatorStatus()
			},
			emulatorListWallets: async () => {
				if (!emulatorEnabled) return []
				const { listFlashImages, hasMnemonic } = await import('./emulator-keychain')
				const { getActiveFlashName, getEmulatorStatus } = await import('./emulator')
				const { getAllEmulatorWalletMeta } = await import('./db')
				const status = getEmulatorStatus()
				const activeFlash = status.state === 'running' ? getActiveFlashName() : null
				const metaByName = new Map(getAllEmulatorWalletMeta().map(m => [m.name, m]))
				return listFlashImages().map(name => {
					const meta = metaByName.get(name)
					return {
						name,
						hasMnemonic: hasMnemonic(name),
						isActive: name === activeFlash,
						label: meta?.label || undefined,
						firmwareVersion: meta?.firmwareVersion || undefined,
						channel: meta?.channel || undefined,
						deviceId: meta?.deviceId || undefined,
						totalUsd: meta?.totalUsd ?? 0,
					}
				})
			},
			emulatorImportWallet: async (params) => {
				if (!emulatorEnabled) throw new Error('Emulator is disabled')
				// Wallet name validation lives in emulator-keychain.validateFlashName
				// (called by every path builder) — call here too so we surface the
				// error before doing any work.
				const { validateFlashName } = await import('./emulator-keychain')
				params = { ...params, name: validateFlashName(params.name) }

				const { stopEmulator, initEmulator, getEmulatorStatus, flushRingBuffers, getActiveFlashName } = await import('./emulator')
				const { saveMnemonic, deleteMnemonic } = await import('./emulator-keychain')
				const { deleteFlash } = await import('./emulator')

				// Remember previous state for rollback
				const prevStatus = getEmulatorStatus()
				const prevFlashName = prevStatus.state === 'running' ? getActiveFlashName() : null

				// Stop current emulator if running
				if (prevStatus.state === 'running') {
					const { closeEmulatorWindow } = await import('./emulator-window')
					closeEmulatorWindow()
					engine.disconnectEmulator()
					stopEmulator()
				}

				// Init with the new flash name + channel (creates flash file on disk)
				const status = initEmulator(params.name)
				if (status.state !== 'running') return status

				try {
					// Open window + connect engine
					const { openEmulatorWindow } = await import('./emulator-window')
					openEmulatorWindow()
					await engine.connectEmulator()

					// Wipe if already initialized
					if (engine.cachedFeatures?.initialized) {
						await emuConfirmOp(() => engine.wallet!.wipe())
						flushRingBuffers()
						await engine.connectEmulator()
					}

					// Load the seed onto the emulator device
					if (!engine.cachedFeatures?.initialized) {
						await emuConfirmOp(() => (engine.wallet as any).loadDevice({
							mnemonic: params.mnemonic, pin: false, passphrase: false, skipChecksum: false,
						}))
					}

					// Set label if provided
					const label = params.label || params.name
					try {
						await emuConfirmOp(() => engine.applySettings({ label, skipRefresh: true }))
					} catch {}

					flushRingBuffers()
					await engine.connectEmulator()

					// Verify the firmware holds the mnemonic via DebugLink (3s race
					// — a stuck read is a verification failure, not silently OK).
					const verifyResult = await raceVerifyMnemonic(params.mnemonic)
					if (!verifyResult.ok) {
						throw new Error(`Seed verification failed — ${verifyResult.reason}`)
					}

					// Only persist mnemonic AFTER seed is verified on device
					saveMnemonic(params.name, params.mnemonic)
					return getEmulatorStatus()
				} catch (err) {
					// Rollback: stop the failed emulator and clean up the orphaned
					// flash + mnemonic + emulator_wallet metadata + device cache.
					// connectEmulator persists metadata as part of its success path,
					// so a failed verify can leave a metadata row + cached balances
					// keyed to a wallet that no longer exists.
					console.error('[Emulator] Import failed, rolling back:', (err as Error).message)
					const failedDeviceId = engine.cachedFeatures?.deviceId
					const { closeEmulatorWindow } = await import('./emulator-window')
					const { deleteEmulatorWalletMeta, deleteDeviceSnapshot } = await import('./db')
					closeEmulatorWindow()
					engine.disconnectEmulator()
					stopEmulator()
					try { deleteFlash(params.name) } catch {}
					try { deleteMnemonic(params.name) } catch {}
					try { deleteEmulatorWalletMeta(params.name) } catch {}
					if (failedDeviceId) { try { deleteDeviceSnapshot(failedDeviceId) } catch {} }

					// Restore previous emulator if one was running
					if (prevFlashName) {
						const restored = initEmulator(prevFlashName)
						if (restored.state === 'running') {
							const { openEmulatorWindow } = await import('./emulator-window')
							openEmulatorWindow()
							await engine.connectEmulator()
						}
					}
					throw err
				}
			},
			emulatorSwitchWallet: async (params) => {
				if (!emulatorEnabled) throw new Error('Emulator is disabled')
				const { stopEmulator, initEmulator, getEmulatorStatus } = await import('./emulator')

				// Stop current emulator if running
				if (getEmulatorStatus().state === 'running') {
					const { closeEmulatorWindow } = await import('./emulator-window')
					closeEmulatorWindow()
					engine.disconnectEmulator()
					stopEmulator()
				}

				// Init with the requested flash name + channel
				const status = initEmulator(params.name)
				if (status.state !== 'running') return status

				// Open window + connect engine (auto-reloads saved mnemonic)
				const { openEmulatorWindow } = await import('./emulator-window')
				openEmulatorWindow()
				await engine.connectEmulator()
				return getEmulatorStatus()
			},
			emulatorGetMnemonic: async () => {
				if (!emulatorEnabled) return null
				return await engine.getEmulatorMnemonic()
			},
			emulatorCreateWallet: async (params) => {
				if (!emulatorEnabled) throw new Error('Emulator is disabled')
				if (!engine.wallet) throw new Error('No device connected')

				const bip39 = require('bip39')
				const wc = params?.wordCount || 12
				const strength = wc === 24 ? 256 : wc === 18 ? 192 : 128
				const mnemonic = bip39.generateMnemonic(strength)
				console.log(`[Emulator] Generated ${wc}-word mnemonic`)

				// Save mnemonic FIRST — connectEmulator's auto-reload uses it
				const { saveMnemonic, deleteMnemonic } = await import('./emulator-keychain')
				const { getActiveFlashName, deleteFlash, stopEmulator } = await import('./emulator')
				const flashName = getActiveFlashName()
				saveMnemonic(flashName, mnemonic)

				try {
					// Wipe first if already initialized — firmware rejects loadDevice otherwise
					if (engine.cachedFeatures?.initialized) {
						console.log('[Emulator] Already initialized — wiping before create')
						await emuConfirmOp(() => engine.wallet!.wipe())
						const { flushRingBuffers } = await import('./emulator')
						flushRingBuffers()
						await engine.connectEmulator()
					}

					// If auto-reload already initialized with the new seed, skip manual load
					if (!engine.cachedFeatures?.initialized) {
						await emuConfirmOp(() => (engine.wallet as any).loadDevice({
							mnemonic, pin: false, passphrase: false, skipChecksum: false,
						}))
						console.log('[Emulator] loadDevice complete')
					} else {
						console.log('[Emulator] Device initialized by auto-reload — skipping manual loadDevice')
					}

					// Auto-set label with EMU prefix
					try {
						await emuConfirmOp(() => engine.applySettings({ label: 'EMU KeepKey', skipRefresh: true }))
						console.log('[Emulator] Label set')
					} catch (e: any) {
						console.warn('[Emulator] Label set failed (non-critical):', e?.message)
					}

					// Drain stale data + reconnect for clean transport
					const { flushRingBuffers } = await import('./emulator')
					flushRingBuffers()
					await engine.connectEmulator()

					// Verify the firmware actually holds the mnemonic we generated.
					// MUST be fatal — a successful return tells the wizard to show
					// the user a seed they should write down. If the firmware doesn't
					// hold this seed, the user backs up a recovery phrase that won't
					// recover the wallet. raceVerifyMnemonic caps at 3s so a stuck
					// DebugLink read doesn't hang the RPC — timeout = failure.
					const verifyResult = await raceVerifyMnemonic(mnemonic)
					if (!verifyResult.ok) {
						throw new Error(`Seed verification failed — ${verifyResult.reason}`)
					}
					console.log('[Emulator] SEED VERIFY OK — firmware mnemonic matches generated seed')

					// Show seed words on emulator device window (NOT the main UI).
					// displaySeedWords throws if the window can't be brought up OR
					// if the user closes the window without acking — so we never
					// tell the wizard "seedDisplayed: true" when the user didn't
					// actually see (and ack) the words.
					const { displaySeedWords } = await import('./emulator-window')
					await displaySeedWords(mnemonic)

					return { seedDisplayed: true }
				} catch (err) {
					// Rollback: a saved mnemonic + initialized firmware would let
					// connectEmulator's auto-reload silently resurrect the wallet
					// next session — meaning the user could end up using a wallet
					// that the wizard told them failed to create and which they
					// were never given the chance to back up. Also drop the
					// emulator_wallet metadata + cached device data that
					// connectEmulator persisted en route to the failed verify.
					console.error('[Emulator] create-wallet failed, rolling back:', (err as Error).message)
					const failedDeviceId = engine.cachedFeatures?.deviceId
					try {
						const { closeEmulatorWindow } = await import('./emulator-window')
						closeEmulatorWindow()
					} catch {}
					try { engine.disconnectEmulator() } catch {}
					try { stopEmulator() } catch {}
					try { deleteMnemonic(flashName) } catch {}
					try { deleteFlash(flashName) } catch {}
					try {
						const { deleteEmulatorWalletMeta, deleteDeviceSnapshot } = await import('./db')
						deleteEmulatorWalletMeta(flashName)
						if (failedDeviceId) deleteDeviceSnapshot(failedDeviceId)
					} catch {}
					throw err
				}
			},

			// ── WalletConnect (native v2) ────────────────────────────
			wcPair: async (params) => {
				console.log('[wcPair] called with URI prefix:', params.uri?.slice(0, 24), 'len:', params.uri?.length)
				if (!walletConnectEnabled) throw new Error('WalletConnect is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				// EVM derivation is now lazy and namespace-scoped — handled by
				// ensureEvmAddressInfo() inside onSessionProposal, only when the
				// dApp actually requests eip155.
				const wc = getOrCreateWcManager()
				await wc.pair(params.uri)
				console.log('[wcPair] pair() returned (session_proposal handled async via listener)')
			},
			wcGetSessions: async () => {
				if (!wcManager) return []
				return wcManager.getSessions()
			},
			wcDisconnectSession: async (params) => {
				if (!wcManager) return
				await wcManager.disconnectSession(params.topic)
			},
			wcApprovePair: async (params) => {
				if (!wcManager) return
				wcManager.approvePair(params.id)
			},
			wcRejectPair: async (params) => {
				if (!wcManager) return
				wcManager.rejectPair(params.id)
			},

			// ── Utility ──────────────────────────────────────────────
			openUrl: async (params) => {
				try {
					const parsed = new URL(params.url)
					if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
					if (process.platform === 'win32') {
						// 'start' is a cmd.exe built-in, not an executable — must invoke via cmd /c
						// Empty title "" required because start treats URLs with & as title strings
						Bun.spawn(['cmd', '/c', 'start', '', parsed.href])
					} else {
						const cmd = process.platform === 'linux' ? 'xdg-open' : 'open'
						Bun.spawn([cmd, parsed.href])
					}
				} catch {
					throw new Error('Invalid URL')
				}
			},
			getPendingDeepLink: async () => {
				// Return but don't consume — frontend will clear via consumePendingDeepLink
				// so the user can retry if processing fails
				return pendingDeepLinkUri
			},
			consumePendingDeepLink: async () => {
				pendingDeepLinkUri = null
			},

			// ── Linux: install udev rules for KeepKey ────────────────
			// Writes /etc/udev/rules.d/51-keepkey.rules via pkexec, then
			// reloads udev and re-triggers detection. Polkit-aware desktop
			// sessions show a graphical password prompt automatically.
			//
			// Uses TAG+="uaccess" (systemd-logind) instead of GROUP="plugdev"
			// so access is granted to the active seat user without requiring
			// the user be in a specific group — works out-of-the-box on every
			// modern systemd distro (Ubuntu 22.04+, Fedora, Arch, Debian 12+).
			installLinuxUdevRules: async () => {
				if (process.platform !== 'linux') {
					return { success: false, error: 'Only available on Linux' }
				}
				const RULE_PATH = '/etc/udev/rules.d/51-keepkey.rules'
				const RULE_BODY = `# KeepKey hardware wallet — installed by KeepKey Vault
# Grants the active seat user raw USB + hidraw access to the device.
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2b24", ATTRS{idProduct}=="0001", TAG+="uaccess"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="2b24", ATTRS{idProduct}=="0002", TAG+="uaccess"
KERNEL=="hidraw*", ATTRS{idVendor}=="2b24", TAG+="uaccess"
`
				// Heredoc with a quoted sentinel ('KKEOF') prevents the shell
				// from interpolating any character in the rule body.
				const script = `set -e
cat > ${RULE_PATH} <<'KKEOF'
${RULE_BODY}KKEOF
chmod 0644 ${RULE_PATH}
udevadm control --reload-rules
udevadm trigger --subsystem-match=usb --attr-match=idVendor=2b24 || udevadm trigger
`
				try {
					const proc = Bun.spawn(['pkexec', '/bin/sh', '-c', script], {
						stdout: 'pipe',
						stderr: 'pipe',
					})
					const exitCode = await proc.exited
					if (exitCode === 0) {
						console.log('[udev] Installed KeepKey udev rules — re-syncing device state')
						// Give udev a moment, then re-probe so the UI updates without manual retry.
						setTimeout(() => engine.syncState().catch(() => {}), 500)
						return { success: true }
					}
					// pkexec exit codes: 126 = auth dismissed, 127 = pkexec/command not found,
					// other = command failed. stderr usually carries the cause.
					const stderr = await new Response(proc.stderr as any).text()
					if (exitCode === 127) {
						return { success: false, error: 'pkexec is not installed. Install policykit-1 (Debian/Ubuntu) or polkit (Fedora/Arch), or copy the rule manually — see the link below.' }
					}
					if (exitCode === 126) {
						return { success: false, error: 'Authentication was cancelled.' }
					}
					return { success: false, error: stderr.trim() || `pkexec exited ${exitCode}` }
				} catch (err: any) {
					return { success: false, error: err?.message || String(err) }
				}
			},

			// ── Windows USB troubleshooter (read-only diagnostic) ────
			// Returns a labelled report (likely cause + guidance + copy-ready
			// text) for the device-not-detected wizard. Never throws.
			runUsbDiagnostic: async () => {
				const version = await Updater.localInfo.version().catch(() => 'unknown')
				return runUsbDiagnosticProbe(version)
			},

			// ── App Updates ──────────────────────────────────────────
			checkForUpdate: async () => {
				const localVer = await Updater.localInfo.version()

				// Always use GitHub API to check for updates.
				// Electrobun's native check is unreliable:
				// - Windows: no update.json published → 404
				// - macOS: update.json version is stale (generated before release)
				try {
					const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`, {
						signal: AbortSignal.timeout(15000),
						headers: { 'Accept': 'application/vnd.github.v3+json' },
					})
					if (!resp.ok) throw new Error(`GitHub API ${resp.status}`)

					const releases = await resp.json() as Array<{ tag_name: string; prerelease: boolean; draft: boolean }>
					const candidate = preReleaseUpdates
						? releases.find(r => !r.draft)
						: releases.find(r => !r.draft && !r.prerelease)

					if (candidate) {
						const remoteVer = candidate.tag_name.replace(/^v/, '')
						if (localVer && versionCompare(remoteVer, localVer) > 0) {
							console.log(`[Updater] Update available: ${remoteVer} > ${localVer}`)
							pendingUpdateVersion = remoteVer
							return {
								updateAvailable: true,
								updateReady: false,
								version: remoteVer,
								hash: '',
								preRelease: candidate.prerelease,
							}
						}
						console.log(`[Updater] Up to date: ${remoteVer} <= ${localVer}`)
					}

					return {
						updateAvailable: false,
						updateReady: false,
						version: '',
						hash: '',
					}
				} catch (e: any) {
					console.warn('[Updater] GitHub API check failed:', e.message)
					return {
						updateAvailable: false,
						updateReady: false,
						version: '',
						hash: '',
						error: `Update check failed: ${e.message}`,
					}
				}
			},
			downloadUpdate: async () => {
				if (process.platform === 'win32' || process.platform === 'darwin') {
					openUpdatePage()
					return
				}
				await Updater.downloadUpdate()
			},
			applyUpdate: async () => {
				if (process.platform === 'win32' || process.platform === 'darwin') {
					openUpdatePage()
					return
				}
				await Updater.applyUpdate()
			},
			getUpdateInfo: async () => {
				return Updater.updateInfo() || null
			},
			getAppVersion: async () => ({
				version: await Updater.localInfo.version(),
				channel: await Updater.localInfo.channel(),
			}),
			// ── REST API UI-active gate ───────────────────────────────
			// The WebView calls uiSetActive(true) on mount and uiSetActive(false)
			// before unload, plus a periodic heartbeat. Without a fresh heartbeat,
			// rest-api.ts refuses to serve pubkeys/addresses to 3rd-party clients.
			uiSetActive: async ({ active, viewDeviceId }) => {
				setUiActive(Boolean(active), viewDeviceId ?? null)
			},
			uiHeartbeat: async (params) => {
				uiHeartbeat((params as any)?.viewDeviceId ?? null)
			},
			// ── Window controls (for custom titlebar) ─────────────────
			windowClose: async () => { _mainWindow?.close() },
			windowMinimize: async () => { _mainWindow?.minimize() },
			windowMaximize: async () => { _mainWindow?.maximize() },
			windowGetFrame: async () => { if (!_mainWindow) throw new Error('Window not ready'); return _mainWindow.getFrame() },
			windowSetPosition: async ({ x, y }) => { _mainWindow?.setPosition(x, y) },
			windowSetFrame: async ({ x, y, width, height }) => { _mainWindow?.setFrame(x, y, width, height) },
		},
		messages: {},
	},
})

// Replace the early `sendFatal` stub now that rpc is live. From here on, an
// uncaught exception or unhandled rejection pushes a typed message to the UI.
sendFatal = (source, err) => {
	const e: any = err
	const message = e?.message ?? String(err)
	const stack = typeof e?.stack === 'string' ? e.stack : undefined
	try { rpc.send['fatal']({ source, message, stack }) } catch { /* webview not ready */ }
}

// Tracker init moved into deferredInit() so it runs after DB ready + settings loaded.

// Hoisted above the state-change listener: engine.start() (later in the file)
// can synchronously emit 'ready', and the listener's deep-link replay path
// would TDZ on this binding if it were declared near the URL handler.
let pendingDeepLinkUri: string | null = null

// Push engine events to WebView
engine.on('state-change', (state) => {
	try { rpc.send['device-state'](state) } catch { /* webview not ready yet */ }
	// Device-to-device swap: a *different* device just reached 'ready'. Reset the
	// in-memory account managers so device B re-derives its own xpubs/addresses
	// instead of reusing device A's (the existing `if (!isInitialized)` guards
	// re-init on the next account/balance fetch, which emits 'change' and pushes
	// fresh data). Runs here — before any frontend-initiated getBtcAccounts /
	// getCachedBalances round-trip — and edge-triggered on a changed truthy
	// deviceId, so the 2-4 benign 'ready' re-emits per device (post-PIN /
	// passphrase / probe / seed-check, all same deviceId) are no-ops, and the
	// first device (lastReadyDeviceId === null) never resets, avoiding the
	// cold-start race that sank the prior attempt. We do NOT clear DB caches here
	// (they are deviceId-scoped and self-correct); that stays exclusive to the
	// seed-changed handler. See src/shared/device-switch.ts.
	if (shouldResetManagersOnReady(state, lastReadyDeviceId)) {
		console.warn(`[Vault] Device swap ${lastReadyDeviceId} → ${state.deviceId}: resetting in-memory account managers`)
		resetSeedManagers()
		// Device-to-device swap is exactly the case `seed-changed` does NOT catch.
		// Force Zcash to re-prove the cached FVK against the NEW device before any
		// shielded balance is shown or spend is built (anti-bleed).
		zcashDeviceVerified = false
		zcashVerifiedThisSession = false
		// Proactively push the now-empty sets so the frontend drops device-A's
		// addresses immediately, rather than showing them until the next re-init.
		try { rpc.send['btc-accounts-update'](btcAccounts.toAccountSet()) } catch { /* webview not ready yet */ }
		try { rpc.send['evm-addresses-update'](evmAddresses.toAddressSet()) } catch { /* webview not ready yet */ }
	}
	lastReadyDeviceId = nextReadyDeviceId(state, lastReadyDeviceId)
	// Seed-staleness guard (event-driven leg): once the engine has classified the
	// session and derived the seed identity (checkSeedIdentity / hidden-wallet
	// scope derive / reconnect probe — all re-emit state-change after setting it),
	// verify the in-memory managers belong to that seed and purge if not. Catches
	// same-device seed changes the deviceId-based reset above can't see, BEFORE
	// the frontend round-trips for accounts/balances. getBalances has its own
	// device-verified leg for fetches that race this. No-op when the identity
	// isn't known yet (currentSeedEthAddress null → never purge on uncertainty).
	if (state.state === 'ready') {
		reconcileSeedManagers(engine.currentSeedEthAddress, 'device-ready')
	}
	// Replay any WC deep link that was queued while no device was connected.
	// Without this, a deep link delivered before the device was ready would
	// sit in pendingDeepLinkUri until the next mount of WalletConnectPanel.
	if (state.state === 'ready' && pendingDeepLinkUri && walletConnectEnabled) {
		const uri = pendingDeepLinkUri
		pendingDeepLinkUri = null
		try { rpc.send['wc-deep-link-pair']({ uri }) }
		catch { pendingDeepLinkUri = uri /* webview not ready — keep queued */ }
	}
	// Auto-disable advanced features if firmware doesn't support them
	if (state.state === 'ready') {
		const fw = state.firmwareVersion
		if (bip85Enabled && (!fw || versionCompare(fw, '7.16.0') < 0)) {
			bip85Enabled = false
			setSetting('bip85_enabled', '0')
			console.log(`[settings] BIP-85 auto-disabled — firmware ${fw || 'unknown'} < 7.16.0`)
		}
		if (zcashPrivacyEnabled && (!fw || versionCompare(fw, '7.15.0') < 0)) {
			zcashPrivacyEnabled = false
			setSetting('zcash_privacy_enabled', '0')
			stopSidecar()
			console.log(`[settings] Zcash privacy auto-disabled — firmware ${fw || 'unknown'} < 7.15.0`)
		}
	}
	if (state.state === 'ready' && !pioneerSocket) {
		// Debounce Pioneer push events per chain — rapid-fire cache pings coalesce into one refresh.
		const pioneerEventDebounce = new Map<string, ReturnType<typeof setTimeout>>()
		pioneerSocket = new PioneerSocket({
			queryKey: getPioneerQueryKey(),
			onEvent: (event, data) => {
				const REFRESH_EVENTS = new Set(['transaction:incoming', 'balance:update', 'balance:cache:update'])
				if (!REFRESH_EVENTS.has(event)) return
				const d = data as any
				const address = d?.address ?? undefined
				const txid = d?.txid ?? d?.tx?.txid ?? undefined
				// Normalize whatever Pioneer sends into a canonical CAIP-19 string.
				// Pioneer may send: CAIP-19 (has "/"), CAIP-2 ("eip155:1"), internal id
				// ("ethereum"), or raw symbol ("ETH"). Symbol is ambiguous (ETH = Ethereum,
				// Arbitrum, Optimism, Base) so we never fall back to it.
				const allChains = [...CHAINS, ...customChainDefs]
				let chain: string | undefined
				const raw: string | undefined = d?.chain
				if (raw) {
					if (raw.includes('/')) {
						chain = raw // already CAIP-19
					} else {
						// CAIP-2 (networkId like "eip155:1") or internal id like "ethereum"
						const def = allChains.find(c => c.networkId === raw || c.id === raw)
						chain = def?.caip
					}
				}
				if (!chain) return
				// Debounce per network (CAIP-2 prefix) so multiple token pushes on the same
				// EVM network collapse into a single refresh rather than bypassing the debounce.
				const networkId = chain.split('/')[0]
				const existing = pioneerEventDebounce.get(networkId)
				if (existing) clearTimeout(existing)
				pioneerEventDebounce.set(networkId, setTimeout(() => {
					pioneerEventDebounce.delete(networkId)
					console.log(`[PioneerSocket] push event '${event}' chain=${chain} → forwarding`)
					try { rpc.send['tx-push-received']({ chain, address, txid }) } catch { /* webview not ready */ }
				}, 2000))
			},
			onConnect: () => console.log('[PioneerSocket] connected to Pioneer'),
			onDisconnect: () => console.log('[PioneerSocket] disconnected from Pioneer'),
		})
		pioneerSocket.start()
	}
	if (state.state === 'ready' && !engine.isPassphraseWallet) {
		// Fire-and-forget background history scan on every ready transition (startup + reconnect).
		// 3s delay lets wallet address derivation settle before hitting Pioneer.
		activityScanRunning = true
		setTimeout(() => {
			const scope = getWalletDbScope()
			if (!scope || !engine.wallet) { activityScanRunning = false; return }
			console.log('[activity] Auto-scanning history on device ready...')
			rebuildActivityHistory({
				wallet: engine.wallet,
				scope,
				chains: getAllChains().filter(c => c.id !== 'hive' || hiveEnabled),
				firmwareVersion: engine.getDeviceState().firmwareVersion,
			}).then(result => {
				console.log(`[activity] Auto-scan complete: ${result.totals.inserted} new txs across ${result.totals.chains} chains`)
				try { rpc.send['activity-scan-complete']({ inserted: result.totals.inserted, chains: result.totals.chains }) } catch { /* webview not ready */ }
			}).catch(e => {
				console.warn('[activity] Auto-scan failed:', e?.message || e)
				try { rpc.send['activity-scan-complete']({ inserted: 0, chains: 0 }) } catch { /* webview not ready */ }
			}).finally(() => {
				activityScanRunning = false
			})
		}, 3000)
	}
	if (state.state === 'disconnected') {
		// Keep btcAccounts + evmAddresses in memory across disconnect so the
		// watch-only / cache-only UI (sidebar account drop-down, per-account
		// balances) keeps rendering the last-known per-account data after the
		// device is unplugged. They get re-derived on reconnect via
		// initialize(wallet); a real seed change resets them via the
		// seed-changed handler below.
		console.log('[Vault] Device disconnected: keeping in-memory account managers for watch-only')
		pioneerSocket?.stop()
		pioneerSocket = null
		stopEventStream()
	}
	if (state.state === 'disconnected' || state.state === 'needs_passphrase') {
		pendingScopedApiLogs.splice(0)
		// PRIVACY: hidden-session activity must not outlive its session — drop the
		// RAM store the moment the session ends (unplug) or a new one starts
		// (device requests a passphrase). No-op for standard sessions (store empty).
		clearSessionActivity()
	}
	// When entering passphrase mode, the seed is about to change — clear all
	// cached addresses so they get re-derived from the new passphrase seed.
	if (state.state === 'needs_passphrase') {
		// Reset in-memory managers so they re-derive after passphrase entry.
		resetSeedManagers()
		// NOTE: We do NOT clear DB caches (clearCachedPubkeys, clearBalances) here.
		// needs_passphrase fires when the device *requests* a passphrase — before the
		// user enters it. We don't know yet if this is the standard wallet (empty
		// passphrase) or a hidden wallet. Clearing DB prematurely destroys the standard
		// wallet's cache for every passphrase-protected unlock. Instead, the write-time
		// guards (isPassphraseWallet checks) prevent hidden wallet data from ever
		// reaching the DB during the session.
		console.log('[Vault] Passphrase mode: reset in-memory address managers — will re-derive after passphrase entry')
		// An open Audit run belongs to the pre-passphrase seed — mark it stale AND
		// push an audit-specific signal so the wizard stops and prompts a re-run
		// instead of mixing seeds. markAuditsStale alone is invisible to a COMPLETED
		// audit (status stays 'complete' and the dialog has stopped polling). We use
		// the dedicated 'audit-stale' push, NOT wallet-data-purged: needs_passphrase
		// fires on every passphrase-protected unlock (incl. the standard
		// empty-passphrase wallet) and must not churn the dashboard cache.
		markAuditsStale('needs_passphrase')
		try { rpc.send['audit-stale']({ reason: 'needs_passphrase' }) } catch { /* webview not ready */ }
	}
})
engine.on('wallet-scope-ready', ({ deviceId, seedAddress }) => {
	console.log(`[Vault] Wallet scope ready on ${deviceId}: ${seedAddress?.slice(0, 10)}...`)
	flushPendingScopedApiLogs()
})
// Seed changed — different mnemonic loaded on the same hardware.
// Reset in-memory address managers so they re-derive from the new seed.
// Don't wipe DB — let the fresh Pioneer fetch naturally overwrite stale entries.
engine.on('seed-changed', ({ deviceId, oldAddress, newAddress }) => {
	console.warn(`[Vault] SEED CHANGED on ${deviceId}: ${oldAddress?.slice(0, 10)} → ${newAddress?.slice(0, 10)}`)
	resetSeedManagers()
	clearSessionActivity()
	// Zcash sidecar holds a per-seed FVK + scanned notes both in memory and in
	// ~/.keepkey/zcash_wallet.db. After a seed change those are wrong for the
	// new wallet — but `hasFvkLoaded()` would still return true (cache is
	// populated for the old seed), so `ensureFvkLoaded()` would short-circuit
	// and the next send would build a tx against the wrong FVK. Stop the
	// sidecar (clears in-memory cache + verification flag), wipe the on-disk
	// DB so the next start boots without auto-loading the stale FVK, and let
	// the next access re-init from the device.
	stopSidecar()
	wipeSidecarWalletDb()
	zcashVerifiedThisSession = false
	zcashDeviceVerified = false
	zcashBackgroundVerifyInFlight = false
	// Clear stale DB caches — old seed's pubkeys and balances are wrong for the new seed
	if (deviceId) {
		clearCachedPubkeys(deviceId)
		clearBalances(deviceId)
		console.log('[Vault] Seed changed: cleared cached pubkeys + balances for', deviceId)
	}
	// The old seed's balances are now wrong: clear the dashboard's displayed
	// balances and invalidate any open Audit run (mirrors the reconciliation purge
	// path so the wizard can't mix an old report with new-seed scans).
	try { rpc.send['wallet-data-purged']({ reason: 'seed-changed' }) } catch { /* webview not ready */ }
	markAuditsStale('seed-changed')
	// Push fresh state to frontend so it re-renders
	try { rpc.send['device-state'](engine.getDeviceState()) } catch {}
})

engine.on('firmware-progress', (progress) => {
	try { rpc.send['firmware-progress'](progress) } catch { /* webview not ready yet */ }
})
onScanProgress((progress) => {
	try { rpc.send['scan-progress'](progress) } catch { /* webview not ready yet */ }
})
engine.on('pin-request', (req) => {
	try { rpc.send['pin-request'](req) } catch { /* webview not ready yet */ }
})
engine.on('pin-error', (err) => {
	try { rpc.send['pin-error'](err) } catch { /* webview not ready yet */ }
})
engine.on('character-request', (req) => {
	try { rpc.send['character-request'](req) } catch { /* webview not ready yet */ }
})
engine.on('passphrase-request', () => {
	try { rpc.send['passphrase-request']({}) } catch { /* webview not ready yet */ }
})
engine.on('button-request', () => {
	try { rpc.send['device-button-request']({}) } catch { /* webview not ready yet */ }
})
engine.on('recovery-error', (err) => {
	try { rpc.send['recovery-error'](err) } catch { /* webview not ready yet */ }
})

// BtcAccountManager change events → push to WebView
btcAccounts.on('change', (set) => {
	try { rpc.send['btc-accounts-update'](set) } catch { /* webview not ready yet */ }
})

// EvmAddressManager change events → push to WebView
evmAddresses.on('change', (set: EvmAddressSet) => {
	try { rpc.send['evm-addresses-update'](set) } catch { /* webview not ready yet */ }
})

// Updater status changes → push to WebView (debounced to prevent spam)
let lastUpdateStatus = ''
let lastUpdateStatusTime = 0
Updater.onStatusChange(async (entry: any) => {
	try {
		const status = entry.status || ''
		const now = Date.now()
		// Debounce: skip duplicate error statuses within 5 seconds
		if ((status === 'error' || status === 'download-error') && status === lastUpdateStatus && now - lastUpdateStatusTime < 5000) return
		// Suppress "update-available" when running a pre-release newer than latest stable
		if (status === 'update-available' || status === 'update-available-full' || status === 'update-available-delta') {
			const info = Updater.updateInfo()
			const localVer = await Updater.localInfo.version()
			if (info?.version && localVer && versionCompare(info.version, localVer) < 0) {
				console.log(`[Updater] Suppressing status ${status}: remote ${info.version} < local ${localVer}`)
				return
			}
		}
		lastUpdateStatus = status
		lastUpdateStatusTime = now
		rpc.send['update-status']({
			status,
			message: entry.message,
			timestamp: entry.timestamp,
			progress: entry.details?.progress,
			bytesDownloaded: entry.details?.bytesDownloaded,
			totalBytes: entry.details?.totalBytes,
			errorMessage: entry.details?.errorMessage,
		})
	} catch { /* webview not ready */ }
})

// ── Window Setup ──────────────────────────────────────────────────────
async function getMainViewUrl(): Promise<string> {
	try {
		const channel = await Updater.localInfo.channel()
		if (channel === "dev") {
			try {
				await fetch(DEV_SERVER_URL, { method: "HEAD" })
				console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`)
				return DEV_SERVER_URL
			} catch {
				console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.")
			}
		}
	} catch (e) {
		console.warn('[Vault] Failed to detect channel, falling back to production view:', e)
	}
	return "views://mainview/index.html"
}

const url = await getMainViewUrl()

// ── Application Menu (required for Cmd+C/V clipboard in WKWebView on macOS) ──
// On Windows, Electrobun renders a menu bar but macOS roles are no-ops — hide it.
if (process.platform !== 'win32') ApplicationMenu.setApplicationMenu([
	{
		label: "KeepKey Vault",
		submenu: [
			{ role: "hide" },
			{ role: "hideOtherApplications" },
			{ role: "unhideAllApplications" },
			{ type: "separator" },
			{ label: "Quit", role: "terminate", accelerator: "Cmd+Q" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo", accelerator: "Cmd+Z" },
			{ role: "redo", accelerator: "Cmd+Shift+Z" },
			{ type: "separator" },
			{ role: "cut", accelerator: "Cmd+X" },
			{ role: "copy", accelerator: "Cmd+C" },
			{ role: "paste", accelerator: "Cmd+V" },
			{ role: "pasteAndMatchStyle", accelerator: "Cmd+Shift+V" },
			{ role: "selectAll", accelerator: "Cmd+A" },
		],
	},
	{
		label: "Window",
		submenu: [
			{ role: "performMiniaturize", accelerator: "Cmd+M" },
			{ role: "performClose", accelerator: "Cmd+W" },
		],
	},
])

perf('creating BrowserWindow')
let _mainWindow: BrowserWindow | null = null
const mainWindow = new BrowserWindow({
	title: `KeepKey Vault v${pkg.version}`,
	url,
	rpc,
	// titleBarStyle left as default — "hidden" breaks WKWebView keyboard input
	frame: {
		width: 1200,
		height: 800,
		x: 100,
		y: 100,
	},
})
_mainWindow = mainWindow

// Set window icon on Windows via Win32 API (SendMessage WM_SETICON).
// Electrobun's setWindowIcon is a no-op on Windows (stub in nativeWrapper.cpp).
// mainWindow.ptr is the HWND, so we call user32.dll directly.
if (process.platform === 'win32') {
	try {
		const { dlopen, FFIType, ptr: ffiPtr } = require("bun:ffi")
		const path = require("path")
		const appRoot = path.resolve(import.meta.dir, "..", "..", "..")
		const { existsSync } = require("fs")
		// Prefer app-real.ico (proper ICO from production build) over app.ico (may be renamed PNG)
		const realIco = path.join(appRoot, "Resources", "app-real.ico")
		const fallbackIco = path.join(appRoot, "Resources", "app.ico")
		const iconPath = existsSync(realIco) ? realIco : fallbackIco

		// LoadImageW from user32.dll to load .ico file
		const user32 = dlopen("user32.dll", {
			LoadImageW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
				returns: FFIType.ptr,
			},
			SendMessageW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
				returns: FFIType.ptr,
			},
			GetSystemMetrics: {
				args: [FFIType.i32],
				returns: FFIType.i32,
			},
		})

		const IMAGE_ICON = 1
		const LR_LOADFROMFILE = 0x00000010
		const WM_SETICON = 0x0080
		const ICON_BIG = 1
		const ICON_SMALL = 0
		const SM_CXICON = 11
		const SM_CYICON = 12
		const SM_CXSMICON = 49
		const SM_CYSMICON = 50

		// Encode icon path as UTF-16LE for LoadImageW
		const iconPathW = Buffer.from(iconPath + '\0', 'utf16le')

		const cxIcon = user32.symbols.GetSystemMetrics(SM_CXICON)
		const cyIcon = user32.symbols.GetSystemMetrics(SM_CYICON)
		const cxSmIcon = user32.symbols.GetSystemMetrics(SM_CXSMICON)
		const cySmIcon = user32.symbols.GetSystemMetrics(SM_CYSMICON)

		const bigIcon = user32.symbols.LoadImageW(null, iconPathW, IMAGE_ICON, cxIcon, cyIcon, LR_LOADFROMFILE)
		const smallIcon = user32.symbols.LoadImageW(null, iconPathW, IMAGE_ICON, cxSmIcon, cySmIcon, LR_LOADFROMFILE)

		const hwnd = mainWindow.ptr
		if (bigIcon) user32.symbols.SendMessageW(hwnd, WM_SETICON, ICON_BIG, bigIcon)
		if (smallIcon) user32.symbols.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, smallIcon)
		console.log('[Vault] Window icon set via Win32 API:', iconPath)
	} catch (e: any) {
		console.warn("[Vault] Failed to set window icon:", e.message)
	}
}

// ── Deferred startup: DB → settings → REST API → engine ──────────────
// Window is already created above — now initialize backend services.
perf('window created, starting deferred init')
deferredInit()
auth.reloadPairings()
loadSettings()
await applyRestApiState()
if (!restApiEnabled) console.log('[Vault] REST API disabled by user setting')
perf('REST API applied, starting engine')
engine.setAlphaFirmware(alphaFirmware)
await engine.start()

// Age out pending swaps older than 24h — prevents accumulation of test/failed
// swaps as permanent dashboard banners. Deferred 5s so the DB is fully open.
setTimeout(() => {
	import('./swap-tracker').then(({ cleanupStalePendingSwaps }) => {
		cleanupStalePendingSwaps()
	}).catch((e: any) => console.warn('[Vault] swap cleanup failed:', e.message))
	setInterval(() => {
		import('./swap-tracker').then(({ cleanupStalePendingSwaps }) => cleanupStalePendingSwaps()).catch(() => {})
	}, 60 * 60 * 1000)
}, 5_000)

// Zcash sidecar is started eagerly at the end of boot (see bottom of file)

// Cache app version for REST health endpoint
Updater.localInfo.version().then(v => { appVersionCache = v }).catch(() => {})

// Background update check (skip in dev, delay to let webview initialize)
// Always uses GitHub API instead of Electrobun's native checker because:
// - Windows: no update.json is published, so Electrobun check always 404s
// - macOS: update.json version is stale (generated before release is published)
Updater.localInfo.channel().then(ch => {
	if (ch !== 'dev') {
		setTimeout(async () => {
			try {
				const localVer = await Updater.localInfo.version()
				if (!localVer) return

				const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`, {
					signal: AbortSignal.timeout(15000),
					headers: { 'Accept': 'application/vnd.github.v3+json' },
				})
				if (!resp.ok) {
					console.warn(`[Vault] Background update check: GitHub API ${resp.status}`)
					return
				}

				const releases = await resp.json() as Array<{ tag_name: string; prerelease: boolean; draft: boolean }>
				// Pre-release channel: first non-draft release (includes pre-releases)
				// Standard channel: first non-draft, non-prerelease release
				const candidate = preReleaseUpdates
					? releases.find(r => !r.draft)
					: releases.find(r => !r.draft && !r.prerelease)

				if (!candidate) {
					console.log('[Vault] Background update check: no suitable release found')
					return
				}

				const remoteVer = candidate.tag_name.replace(/^v/, '')
				if (versionCompare(remoteVer, localVer) > 0) {
					console.log(`[Vault] Update available: ${remoteVer} > ${localVer}`)
					pendingUpdateVersion = remoteVer
					rpc.send['update-status']({ status: 'update-available', message: `Version ${remoteVer} available` })
				} else {
					console.log(`[Vault] Up to date: ${remoteVer} <= ${localVer}`)
				}
			} catch (e: any) {
				console.warn('[Vault] Background update check failed:', e.message)
			}
		}, 5000)
	}
})

function findMacAppBundlePath(): string | null {
	const starts = [
		process.execPath,
		process.argv[1],
		import.meta.dir,
		process.cwd(),
	].filter((p): p is string => !!p)

	for (const start of starts) {
		let current = start
		try {
			if (fs.existsSync(current) && fs.statSync(current).isFile()) current = path.dirname(current)
		} catch { /* best effort */ }

		for (let i = 0; i < 10; i++) {
			if (current.endsWith('.app') && fs.existsSync(path.join(current, 'Contents', 'Info.plist'))) {
				return current
			}
			const next = path.dirname(current)
			if (next === current) break
			current = next
		}
	}

	return null
}

// ── Force keepkey:// protocol registration (override old keepkey-desktop) ──
if (process.platform === 'darwin') {
	// Re-register this app as the handler for keepkey:// via Launch Services.
	// When both keepkey-desktop (Electron) and keepkey-vault (Electrobun) are
	// installed, the last one to register wins. We force it on every launch.
	try {
		const appPath = findMacAppBundlePath()
		if (!appPath) throw new Error('Could not locate enclosing .app bundle')
		const lsregister = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'
		// -f forces re-registration of the app's URL schemes from its Info.plist,
		// ensuring keepkey:// points to this vault instead of the old Electron desktop app.
		Bun.spawn([lsregister, '-f', appPath], {
			stdout: 'ignore',
			stderr: 'ignore',
		})
		console.log('[Vault] Re-registered keepkey:// protocol handler for:', appPath)
	} catch (e: any) {
		console.warn('[Vault] Failed to re-register protocol:', e.message)
	}
}

// ── keepkey:// and keepkey-vault:// Protocol Handler ──────────────────
// (declared above; moved earlier to avoid TDZ access from the state-change
// listener that replays queued deep links on device-ready.)

function getWalletConnectUri(inputUri: string): string | undefined {
	const uri = inputUri
		.replace('keepkey://launch/wc?uri=', '')
		.replace('keepkey://wc?uri=', '')
		.replace('keepkey-vault://launch/wc?uri=', '')
		.replace('keepkey-vault://wc?uri=', '')
	if (!uri.startsWith('wc')) return undefined
	return decodeURIComponent(uri.replace('wc/?uri=', '').replace('wc?uri=', ''))
}

function handleKeepKeyUrl(url: string) {
	console.log('[Vault] URL handler:', url)
	const wcUri = getWalletConnectUri(url)
	if (wcUri) {
		if (walletConnectEnabled && engine.wallet) {
			// Hand the URI to the panel so it mounts *before* the WC
			// session_proposal arrives. The pair-approval modal lives inside
			// WalletConnectPanel; pairing directly from here while the panel
			// is closed would let the modal render invisibly and the proposal
			// would silently time out at 120s.
			try {
				rpc.send['wc-deep-link-pair']({ uri: wcUri })
				pendingDeepLinkUri = null
			} catch {
				// Webview not ready — let the cold-start path pick it up.
				pendingDeepLinkUri = wcUri
			}
		} else if (walletConnectEnabled && !engine.wallet) {
			// Device not ready — queue for later
			pendingDeepLinkUri = wcUri
			console.log('[Vault] Device not ready, queued WC URI for later')
		} else {
			// WC disabled — notify frontend to show "not supported" dialog
			try {
				rpc.send['walletconnect-uri'](wcUri)
				pendingDeepLinkUri = null
			} catch {
				pendingDeepLinkUri = wcUri
			}
		}
	}
	// Bring window to front
	try { mainWindow.focus() } catch {}
}

// Use global Electrobun event emitter — BrowserWindow.on() scopes to window-{id},
// but open-url is an APPLICATION-level event fired by the native URL handler.
Electrobun.events.on("open-url", (e: any) => {
	const url = typeof e === 'string' ? e : e?.data?.url || e?.url || ''
	if (url.startsWith('keepkey://') || url.startsWith('keepkey-vault://')) handleKeepKeyUrl(url)
})

// Cleanup and quit helper — shared between window close and app quit
let quitting = false
function cleanupAndQuit() {
	if (quitting) return
	quitting = true

	// Force-exit safety net — if cleanup blocks (e.g. FFI busy-wait), exit anyway.
	// stopEmulator() below disarms the emulator-owned watchdog.
	setTimeout(() => {
		console.error('[cleanup] Force-exiting after 5s timeout')
		process.exit(1)
	}, 5000).unref?.()

	// Close emulator window + persist flash before exit
	try {
		const { closeEmulatorWindow } = require('./emulator-window')
		closeEmulatorWindow()
	} catch {}
	try {
		const { stopEmulator, getEmulatorStatus } = require('./emulator')
		if (getEmulatorStatus().state === 'running') {
			stopEmulator()
		}
	} catch {}
	// Disconnect WalletConnect sessions so dApps aren't left in stale state.
	// Fire-and-forget — relay WebSocket close is best-effort within the 5s force-exit.
	try { wcManager?.destroy().catch((e: any) => console.warn('[cleanup] WC destroy:', e.message)) } catch {}
	stopSidecar()
	// Flip REST UI-active flag off + flush pubkey/address caches so a late
	// in-flight request during the 5s force-exit window can't leak state.
	try { setUiActive(false, null) } catch {}
	engine.stop()
	restServer?.stop()
	Utils.quit()
}

// Quit the app when the main window is closed
mainWindow.on("close", cleanupAndQuit)

// Explicit Cmd+Q / app terminate handler (Electrobun may not fire window "close")
if (typeof process !== 'undefined') {
	process.on('SIGTERM', cleanupAndQuit)
	process.on('SIGINT', cleanupAndQuit)
}

// Emulator FFI liveness watchdog has moved to ./emulator-watchdog.ts and is
// now armed/disarmed by emulator.ts on init/stop. It no longer runs for
// physical-device flows — a slow button press on an old bootloader is a
// recoverable operation error, not a reason to SIGKILL the whole app.

// ── Start Zcash sidecar only if feature flag is ON ──────────────────
if (zcashPrivacyEnabled) {
	console.log('[zcash] Starting sidecar (feature flag ON)...')
	try {
		await startSidecar()
		console.log('[zcash] Sidecar started successfully, ready:', isSidecarReady())
	} catch (e: any) {
		console.error('[zcash] SIDECAR FAILED TO START:', e.message)
		console.error('[zcash] Zcash shielded features will be unavailable')
	}
} else {
	console.log('[zcash] Sidecar skipped (feature flag OFF)')
}

perf('boot complete')
console.log("KeepKey Vault started!")
