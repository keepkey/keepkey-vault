import { BrowserView, BrowserWindow, Updater, Utils, ApplicationMenu } from "electrobun/bun"
import { EngineController } from "./engine-controller"
import { startRestApi } from "./rest-api"
import { AuthStore } from "./auth"
import { getPioneer } from "./pioneer"
import { buildTx, broadcastTx } from "./txbuilder"
import { CHAINS, customChainToChainDef } from "../shared/chains"
import type { ChainDef } from "../shared/chains"
import { BtcAccountManager } from "./btc-accounts"
import { initDb, getCustomTokens, addCustomToken as dbAddCustomToken, removeCustomToken as dbRemoveCustomToken, getCustomChains, addCustomChainDb, removeCustomChainDb } from "./db"
import { EVM_RPC_URLS, getTokenMetadata, broadcastEvmTx, getEvmBalance } from "./evm-rpc"
import { startCamera, stopCamera } from "./camera"
import type { ChainBalance, TokenBalance, CustomToken, CustomChain } from "../shared/types"
import type { VaultRPCSchema } from "../shared/rpc-schema"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`
const REST_API_PORT = 1646

// ── Engine Controller ─────────────────────────────────────────────────
const engine = new EngineController()
const btcAccounts = new BtcAccountManager()

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

/** Lookup RPC URL for a chain (custom chains store it, built-in chains use EVM_RPC_URLS) */
function getRpcUrl(chain: ChainDef): string | undefined {
	// Custom chains: find the stored entry
	const stored = getCustomChains().find(c => `evm-custom-${c.chainId}` === chain.id)
	if (stored) return stored.rpcUrl
	// Built-in chains: lookup from EVM_RPC_URLS
	return chain.chainId ? EVM_RPC_URLS[chain.chainId] : undefined
}

// ── REST API Server (opt-in via KEEPKEY_REST_API env) ──────────────────
const auth = new AuthStore()
const enableRest = process.env.KEEPKEY_REST_API === "true" || process.env.KEEPKEY_REST_API === "1"
const restServer = enableRest ? startRestApi(engine, auth, REST_API_PORT) : null
if (enableRest) console.log(`[Vault] REST API enabled on port ${REST_API_PORT}`)
else console.log("[Vault] REST API disabled (set KEEPKEY_REST_API=true to enable)")

// ── RPC Bridge (Electrobun UI ↔ Bun) ─────────────────────────────────
const rpc = BrowserView.defineRPC<VaultRPCSchema>({
	maxRequestTime: 600000, // device-interactive ops (recovery, create) can take 5-10 minutes
	handlers: {
		requests: {
			// ── Device lifecycle ──────────────────────────────────────
			getDeviceState: async () => engine.getDeviceState(),
			startBootloaderUpdate: async () => { await engine.startBootloaderUpdate() },
			startFirmwareUpdate: async () => { await engine.startFirmwareUpdate() },
			flashFirmware: async () => { await engine.flashFirmware() },
			resetDevice: async (params) => { await engine.resetDevice(params) },
			recoverDevice: async (params) => { await engine.recoverDevice(params) },
			verifySeed: async (params) => { return await engine.verifySeed(params) },
			applySettings: async (params) => { await engine.applySettings(params) },
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
				return await engine.wallet.btcGetAddress(params)
			},
			ethGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.ethGetAddress(params)
			},
			cosmosGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.cosmosGetAddress(params)
			},
			thorchainGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.thorchainGetAddress(params)
			},
			mayachainGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.mayachainGetAddress(params)
			},
			osmosisGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.osmosisGetAddress(params)
			},
			binanceGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.binanceGetAddress(params)
			},
			xrpGetAddress: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.rippleGetAddress(params)
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
			binanceSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.binanceSignTx(params)
			},
			xrpSignTx: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				return await engine.wallet.rippleSignTx(params)
			},

			// ── Pioneer integration (batch portfolio API) ────────────────
			getBalances: async () => {
				if (!engine.wallet) throw new Error('No device connected')
				const pioneer = await getPioneer()
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
				const xpubResults = utxoChains.length > 0
					? await wallet.getPublicKeys(utxoChains.map(c => ({
						addressNList: c.defaultPath.slice(0, 3),
						coin: c.coin,
						scriptType: c.scriptType,
						curve: 'secp256k1',
					})))
					: []

				// 2. Derive non-UTXO addresses (one device call per chain — unavoidable)
				const pubkeys: Array<{ caip: string; pubkey: string; chainId: string; symbol: string; networkId: string }> = []

				for (let i = 0; i < utxoChains.length; i++) {
					const xpub = xpubResults?.[i]?.xpub
					if (xpub) pubkeys.push({ caip: utxoChains[i].caip, pubkey: xpub, chainId: utxoChains[i].id, symbol: utxoChains[i].symbol, networkId: utxoChains[i].networkId })
				}

				// Cache EVM address — all EVM chains share m/44'/60'/0'/0/0
				let cachedEvmAddress: string | null = null
				for (const chain of nonUtxoChains) {
					try {
						if (chain.chainFamily === 'evm') {
							if (!cachedEvmAddress) {
								const result = await wallet.ethGetAddress({ addressNList: chain.defaultPath, showDisplay: false, coin: 'Ethereum' })
								cachedEvmAddress = typeof result === 'string' ? result : result?.address || ''
							}
							if (cachedEvmAddress) pubkeys.push({ caip: chain.caip, pubkey: cachedEvmAddress, chainId: chain.id, symbol: chain.symbol, networkId: chain.networkId })
							continue
						}
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
				const btcPubkeyEntries = btcAccounts.getAllPubkeyEntries(btcChain.caip)
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

				// 3. Single API call for ALL balances + prices
				const results: ChainBalance[] = []
				try {
					const resp = await pioneer.GetPortfolioBalances({
						pubkeys: pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey }))
					})
					// Handle Swagger double-wrapping: resp.data?.data || resp.data
					const rawData = resp?.data?.data || resp?.data || {}
					const data: any[] = rawData.balances || []

					// Separate native balances from token entries
					const nativeEntries: any[] = []
					const tokenEntries: any[] = []
					for (const d of data) {
						const caip = d.caip || ''
						if (caip.includes('/erc20:') || (d.type === 'token' && !d.isNative)) {
							tokenEntries.push(d)
						} else {
							nativeEntries.push(d)
						}
					}

					console.log(`[getBalances] Portfolio response: ${nativeEntries.length} natives, ${tokenEntries.length} tokens`)

					// Group tokens by their parent chain (via networkId or CAIP prefix)
					const tokensByChainId = new Map<string, TokenBalance[]>()
					for (const tok of tokenEntries) {
						const bal = parseFloat(String(tok.balance ?? '0'))
						if (bal <= 0) continue

						// Determine parent chainId from networkId or CAIP-2 prefix
						const tokNetworkId = tok.networkId || ''
						const caipPrefix = (tok.caip || '').split('/')[0] // e.g. "eip155:1"
						const parentChainId = networkToChain.get(tokNetworkId) || networkToChain.get(caipPrefix) || null
						if (!parentChainId) continue // skip tokens for chains we don't track

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
					let btcTotalBalance = 0
					let btcTotalUsd = 0
					let btcAddress = ''

					for (const entry of pubkeys) {
						if (entry.chainId === 'bitcoin') {
							// Find the Pioneer response for this xpub
							const match = nativeEntries.find((d: any) => d.pubkey === entry.pubkey)
								|| nativeEntries.find((d: any) => d.caip === entry.caip && d.address === entry.pubkey)
							const bal = parseFloat(String(match?.balance ?? '0'))
							const usd = Number(match?.valueUsd ?? 0)
							btcTotalBalance += bal
							btcTotalUsd += usd
							if (!btcAddress && match?.address) btcAddress = match.address
							// Update per-xpub balance in BtcAccountManager
							btcAccounts.updateXpubBalance(entry.pubkey, String(match?.balance ?? '0'), usd)
							continue
						}

						const match = nativeEntries.find((d: any) => d.caip === entry.caip)
							|| nativeEntries.find((d: any) => d.pubkey === entry.pubkey)
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
					const resp = await pioneer.GetPortfolioBalances({ pubkeys: [{ caip: chain.caip, pubkey }] })
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

				if (chain.chainFamily !== 'utxo') {
					const addrParams: any = {
						addressNList: chain.defaultPath,
						showDisplay: false,
						coin: chain.chainFamily === 'evm' ? 'Ethereum' : chain.coin,
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
				const result = await buildTx(pioneer, chain, {
					...params,
					fromAddress,
					xpub,
					rpcUrl,
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
					const serialized = params.signedTx?.serializedTx || params.signedTx
					if (!serialized || typeof serialized !== 'string') throw new Error('Cannot extract serialized tx')
					const txid = await broadcastEvmTx(rpcUrl, serialized)
					return { txid }
				}

				const pioneer = await getPioneer()
				return await broadcastTx(pioneer, chain, params.signedTx)
			},

			getMarketData: async (params) => {
				const pioneer = await getPioneer()
				const resp = await pioneer.GetMarketInfo(params.caips)
				return resp?.data || []
			},

			getFees: async (params) => {
				const chain = getAllChains().find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				const pioneer = await getPioneer()

				if (chain.chainFamily === 'utxo') {
					const resp = await pioneer.GetFeeRateByNetwork({ networkId: chain.networkId })
					return { feeRate: resp?.data, unit: 'sat/byte' }
				} else if (chain.chainFamily === 'evm') {
					const resp = await pioneer.GetGasPriceByNetwork({ networkId: chain.networkId })
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
					const resp = await pioneer.GetPubkeyInfo({ network: 'BTC', xpub })
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

			// ── Custom chains ────────────────────────────────────────
			addCustomChain: async (params) => {
				if (!params.chainId || params.chainId < 1) throw new Error('Invalid chainId')
				if (!params.name?.trim()) throw new Error('Chain name required')
				if (!params.symbol?.trim()) throw new Error('Gas token symbol required')
				if (!params.rpcUrl?.trim() || !params.rpcUrl.startsWith('http')) throw new Error('Valid RPC URL required')
				// Prevent duplicate built-in chains
				const existing = getAllChains().find(c => c.chainId === String(params.chainId))
				if (existing) throw new Error(`Chain ${params.chainId} already exists as ${existing.coin}`)
				addCustomChainDb(params)
				customChainDefs.push(customChainToChainDef(params))
			},
			removeCustomChain: async (params) => {
				removeCustomChainDb(params.chainId)
				customChainDefs = customChainDefs.filter(c => c.id !== `evm-custom-${params.chainId}`)
			},
			getCustomChains: async () => {
				return getCustomChains()
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

			// ── Utility ──────────────────────────────────────────────
			openUrl: async (params) => {
				if (!params.url || !params.url.startsWith('http')) throw new Error('Invalid URL')
				Bun.spawn(['open', params.url])
			},
		},
		messages: {},
	},
})

// Push engine events to WebView
engine.on('state-change', (state) => {
	try { rpc.send['device-state'](state) } catch { /* webview not ready yet */ }
	if (state.state === 'disconnected') btcAccounts.reset()
})
engine.on('firmware-progress', (progress) => {
	try { rpc.send['firmware-progress'](progress) } catch { /* webview not ready yet */ }
})
engine.on('pin-request', (req) => {
	try { rpc.send['pin-request'](req) } catch { /* webview not ready yet */ }
})
engine.on('character-request', (req) => {
	try { rpc.send['character-request'](req) } catch { /* webview not ready yet */ }
})
engine.on('recovery-error', (err) => {
	try { rpc.send['recovery-error'](err) } catch { /* webview not ready yet */ }
})

// BtcAccountManager change events → push to WebView
btcAccounts.on('change', (set) => {
	try { rpc.send['btc-accounts-update'](set) } catch { /* webview not ready yet */ }
})

// ── Window Setup ──────────────────────────────────────────────────────
async function getMainViewUrl(): Promise<string> {
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

const mainWindow = new BrowserWindow({
	title: "KeepKey Vault",
	url,
	rpc,
	frame: {
		width: 1200,
		height: 800,
		x: 100,
		y: 100,
	},
})

// Start engine (USB event listeners + initial device sync)
await engine.start()

// Quit the app when the main window is closed
mainWindow.on("close", () => {
	engine.stop()
	restServer?.stop()
	Utils.quit()
})

console.log("KeepKey Vault started!")
