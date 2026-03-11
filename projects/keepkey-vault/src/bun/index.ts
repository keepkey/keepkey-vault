import { BrowserView, BrowserWindow, Updater, Utils, ApplicationMenu } from "electrobun/bun"

// ── Global error handlers (MUST be first — prevents silent crashes) ──
process.on('uncaughtException', (err) => {
	console.error('[Vault] UNCAUGHT EXCEPTION:', err)
})
process.on('unhandledRejection', (reason) => {
	console.error('[Vault] UNHANDLED REJECTION:', reason)
})

import { EngineController, withTimeout } from "./engine-controller"
import { startRestApi, type RestApiCallbacks } from "./rest-api"
import { AuthStore } from "./auth"
import { getPioneer, getPioneerApiBase, resetPioneer } from "./pioneer"
import { buildTx, broadcastTx } from "./txbuilder"
import { initializeOrchardFromDevice, scanOrchardNotes, getShieldedBalance, sendShielded } from "./txbuilder/zcash-shielded"
import { isSidecarReady, startSidecar, stopSidecar, hasFvkLoaded, getCachedFvk, setCachedFvk, onScanProgress } from "./zcash-sidecar"
import { CHAINS, customChainToChainDef, isChainSupported } from "../shared/chains"
import type { ChainDef } from "../shared/chains"
import { BtcAccountManager } from "./btc-accounts"
import { EvmAddressManager, evmAddressPath } from "./evm-addresses"
import { initDb, getCustomTokens, addCustomToken as dbAddCustomToken, removeCustomToken as dbRemoveCustomToken, getCustomChains, addCustomChainDb, removeCustomChainDb, getSetting, setSetting, setTokenVisibility as dbSetTokenVisibility, removeTokenVisibility as dbRemoveTokenVisibility, getAllTokenVisibility, insertApiLog, getApiLogs, clearApiLogs, setCachedBalances, getCachedBalances, saveCachedPubkey, getLatestDeviceSnapshot, getCachedPubkeys, saveReport, getReportsList, getReportById, deleteReport, reportExists, getSwapHistory, getSwapHistoryStats } from "./db"
import { generateReport, reportToPdfBuffer } from "./reports"
import { extractTransactionsFromReport, toCoinTrackerCsv, toZenLedgerCsv } from "./tax-export"
import * as os from "os"
import * as path from "path"
import { EVM_RPC_URLS, getTokenMetadata, broadcastEvmTx } from "./evm-rpc"
import { startCamera, stopCamera } from "./camera"
import type { ChainBalance, TokenBalance, CustomToken, SigningRequestInfo, ApiLogEntry, PioneerChainInfo, EvmAddressSet } from "../shared/types"
import type { VaultRPCSchema } from "../shared/rpc-schema"

// L3 fix: withTimeout imported from engine-controller (was duplicated here)
const PIONEER_TIMEOUT_MS = 60_000

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

/** Fire-and-forget: cache a derived address for watch-only mode */
function cacheAddress(chainId: string, path: string, address: string) {
	try {
		const deviceId = engine.getDeviceState().deviceId || 'unknown'
		saveCachedPubkey(deviceId, chainId, path, '', address, '')
	} catch { /* never block on cache failure */ }
}

