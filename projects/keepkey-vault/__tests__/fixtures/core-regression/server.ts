/** In-memory core-flow QA. No app DB, device, credentials, seeds or network clients. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CHAINS } from '../../../src/shared/chains'

const addresses = { bitcoin: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', ethereum: '0x000000000000000000000000000000000000dEaD', zcash: 't1' + 'A'.repeat(33) }
const balances = [
  { chainId: 'bitcoin', symbol: 'BTC', balance: '0.25', balanceUsd: 16250, nativeBalanceUsd: 16250, priceUsd: 65000, address: addresses.bitcoin, tokens: [], syncState: 'confirmed', updatedAt: Date.now() },
  { chainId: 'ethereum', symbol: 'ETH', balance: '2', balanceUsd: 5000, nativeBalanceUsd: 5000, priceUsd: 2500, address: addresses.ethereum, tokens: [], syncState: 'confirmed', updatedAt: Date.now() },
  { chainId: 'zcash', symbol: 'ZEC', balance: '1.25', balanceUsd: 50, nativeBalanceUsd: 50, priceUsd: 40, address: addresses.zcash, tokens: [], syncState: 'confirmed', updatedAt: Date.now() },
]
const settings = {
  passwordManagerEnabled: false, moneroEnabled: false, moneroAvailable: false,
  zcashPrivacyEnabled: false, btcMultisigEnabled: false, walletConnectEnabled: false,
  emulatorEnabled: false, hiveEnabled: false, offlineMode: false, restApiEnabled: false,
  btcNodeEnabled: false, btcNodeType: 'blockbook', btcNodeUrl: '', btcOnboardingShown: true,
  preReleaseUpdates: false, alphaFirmware: false, addressBookClearsignEnabled: false,
  privateModeEnabled: false, passphraseIntroShown: true, networksChosen: true,
  moneroDaemonUrl: 'http://127.0.0.1:18081', moneroNodeMode: 'local', moneroRestoreHeight: 0,
  pioneerApiBase: 'http://127.0.0.1:5201', pioneerServers: [], activePioneerServer: '',
  fiatCurrency: 'USD', numberLocale: 'en-US', appLanguage: 'en', evmSimulationRpcUrls: {},
  disabledNetworks: CHAINS.filter(c => !['bitcoin', 'ethereum', 'zcash'].includes(c.id)).map(c => c.id),
}
const device = { state: 'ready', activeTransport: 'webusb', updatePhase: 'idle', bootloaderMode: false, initialized: true, needsInit: false, needsBootloaderUpdate: false, needsFirmwareUpdate: false, isOob: false, isEmulator: false, firmwareVersion: '7.17.0', label: 'Synthetic regression wallet' }
const assets = [
  { asset: 'BTC.BTC', chainId: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', chainFamily: 'utxo', decimals: 8, caip: CHAINS.find(c => c.id === 'bitcoin')!.caip },
  { asset: 'ETH.ETH', chainId: 'ethereum', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: CHAINS.find(c => c.id === 'ethereum')!.caip },
  { asset: 'ZEC.ZEC', chainId: 'zcash', symbol: 'ZEC', name: 'Zcash', chainFamily: 'utxo', decimals: 8, caip: CHAINS.find(c => c.id === 'zcash')!.caip },
]
let scenario = 'normal'
let calls: { method: string; params?: unknown; blocked?: boolean; fixtureOnly?: boolean; error?: string }[] = []
let pendingExecution: { params: any; complete: (response: Response) => void } | null = null
let pendingSwaps: any[] = []
let swapUi: unknown = null
const blocked = /(?:sign|broadcast|executeSwap|wipe|factoryReset|recovery|recoverDevice|resetDevice|loadDevice|seed|applyPolicy|applySettings|changePin|verifySeed|setMonero|setPasswordManager|setEmulator|setBtcMultisig|setWalletConnect)/i
const never = () => new Promise<Response>(() => {})
const rpc = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(req) {
  const { method, params: p } = await req.json()
  const call = { method, params: p } as typeof calls[number]; calls.push(call)
  const fromHeader = req.headers.get('X-Fixture-Scenario')
  const mode = fromHeader && fromHeader !== 'normal' ? fromHeader : scenario
  try {
    let payload: unknown = {}
    if (method === 'executeSwap' && mode === 'execute-stall') {
      call.fixtureOnly = true
      if (pendingExecution) throw new Error('A synthetic execution is already pending')
      return new Promise<Response>(complete => { pendingExecution = { params: p, complete } })
    }
    if (blocked.test(method) && !['getDeviceState', 'getFeatures', 'cancelDeviceSigning'].includes(method)) {
      call.blocked = true
      throw new Error('Signing, broadcasts, wallet changes and optional features are disabled in core QA')
    }
    switch (method) {
      case 'testReset': pendingExecution?.complete(Response.json({ success: false, error: 'Synthetic fixture reset' })); pendingExecution = null; pendingSwaps = []; scenario = p?.scenario || 'normal'; calls = []; swapUi = null; break
      case 'testSetScenario': scenario = p?.scenario || 'normal'; break
      case 'testCalls': payload = [...calls]; break
      case 'testState': payload = { scenario, settings, calls, swapUi, pendingExecution: !!pendingExecution, pendingSwaps }; break
      case 'testFinishExecution': {
        if (!pendingExecution) throw new Error('No synthetic execution is pending')
        const execution = pendingExecution; pendingExecution = null
        const terms = execution.params
        const from = assets.find(a => a.chainId === terms.fromChainId) || assets[1], to = assets.find(a => a.chainId === terms.toChainId) || assets[0]
        const receipt = { txid: 'e'.repeat(64), fromChainId: from.chainId, toChainId: to.chainId, fromAsset: from.asset, toAsset: to.asset, fromCaip: from.caip, toCaip: to.caip, fromSymbol: from.symbol, toSymbol: to.symbol, fromAmount: terms.amount, expectedOutput: terms.expectedOutput, status: 'pending', confirmations: 0, requiredConfirmations: 1, createdAt: Date.now(), integration: 'thorchain', fixtureOnly: true }
        pendingSwaps.push(receipt)
        execution.complete(Response.json({ success: true, payload: { txid: receipt.txid } }))
        payload = { saved: true, txid: receipt.txid }; break
      }
      case 'getPendingSwaps': payload = pendingSwaps; break
      case 'refreshSwap': case 'getSwapByTxid': payload = pendingSwaps.find(s => s.txid === p.txid) || null; break
      case 'testSwapState': payload = swapUi; break
      case 'getAppSettings': payload = settings; break
      case 'getDeviceState': payload = device; break
      case 'getFeatures': payload = { label: device.label, majorVersion: 7, minorVersion: 17, patchVersion: 0, initialized: true, pinProtection: true, passphraseProtection: false, policiesList: [], supportsTaproot: false }; break
      case 'getWindowFocusState': payload = { refs: 0, alwaysOnTop: false }; break
      case 'getSwappableChainIds': payload = ['bitcoin', 'ethereum', 'zcash']; break
      case 'getSwapAssets': if (mode === 'assets-stall') return never(); if (mode === 'assets-error') throw new Error('Synthetic swap assets unavailable'); payload = assets; break
      case 'getSwapHealth': payload = { fetchedAt: Date.now(), integrations: [{ key: 'thorchain', label: 'THORChain', status: 'ok' }, { key: 'mayachain', label: 'Maya', status: 'ok' }] }; break
      case 'getCachedBalances': payload = mode === 'missing-balances' ? null : { balances, updatedAt: Date.now(), staleReasons: [] }; break
      case 'getBalances': if (mode === 'balance-error') throw new Error('Synthetic balance refresh unavailable'); payload = mode === 'missing-balances' ? [] : balances; break
      case 'getBalance': if (['balance-error', 'missing-balances'].includes(mode)) throw new Error('Synthetic chain balance unavailable'); payload = balances.find(b => b.chainId === p.chainId) || balances[1]; break
      case 'getMarketData': payload = Object.fromEntries(balances.map(b => [assets.find(a => a.chainId === b.chainId)!.caip!, { priceUsd: b.priceUsd, changePercent24Hr: 0 }])); break
      case 'getBtcAccounts': payload = { accounts: [{ accountIndex: 0, xpubs: [{ scriptType: 'p2wpkh', purpose: 84, path: [2147483732, 2147483648, 2147483648], xpub: 'zpubSyntheticRegressionFixtureNotForSigning', xpubPrefix: 'zpub', balance: '0.25', balanceUsd: 16250 }], totalBalanceUsd: 16250 }], totalBalanceUsd: 16250, totalBalance: '0.25', selectedXpub: { accountIndex: 0, scriptType: 'p2wpkh' } }; break
      case 'getEvmAddresses': payload = { addresses: [{ addressIndex: 0, address: addresses.ethereum, balanceUsd: 5000, chainBalances: { ethereum: balances[1] } }], selectedIndex: 0, totalBalanceUsd: 5000 }; break
      case 'getUtxoAccounts': payload = { accounts: [0] }; break
      case 'getBtcAddressIndices': payload = { receiveIndex: 0, changeIndex: 0, discoveryAvailable: true, source: 'pioneer' }; break
      case 'getPublicKeys': payload = [{ xpub: 'zpubSyntheticRegressionFixtureNotForSigning' }]; break
      case 'btcGetAddress': payload = { address: p?.coin === 'Zcash' ? addresses.zcash : addresses.bitcoin }; break
      case 'ethGetAddress': payload = { address: addresses.ethereum }; break
      case 'getRecentActivity': case 'getCustomTokens': case 'getCustomChains': case 'listSavedVaults': case 'getVaultPortfolios': case 'getSwapHistory': case 'listRegisteredDevices': case 'listEmulatorWallets': case 'getPairedApps': case 'getPioneerServers': case 'getAddressBook': payload = []; break
      case 'getSwapHistoryStats': payload = { totalSwaps: pendingSwaps.length, completed: 0, pending: pendingSwaps.length, failed: 0, refunded: 0 }; break
      case 'getTokenVisibilityMap': payload = {}; break
      case 'getActivityScanState': payload = { running: false }; break
      case 'checkVaultDestination': payload = { valid: true }; break
      case 'matchAddress': payload = null; break
      case 'buildTx': if (mode === 'build-error') throw new Error('Synthetic transaction build failed'); payload = { unsignedTx: { to: p.to, value: '0x' + BigInt(Math.round(Number(p.amount) * 1e18)).toString(16), gasLimit: '0x5208', gasPrice: '0x3b9aca00', chainId: 1, data: '0x', fixtureOnly: true }, fee: '0.000021', feeUsd: 0.0525 }; break
      case 'getSwapQuote': {
        if (mode === 'quote-stall') return never()
        if (mode === 'quote-error') throw new Error('Synthetic swap quote unavailable')
        const from = assets.find(a => a.caip === p.fromCaip)!, to = assets.find(a => a.caip === p.toCaip)!
        const fromPrice = balances.find(b => b.chainId === from?.chainId)?.priceUsd || 1, toPrice = balances.find(b => b.chainId === to?.chainId)?.priceUsd || 1
        const output = Number(p.amount) * fromPrice / toPrice * .995
        payload = { quoteId: 'synthetic-core-quote', quoteCreatedAt: Date.now(), quoteExpiresAt: Date.now() + 60000, expectedOutput: String(output), minimumOutput: String(output * .99), minimumOutputSource: 'quote', requestedSlippageBps: 100, inboundAddress: addresses.ethereum, memo: 'SYNTHETIC CORE QA ONLY', fees: { affiliate: '0', outbound: '0.00001', totalBps: 50 }, estimatedTime: 60, slippageBps: 50, integration: 'thorchain' }; break
      }
      case 'previewSwapBuild': if (mode === 'preview-stall') return never(); if (mode === 'preview-error') throw new Error('Synthetic swap preview unavailable'); payload = { unsignedTx: { to: addresses.ethereum, value: '0x16345785d8a0000', data: '0x', gasLimit: '0x5208', gasPrice: '0x3b9aca00', chainId: 1, fixtureOnly: true }, balance: { current: '2', required: '0.1', sufficient: true } }; break
      case 'publishSwapUiState': swapUi = p; break
      case 'setBtcSelectedXpub': case 'setEvmSelectedIndex': case 'cancelDeviceSigning': payload = { ok: true }; break
      case 'openUrl': case 'openExternal': payload = { opened: false, fixtureOnly: true }; break
      default: call.error = 'Unhandled synthetic RPC'; throw new Error(`Unhandled synthetic RPC: ${method}`)
    }
    return Response.json({ success: true, payload })
  } catch (error: any) { call.error = error.message; return Response.json({ success: false, error: error.message }) }
} })
const port = Number(process.env.CORE_QA_PORT || 5201)
const swapSource = resolve(import.meta.dir, '../../../src/mainview/components/SwapDialog.tsx')
const baselineFile = process.env.QA_SWAP_BASELINE_FILE
const baselinePlugin = { name: 'qa-swap-baseline', enforce: 'pre' as const, load(id: string) { if (baselineFile && id.split('?')[0] === swapSource) return readFileSync(baselineFile, 'utf8') } }
const vite = await createServer({ configFile: false, plugins: [baselinePlugin, react()], root: import.meta.dir, server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [new URL('../../../..', import.meta.url).pathname] }, proxy: { '/__test_rpc': `http://127.0.0.1:${rpc.port}` } } })
await vite.listen()
console.log(`Synthetic core regression fixture: http://127.0.0.1:${port}`)
