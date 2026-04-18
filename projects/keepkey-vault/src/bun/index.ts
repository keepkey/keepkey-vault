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
	console.error('[Vault] UNHANDLED REJECTION:', reason)
	try { sendFatal('unhandled-rejection', reason) } catch {}
})

import { EngineController, withTimeout } from "./engine-controller"
import { startRestApi, clearFeaturesCache, type RestApiCallbacks } from "./rest-api"
import { AuthStore } from "./auth"
import { getPioneer, getPioneerApiBase, resetPioneer } from "./pioneer"
import { buildTx, broadcastTx } from "./txbuilder"
import { buildCosmosStakingTx } from "./txbuilder/cosmos"
import { initializeOrchardFromDevice, scanOrchardNotes, getShieldedBalance, sendShielded } from "./txbuilder/zcash-shielded"
import { isSidecarReady, startSidecar, stopSidecar, hasFvkLoaded, getCachedFvk, setCachedFvk, onScanProgress, getScanState, updateSyncedTo } from "./zcash-sidecar"
import { CHAINS, customChainToChainDef, isChainSupported } from "../shared/chains"
import { versionCompare } from "../shared/firmware-versions"
import type { ChainDef } from "../shared/chains"
import { BtcAccountManager } from "./btc-accounts"
import { EvmAddressManager, evmAddressPath } from "./evm-addresses"
import { WalletConnectManager } from "./walletconnect"
import { initDb, factoryResetDb, getCustomTokens, addCustomToken as dbAddCustomToken, removeCustomToken as dbRemoveCustomToken, getCustomChains, addCustomChainDb, removeCustomChainDb, getSetting, setSetting, setTokenVisibility as dbSetTokenVisibility, removeTokenVisibility as dbRemoveTokenVisibility, getAllTokenVisibility, insertApiLog, getApiLogs, clearApiLogs, setCachedBalances, getCachedBalances, updateCachedBalance, clearBalances, saveCachedPubkey, getLatestDeviceSnapshot, getCachedPubkeys, saveReport, getReportsList, getReportById, deleteReport, reportExists, getSwapHistory, getSwapHistoryStats, getSwapHistoryByTxid, getBip85Seeds, saveBip85Seed, deleteBip85Seed, clearCachedPubkeys, getRecentActivityFromLog, apiLogTxidExists, updateApiLogTxMeta, getPioneerServers, addPioneerServerDb, removePioneerServerDb } from "./db"
import { generateReport, reportToPdfBuffer, reportToCsv } from "./reports"
import { extractTransactionsFromReport, toCoinTrackerCsv, toZenLedgerCsv } from "./tax-export"
import * as os from "os"
import * as path from "path"
import { EVM_RPC_URLS, getTokenMetadata, broadcastEvmTx } from "./evm-rpc"
import type { ChainBalance, TokenBalance, CustomToken, SigningRequestInfo, ApiLogEntry, PioneerChainInfo, EvmAddressSet, Bip85SeedMeta, StakingPosition } from "../shared/types"
import type { VaultRPCSchema } from "../shared/rpc-schema"

// L3 fix: withTimeout imported from engine-controller (was duplicated here)
const PIONEER_TIMEOUT_MS = 60_000

// ── Desktop update — open GitHub releases page ──
// In-app auto-update is unreliable on both platforms:
// - macOS: zig-zstd has different CLI flags than zstd, stock macOS has no zstd
// - Windows: in-app exe download + spawn had process lock issues
// Both platforms now open the GitHub releases page for manual download.
const GITHUB_REPO = 'keepkey/keepkey-vault'
// Cached version from pre-release GitHub check (Updater.updateInfo() doesn't have it)
let pendingUpdateVersion: string | null = null

