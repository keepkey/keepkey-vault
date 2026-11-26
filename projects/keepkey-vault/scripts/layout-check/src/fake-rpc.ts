// Scripted Bun side for layout runs: no device, no network.
const w = window as any
w.__listeners = w.__listeners || {}
w.__calls = w.__calls || []
const owner = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
export const ethEth = { asset: 'ETH.ETH', chainId: 'ethereum', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:1/slip44:60' }
export const baseEth = { asset: 'BASE.ETH', chainId: 'base', symbol: 'ETH', name: 'Ethereum', chainFamily: 'evm', decimals: 18, caip: 'eip155:8453/slip44:60' }
export const arbUsdc = { asset: 'ARB.USDC', chainId: 'arbitrum', symbol: 'USDC', name: 'USD Coin', chainFamily: 'evm', decimals: 6, caip: 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831', contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' }
export const ethUsdc = { asset: 'ETH.USDC', chainId: 'ethereum', symbol: 'USDC', name: 'USD Coin', chainFamily: 'evm', decimals: 6, caip: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }
export const btc = { asset: 'BTC.BTC', chainId: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', chainFamily: 'utxo', decimals: 8, caip: 'bip122:000000000019d6689c085ae165831e93/slip44:0' }
export const ASSETS = [ethEth, baseEth, arbUsdc, ethUsdc, btc]
let serial = 0
const quote = (p: any) => ({
  expectedOutput: '0.00995', minimumOutput: '0.0098', inboundAddress: '0x4cd00e387622c35bddb9b4c962c136462338bc31', memo: '',
  fees: { affiliate: '0', outbound: '0', totalBps: 0 }, estimatedTime: 30, slippageBps: 50,
  integration: 'near-intents', swapper: 'near-intents', executionMode: 'deposit',
  quoteId: `quote-${++serial}`, quoteCreatedAt: Date.now(), quoteExpiresAt: Date.now() + 600_000,
  risk: { tier: 'small', blocked: false, warning: false, requiresAcknowledgment: false, quoteMaxAgeMs: 600_000, allowancePct: 1, inputUsd: 31.2, expectedUsd: 31.05, minimumUsd: 30.6, expectedLossPct: 0.48, expectedLossUsd: 0.15 },
  toAddress: p?.toAddress,
})
const magiQuote = { quoteId: 'q1', provider: 'Magi', route: { from: 'HIVE', to: 'HBD', kind: 'hive-ops' }, username: 'vladtest',
  amountIn: '10.000', expectedOut: '2.400', minOut: '2.388', referralBps: 0, hops: 1, recipient: 'hive:vladtest', simDeferred: true }
export async function rpcRequest(method: string, params?: any): Promise<any> {
  w.__calls.push(method)
  switch (method) {
    case 'getSwapAssets': return ASSETS
    case 'getBalances': return [
      { chainId: 'ethereum', symbol: 'ETH', balance: '0.5', balanceUsd: 1560, nativeBalanceUsd: 1560, address: owner, tokens: [{ caip: ethUsdc.caip, symbol: 'USDC', name: 'USD Coin', balance: '120.5', balanceUsd: 120.5, decimals: 6 }] },
      { chainId: 'base', symbol: 'ETH', balance: '0.12', balanceUsd: 374, nativeBalanceUsd: 374, address: owner },
      { chainId: 'bitcoin', symbol: 'BTC', balance: '0.031', balanceUsd: 2900, nativeBalanceUsd: 2900, address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
    ]
    case 'getCustomTokens': return []
    case 'getCachedBalances': return null
    case 'getSwapHealth': return { fetchedAt: Date.now(), integrations: [{ key: 'relay', label: 'Relay', status: 'ok', detail: 'Quoting' }, { key: 'thorchain', label: 'THORChain', status: 'degraded', haltedPools: ['eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7'], detail: '1 pool halted' }, { key: 'near-intents', label: 'NEAR Intents', status: 'ok', checkScope: 'quote', checkedAt: Date.now() }] }
    case 'getSwapQuote': return quote(params)
    case 'previewSwapBuild': return { unsignedTx: { chainId: 1, to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0x', value: '0x2386f26fc10000', gasLimit: '0x5208', maxFeePerGas: '0x6fc23ac00', nonce: '0x1' } }
    case 'executeSwap': return new Promise(() => {})
    case 'verifyTokenBalance': return { balance: '0.5' }
    case 'searchSwapAssets': return []
    case 'magiCapability': return { capability: 'supported' }
    case 'magiBalance': return { username: 'vladtest', hive: '12.500', hbd: '0.000' }
    case 'magiRecords': return []
    case 'magiQuote': return magiQuote
    case 'btcGetAddress': return { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }
    default: return {}
  }
}
export function rpcFire(method: string, payload: any) { if (method === 'publishSwapUiState') w.__swapState = payload }
export function onRpcMessage(name: string, handler: (m: any) => void) { w.__listeners[name] = handler; return () => { if (w.__listeners[name] === handler) delete w.__listeners[name] } }
export async function rpcRequestWithTimeout(method: string, params?: any) { return rpcRequest(method, params) }
export function dispatchLocalRpcMessage(name: string, payload: any) { w.__listeners[name]?.(payload) }