const DEV_SERVER_PORT = 5177
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`
const REST_API_PORT = 1646

// ── Engine Controller ─────────────────────────────────────────────────
const engine = new EngineController()
const btcAccounts = new BtcAccountManager()
const evmAddresses = new EvmAddressManager()

// ── Custom chains (loaded from SQLite on startup) ────────────────────
initDb()
let customChainDefs: ChainDef[] = []
try {
	const stored = getCustomChains()
	customChainDefs = stored.map(customChainToChainDef)
	if (stored.length) console.log(`[Vault] Loaded ${stored.length} custom chains from DB`)
} catch { /* db not ready yet */ }

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

// ── REST API Server (opt-in, persisted in DB, default OFF) ─────────────
const auth = new AuthStore()
let restApiEnabled = getSetting('rest_api_enabled') === '1' // default OFF
let swapsEnabled = getSetting('swaps_enabled') === '1' // default OFF
let appVersionCache = ''
let restServer: ReturnType<typeof startRestApi> | null = null

function getAppSettings() {
	return {
		restApiEnabled,
		pioneerApiBase: getPioneerApiBase(),
		fiatCurrency: getSetting('fiat_currency') || 'USD',
		numberLocale: getSetting('number_locale') || 'en-US',
		swapsEnabled,
	}
}

// Callbacks bridge REST → RPC UI
const restCallbacks: RestApiCallbacks = {
	onApiLog: (entry: ApiLogEntry) => {
		try { rpc.send['api-log'](entry) } catch { /* webview not ready */ }
		try { insertApiLog(entry) } catch { /* db not ready */ }
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
}

/** Start or stop the REST API server based on the persisted setting */
function applyRestApiState() {
	if (restApiEnabled && !restServer) {
		restServer = startRestApi(engine, auth, REST_API_PORT, restCallbacks)
		console.log(`[Vault] REST API started on port ${REST_API_PORT}`)
	} else if (!restApiEnabled && restServer) {
		restServer.stop()
		restServer = null
		console.log('[Vault] REST API stopped')
	}
}

// Start REST if previously enabled
applyRestApiState()
if (!restApiEnabled) console.log('[Vault] REST API disabled (enable in Settings → Application)')

// ── Swap quote cache (last 10 quotes for tracker data) ───────────────
import type { SwapQuote } from '../shared/types'
const swapQuoteCache = new Map<string, SwapQuote>()

// ── RPC Bridge (Electrobun UI ↔ Bun) ─────────────────────────────────
const rpc = BrowserView.defineRPC<VaultRPCSchema>({
	maxRequestTime: 1_800_000, // 30 minutes — generous for device-interactive ops, but not infinite
	handlers: {
		requests: {
			// ── Device lifecycle ──────────────────────────────────────
			getDeviceState: async () => engine.getDeviceState(),
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
			loadDevice: async (params) => { await engine.loadDevice(params) },
			verifySeed: async (params) => { return await engine.verifySeed(params) },
			applySettings: async (params) => { await engine.applySettings(params) },
			changePin: async () => { await engine.changePin() },
			removePin: async () => { await engine.removePin() },
			sendPin: async (params) => { await engine.sendPin(params.pin) },
			sendPassphrase: async (params) => { await engine.sendPassphrase(params.passphrase) },
			sendCharacter: async (params) => { await engine.sendCharacter(params.character) },
			sendCharacterDelete: async () => { await engine.sendCharacterDelete() },
			sendCharacterDone: async () => { await engine.sendCharacterDone() },

			// ── Wallet operations (hdwallet pass-through) ─────────────
			getFeatures: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.getFeatures()
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
				await engine.wallet.wipe()
				await engine.syncState()
				return { success: true }
			},
			getPublicKeys: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.getPublicKeys(params.paths)
			},

			// ── Address derivation ────────────────────────────────────
			btcGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.btcGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('bitcoin', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			ethGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.ethGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('ethereum', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			cosmosGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.cosmosGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('cosmos', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			thorchainGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.thorchainGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('thorchain', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			mayachainGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.mayachainGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('mayachain', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			osmosisGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.osmosisGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('osmosis', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			xrpGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.rippleGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('ripple', JSON.stringify(params.addressNList || []), addr)
				return result
			},
			solanaGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.solanaGetAddress(params)
				const addr = typeof result === 'string' ? result : result?.address
				if (addr) cacheAddress('solana', JSON.stringify(params.addressNList || []), addr)
				return result
			},

			// ── Transaction signing ───────────────────────────────────
			btcSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.btcSignTx(params)
			},
			ethSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.ethSignTx(params)
			},
			ethSignMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.ethSignMessage(params)
			},
			ethSignTypedData: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.ethSignTypedData(params)
			},
			ethVerifyMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.ethVerifyMessage(params)
			},
			cosmosSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.cosmosSignTx(params)
			},
			thorchainSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.thorchainSignTx(params)
			},
			mayachainSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.mayachainSignTx(params)
			},
			osmosisSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.osmosisSignTx(params)
			},
			xrpSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.rippleSignTx(params)
			},
			solanaSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.solanaSignTx(params)
				// Assemble signed tx: replace the 64-byte dummy signature in rawTx with real signature
				if (result?.signature && params.rawTx) {
					const rawBytes = Buffer.from(params.rawTx, 'base64')
					const sigBytes = result.signature instanceof Uint8Array
						? result.signature
						: Buffer.from(result.signature, 'base64')
					// rawTx format: [1 byte sig_count] [64 bytes dummy sig] [message...]
					// Replace bytes 1-64 with real signature
					if (rawBytes.length > 65 && sigBytes.length === 64) {
						sigBytes.forEach((b: number, i: number) => { rawBytes[1 + i] = b })
						return { signature: result.signature, serializedTx: rawBytes.toString('base64') }
					}
				}
				return result
			},
			solanaSignMessage: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const result = await engine.wallet.solanaSignMessage(params)
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

				// Non-BTC UTXO chains still use the old single-xpub path
				const allChains = getAllChains()
				const utxoChains = allChains.filter(c => c.chainFamily === 'utxo' && c.id !== 'bitcoin')
				const nonUtxoChains = allChains.filter(c => c.chainFamily !== 'utxo')

				// 1. Batch-fetch non-BTC UTXO xpubs in a single device call
				let xpubResults: any[] = []
				try {
					if (utxoChains.length > 0) {
						xpubResults = await wallet.getPublicKeys(utxoChains.map(c => ({
							addressNList: c.defaultPath.slice(0, 3),
							coin: c.coin,
							scriptType: c.scriptType,
							curve: 'secp256k1',
						}))) || []
					}
				} catch (e: any) {
					console.warn('[getBalances] UTXO xpub batch failed:', e.message)
				}

				// 2. Derive non-UTXO addresses (one device call per chain — unavoidable)
				const pubkeys: Array<{ caip: string; pubkey: string; chainId: string; symbol: string; networkId: string }> = []

				for (let i = 0; i < utxoChains.length; i++) {
					const xpub = xpubResults?.[i]?.xpub
					if (xpub) pubkeys.push({ caip: utxoChains[i].caip, pubkey: xpub, chainId: utxoChains[i].id, symbol: utxoChains[i].symbol, networkId: utxoChains[i].networkId })
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

				// Non-EVM, non-UTXO chains (cosmos, xrp, etc.)
				for (const chain of nonEvmChains) {
					try {
						const addrParams: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.coin }
						if (chain.scriptType) addrParams.scriptType = chain.scriptType
						const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
						const result = await wallet[method](addrParams)
						const address = typeof result === 'string' ? result : result?.address || ''
						if (address) pubkeys.push({ caip: chain.caip, pubkey: address, chainId: chain.id, symbol: chain.symbol, networkId: chain.networkId })
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

				// Build networkId → chainId lookup for token grouping
				const networkToChain = new Map<string, string>()
				for (const chain of allChains) {
					if (chain.networkId) networkToChain.set(chain.networkId, chain.id)
				}

				// 3. Single API call — use GetPortfolio (charts endpoint) which returns
				//    both native balances AND tokens (ERC-20, etc.)
				const results: ChainBalance[] = []
				try {
					if (!pioneer) throw new Error('Pioneer client not available')
					const resp = await withTimeout(
						pioneer.GetPortfolio({
							pubkeys: pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey }))
						}),
						PIONEER_TIMEOUT_MS,
						'GetPortfolio'
					)
					// Unwrap Swagger double-wrap: { data: { data: { balances, tokens } } }
					const portfolio = resp?.data?.data || resp?.data || {}
					const nativeEntries: any[] = portfolio.balances || (Array.isArray(portfolio) ? portfolio : [])
					const portfolioTokens: any[] = portfolio.tokens || []

					console.log(`[getBalances] GetPortfolio response: ${nativeEntries.length} balances, ${portfolioTokens.length} tokens`)
					// Log BTC-specific entries for debugging
					const btcNatives = nativeEntries.filter((d: any) => d.caip?.includes('bip122') || d.pubkey?.startsWith('xpub') || d.pubkey?.startsWith('ypub') || d.pubkey?.startsWith('zpub'))
					console.log(`[getBalances] BTC native entries from Pioneer: ${btcNatives.length}`)
					for (const b of btcNatives) {
						console.log(`  BTC: caip=${b.caip}, pubkey=${String(b.pubkey).substring(0, 24)}..., balance=${b.balance}, valueUsd=${b.valueUsd}, address=${b.address}`)
					}

					// Convert portfolio.tokens (different shape) into the same format as native entries
					// so our existing token grouping logic works on them
					const tokenEntries: any[] = []
					for (const t of portfolioTokens) {
						if (!t.assetCaip) continue
						// Skip native assets that leaked into tokens array
						if (t.assetCaip.includes('/slip44:')) continue
						tokenEntries.push({
							caip: t.assetCaip,
							networkId: t.networkId,
							symbol: t.token?.symbol || 'UNK',
							name: t.token?.name || t.token?.coingeckoId || 'Unknown',
							balance: t.token?.balance?.toString() || '0',
							valueUsd: t.token?.balanceUSD || 0,
							priceUsd: t.token?.price || 0,
							decimals: t.token?.decimals ?? t.token?.decimal ?? 18,
							type: 'token',
							contract: t.assetCaip.match(/\/erc20:(0x[a-fA-F0-9]+)/)?.[1] || undefined,
						})
					}

					// Also scan nativeEntries for any tokens mixed in (belt + suspenders)
					const pureNatives: any[] = []
					for (const d of nativeEntries) {
						const caip = d.caip || ''
						const caipPath = caip.split('/')[1] || ''
						const isTokenByCaip = caipPath && !caipPath.startsWith('slip44:')
						const isTokenByType = d.type === 'token' && d.isNative !== true
						if (isTokenByCaip || isTokenByType) {
							tokenEntries.push(d)
						} else {
							pureNatives.push(d)
						}
					}

					console.log(`[getBalances] After classification: ${pureNatives.length} natives, ${tokenEntries.length} tokens`)

					// Group tokens by their parent chain (via networkId or CAIP prefix)
					// Also log the networkToChain map so we can audit matching
					console.log(`[getBalances] networkToChain map (${networkToChain.size} entries): ${JSON.stringify(Object.fromEntries(networkToChain))}`)

					const tokensByChainId = new Map<string, TokenBalance[]>()
					let tokensSkippedZero = 0, tokensSkippedNoChain = 0, tokensGrouped = 0
					for (const tok of tokenEntries) {
						const bal = parseFloat(String(tok.balance ?? '0'))
						if (bal <= 0) { tokensSkippedZero++; continue }

						// Determine parent chainId from networkId or CAIP-2 prefix
						const tokNetworkId = tok.networkId || ''
						const caipPrefix = (tok.caip || '').split('/')[0] // e.g. "eip155:1"
						const parentChainId = networkToChain.get(tokNetworkId) || networkToChain.get(caipPrefix) || null
						if (!parentChainId) {
							tokensSkippedNoChain++
							console.warn(`[getBalances] Token DROPPED (no parent chain): ${tok.symbol} caip=${tok.caip} networkId=${tokNetworkId} caipPrefix=${caipPrefix} bal=${bal} usd=${tok.valueUsd}`)
							continue
						}

						// Extract contract address from CAIP: "eip155:1/erc20:0xdac17..." → "0xdac17..."
						const contractMatch = (tok.caip || '').match(/\/erc20:(0x[a-fA-F0-9]+)/)
						const contractAddress = contractMatch?.[1] || tok.contract || undefined

						const token: TokenBalance = {
							symbol: tok.symbol || '???',
							name: tok.name || tok.symbol || 'Unknown Token',
							balance: String(tok.balance ?? '0'),
							balanceUsd: Number(tok.valueUsd ?? 0),
							priceUsd: Number(tok.priceUsd ?? 0),
							caip: tok.caip || '',
							contractAddress,
							networkId: tokNetworkId || caipPrefix,
							decimals: tok.decimals ?? tok.precision,
							type: tok.type || 'token',
							dataSource: tok.dataSource,
						}

						const existing = tokensByChainId.get(parentChainId) || []
						existing.push(token)
						tokensByChainId.set(parentChainId, existing)
						tokensGrouped++
					}

					console.log(`[getBalances] Token grouping: ${tokensGrouped} grouped, ${tokensSkippedZero} skipped (zero bal), ${tokensSkippedNoChain} DROPPED (no parent chain)`)
					for (const [chainId, toks] of tokensByChainId) {
						console.log(`[getBalances]   ${chainId}: ${toks.length} tokens, $${toks.reduce((s, t) => s + t.balanceUsd, 0).toFixed(2)} — ${toks.map(t => t.symbol).join(', ')}`)
					}

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
					console.log(`[getBalances] pureNatives count: ${pureNatives.length}`)
					for (const n of pureNatives) {
						if (n.caip?.includes('bip122') || n.pubkey?.startsWith('xpub') || n.pubkey?.startsWith('ypub') || n.pubkey?.startsWith('zpub')) {
							console.log(`[getBalances] BTC native entry: caip=${n.caip}, pubkey=${n.pubkey?.substring(0, 20)}..., balance=${n.balance}, usd=${n.valueUsd}`)
						}
					}
					let btcTotalBalance = 0
					let btcTotalUsd = 0
					let btcAddress = ''

					// Aggregate EVM entries per-chain (sum across address indices)
					const evmChainAgg = new Map<string, { balance: number; usd: number; address: string; symbol: string }>()

					for (const entry of pubkeys) {
						if (entry.chainId === 'bitcoin') {
							// Find the Pioneer response for this xpub
							const match = pureNatives.find((d: any) => d.pubkey === entry.pubkey)
								|| pureNatives.find((d: any) => d.caip === entry.caip && d.address === entry.pubkey)
							console.log(`[getBalances] BTC match for ${entry.pubkey?.substring(0, 20)}...: ${match ? `balance=${match.balance}, usd=${match.valueUsd}` : 'NO MATCH'}`)
							const bal = parseFloat(String(match?.balance ?? '0'))
							const usd = Number(match?.valueUsd ?? 0)
							btcTotalBalance += bal
							btcTotalUsd += usd
							if (!btcAddress && match?.address) btcAddress = match.address
							// Update per-xpub balance in BtcAccountManager
							btcAccounts.updateXpubBalance(entry.pubkey, String(match?.balance ?? '0'), usd)
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

						const match = pureNatives.find((d: any) => d.caip === entry.caip)
							|| pureNatives.find((d: any) => d.pubkey === entry.pubkey)
						const chainTokens = tokensByChainId.get(entry.chainId)
						// Sum token USD values into the chain total
						const tokenUsdTotal = chainTokens?.reduce((sum, t) => sum + t.balanceUsd, 0) || 0
						const nativeUsd = Number(match?.valueUsd ?? 0)
						results.push({
							chainId: entry.chainId, symbol: entry.symbol,
							balance: String(match?.balance ?? '0'),
							balanceUsd: nativeUsd + tokenUsdTotal,
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
							address: agg.address,
							tokens: chainTokens && chainTokens.length > 0 ? chainTokens : undefined,
						})
					}

					// BTC fallback: GetPortfolio (charts/portfolio) returns empty for BTC xpubs.
					// Use GetPortfolioBalances (/portfolio) which correctly returns BTC data.
					if (btcTotalBalance === 0 && btcPubkeyEntries.length > 0 && pioneer) {
						console.log('[getBalances] BTC zero from GetPortfolio (charts) — trying GetPortfolioBalances fallback')
						try {
							const btcResp = await withTimeout(
								pioneer.GetPortfolioBalances({
									pubkeys: btcPubkeyEntries.map(e => ({ caip: e.caip, pubkey: e.pubkey }))
								}),
								PIONEER_TIMEOUT_MS,
								'GetPortfolioBalances-BTC'
							)
							const btcBalances = btcResp?.data?.balances || btcResp?.data || []
							for (const b of (Array.isArray(btcBalances) ? btcBalances : [])) {
								const bal = parseFloat(String(b.balance ?? '0'))
								const usd = Number(b.valueUsd ?? 0)
								btcTotalBalance += bal
								btcTotalUsd += usd
								if (!btcAddress && b.address) btcAddress = b.address
								if (b.pubkey) btcAccounts.updateXpubBalance(b.pubkey, String(b.balance ?? '0'), usd)
							}
							console.log(`[getBalances] BTC fallback result: ${btcTotalBalance.toFixed(8)} BTC, $${btcTotalUsd.toFixed(2)}`)
						} catch (e: any) {
							console.warn('[getBalances] BTC GetPortfolioBalances fallback failed:', e.message)
						}
					}

					// Push one aggregated BTC entry
					if (btcPubkeyEntries.length > 0) {
						const selectedXpub = btcAccounts.getSelectedXpub()
						results.push({
							chainId: 'bitcoin', symbol: 'BTC',
							balance: btcTotalBalance > 0 ? btcTotalBalance.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '0',
							balanceUsd: btcTotalUsd,
							address: btcAddress || selectedXpub?.xpub || btcPubkeyEntries[0]?.pubkey || '',
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

					// Cache balances (fire-and-forget) — only on successful Pioneer response
					try {
						const deviceId = engine.getDeviceState().deviceId || 'unknown'
						if (results.length > 0) setCachedBalances(deviceId, results)
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

				// Derive pubkey (xpub for UTXO, address for others)
				let pubkey: string
				if (chain.chainFamily === 'utxo') {
					const result = await wallet.getPublicKeys([{
						addressNList: chain.defaultPath.slice(0, 3),
						coin: chain.coin, scriptType: chain.scriptType, curve: 'secp256k1',
					}])
					pubkey = result?.[0]?.xpub || ''
					if (!pubkey) throw new Error(`Could not derive xpub for ${chain.coin}`)
				} else {
					const addrParams: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.chainFamily === 'evm' ? 'Ethereum' : chain.coin }
					if (chain.scriptType) addrParams.scriptType = chain.scriptType
					const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
					const result = await wallet[method](addrParams)
					pubkey = typeof result === 'string' ? result : result?.address || ''
					if (!pubkey) throw new Error(`Could not derive address for ${chain.coin}`)
				}

				// Single portfolio call
				let balance = '0', balanceUsd = 0
				try {
					const resp = await withTimeout(pioneer.GetPortfolioBalances({ pubkeys: [{ caip: chain.caip, pubkey }] }), PIONEER_TIMEOUT_MS, 'GetPortfolioBalances')
					const match = (resp?.data?.balances || [])[0]
					if (match) { balance = String(match.balance ?? '0'); balanceUsd = Number(match.valueUsd ?? 0) }
				} catch (e: any) {
					console.warn(`[getBalance] ${chain.coin} portfolio failed:`, e.message)
				}
				return { chainId: chain.id, symbol: chain.symbol, balance, balanceUsd, address: pubkey }
			},

			buildTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				// For chains that need fromAddress or xpub, derive them
				const wallet = engine.wallet as any
				let fromAddress: string | undefined
				let xpub: string | undefined

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
					const walletMethod = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
					const addrResult = await wallet[walletMethod](addrParams)
					fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
				} else if (chain.id === 'bitcoin') {
					// BTC multi-account: use override or selected xpub + scriptType
					const selectedBtcXpub = btcAccounts.getSelectedXpub()
					xpub = params.xpubOverride || selectedBtcXpub?.xpub
					// Ensure scriptTypeOverride is set when using a selected xpub
					if (!params.scriptTypeOverride && selectedBtcXpub?.scriptType) {
						params = { ...params, scriptTypeOverride: selectedBtcXpub.scriptType }
					}
					// Pass account-level path so UTXO builder can correct blockbook's always-account-0 paths
					if (selectedBtcXpub?.path) {
						params = { ...params, accountPath: selectedBtcXpub.path }
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
					const xpubResult = await wallet.getPublicKeys([{
						addressNList: chain.defaultPath.slice(0, 3),
						coin: chain.coin,
						scriptType: chain.scriptType,
						curve: 'secp256k1',
					}])
					xpub = xpubResult?.[0]?.xpub
				}

				const rpcUrl = chain.id.startsWith('evm-custom-') ? getRpcUrl(chain) : undefined
				const evmIdx = chain.chainFamily === 'evm' ? (params.evmAddressIndex ?? evmAddresses.getSelectedAddress()?.addressIndex ?? 0) : undefined
				const result = await buildTx(pioneer, chain, {
					...params,
					fromAddress,
					xpub,
					rpcUrl,
					evmAddressIndex: evmIdx,
				})

				return { unsignedTx: result.unsignedTx, fee: result.fee }
			},

			broadcastTx: async (params) => {
				if (!params.signedTx) throw new Error('Missing signedTx payload')
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)

				// Custom chains: broadcast via direct RPC
				const rpcUrl = chain.id.startsWith('evm-custom-') ? getRpcUrl(chain) : undefined
				if (rpcUrl) {
					const serialized = params.signedTx?.serializedTx || params.signedTx?.serialized || (typeof params.signedTx === 'string' ? params.signedTx : undefined)
					if (!serialized || typeof serialized !== 'string') throw new Error(`Cannot extract serialized tx from: ${JSON.stringify(params.signedTx).slice(0, 200)}`)
					const txid = await broadcastEvmTx(rpcUrl, serialized)
					return { txid }
				}

				const pioneer = await getPioneer()
				return await broadcastTx(pioneer, chain, params.signedTx)
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

			// ── Bitcoin multi-account ─────────────────────────────────
			getBtcAccounts: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				if (!btcAccounts.isInitialized) {
					await btcAccounts.initialize(engine.wallet as any)
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
				const zcashDef = CHAINS.find(c => c.id === 'zcash-shielded')
				if (!zcashDef || !isChainSupported(zcashDef, engine.state?.firmwareVersion)) {
					return { ready: false, fvk_loaded: false, address: null, fvk: null }
				}
				// Lazy-start sidecar on first status check
				if (!isSidecarReady()) {
					try { await startSidecar() } catch { /* binary not found — will show not_running */ }
				}
				const cached = getCachedFvk()
				return {
					ready: isSidecarReady(),
					fvk_loaded: hasFvkLoaded(),
					address: cached?.address ?? null,
					fvk: cached?.fvk ?? null,
				}
			},
			zcashShieldedInit: async (params) => {
				const zcashDef = CHAINS.find(c => c.id === 'zcash-shielded')
				if (!zcashDef || !isChainSupported(zcashDef, engine.state?.firmwareVersion)) {
					throw new Error('Zcash shielded requires firmware >= 7.11.0')
				}
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
				return await scanOrchardNotes(params?.startHeight, params?.fullRescan)
			},
			zcashShieldedBalance: async () => {
				return await getShieldedBalance()
			},
			zcashShieldedSend: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const zcashDef = CHAINS.find(c => c.id === 'zcash-shielded')
				if (!zcashDef || !isChainSupported(zcashDef, engine.state?.firmwareVersion)) {
					throw new Error('Zcash shielded requires firmware >= 7.11.0')
				}
				return await sendShielded(engine.wallet as any, {
					recipient: params.recipient,
					amount: params.amount,
					memo: params.memo,
				})
			},

			// ── Camera / QR scanning ─────────────────────────────────
			startQrScan: async () => {
				startCamera(
					(base64) => { try { rpc.send['camera-frame'](base64) } catch { /* webview not ready */ } },
					(message) => { try { rpc.send['camera-error'](message) } catch { /* webview not ready */ } },
				)
			},
			stopQrScan: async () => {
				stopCamera()
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

			// ── App Settings ─────────────────────────────────────────
			getAppSettings: async () => {
				return getAppSettings()
			},
			setRestApiEnabled: async (params) => {
				restApiEnabled = params.enabled
				setSetting('rest_api_enabled', params.enabled ? '1' : '0')
				applyRestApiState()
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
			setSwapsEnabled: async (params) => {
				swapsEnabled = params.enabled
				setSetting('swaps_enabled', params.enabled ? '1' : '0')
				console.log('[settings] Swaps enabled:', params.enabled)
				return getAppSettings()
			},

			// ── API Audit Log ────────────────────────────────────────
			getApiLogs: async (params) => {
				return getApiLogs(params?.limit ?? 200, params?.offset ?? 0)
			},
			clearApiLogs: async () => {
				clearApiLogs()
			},

			// ── Reports ─────────────────────────────────────────────
			generateReport: async () => {
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')

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
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) return []
				return getReportsList(deviceId)
			},

			// H1: Scope getReport/deleteReport to the current device
			getReport: async (params) => {
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')
				return getReportById(params.id, deviceId)
			},

			deleteReport: async (params) => {
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')
				deleteReport(params.id, deviceId)
			},

			saveReportFile: async (params) => {
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) throw new Error('No device connected')
				const report = getReportById(params.id, deviceId)
				if (!report) throw new Error('Report not found')

				const dateSuffix = new Date(report.meta.createdAt).toISOString().split('T')[0]
				const year = new Date(report.meta.createdAt).getFullYear()
				const downloadsDir = path.join(os.homedir(), 'Downloads')

				console.log(`[reports] saveReportFile: format=${params.format}, id=${params.id}`)

				let filePath: string
				if (params.format === 'cointracker') {
					filePath = path.join(downloadsDir, `keepkey_cointracker_${year}.csv`)
					const txs = extractTransactionsFromReport(report.data)
					await Bun.write(filePath, toCoinTrackerCsv(txs))
				} else if (params.format === 'zenledger') {
					filePath = path.join(downloadsDir, `keepkey_zenledger_${year}.csv`)
					const txs = extractTransactionsFromReport(report.data)
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
			getSwapAssets: async () => {
				const { getSwapAssets } = await import('./swap')
				return await getSwapAssets()
			},
			getSwapQuote: async (params) => {
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
							const result = await engine.wallet.btcGetAddress({
								addressNList: chainDef.defaultPath,
								coin: chainDef.coin,
								scriptType: chainDef.scriptType,
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
				if (!engine.wallet) throw new Error('No device connected')
				const { executeSwap } = await import('./swap')
				const { trackSwap } = await import('./swap-tracker')
				const result = await executeSwap(params, {
					wallet: engine.wallet,
					getAllChains,
					getRpcUrl,
					getBtcXpub: () => {
						if (btcAccounts.isInitialized) {
							const selected = btcAccounts.getSelectedXpub()
							if (selected) return selected.xpub
						}
						return undefined
					},
				})
				// Look up cached quote for real tracker data (match by asset+amount, addresses from getSwapQuote context)
				// Try exact match first, then fallback to base key without addresses
				const baseKey = `${params.fromAsset}-${params.toAsset}-${params.amount}`
				let cachedQuote: Awaited<ReturnType<typeof getSwapQuote>> | undefined
				for (const [key, val] of swapQuoteCache) {
					if (key.startsWith(baseKey) && val.inboundAddress === params.inboundAddress) {
						cachedQuote = val
						break
					}
				}
				if (!cachedQuote) {
					// Fallback: find any quote matching the base key
					for (const [key, val] of swapQuoteCache) {
						if (key.startsWith(baseKey)) { cachedQuote = val; break }
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
					})
				} catch (e: any) {
					console.warn('[index] Failed to register swap for tracking:', e.message)
				}
				return result
			},
			getPendingSwaps: async () => {
				const { getPendingSwaps } = await import('./swap-tracker')
				return getPendingSwaps()
			},
			dismissSwap: async (params) => {
				const { dismissSwap } = await import('./swap-tracker')
				dismissSwap(params.txid)
			},

			// ── Swap History (SQLite-persisted) ─────────────────────
			getSwapHistory: async (params) => {
				return getSwapHistory(params || undefined)
			},
			getSwapHistoryStats: async () => {
				return getSwapHistoryStats()
			},
			exportSwapReport: async (params) => {
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

			// ── Balance cache (instant portfolio) ────────────────────
			getCachedBalances: async () => {
				const deviceId = engine.getDeviceState().deviceId
				if (!deviceId) return null
				const result = getCachedBalances(deviceId)
				if (!result) return null
				return { balances: result.balances, updatedAt: result.updatedAt }
			},

			// ── Watch-only mode ─────────────────────────────────────
			checkWatchOnlyCache: async () => {
				const snap = getLatestDeviceSnapshot()
				if (!snap) return { available: false }
				return { available: true, deviceLabel: snap.label || undefined, lastSynced: snap.updatedAt }
			},
			getWatchOnlyBalances: async () => {
				const snap = getLatestDeviceSnapshot()
				if (!snap) return null
				const result = getCachedBalances(snap.deviceId)
				return result?.balances ?? null
			},
			getWatchOnlyPubkeys: async () => {
				const snap = getLatestDeviceSnapshot()
				if (!snap) return []
				return getCachedPubkeys(snap.deviceId)
			},


			// ── Utility ──────────────────────────────────────────────
			openUrl: async (params) => {
				try {
					const parsed = new URL(params.url)
					if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
					const cmd = process.platform === 'win32' ? 'start' : process.platform === 'linux' ? 'xdg-open' : 'open'
					Bun.spawn([cmd, parsed.href])
				} catch {
					throw new Error('Invalid URL')
				}
			},

			// ── App Updates ──────────────────────────────────────────
			checkForUpdate: async () => {
				const result = await Updater.checkForUpdate()
				const info = Updater.updateInfo()
				return {
					updateAvailable: !!info?.updateAvailable,
					updateReady: !!info?.updateReady,
					version: info?.version ?? '',
					hash: info?.hash ?? '',
					error: result?.error || undefined,
				}
			},
			downloadUpdate: async () => {
				await Updater.downloadUpdate()
			},
			applyUpdate: async () => {
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

// Initialize swap tracker with typed RPC message sender
// FAIL FAST: If Pioneer SDK doesn't have swap tracking methods, crash the app
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

// Push engine events to WebView
engine.on('state-change', (state) => {
	try { rpc.send['device-state'](state) } catch { /* webview not ready yet */ }
	if (state.state === 'disconnected') { btcAccounts.reset(); evmAddresses.reset() }
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
Updater.onStatusChange((entry: any) => {
	try {
		const status = entry.status || ''
		const now = Date.now()
		// Debounce: skip duplicate error statuses within 5 seconds
		if ((status === 'error' || status === 'download-error') && status === lastUpdateStatus && now - lastUpdateStatusTime < 5000) return
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

// ── Application Menu (required for Cmd+C/V clipboard in WKWebView) ──
ApplicationMenu.setApplicationMenu([
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

let _mainWindow: BrowserWindow | null = null
const mainWindow = new BrowserWindow({
	title: "KeepKey Vault",
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

// Start engine (USB event listeners + initial device sync)
await engine.start()

// Zcash sidecar is started lazily on first zcash RPC call (requires firmware >= 7.11.0)

// Cache app version for REST health endpoint
Updater.localInfo.version().then(v => { appVersionCache = v }).catch(() => {})

// Background update check (skip in dev, delay to let webview initialize)
Updater.localInfo.channel().then(ch => {
	if (ch !== 'dev') {
		setTimeout(() => {
			Updater.checkForUpdate().catch(e => console.warn('[Vault] Update check failed:', e.message))
		}, 5000)
	}
})

// ── keepkey:// Protocol Handler ────────────────────────────────────────
function getWalletConnectUri(inputUri: string): string | undefined {
	const uri = inputUri
		.replace('keepkey://launch/wc?uri=', '')
		.replace('keepkey://wc?uri=', '')
	if (!uri.startsWith('wc')) return undefined
	return decodeURIComponent(uri.replace('wc/?uri=', '').replace('wc?uri=', ''))
}

mainWindow.on("open-url", (e: any) => {
	const url = typeof e === 'string' ? e : e?.data?.url || e?.url || ''
	if (url.startsWith('keepkey://')) {
		const wcUri = getWalletConnectUri(url)
		if (wcUri) {
			try { rpc.send['walletconnect-uri'](wcUri) } catch { /* webview not ready */ }
		}
	}
})

// Cleanup and quit helper — shared between window close and app quit
let quitting = false
function cleanupAndQuit() {
	if (quitting) return
	quitting = true
	stopCamera()
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

console.log("KeepKey Vault started!")