function openReleasePage() {
	const version = pendingUpdateVersion || Updater.updateInfo()?.version
	const url = version
		? `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`
		: `https://github.com/${GITHUB_REPO}/releases`
	console.log(`[Update] Opening releases page: ${url}`)
	const cmd = process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['open', url]
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
let swapsEnabled = false
let bip85Enabled = false
let zcashPrivacyEnabled = false
let preReleaseUpdates = false
let alphaFirmware = false

function loadSettings() {
	restApiEnabled = getSetting('rest_api_enabled') === '1'
	walletConnectEnabled = getSetting('walletconnect_enabled') === '1'
	swapsEnabled = getSetting('swaps_enabled') === '1'
	bip85Enabled = getSetting('bip85_enabled') === '1'
	zcashPrivacyEnabled = getSetting('zcash_privacy_enabled') === '1'
	preReleaseUpdates = getSetting('pre_release_updates') === '1'
	alphaFirmware = getSetting('alpha_firmware') === '1'
}
let appVersionCache = ''
let restServer: ReturnType<typeof startRestApi> | null = null
// WalletConnect manager — lazily initialized when user pairs
let wcManager: WalletConnectManager | null = null
function getOrCreateWcManager(): WalletConnectManager {
	if (wcManager) return wcManager
	wcManager = new WalletConnectManager({
		getEvmAddressInfo: () => {
			const sel = evmAddresses.getSelectedAddress()
			return sel ? { address: sel.address, addressIndex: sel.addressIndex } : null
		},
		ethSignTx: (params) => { if (!engine.wallet) throw new Error('Device disconnected'); return engine.wallet.ethSignTx(params) },
		ethSignMessage: (params) => { if (!engine.wallet) throw new Error('Device disconnected'); return engine.wallet.ethSignMessage(params) },
		ethSignTypedData: (params) => { if (!engine.wallet) throw new Error('Device disconnected'); return engine.wallet.ethSignTypedData(params) },
		requestSigningApproval: async (info) => {
			try { rpc.send['signing-request'](info) } catch { /* webview not ready */ }
			try {
				mainWindow.setAlwaysOnTop(true)
				mainWindow.focus()
			} catch { /* window not ready */ }
			try {
				return await auth.requestSigningApproval(info.id)
			} finally {
				try { mainWindow.setAlwaysOnTop(false) } catch {}
			}
		},
		dismissSigning: (id) => {
			try { rpc.send['signing-dismissed']({ id }) } catch {}
		},
		log: (msg) => console.log(msg),
		onSessionsChanged: (sessions) => {
			try { rpc.send['wc-sessions'](sessions) } catch {}
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
		swapsEnabled,
		bip85Enabled,
		zcashPrivacyEnabled,
		preReleaseUpdates,
		alphaFirmware,
	}
}

// Callbacks bridge REST → RPC UI
const restCallbacks: RestApiCallbacks = {
	onApiLog: (entry: ApiLogEntry) => {
		try { rpc.send['api-log'](entry) } catch { /* webview not ready */ }
		// PRIVACY: Don't persist API activity from passphrase wallets to disk.
		if (!engine.isPassphraseWallet) {
			try { insertApiLog(entry) } catch { /* db not ready */ }
		}
	},
	onSigningRequest: async (info: SigningRequestInfo) => {
		try { rpc.send['signing-request'](info) } catch { /* webview not ready */ }
		// Bring window to front so user sees the approval prompt immediately
		try {
			mainWindow.setAlwaysOnTop(true)
			mainWindow.focus()
		} catch { /* window not ready */ }
		try {
			return await auth.requestSigningApproval(info.id)
		} finally {
			// Restore normal window level after user responds (or timeout)
			try { mainWindow.setAlwaysOnTop(false) } catch { /* ignore */ }
		}
	},
	onSigningDismissed: (id: string) => {
		try { rpc.send['signing-dismissed']({ id }) } catch { /* webview not ready */ }
	},
	onPairRequest: (info) => {
		try { rpc.send['pair-request'](info) } catch { /* webview not ready */ }
		// Bring window to front so user sees the pairing approval prompt
		try {
			mainWindow.setAlwaysOnTop(true)
			mainWindow.focus()
		} catch { /* window not ready */ }
	},
	onPairDismissed: () => {
		// Restore normal window level + dismiss frontend overlay (covers timeout case)
		try { mainWindow.setAlwaysOnTop(false) } catch { /* ignore */ }
		try { rpc.send['pair-dismissed']({}) } catch { /* webview not ready */ }
	},
	getVersion: () => appVersionCache,
	emuSigningOp: (fn, details) => emuSigningOp(fn, details),
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
import type { SwapQuote } from '../shared/types'
const swapQuoteCache = new Map<string, SwapQuote>()

// ── Emulator confirm helper ──────────────────────────────────────────
// Wraps any operation that triggers firmware confirm_helper() (blocking C loop).
//
// The key challenge: multi-chunk messages (e.g. LoadDevice with a real mnemonic)
// span 2+ HID packets. If BA+DLD are pre-written to rb_main_in before all chunks
// are consumed, usb_rx_helper treats BA as a continuation chunk → corruption.
//
// Solution (proven in test harness — 17/17 pass):
// 1. Pause poll, start the operation (transport writes N chunks)
// 2. Poll (N-1) times to consume all chunks except the last
// 3. Write BA+DLD to ring buffers
// 4. Poll once — firmware reads last chunk, assembles, dispatches,
//    enters confirm_helper, finds BA+DLD → exits immediately
// 5. Resume poll for transport to read the response
async function emuConfirmOp(fn: () => Promise<any>, confirmCount = 2): Promise<any> {
	const { pausePoll, resumePoll, saveEmulatorState, emuPollOnce, flushRingBuffers } = await import('./emulator')
	const { prewriteConfirmations } = await import('./emulator-transport')

	// Get the transport delegate for chunk counting
	const delegate = engine.emuDelegate
	if (delegate) delegate.chunkCount = 0

	pausePoll()

	try {
		const promise = fn()
		await new Promise(r => setTimeout(r, 30)) // let transport write all chunks

		const numChunks = delegate?.chunkCount || 1
		console.log(`[emuConfirmOp] ${numChunks} chunks written, polling ${numChunks - 1} pre-polls`)

		// Consume all chunks except the last
		for (let i = 0; i < numChunks - 1; i++) {
			emuPollOnce()
		}

		// Pre-write all confirmations then poll once. Both BA+DLD go to iface 1
		// (same FIFO) so confirm_helper reads them in order without starvation.
		prewriteConfirmations(confirmCount)
		emuPollOnce()

		// Resume poll BEFORE awaiting — readChunk needs kkemu_poll() running
		// to deliver the firmware response.
		resumePoll()

		const result = await promise
		flushRingBuffers() // drain any unused pre-written confirmations
		saveEmulatorState()
		return result
	} finally {
		resumePoll() // idempotent — ensures poll is always restored
	}
}

// ── Emulator interactive signing helper ─────────────────────────────
// Wraps signing/address-display operations that need user confirmation
// on the emulator window. Setup ops (loadDevice, wipe) keep using
// emuConfirmOp for auto-confirm.
async function emuSigningOp(
	fn: () => Promise<any>,
	details: { operation: string; chain?: string; to?: string; value?: string; memo?: string },
): Promise<any> {
	const { emuInteractiveConfirm } = await import('./emulator-window')
	return emuInteractiveConfirm(fn, details, engine.emuDelegate)
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
					// Save mnemonic FIRST — connectEmulator's auto-reload (stale
					// storage key recovery) will pick up the NEW seed instead of
					// the previously saved one.
					if (params.mnemonic) {
						const { saveMnemonic } = await import('./emulator-keychain')
						const { getActiveFlashName } = await import('./emulator')
						console.log('[Vault] Saving new mnemonic before load (flash=%s)', getActiveFlashName())
						saveMnemonic(getActiveFlashName(), params.mnemonic)
					}

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

					// Verify the firmware actually holds the mnemonic we loaded
					if (params.mnemonic) {
						const actual = await engine.getEmulatorMnemonic()
						if (!actual) {
							console.error('[Vault] SEED VERIFY FAIL — firmware returned no mnemonic via DebugLink')
						} else if (actual.trim() !== params.mnemonic.trim()) {
							console.error('[Vault] SEED VERIFY FAIL — firmware mnemonic does NOT match loaded seed')
							console.error('[Vault]   expected first word: %s', params.mnemonic.trim().split(/\s+/)[0])
							console.error('[Vault]   actual first word:   %s', actual.trim().split(/\s+/)[0])
						} else {
							console.log('[Vault] SEED VERIFY OK — firmware mnemonic matches loaded seed')
						}
					}
					return
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
				await engine.wallet.applyPolicy({ policyName: params.policyName, enabled: params.enabled })
				clearFeaturesCache()
			},
			ping: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.ping({ msg: params.msg || 'pong', passphrase: false })
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
				const result = (engine.isEmulator && params.showDisplay)
					? await emuSigningOp(() => engine.wallet!.btcGetAddress(params), { operation: 'btcGetAddress', chain: 'Bitcoin' })
					: await engine.wallet.btcGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('bitcoin', JSON.stringify(params.addressNList || []), addr)
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
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.btcSignTx(params),
					{ operation: 'btcSignTx', chain: 'Bitcoin', to: params.outputs?.[0]?.address, value: params.outputs?.[0]?.amount },
				)
				return await engine.wallet.btcSignTx(params)
			},
			ethSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.ethSignTx(params),
					{ operation: 'ethSignTx', chain: 'Ethereum', to: params.to, value: params.value },
				)
				return await engine.wallet.ethSignTx(params)
			},
			ethSignMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.ethSignMessage(params),
					{ operation: 'ethSignMessage', chain: 'Ethereum', memo: params.message?.toString()?.slice(0, 64) },
				)
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
				return await engine.wallet.ethVerifyMessage(params)
			},
			cosmosSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.cosmosSignTx(params),
					{ operation: 'cosmosSignTx', chain: 'Cosmos' },
				)
				return await engine.wallet.cosmosSignTx(params)
			},
			thorchainSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.thorchainSignTx(params),
					{ operation: 'thorchainSignTx', chain: 'THORChain' },
				)
				return await engine.wallet.thorchainSignTx(params)
			},
			mayachainSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.mayachainSignTx(params),
					{ operation: 'mayachainSignTx', chain: 'Maya' },
				)
				return await engine.wallet.mayachainSignTx(params)
			},
			osmosisSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.osmosisSignTx(params),
					{ operation: 'osmosisSignTx', chain: 'Osmosis' },
				)
				return await engine.wallet.osmosisSignTx(params)
			},
			xrpSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				if (engine.isEmulator) return emuSigningOp(
					() => engine.wallet!.rippleSignTx(params),
					{ operation: 'xrpSignTx', chain: 'XRP' },
				)
				return await engine.wallet.rippleSignTx(params)
			},
			solanaSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')

				console.debug(`[solanaSignTx] RPC call received`)

				// Pioneer returns full serialized tx: [compact-u16:sigCount][sig0(64)]...[sigN(64)][message]
				// Firmware expects just the message bytes for parsing and signing.
				// Extract message portion before sending to device.
				let deviceParams = params
				if (params.rawTx) {
					const fullTx = Buffer.from(
						typeof params.rawTx === 'string' ? params.rawTx : Buffer.from(params.rawTx).toString('base64'),
						'base64',
					)
					// Read compact-u16 signature count
					let pos = 0
					let sigCount = 0
					if (fullTx[0] < 0x80) {
						sigCount = fullTx[0]; pos = 1
					} else if (fullTx.length >= 2 && fullTx[1] < 0x80) {
						sigCount = (fullTx[0] & 0x7f) | (fullTx[1] << 7); pos = 2
					} else if (fullTx.length >= 3) {
						sigCount = (fullTx[0] & 0x7f) | ((fullTx[1] & 0x7f) << 7) | (fullTx[2] << 14); pos = 3
					}
					// Solana transactions have at most ~20 signers; reject clearly malformed data
					if (sigCount > 127) {
						throw new Error(`[solanaSignTx] Unreasonable signature count (${sigCount}) — malformed transaction`)
					}
					const messageStart = pos + sigCount * 64
					console.debug(`[solanaSignTx] fullTx=${fullTx.length}B sigCount=${sigCount} messageStart=${messageStart}`)
					if (sigCount > 0 && messageStart < fullTx.length) {
						const messageBytes = fullTx.subarray(messageStart)
						deviceParams = { ...params, rawTx: Buffer.from(messageBytes).toString('base64') }
						console.debug(`[solanaSignTx] Extracted message: ${messageBytes.length}B (stripped ${sigCount} dummy sigs)`)
					}
				}

				console.debug(`[solanaSignTx] Calling hdwallet.solanaSignTx`)
				const result = engine.isEmulator
					? await emuSigningOp(() => engine.wallet!.solanaSignTx(deviceParams), { operation: 'solanaSignTx', chain: 'Solana' })
					: await engine.wallet.solanaSignTx(deviceParams)

				console.debug(`[solanaSignTx] hdwallet result: hasSig=${!!result?.signature} sigLen=${result?.signature?.length || 0}`)

				// Assemble signed tx: replace the 64-byte dummy signature in rawTx with real signature
				if (result?.signature && params.rawTx) {
					const rawBytes = Buffer.from(
						typeof params.rawTx === 'string' ? params.rawTx : Buffer.from(params.rawTx).toString('base64'),
						'base64',
					)
					const sigBytes = result.signature instanceof Uint8Array
						? result.signature
						: Buffer.from(result.signature, 'base64')
					// Full tx format: [1 byte sig_count] [64 bytes dummy sig] [message...]
					// Replace bytes 1-64 with real signature
					if (rawBytes.length > 65 && sigBytes.length === 64) {
						sigBytes.forEach((b: number, i: number) => { rawBytes[1 + i] = b })
						const assembled = rawBytes.toString('base64')
						console.debug(`[solanaSignTx] Assembled signed tx: ${rawBytes.length}B`)
						return { signature: result.signature, serializedTx: assembled }
					} else {
						console.debug(`[solanaSignTx] Cannot assemble: rawBytes=${rawBytes.length}B sigBytes=${sigBytes.length}B`)
					}
				}
				return result
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

			// ── Pioneer integration (batch portfolio API) ────────────────
			getBalances: async () => {
				if (!engine.wallet) throw new Error('No device connected')

				// Initialize Pioneer client — isolate failure so device derivation still works
				let pioneer: any = null
				try {
					pioneer = await getPioneer()
				} catch (e: any) {
					console.warn('[getBalances] Pioneer init failed (will return zero balances):', e.message)
					// Notify UI so user can change server or get support
					try { rpc.send['pioneer-error']({ message: e.message, url: getPioneerApiBase() }) } catch { /* webview not ready */ }
				}

				const wallet = engine.wallet as any

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
					return true
				})
				const utxoChains = allChains.filter(c => c.chainFamily === 'utxo' && c.id !== 'bitcoin')
				const nonUtxoChains = allChains.filter(c => c.chainFamily !== 'utxo')

				// 1. Batch-fetch non-BTC UTXO xpubs in a single device call.
				// LTC supports multiple script types (p2pkh, p2sh-p2wpkh, p2wpkh) — derive
				// all so Pioneer reports balances from every address type.
				const utxoPubKeyPaths: Array<{ chain: typeof utxoChains[0]; scriptType: string; path: number[] }> = []
				for (const c of utxoChains) {
					const scriptTypes = c.id === 'litecoin'
						? [{ scriptType: 'p2pkh', purpose: 44 }, { scriptType: 'p2sh-p2wpkh', purpose: 49 }, { scriptType: 'p2wpkh', purpose: 84 }]
						: [{ scriptType: c.scriptType || 'p2pkh', purpose: 44 }]
					for (const st of scriptTypes) {
						utxoPubKeyPaths.push({
							chain: c,
							scriptType: st.scriptType,
							path: [st.purpose + 0x80000000, c.defaultPath[1], 0x80000000],
						})
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

				// Reset EVM balances before aggregation
				evmAddresses.resetBalances()

				// Add N addresses × M EVM chains to pubkeys
				const evmPubkeyEntries = evmAddresses.getAllPubkeyEntries(evmChains)
				const evmAddressSet = new Set(evmAddresses.toAddressSet().addresses.map(a => a.address.toLowerCase()))
				for (const entry of evmPubkeyEntries) {
					pubkeys.push({ caip: entry.caip, pubkey: entry.pubkey, chainId: entry.chainId, symbol: entry.symbol, networkId: entry.networkId })
				}

				// Non-EVM, non-UTXO chains (cosmos, xrp, etc.) — skip hidden chains (e.g. zcash-shielded has dedicated RPC)
				for (const chain of nonEvmChains) {
					if (chain.hidden) continue
					try {
						const addrParams: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.coin }
						if (chain.scriptType) addrParams.scriptType = chain.scriptType
						// TON: always non-bounceable (UQ) — bounceable (EQ) bounces if wallet uninitialized
						if (chain.chainFamily === 'ton') addrParams.bounceable = false
						const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
						const result = await wallet[method](addrParams)
						const address = typeof result === 'string' ? result : result?.address || ''
						if (address) {
							pubkeys.push({ caip: chain.caip, pubkey: address, chainId: chain.id, symbol: chain.symbol, networkId: chain.networkId })
							if (chain.id === 'tron') console.log(`[getBalances] TRON address derived: ${address}, caip: ${chain.caip}, networkId: ${chain.networkId}`)
						} else {
							if (chain.id === 'tron') console.warn(`[getBalances] TRON address derivation returned empty! result:`, JSON.stringify(result))
						}
					} catch (e: any) {
						console.warn(`[getBalances] ${chain.coin} address failed:`, e.message)
					}
				}

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

				console.log(`[getBalances] ${pubkeys.length} pubkeys (${btcPubkeyEntries.length} BTC xpubs) → single GetPortfolioBalances call`)

				// Build networkId → chainId lookup for token grouping (lowercase keys — Pioneer may return different casing)
				const networkToChain = new Map<string, string>()
				for (const chain of allChains) {
					if (!chain.networkId) continue
					// Non-hidden chains take priority (zcash vs zcash-shielded share the same networkId)
					if (chain.hidden && networkToChain.has(chain.networkId.toLowerCase())) continue
					networkToChain.set(chain.networkId.toLowerCase(), chain.id)
				}

				// 3. Single API call — GetPortfolioBalances returns natives + tokens in one flat array
				const results: ChainBalance[] = []
				try {
					if (!pioneer) throw new Error('Pioneer client not available')
					const resp = await withTimeout(
						pioneer.GetPortfolioBalances(
							{ pubkeys: pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey })) },
							{ forceRefresh: true }
						),
						PIONEER_TIMEOUT_MS,
						'GetPortfolioBalances'
					)
					// Unwrap: { data: { balances: [...] } } or { data: [...] }
					const rawData = resp?.data?.data || resp?.data || {}
					const allEntries: any[] = rawData.balances || (Array.isArray(rawData) ? rawData : [])

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
					let tokensSkippedZero = 0, tokensSkippedNoChain = 0, tokensGrouped = 0
					for (const tok of tokenEntries) {
						const bal = parseFloat(String(tok.balance ?? '0'))
						if (bal <= 0) { tokensSkippedZero++; continue }

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
						const contractMatch = (tok.caip || '').match(/\/(erc20|spl|trc20|token):([^\s]+)/)
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
						tokensGrouped++
					}

					console.debug(`[getBalances] Token grouping: ${tokensGrouped} grouped, ${tokensSkippedZero} skipped (zero bal), ${tokensSkippedNoChain} DROPPED (no parent chain)`)

					// Merge user-added custom tokens as placeholders
					try {
						const customTokens = getCustomTokens()
						for (const ct of customTokens) {
							const existing = tokensByChainId.get(ct.chainId) || []
							// Skip if Pioneer already returned this token
							if (existing.some(t => t.contractAddress?.toLowerCase() === ct.contractAddress.toLowerCase())) continue
							existing.push({
								symbol: ct.symbol, name: ct.name, balance: '0', balanceUsd: 0, priceUsd: 0,
								caip: `${ct.networkId}/erc20:${ct.contractAddress}`,
								contractAddress: ct.contractAddress, networkId: ct.networkId, decimals: ct.decimals, type: 'token',
							})
							tokensByChainId.set(ct.chainId, existing)
						}
					} catch { /* custom tokens lookup failed, non-fatal */ }

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
							const xpubBal = String(match?.balance ?? '0')
							btcAccounts.updateXpubBalance(entry.pubkey, xpubBal, usd)
							try {
								const devId = engine.getDeviceState().deviceId
								if (devId && !engine.isPassphraseWallet) saveCachedPubkey(devId, 'bitcoin', entry.pubkey, entry.pubkey, match?.address || '', '', xpubBal, usd)
							} catch { /* non-fatal */ }
							continue
						}

						// EVM multi-address: aggregate per-chain, update per-address balance
						if (evmAddressSet.has(entry.pubkey.toLowerCase())) {
							const match = pureNatives.find((d: any) => d.caip === entry.caip && d.pubkey === entry.pubkey)
								|| pureNatives.find((d: any) => d.caip === entry.caip && d.address?.toLowerCase() === entry.pubkey.toLowerCase())
							const bal = parseFloat(String(match?.balance ?? '0'))
							const usd = Number(match?.valueUsd ?? 0)
							// Accumulate per-address USD for EvmAddressManager
							if (usd > 0) evmAddresses.updateAddressBalance(entry.pubkey, usd)
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
						results.push({
							chainId,
							symbol: agg.symbol,
							balance: agg.balance > 0 ? agg.balance.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') : '0',
							balanceUsd: agg.usd + tokenUsdTotal,
							nativeBalanceUsd: agg.usd,
							address: agg.address,
							tokens: chainTokens && chainTokens.length > 0 ? chainTokens : undefined,
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


					// Push updated BTC accounts to frontend
					try { rpc.send['btc-accounts-update'](btcAccounts.toAccountSet()) } catch { /* webview not ready */ }
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

					// Cache balances (fire-and-forget) — only on successful Pioneer response.
					// PRIVACY: Skip for passphrase wallets (hidden wallet data must not hit disk).
					try {
						const deviceId = engine.getDeviceState().deviceId || 'unknown'
						if (results.length > 0 && !engine.isPassphraseWallet) setCachedBalances(deviceId, results)
					} catch { /* never block on cache failure */ }
				} catch (e: any) {
					console.warn('[getBalances] Portfolio API failed:', e.message)
					const seen = new Set<string>()
					for (const entry of pubkeys) {
						// Deduplicate BTC entries in fallback
						if (seen.has(entry.chainId)) continue
						seen.add(entry.chainId)
						results.push({ chainId: entry.chainId, symbol: entry.symbol, balance: '0', balanceUsd: 0, address: entry.pubkey })
					}
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

				return results
			},

			getBalance: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				const pioneer = await getPioneer()
				const wallet = engine.wallet as any

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

				// Single portfolio call with all pubkeys for this chain
				const isBtc = chain.id === 'bitcoin'
				const isEvm = chain.chainFamily === 'evm'
				const isUtxo = chain.chainFamily === 'utxo'
				let balance = '0', balanceUsd = 0, address = displayAddress
				let tokens: TokenBalance[] | undefined
				// Snapshot pre-refresh address from cache so we can preserve it on Pioneer failure (Finding 3)
				let cachedAddress = ''
				try {
					const devId = engine.getDeviceState().deviceId
					if (devId) {
						const cached = getCachedBalances(devId)
						cachedAddress = cached?.balances.find(b => b.chainId === chain.id)?.address || ''
					}
				} catch { /* cache lookup failed, non-fatal */ }

				// Reset per-address balances for this refresh (mirrors getBalances line 991)
				if (isEvm) evmAddresses.resetBalances()

				try {
					const resp = await withTimeout(
						pioneer.GetPortfolioBalances(
							{ pubkeys: pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey })) },
							{ forceRefresh: true }
						),
						PIONEER_TIMEOUT_MS,
						'GetPortfolioBalances'
					)
					const rawData = resp?.data?.data || resp?.data || {}
					const allEntries: any[] = rawData.balances || (Array.isArray(rawData) ? rawData : [])

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

					for (const pk of pubkeys) {
						// Find ONE matching native entry for this requested pubkey (no double-counting)
						const match = pureNatives.find((d: any) => d.pubkey === pk.pubkey)
							|| pureNatives.find((d: any) => d.caip === pk.caip && d.address === pk.pubkey)
							|| pureNatives.find((d: any) => d.address?.toLowerCase() === pk.pubkey.toLowerCase())
						const bal = parseFloat(String(match?.balance ?? '0'))
						const usd = Number(match?.valueUsd ?? 0)
						nativeTotalBalance += bal
						nativeTotalUsd += usd

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
						} else if (isEvm && usd > 0) {
							evmAddresses.updateAddressBalance(pk.pubkey, usd)
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
					if (tokenEntries.length > 0) {
						const parsedTokens: TokenBalance[] = []
						for (const tok of tokenEntries) {
							const bal = parseFloat(String(tok.balance ?? '0'))
							if (bal <= 0) continue
							const contractMatch = (tok.caip || '').match(/\/(erc20|spl|trc20|token):([^\s]+)/)
							const contractAddress = contractMatch?.[2] || tok.contract || undefined
							parsedTokens.push({
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
							})
						}

						// Merge user-added custom tokens as placeholders
						try {
							const customTokens = getCustomTokens().filter(ct => ct.chainId === chain.id)
							for (const ct of customTokens) {
								if (parsedTokens.some(t => t.contractAddress?.toLowerCase() === ct.contractAddress.toLowerCase())) continue
								parsedTokens.push({
									symbol: ct.symbol, name: ct.name, balance: '0', balanceUsd: 0, priceUsd: 0,
									caip: `${ct.networkId}/erc20:${ct.contractAddress}`,
									contractAddress: ct.contractAddress, networkId: ct.networkId, decimals: ct.decimals, type: 'token',
								})
							}
						} catch { /* custom tokens lookup failed, non-fatal */ }

						if (parsedTokens.length > 0) {
							tokens = parsedTokens
							const tokenUsdTotal = parsedTokens.reduce((sum, t) => sum + t.balanceUsd, 0)
							balanceUsd += tokenUsdTotal
						}
						console.log(`[getBalance] ${chain.coin}: ${parsedTokens.length} tokens, $${balanceUsd.toFixed(2)} total`)
					}
				} catch (e: any) {
					console.warn(`[getBalance] ${chain.coin} portfolio failed:`, e.message)
				}
				// If Pioneer failed or returned no address, preserve the cached address
				// so we don't wipe a previously good address from the shared cache (Finding 3)
				if (!address && cachedAddress) address = cachedAddress
				const nativeBalanceUsd = Number(balanceUsd) - (tokens?.reduce((s, t) => s + (t.balanceUsd || 0), 0) || 0)
				const result: ChainBalance = { chainId: chain.id, symbol: chain.symbol, balance, balanceUsd, nativeBalanceUsd, address, tokens }

				// Update single-chain cache + push to frontend so Dashboard stays in sync.
				// PRIVACY: Skip DB write for passphrase wallets.
				try {
					const deviceId = engine.getDeviceState().deviceId || 'unknown'
					if (!engine.isPassphraseWallet) updateCachedBalance(deviceId, result)
				} catch { /* never block on cache failure */ }
				try { rpc.send['balance-updated'](result) } catch { /* webview not ready */ }
				// Push updated EVM per-address balances so address selector stays current
				if (isEvm) {
					try { rpc.send['evm-addresses-update'](evmAddresses.toAddressSet()) } catch { /* webview not ready */ }
				}
				// Push updated BTC per-xpub balances — only if manager is hydrated (Finding 2)
				if (isBtc && btcAccounts.isInitialized && btcAccounts.getAllPubkeyEntries(chain.caip).length > 0) {
					try { rpc.send['btc-accounts-update'](btcAccounts.toAccountSet()) } catch { /* webview not ready */ }
				}

				return result
			},

			buildTx: async (params) => {
				console.debug(`[buildTx] isMax=${params.isMax} chainId=${params.chainId}`)
				if (!engine.wallet) throw new Error('No device connected')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				const pioneer = await getPioneer()

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
					fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
					console.debug(`[buildTx] Derived ${chain.coin} address OK`)
				} else if (chain.id === 'bitcoin') {
					// BTC multi-account: resolve xpub, scriptType, and accountPath from the
					// override string itself (not from getSelectedXpub(), which can drift
					// between render and RPC handling). Finding 5 fix.
					const resolvedXpub = params.xpubOverride || btcAccounts.getSelectedXpub()?.xpub
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
				const logEntry: ApiLogEntry = { method: 'RPC', route: 'broadcastTx', timestamp: Date.now(), durationMs: 0, status: 200, appName: 'vault', txid: result.txid, chain: chain.symbol, activityType: 'broadcast' }
				if (!engine.isPassphraseWallet) insertApiLog(logEntry)
				try { rpc.send['api-log'](logEntry) } catch { /* webview not ready */ }

				return result
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

			// ── Bitcoin multi-account ─────────────────────────────────
			getBtcAccounts: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				if (!btcAccounts.isInitialized) {
					await btcAccounts.initialize(engine.wallet as any)
				}
				// Hydrate per-xpub balances from DB cache (so pills show values on first load)
				const devId = engine.getDeviceState().deviceId
				if (devId) {
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
					const resp = await withTimeout(pioneer.GetPubkeyInfo({ network: 'BTC', xpub }), PIONEER_TIMEOUT_MS, 'GetPubkeyInfo')
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
				if (!evmAddresses.isInitialized) {
					await evmAddresses.initialize(engine.wallet as any)
				}
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
				if (!chain.chainId) throw new Error('Chain has no EVM chainId')
				const rpcUrl = getRpcUrl(chain) || EVM_RPC_URLS[chain.chainId]
				if (!rpcUrl) throw new Error(`No RPC URL for chain ${chain.coin}`)
				const addr = params.contractAddress.trim()
				if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('Invalid contract address')
				const meta = await getTokenMetadata(rpcUrl, addr)
				const token: CustomToken = {
					chainId: params.chainId,
					contractAddress: addr,
					symbol: meta.symbol,
					name: meta.name,
					decimals: meta.decimals,
					networkId: chain.networkId,
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
			},
			removeTokenVisibility: async (params) => {
				const caip = params.caip?.trim()
				if (!caip) throw new Error('caip required')
				dbRemoveTokenVisibility(caip)
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
				const result = {
					ready: sidecarReady,
					fvk_loaded: fvkLoaded,
					address: cached?.address ?? null,
					fvk: cached?.fvk ?? null,
					synced_to: scanState.syncedTo,
					keepkey_release_block: scanState.releaseBlock,
				}
				console.log(`[zcash] zcashShieldedStatus → ready=${result.ready} fvk=${fvkLoaded} synced_to=${scanState.syncedTo} addr=${cached?.address?.slice(0, 20) ?? 'none'}`)
				return result
			},
			zcashShieldedInit: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				// If FVK is already loaded from DB, return it immediately
				const cached = getCachedFvk()
				if (cached) return cached
				// Otherwise get from device
				if (!engine.wallet) throw new Error('No device connected')
				const result = await initializeOrchardFromDevice(engine.wallet as any, params?.account ?? 0)
				setCachedFvk(result.address, result.fvk)
				return result
			},
			zcashShieldedScan: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				const result = await scanOrchardNotes(params?.startHeight, params?.fullRescan)
				if (result?.synced_to != null) updateSyncedTo(result.synced_to)
				return result
			},
			zcashShieldedBalance: async () => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				return await getShieldedBalance()
			},
			zcashShieldedSend: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				// FVK already loaded means device supports Orchard — skip version check
				// (version string may not be populated yet at call time)
				return await sendShielded(engine.wallet as any, {
					recipient: params.recipient,
					amount: params.amount,
					memo: params.memo,
				})
			},
			zcashShieldZec: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				// Transparent shielding uses standard ECDSA (secp256k1) for transparent inputs
				// + Orchard RedPallas for the shielded output. The ECDSA part works on any
				// firmware; the Orchard part needs >= 7.14.0 (checked by zcashShieldedInit).
				const zcashDef = CHAINS.find(c => c.id === 'zcash-shielded')
				if (!zcashDef) {
					throw new Error('Zcash shielded chain definition not found')
				}
				const { shieldZec } = await import("./txbuilder/zcash-shield")
				const pioneer = await getPioneer()
				try { rpc.send['shield-progress']({ step: 'building' }) } catch { /* webview not ready */ }
				const result = await shieldZec(engine.wallet as any, pioneer, {
					amount: params.amount,
					account: params.account,
				})
				try { rpc.send['shield-progress']({ step: 'complete', detail: result.txid }) } catch { /* webview not ready */ }
				return result
			},

			zcashDeshieldZec: async (params) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				const { deshieldZec } = await import("./txbuilder/zcash-deshield")
				try { rpc.send['deshield-progress']({ step: 'building' }) } catch { /* webview not ready */ }
				const result = await deshieldZec(engine.wallet as any, {
					recipient: params.recipient,
					amount: params.amount,
					account: params.account,
				})
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

			zcashDiagnoseAnchor: async (params: any) => {
				if (!zcashPrivacyEnabled) throw new Error('Zcash privacy feature is disabled')
				const { diagnoseAnchor } = await import("./zcash-sidecar")
				return await diagnoseAnchor(params?.shardIndex)
			},

			// ── Pairing & Signing approval ───────────────────────────
			approvePairing: async () => {
				const apiKey = auth.approvePairing()
				if (!apiKey) throw new Error('No pending pairing request')
				try { mainWindow.setAlwaysOnTop(false) } catch { /* ignore */ }
				return { apiKey }
			},
			rejectPairing: async () => {
				auth.rejectPairing()
				try { mainWindow.setAlwaysOnTop(false) } catch { /* ignore */ }
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

			// ── App Settings ─────────────────────────────────────────
			getAppSettings: async () => {
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
			setSwapsEnabled: async (params) => {
				swapsEnabled = params.enabled
				setSetting('swaps_enabled', params.enabled ? '1' : '0')
				console.log('[settings] Swaps enabled:', params.enabled)
				// Initialize tracker on-demand when user enables swaps mid-session
				if (params.enabled) {
					import('./swap-tracker').then(async ({ initSwapTracker }) => {
						await initSwapTracker((msg: string, data: any) => {
							try {
								if (msg === 'swap-update') rpc.send['swap-update'](data)
								else if (msg === 'swap-complete') rpc.send['swap-complete'](data)
								else console.error(`[swap-tracker] Unknown message: ${msg}`)
							} catch (e: any) {
								console.warn(`[swap-tracker] Failed to send '${msg}':`, e.message)
							}
						})
					}).catch((e) => {
						console.error('[swap-tracker] Failed to initialize swap tracker:', e.message || e)
					})
				}
				return getAppSettings()
			},
			setBip85Enabled: async (params) => {
				// BIP-85 requires firmware >= 7.15.0
				const fwVer = engine.getDeviceState().firmwareVersion
				if (params.enabled && (!fwVer || versionCompare(fwVer, '7.15.0') < 0)) {
					console.warn(`[settings] BIP-85 blocked — firmware ${fwVer || 'unknown'} < 7.15.0`)
					return getAppSettings()
				}
				bip85Enabled = params.enabled
				setSetting('bip85_enabled', params.enabled ? '1' : '0')
				console.log('[settings] BIP-85 enabled:', params.enabled)
				return getAppSettings()
			},
			setZcashPrivacyEnabled: async (params) => {
				// Zcash shielded requires firmware >= 7.14.0
				const fwVer = engine.getDeviceState().firmwareVersion
				if (params.enabled && (!fwVer || versionCompare(fwVer, '7.14.0') < 0)) {
					console.warn(`[settings] Zcash privacy blocked — firmware ${fwVer || 'unknown'} < 7.14.0`)
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
				// Find the default server — if switching to default, clear the override
				const defaultServer = servers.find(s => s.isDefault)
				if (defaultServer && defaultServer.url === url) {
					setSetting('pioneer_api_base', '')
				} else {
					setSetting('pioneer_api_base', url)
				}
				resetPioneer()
				chainCatalog = []
				catalogLoadedAt = 0
				console.log('[settings] Active Pioneer server set to:', url)
				return getAppSettings()
			},

			// ── API Audit Log ────────────────────────────────────────
			getApiLogs: async (params) => {
				// PRIVACY: Don't expose standard-wallet activity logs during hidden sessions.
				if (engine.isPassphraseWallet) return []
				return getApiLogs(params?.limit ?? 200, params?.offset ?? 0)
			},
			clearApiLogs: async () => {
				clearApiLogs()
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
				if (!swapsEnabled) return []
				const { getSwapAssets } = await import('./swap')
				const assets = await getSwapAssets()
				// Deduplicate: return unique chain IDs that have at least one native (non-token) asset
				const chainIds = new Set(assets.filter(a => !a.contractAddress).map(a => a.chainId))
				return [...chainIds]
			},
			getSwapAssets: async () => {
				if (!swapsEnabled) return []
				const { getSwapAssets } = await import('./swap')
				return await getSwapAssets()
			},
			getSwapQuote: async (params) => {
				if (!swapsEnabled) throw new Error('Swaps feature is disabled')
				const { getSwapQuote, THOR_TO_CHAIN, parseThorAsset } = await import('./swap')

				// Resolve xpub addresses to real receive addresses for UTXO chains.
				// ChainBalance.address can be an xpub when Pioneer doesn't return
				// an address field — THORChain rejects xpubs as destination addresses.
				// Detect extended pubkeys: xpub/ypub/zpub (BTC), dgub (DOGE), Ltub/Mtub (LTC), drkp (DASH), tpub (testnet)
				const isXpub = (addr: string) => /^(xpub|ypub|zpub|dgub|Ltub|Mtub|drkp|drks|tpub|upub|vpub)/.test(addr)

				if (engine.wallet) {
					const resolveAddr = async (thorAsset: string, addr: string): Promise<string> => {
						if (!isXpub(addr)) return addr
						const parsed = parseThorAsset(thorAsset)
						const chainId = THOR_TO_CHAIN[parsed.chain]
						if (!chainId) return addr
						const chainDef = getAllChains().find(c => c.id === chainId)
						if (!chainDef || chainDef.chainFamily !== 'utxo') return addr
						try {
							// Use selected BTC account path/scriptType when available
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
								console.log(`[swap] Resolved xpub → ${resolved} for ${thorAsset}`)
								return resolved
							}
						} catch (e: any) {
							console.warn(`[swap] Failed to resolve xpub for ${thorAsset}: ${e.message}`)
						}
						return addr
					}
					params = {
						...params,
						fromAddress: await resolveAddr(params.fromAsset, params.fromAddress),
						toAddress: await resolveAddr(params.toAsset, params.toAddress),
					}
				}

				// Fail fast if addresses are still xpubs after resolution attempt
				if (isXpub(params.fromAddress)) {
					throw new Error(`Could not resolve source address for ${params.fromAsset} — device may be locked or disconnected`)
				}
				if (isXpub(params.toAddress)) {
					throw new Error(`Could not resolve destination address for ${params.toAsset} — device may be locked or disconnected`)
				}

				const quote = await getSwapQuote(params)
				// Cache quote so executeSwap can pass real data to the tracker
				const cacheKey = `${params.fromAsset}-${params.toAsset}-${params.amount}-${params.slippageBps || 300}-${params.fromAddress}-${params.toAddress}`
				swapQuoteCache.delete(cacheKey) // delete+set for LRU ordering
				swapQuoteCache.set(cacheKey, quote)
				// Keep cache small (last 10 quotes)
				if (swapQuoteCache.size > 10) {
					const oldest = swapQuoteCache.keys().next().value
					if (oldest) swapQuoteCache.delete(oldest)
				}
				return quote
			},
			executeSwap: async (params) => {
				if (!swapsEnabled) throw new Error('Swaps feature is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				const { executeSwap } = await import('./swap')
				const { trackSwap, isTrackerInitialized, initSwapTracker } = await import('./swap-tracker')
				// Ensure tracker is initialized before tracking (guards against race/init failure)
				if (!isTrackerInitialized()) {
					await initSwapTracker((msg: string, data: any) => {
						try {
							if (msg === 'swap-update') rpc.send['swap-update'](data)
							else if (msg === 'swap-complete') rpc.send['swap-complete'](data)
						} catch (e: any) {
							console.warn(`[swap-tracker] Failed to send '${msg}':`, e.message)
						}
					})
				}
				const result = await executeSwap(params, {
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
				})
				// Look up cached quote for real tracker data
				// Match by asset pair + amount + inboundAddress to avoid collisions between
				// quotes that share the same pair/amount but differ in slippage/addresses
				let cachedQuote: Awaited<ReturnType<typeof getSwapQuote>> | undefined
				for (const [key, val] of swapQuoteCache) {
					// Key format: fromAsset-toAsset-amount-slippageBps-fromAddress-toAddress
					// Match on the asset-pair+amount prefix AND inboundAddress from the quote
					const keyPrefix = `${params.fromAsset}-${params.toAsset}-${params.amount}-`
					if (key.startsWith(keyPrefix) && val.inboundAddress === params.inboundAddress) {
						cachedQuote = val
						break
					}
				}
				if (!cachedQuote) console.warn('[index] No cached quote for swap tracker — using fallback data')
				// Register swap for tracking (non-blocking)
				try {
					trackSwap(result, params, {
						expectedOutput: cachedQuote?.expectedOutput || params.expectedOutput,
						minimumOutput: cachedQuote?.minimumOutput || '0',
						inboundAddress: cachedQuote?.inboundAddress || params.inboundAddress,
						router: cachedQuote?.router || params.router,
						memo: cachedQuote?.memo || params.memo,
						expiry: cachedQuote?.expiry || params.expiry,
						fees: cachedQuote?.fees || { affiliate: '0', outbound: '0', totalBps: 0 },
						estimatedTime: cachedQuote?.estimatedTime || 600,
						slippageBps: cachedQuote?.slippageBps || 300,
						fromAsset: params.fromAsset,
						toAsset: params.toAsset,
						integration: cachedQuote?.integration || 'thorchain',
					}, { skipPersist: engine.isPassphraseWallet })
				} catch (e: any) {
					console.warn('[index] Failed to register swap for tracking:', e.message)
				}
				// Track swap in api_log. PRIVACY: Skip DB write for passphrase wallets.
				if (!engine.isPassphraseWallet) {
					const fromChain = getAllChains().find(c => c.id === params.fromChainId)
					insertApiLog({ method: 'RPC', route: 'executeSwap', timestamp: Date.now(), durationMs: 0, status: 200, appName: 'vault', txid: result.txid, chain: fromChain?.symbol || params.fromChainId, activityType: 'swap' })
				}
				return result
			},
			getPendingSwaps: async () => {
				if (!swapsEnabled) return []
				if (engine.isPassphraseWallet) return []
				const { getPendingSwaps } = await import('./swap-tracker')
				return getPendingSwaps()
			},
			dismissSwap: async (params) => {
				const { dismissSwap } = await import('./swap-tracker')
				dismissSwap(params.txid)
			},

			// ── Swap History (SQLite-persisted) ─────────────────────
			getSwapByTxid: async (params) => {
				// PRIVACY: Don't expose standard-wallet swap records during hidden sessions.
				if (engine.isPassphraseWallet) return null
				const record = getSwapHistoryByTxid(params.txid)
				if (!record) return null
				const { inferConfirmationsFromStatus } = await import('./swap-tracker')
				return {
					txid: record.txid,
					fromAsset: record.fromAsset,
					toAsset: record.toAsset,
					fromSymbol: record.fromSymbol,
					toSymbol: record.toSymbol,
					fromChainId: record.fromChainId,
					toChainId: record.toChainId,
					fromAmount: record.fromAmount,
					expectedOutput: record.quotedOutput,
					memo: record.memo,
					inboundAddress: record.inboundAddress,
					router: record.router,
					integration: record.integration,
					status: record.status,
					confirmations: inferConfirmationsFromStatus(record.status),
					outboundTxid: record.outboundTxid,
					createdAt: record.createdAt,
					updatedAt: record.updatedAt,
					estimatedTime: record.estimatedTimeSeconds,
				}
			},
			getSwapHistory: async (params) => {
				if (engine.isPassphraseWallet) return []
				return getSwapHistory(params || undefined)
			},
			getSwapHistoryStats: async () => {
				if (engine.isPassphraseWallet) return { total: 0, completed: 0, failed: 0, pending: 0, totalVolumeUsd: 0 }
				return getSwapHistoryStats()
			},
			exportSwapReport: async (params) => {
				if (engine.isPassphraseWallet) throw new Error('Swap reports are not available for passphrase-protected wallets (privacy).')
				const records = getSwapHistory({
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
				if (engine.isPassphraseWallet) return []
				return getRecentActivityFromLog(params?.limit || 50, params?.chainId)
			},
			scanChainHistory: async (params) => {
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)

				// PRIVACY: Chain history reads from DB cache + writes to api_log,
				// both of which are bypassed/risky for passphrase wallets.
				if (engine.isPassphraseWallet) {
					throw new Error('Chain history scanning is not available for passphrase-protected wallets (privacy).')
				}

				// Get the address/xpub for this chain from cached balances
				// UTXO chains store xpub, account-based chains store address
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')
				const cachedBalances = getCachedBalances(deviceId)
				const chainBalance = cachedBalances?.balances?.find(b => b.chainId === params.chainId)
				const pubkey = chainBalance?.address
				if (!pubkey) throw new Error(`No cached address for ${chain.symbol} — load balances first`)

				const pioneer = await getPioneer()
				console.log(`[activity] Scanning ${chain.symbol} history for ${chain.chainFamily === 'utxo' ? 'xpub' : 'address'}: ${pubkey.slice(0, 16)}...`)

				const resp = await withTimeout(
					pioneer.GetTransactionHistory({ queries: [{ pubkey, caip: chain.caip }] }),
					PIONEER_TIMEOUT_MS,
					`GetTransactionHistory(${chain.symbol})`
				)
				const data = resp?.data || resp
				const histories = data?.histories || data?.data?.histories || []
				const txs: any[] = histories[0]?.transactions || []

				if (txs.length === 0) {
					console.log(`[activity] No transactions found for ${chain.symbol}`)
					return { count: 0 }
				}

					// Insert new txs, update confirmations on existing ones
				let inserted = 0
				let updated = 0
				for (const tx of txs) {
					const txid = tx.txid || tx.hash || tx.txHash
					if (!txid) continue

					const direction = tx.direction || (tx.value < 0 ? 'sent' : 'received')
					const activityType = direction === 'sent' ? 'send' : 'receive'
					const ts = tx.timestamp ? tx.timestamp * 1000 : tx.blockTime ? tx.blockTime * 1000 : Date.now()
					const confirmations = typeof tx.confirmations === 'number' ? tx.confirmations : 0
					const blockHeight = tx.blockHeight || tx.block_height || tx.height || 0
					const value = tx.value != null ? String(tx.value) : undefined
					const fee = tx.fee != null ? String(tx.fee) : undefined

					// Tx metadata stored in response_body
					const meta = { confirmations, blockHeight, value, fee, direction }

					// PRIVACY: Skip DB writes for passphrase wallets (defense in depth —
					// the RPC handler already throws before reaching here).
					if (engine.isPassphraseWallet) continue

					if (apiLogTxidExists(txid)) {
						// Update confirmation count on existing entry
						updateApiLogTxMeta(txid, meta)
						updated++
					} else {
						// New tx — insert
						insertApiLog({
							method: 'SCAN',
							route: `history/${params.chainId}`,
							timestamp: ts,
							durationMs: 0,
							status: 200,
							appName: 'vault',
							txid,
							chain: chain.symbol,
							activityType,
							responseBody: meta,
						})
						inserted++
					}
				}

				console.log(`[activity] Scanned ${chain.symbol}: ${txs.length} txs, ${inserted} new, ${updated} updated`)
				return { count: inserted }
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
				const supportedChains = getAllChains().filter(c => !c.hidden && isChainSupported(c, fwVersion))
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

				return { balances: result.balances, updatedAt: result.updatedAt, staleReasons: staleReasons.length > 0 ? staleReasons : undefined }
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
				const { startScan } = await import('./sweep-engine')
				const scanId = await startScan(engine.wallet, {
					accountRange: params.accountRange,
					mismatchAccounts: params.mismatchAccounts,
					currentMaxAccount: params.currentMaxAccount,
					higherAccountScanLimit: params.higherAccountScanLimit,
				})
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

			// ── Emulator (macOS only) ────────────────────────────────
			emulatorPair: async () => {
				const { pairEmulator, getEmulatorStatus } = await import('./emulator')
				pairEmulator()
				return getEmulatorStatus()
			},
			emulatorInit: async (params) => {
				const { initEmulator } = await import('./emulator')
				const status = initEmulator(params?.flashName, undefined, params?.channel)
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
				const { closeEmulatorWindow } = await import('./emulator-window')
				closeEmulatorWindow()
				const { stopEmulator } = await import('./emulator')
				engine.disconnectEmulator()
				return stopEmulator()
			},
			emulatorSave: async () => {
				const { saveEmulatorState } = await import('./emulator')
				saveEmulatorState()
			},
			emulatorStatus: async () => {
				const { getEmulatorStatus } = await import('./emulator')
				return getEmulatorStatus()
			},
			emulatorGetChannels: async () => {
				const { getEmulatorChannels } = await import('./emulator')
				return getEmulatorChannels()
			},
			emulatorDeleteFlash: async (params) => {
				const { deleteFlash, getEmulatorStatus, getActiveFlashName, stopEmulator } = await import('./emulator')
				const { deleteMnemonic } = await import('./emulator-keychain')

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
				return getEmulatorStatus()
			},
			emulatorListWallets: async () => {
				const { listFlashImages, hasMnemonic } = await import('./emulator-keychain')
				const { getActiveFlashName, getEmulatorStatus } = await import('./emulator')
				const status = getEmulatorStatus()
				const activeFlash = status.state === 'running' ? getActiveFlashName() : null
				return listFlashImages().map(name => ({
					name,
					hasMnemonic: hasMnemonic(name),
					isActive: name === activeFlash,
				}))
			},
			emulatorImportWallet: async (params) => {
				// Sanitize wallet name — prevent path traversal and invisible names
				const name = params.name.trim()
				if (!name || name.length > 64) throw new Error('Wallet name must be 1-64 characters')
				if (/[\/\\]/.test(name)) throw new Error('Wallet name cannot contain path separators')
				if (name.includes('..')) throw new Error('Wallet name cannot contain ".."')
				if (name.includes('\0')) throw new Error('Wallet name cannot contain null bytes')
				if (name.includes('.mnemonic.')) throw new Error('Wallet name cannot contain ".mnemonic."')
				params = { ...params, name }

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
				const status = initEmulator(params.name, undefined, params.channel)
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

					// Verify the firmware holds the mnemonic via DebugLink
					const actualMnemonic = await engine.getEmulatorMnemonic()
					if (!actualMnemonic || actualMnemonic.trim() !== params.mnemonic.trim()) {
						throw new Error('Seed verification failed — firmware mnemonic does not match imported seed')
					}

					// Only persist mnemonic AFTER seed is verified on device
					saveMnemonic(params.name, params.mnemonic)
					return getEmulatorStatus()
				} catch (err) {
					// Rollback: stop the failed emulator and clean up the orphaned flash
					console.error('[Emulator] Import failed, rolling back:', (err as Error).message)
					const { closeEmulatorWindow } = await import('./emulator-window')
					closeEmulatorWindow()
					engine.disconnectEmulator()
					stopEmulator()
					deleteFlash(params.name)
					deleteMnemonic(params.name)

					// Restore previous emulator if one was running (channel preserved by selectedChannel)
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
				const { stopEmulator, initEmulator, getEmulatorStatus } = await import('./emulator')

				// Stop current emulator if running
				if (getEmulatorStatus().state === 'running') {
					const { closeEmulatorWindow } = await import('./emulator-window')
					closeEmulatorWindow()
					engine.disconnectEmulator()
					stopEmulator()
				}

				// Init with the requested flash name + channel
				const status = initEmulator(params.name, undefined, params.channel)
				if (status.state !== 'running') return status

				// Open window + connect engine (auto-reloads saved mnemonic)
				const { openEmulatorWindow } = await import('./emulator-window')
				openEmulatorWindow()
				await engine.connectEmulator()
				return getEmulatorStatus()
			},
			emulatorGetMnemonic: async () => {
				return await engine.getEmulatorMnemonic()
			},
			emulatorCreateWallet: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')

				const bip39 = require('bip39')
				const wc = params?.wordCount || 12
				const strength = wc === 24 ? 256 : wc === 18 ? 192 : 128
				const mnemonic = bip39.generateMnemonic(strength)
				console.log(`[Emulator] Generated ${wc}-word mnemonic`)

				// Save mnemonic FIRST — connectEmulator's auto-reload uses it
				const { saveMnemonic } = await import('./emulator-keychain')
				const { getActiveFlashName } = await import('./emulator')
				saveMnemonic(getActiveFlashName(), mnemonic)

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

				// Verify the firmware actually holds the mnemonic we generated
				const actualMnemonic = await engine.getEmulatorMnemonic()
				if (!actualMnemonic) {
					console.error('[Emulator] SEED VERIFY FAIL — firmware returned no mnemonic via DebugLink')
				} else if (actualMnemonic.trim() !== mnemonic.trim()) {
					console.error('[Emulator] SEED VERIFY FAIL — firmware mnemonic does NOT match generated seed')
					console.error('[Emulator]   expected first word: %s', mnemonic.trim().split(/\s+/)[0])
					console.error('[Emulator]   actual first word:   %s', actualMnemonic.trim().split(/\s+/)[0])
				} else {
					console.log('[Emulator] SEED VERIFY OK — firmware mnemonic matches generated seed')
				}

				// Show seed words on emulator device window (NOT the main UI)
				const { displaySeedWords, isEmulatorWindowOpen } = await import('./emulator-window')
				if (isEmulatorWindowOpen()) {
					await displaySeedWords(mnemonic)
				}

				// Return success flag only — mnemonic stays on the "device"
				return { seedDisplayed: true }
			},

			// ── WalletConnect (native v2) ────────────────────────────
			wcPair: async (params) => {
				if (!walletConnectEnabled) throw new Error('WalletConnect is disabled')
				if (!engine.wallet) throw new Error('No device connected')
				const wc = getOrCreateWcManager()
				await wc.pair(params.uri)
			},
			wcGetSessions: async () => {
				if (!wcManager) return []
				return wcManager.getSessions()
			},
			wcDisconnectSession: async (params) => {
				if (!wcManager) return
				await wcManager.disconnectSession(params.topic)
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
					openReleasePage()
					return
				}
				await Updater.downloadUpdate()
			},
			applyUpdate: async () => {
				if (process.platform === 'win32' || process.platform === 'darwin') {
					openReleasePage()
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

// Initialize swap tracker with typed RPC message sender (only if swaps feature is ON)
if (swapsEnabled) {
	import('./swap-tracker').then(async ({ initSwapTracker }) => {
		await initSwapTracker((msg: string, data: any) => {
			try {
				if (msg === 'swap-update') rpc.send['swap-update'](data)
				else if (msg === 'swap-complete') rpc.send['swap-complete'](data)
				else console.error(`[swap-tracker] Unknown message: ${msg}`)
			} catch (e: any) {
				console.warn(`[swap-tracker] Failed to send '${msg}':`, e.message)
			}
		})
	}).catch((e) => {
		console.error('[swap-tracker] Failed to initialize swap tracker (swaps will be unavailable):', e.message || e)
	})
} else {
	console.log('[swap-tracker] Swap feature flag is OFF — tracker not initialized')
}

// Push engine events to WebView
engine.on('state-change', (state) => {
	try { rpc.send['device-state'](state) } catch { /* webview not ready yet */ }
	// Auto-disable advanced features if firmware doesn't support them
	if (state.state === 'ready') {
		const fw = state.firmwareVersion
		if (bip85Enabled && (!fw || versionCompare(fw, '7.15.0') < 0)) {
			bip85Enabled = false
			setSetting('bip85_enabled', '0')
			console.log(`[settings] BIP-85 auto-disabled — firmware ${fw || 'unknown'} < 7.15.0`)
		}
		if (zcashPrivacyEnabled && (!fw || versionCompare(fw, '7.14.0') < 0)) {
			zcashPrivacyEnabled = false
			setSetting('zcash_privacy_enabled', '0')
			stopSidecar()
			console.log(`[settings] Zcash privacy auto-disabled — firmware ${fw || 'unknown'} < 7.14.0`)
		}
	}
	if (state.state === 'disconnected') { btcAccounts.reset(); evmAddresses.reset() }
	// When entering passphrase mode, the seed is about to change — clear all
	// cached addresses so they get re-derived from the new passphrase seed.
	if (state.state === 'needs_passphrase') {
		// Reset in-memory managers so they re-derive after passphrase entry.
		btcAccounts.reset()
		evmAddresses.reset()
		// NOTE: We do NOT clear DB caches (clearCachedPubkeys, clearBalances) here.
		// needs_passphrase fires when the device *requests* a passphrase — before the
		// user enters it. We don't know yet if this is the standard wallet (empty
		// passphrase) or a hidden wallet. Clearing DB prematurely destroys the standard
		// wallet's cache for every passphrase-protected unlock. Instead, the write-time
		// guards (isPassphraseWallet checks) prevent hidden wallet data from ever
		// reaching the DB during the session.
		console.log('[Vault] Passphrase mode: reset in-memory address managers — will re-derive after passphrase entry')
	}
})
// Seed changed — different mnemonic loaded on the same hardware.
// Reset in-memory address managers so they re-derive from the new seed.
// Don't wipe DB — let the fresh Pioneer fetch naturally overwrite stale entries.
engine.on('seed-changed', ({ deviceId, oldAddress, newAddress }) => {
	console.warn(`[Vault] SEED CHANGED on ${deviceId}: ${oldAddress?.slice(0, 10)} → ${newAddress?.slice(0, 10)}`)
	btcAccounts.reset()
	evmAddresses.reset()
	// Clear stale DB caches — old seed's pubkeys and balances are wrong for the new seed
	if (deviceId) {
		clearCachedPubkeys(deviceId)
		clearBalances(deviceId)
		console.log('[Vault] Seed changed: cleared cached pubkeys + balances for', deviceId)
	}
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

// ── Force keepkey:// protocol registration (override old keepkey-desktop) ──
if (process.platform === 'darwin') {
	// Re-register this app as the handler for keepkey:// via Launch Services.
	// When both keepkey-desktop (Electron) and keepkey-vault (Electrobun) are
	// installed, the last one to register wins. We force it on every launch.
	try {
		const appPath = path.resolve(import.meta.dir, '..', '..', '..')
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

// ── keepkey:// Protocol Handler ────────────────────────────────────────
let pendingDeepLinkUri: string | null = null

function getWalletConnectUri(inputUri: string): string | undefined {
	const uri = inputUri
		.replace('keepkey://launch/wc?uri=', '')
		.replace('keepkey://wc?uri=', '')
	if (!uri.startsWith('wc')) return undefined
	return decodeURIComponent(uri.replace('wc/?uri=', '').replace('wc?uri=', ''))
}

function handleKeepKeyUrl(url: string) {
	console.log('[Vault] keepkey:// URL:', url)
	const wcUri = getWalletConnectUri(url)
	if (wcUri) {
		if (walletConnectEnabled && engine.wallet) {
			// Native WC v2 — pair directly in the backend
			const wc = getOrCreateWcManager()
			wc.pair(wcUri).catch(e => {
				console.error('[WC] Pair failed:', e.message)
				// Store for retry via getPendingDeepLink when device becomes ready
				pendingDeepLinkUri = wcUri
			})
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
	if (url.startsWith('keepkey://')) handleKeepKeyUrl(url)
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
