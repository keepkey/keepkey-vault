import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun"
import { EngineController } from "./engine-controller"
import { startRestApi } from "./rest-api"
import { getPioneer } from "./pioneer"
import { buildTx, broadcastTx } from "./txbuilder"
import { CHAINS } from "../shared/chains"
import type { ChainBalance, TokenBalance } from "../shared/types"
import type { VaultRPCSchema } from "../shared/rpc-schema"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`
const REST_API_PORT = 1646

// ── Engine Controller ─────────────────────────────────────────────────
const engine = new EngineController()

// ── REST API Server (opt-in via KEEPKEY_REST_API env) ──────────────────
const enableRest = process.env.KEEPKEY_REST_API === "true" || process.env.KEEPKEY_REST_API === "1"
const restServer = enableRest ? startRestApi(engine, REST_API_PORT) : null
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
				const utxoChains = CHAINS.filter(c => c.chainFamily === 'utxo')
				const nonUtxoChains = CHAINS.filter(c => c.chainFamily !== 'utxo')

				// 1. Batch-fetch ALL UTXO xpubs in a single device call
				const xpubResults = utxoChains.length > 0
					? await wallet.getPublicKeys(utxoChains.map(c => ({
						addressNList: c.defaultPath.slice(0, 3),
						coin: c.coin,
						scriptType: c.scriptType,
						curve: 'secp256k1',
					})))
					: []

				// 2. Derive non-UTXO addresses (one device call per chain — unavoidable)
				const pubkeys: Array<{ caip: string; pubkey: string; chainId: string; symbol: string }> = []

				for (let i = 0; i < utxoChains.length; i++) {
					const xpub = xpubResults?.[i]?.xpub
					if (xpub) pubkeys.push({ caip: utxoChains[i].caip, pubkey: xpub, chainId: utxoChains[i].id, symbol: utxoChains[i].symbol })
				}

				for (const chain of nonUtxoChains) {
					try {
						const addrParams: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.coin }
						if (chain.scriptType) addrParams.scriptType = chain.scriptType
						const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
						const result = await wallet[method](addrParams)
						const address = typeof result === 'string' ? result : result?.address || ''
						if (address) pubkeys.push({ caip: chain.caip, pubkey: address, chainId: chain.id, symbol: chain.symbol })
					} catch (e: any) {
						console.warn(`[getBalances] ${chain.coin} address failed:`, e.message)
					}
				}

				console.log(`[getBalances] ${pubkeys.length} pubkeys → single GetPortfolioBalances call`)

				// 3. Single API call for ALL balances + prices
				const results: ChainBalance[] = []
				try {
					const resp = await pioneer.GetPortfolioBalances({
						pubkeys: pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey }))
					})
					const portfolio = resp?.data || {}
					const data: any[] = portfolio.balances || []
					console.log(`[getBalances] Portfolio response: ${data.length} balances`)
					for (const entry of pubkeys) {
						const match = data.find((d: any) => d.caip === entry.caip || d.pubkey === entry.pubkey)
						// Extract token balances: entries sharing same pubkey but different caip
						const tokens: TokenBalance[] = data
							.filter((d: any) => {
								if (!d.caip || d.caip === entry.caip) return false
								return d.pubkey === entry.pubkey || d.address === (match?.address || entry.pubkey)
							})
							.map((d: any) => ({
								symbol: d.symbol || '???',
								name: d.name || d.symbol || 'Unknown Token',
								balance: String(d.balance ?? '0'),
								balanceUsd: Number(d.valueUsd ?? 0),
								caip: d.caip,
								contractAddress: d.contractAddress,
							}))
							.filter((t: TokenBalance) => parseFloat(t.balance) > 0)
						results.push({
							chainId: entry.chainId, symbol: entry.symbol,
							balance: String(match?.balance ?? '0'),
							balanceUsd: Number(match?.valueUsd ?? 0),
							address: match?.address || entry.pubkey,
							tokens: tokens.length > 0 ? tokens : undefined,
						})
					}
				} catch (e: any) {
					console.warn('[getBalances] Portfolio API failed:', e.message)
					for (const entry of pubkeys) {
						results.push({ chainId: entry.chainId, symbol: entry.symbol, balance: '0', balanceUsd: 0, address: entry.pubkey })
					}
				}
					return results
			},

			getBalance: async (params) => {
				if (!engine.wallet) throw new Error('No device connected')
				const chain = CHAINS.find(c => c.id === params.chainId)
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
					const addrParams: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.coin }
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
				const chain = CHAINS.find(c => c.id === params.chainId)
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
						coin: chain.coin,
					}
					if (chain.scriptType) addrParams.scriptType = chain.scriptType
					const walletMethod = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
					const addrResult = await wallet[walletMethod](addrParams)
					fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
				} else {
					const xpubResult = await wallet.getPublicKeys([{
						addressNList: chain.defaultPath.slice(0, 3),
						coin: chain.coin,
						scriptType: chain.scriptType,
						curve: 'secp256k1',
					}])
					xpub = xpubResult?.[0]?.xpub
				}

				const result = await buildTx(pioneer, chain, {
					...params,
					fromAddress,
					xpub,
				})

				return { unsignedTx: result.unsignedTx, fee: result.fee }
			},

			broadcastTx: async (params) => {
				const chain = CHAINS.find(c => c.id === params.chainId)
				if (!chain) throw new Error(`Unknown chain: ${params.chainId}`)
				const pioneer = await getPioneer()
				return await broadcastTx(pioneer, chain, params.signedTx)
			},

			getMarketData: async (params) => {
				const pioneer = await getPioneer()
				const resp = await pioneer.GetMarketInfo(params.caips)
				return resp?.data || []
			},

			getFees: async (params) => {
				const chain = CHAINS.find(c => c.id === params.chainId)
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
		},
		messages: {},
	},
})

// Push engine events to WebView
engine.on('state-change', (state) => {
	try { rpc.send['device-state'](state) } catch { /* webview not ready yet */ }
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
