/** Synthetic balance refresh only. No app DB, device or remote network. */
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CHAINS } from '../../../src/shared/chains'

const settings = {
  passwordManagerEnabled: false, moneroEnabled: false, moneroAvailable: false,
  zcashPrivacyEnabled: false, btcMultisigEnabled: false, walletConnectEnabled: false,
  emulatorEnabled: false, hiveEnabled: false, offlineMode: false, restApiEnabled: false,
  btcNodeEnabled: false, alphaFirmware: false, preReleaseUpdates: false,
  privateModeEnabled: false, passphraseIntroShown: true, networksChosen: true,
  fiatCurrency: 'USD', numberLocale: 'en-US', appLanguage: 'en',
  disabledNetworks: CHAINS.filter(c => !['bitcoin', 'ethereum'].includes(c.id)).map(c => c.id),
}
const row = (chainId: string, balance = '0', syncState = 'confirmed') => ({
  chainId, symbol: chainId === 'bitcoin' ? 'BTC' : 'ETH', balance,
  balanceUsd: Number(balance) * (chainId === 'bitcoin' ? 60000 : 2500),
  nativeBalanceUsd: Number(balance) * (chainId === 'bitcoin' ? 60000 : 2500),
  address: chainId === 'bitcoin' ? 'bc1qSyntheticBalanceFixture' : '0x000000000000000000000000000000000000dEaD',
  tokens: [], syncState, updatedAt: Date.now() - 60000,
})
type Call = { method: string; params?: unknown; blocked?: boolean; error?: string }
let scenario = 'cached-zero'
let calls: Call[] = []
let pending: ((response: Response) => void) | undefined
const cached = () => scenario === 'cold-empty' ? []
  : scenario === 'all-cached' ? [row('bitcoin'), row('ethereum')]
  : [row('bitcoin', scenario === 'cached-positive' ? '0.5' : '0')]
const rpc = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(req) {
  const { method, params } = await req.json()
  const call: Call = { method, params }; calls.push(call)
  try {
    let payload: unknown = {}
    switch (method) {
      case 'testReset':
        pending?.(Response.json({ success: false, error: 'Synthetic fixture reset' })); pending = undefined
        scenario = params?.scenario || 'cached-zero'; calls = []; break
      case 'testState': payload = { scenario, calls, pending: !!pending, settings }; break
      case 'testCalls': payload = [...calls]; break
      case 'testCompleteRefresh': {
        if (!pending) throw new Error('No synthetic refresh is pending')
        const complete = pending; pending = undefined
        complete(params?.error ? Response.json({ success: false, error: 'Synthetic balance refresh failed' })
          : Response.json({ success: true, payload: params?.rows || [row('bitcoin'), row('ethereum')] }))
        payload = { completed: true }; break
      }
      case 'getBalances':
        if (pending) throw new Error('Only one synthetic refresh may run')
        return new Promise<Response>(complete => { pending = complete })
      case 'getCachedBalances': payload = { balances: cached(), updatedAt: Date.now() - 60000, staleReasons: ['missing-chain'] }; break
      case 'getAppSettings': payload = settings; break
      case 'getDeviceState': payload = { state: 'ready', initialized: true, firmwareVersion: '7.17.0', label: 'Synthetic balance QA' }; break
      case 'getFeatures': payload = { initialized: true, pinProtection: true, majorVersion: 7, minorVersion: 17, patchVersion: 0 }; break
      case 'getBtcAccounts': payload = { accounts: [], totalBalance: '0', totalBalanceUsd: 0 }; break
      case 'getEvmAddresses': payload = { addresses: [], selectedIndex: 0, totalBalanceUsd: 0 }; break
      case 'getTokenVisibilityMap': case 'getMarketData': payload = {}; break
      case 'getVaultPortfolios': case 'getCustomChains': case 'getPendingSwaps':
      case 'getRecentActivity': case 'getCustomTokens': case 'listSavedVaults': payload = []; break
      default: call.blocked = true; throw new Error(`Native RPC disabled in balance QA: ${method}`)
    }
    return Response.json({ success: true, payload })
  } catch (error: any) { call.error = error.message; return Response.json({ success: false, error: error.message }) }
} })
const source = resolve(import.meta.dir, '../../../src/mainview/components/Dashboard.tsx')
const baselineFile = process.env.QA_BALANCE_BASELINE_FILE
const baselinePlugin = { name: 'qa-balance-baseline', enforce: 'pre' as const,
  load(id: string) { if (baselineFile && id.split('?')[0] === source) return readFileSync(baselineFile, 'utf8') } }
const port = Number(process.env.BALANCE_QA_PORT || 5205)
const vite = await createServer({ configFile: false, plugins: [baselinePlugin, react()], root: import.meta.dir,
  server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [new URL('../../../..', import.meta.url).pathname] },
    proxy: { '/__test_rpc': `http://127.0.0.1:${rpc.port}` } } })
await vite.listen()
console.log(`Synthetic Bitcoin balance refresh QA: http://127.0.0.1:${port}`)
