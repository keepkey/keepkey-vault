import { Chain, ChainToNetworkId, ChainToCaip, BaseDecimal } from '@pioneer-platform/pioneer-caip'

export interface ChainDef {
  id: string
  chain: string           // Chain enum value: 'BTC', 'ETH', 'GAIA', etc.
  coin: string            // KeepKey hdwallet coin name
  symbol: string          // Display symbol: 'BTC', 'ATOM', 'RUNE'
  networkId: string       // CAIP-2 (derived from pioneer-caip)
  caip: string            // CAIP-19 (derived from pioneer-caip)
  decimals: number        // Base decimals (derived from pioneer-caip)
  chainFamily: 'utxo' | 'evm' | 'cosmos' | 'binance' | 'xrp'
  color: string
  rpcMethod: string
  signMethod: string
  defaultPath: number[]
  scriptType?: string
  denom?: string
  chainId?: string
}

// Minimal per-chain config — everything else derived from pioneer-caip
type ChainConfig = Omit<ChainDef, 'networkId' | 'caip' | 'decimals'>

const CONFIGS: ChainConfig[] = [
  {
    id: 'bitcoin', chain: Chain.Bitcoin, coin: 'Bitcoin', symbol: 'BTC',
    chainFamily: 'utxo', color: '#F7931A',
    rpcMethod: 'btcGetAddress', signMethod: 'btcSignTx',
    defaultPath: [0x8000002C, 0x80000000, 0x80000000, 0, 0], scriptType: 'p2wpkh',
  },
  {
    id: 'ethereum', chain: Chain.Ethereum, coin: 'Ethereum', symbol: 'ETH',
    chainFamily: 'evm', color: '#627EEA',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '1',
  },
  {
    id: 'cosmos', chain: Chain.Cosmos, coin: 'Cosmos', symbol: 'ATOM',
    chainFamily: 'cosmos', color: '#2E3148',
    rpcMethod: 'cosmosGetAddress', signMethod: 'cosmosSignTx',
    defaultPath: [0x8000002C, 0x80000076, 0x80000000, 0, 0],
    denom: 'uatom', chainId: 'cosmoshub-4',
  },
  {
    id: 'thorchain', chain: Chain.THORChain, coin: 'THORChain', symbol: 'RUNE',
    chainFamily: 'cosmos', color: '#23DCC8',
    rpcMethod: 'thorchainGetAddress', signMethod: 'thorchainSignTx',
    defaultPath: [0x8000002C, 0x800003A3, 0x80000000, 0, 0],
    denom: 'rune', chainId: 'thorchain-1',
  },
  {
    id: 'mayachain', chain: Chain.Mayachain, coin: 'Mayachain', symbol: 'CACAO',
    chainFamily: 'cosmos', color: '#3B82F6',
    rpcMethod: 'mayachainGetAddress', signMethod: 'mayachainSignTx',
    defaultPath: [0x8000002C, 0x800003A3, 0x80000000, 0, 0],
    denom: 'cacao', chainId: 'mayachain-mainnet-v1',
  },
  {
    id: 'osmosis', chain: Chain.Osmosis, coin: 'Osmosis', symbol: 'OSMO',
    chainFamily: 'cosmos', color: '#750BBB',
    rpcMethod: 'osmosisGetAddress', signMethod: 'osmosisSignTx',
    defaultPath: [0x8000002C, 0x80000076, 0x80000000, 0, 0],
    denom: 'uosmo', chainId: 'osmosis-1',
  },
  {
    id: 'litecoin', chain: Chain.Litecoin, coin: 'Litecoin', symbol: 'LTC',
    chainFamily: 'utxo', color: '#BFBBBB',
    rpcMethod: 'btcGetAddress', signMethod: 'btcSignTx',
    defaultPath: [0x8000002C, 0x80000002, 0x80000000, 0, 0], scriptType: 'p2wpkh',
  },
  {
    id: 'dogecoin', chain: Chain.Dogecoin, coin: 'Dogecoin', symbol: 'DOGE',
    chainFamily: 'utxo', color: '#C2A633',
    rpcMethod: 'btcGetAddress', signMethod: 'btcSignTx',
    defaultPath: [0x8000002C, 0x80000003, 0x80000000, 0, 0], scriptType: 'p2pkh',
  },
  {
    id: 'bitcoincash', chain: Chain.BitcoinCash, coin: 'BitcoinCash', symbol: 'BCH',
    chainFamily: 'utxo', color: '#0AC18E',
    rpcMethod: 'btcGetAddress', signMethod: 'btcSignTx',
    defaultPath: [0x8000002C, 0x80000091, 0x80000000, 0, 0], scriptType: 'p2pkh',
  },
  {
    id: 'dash', chain: Chain.Dash, coin: 'Dash', symbol: 'DASH',
    chainFamily: 'utxo', color: '#008CE7',
    rpcMethod: 'btcGetAddress', signMethod: 'btcSignTx',
    defaultPath: [0x8000002C, 0x80000005, 0x80000000, 0, 0], scriptType: 'p2pkh',
  },
  {
    id: 'binance', chain: Chain.Binance, coin: 'Binance', symbol: 'BNB',
    chainFamily: 'binance', color: '#F3BA2F',
    rpcMethod: 'binanceGetAddress', signMethod: 'binanceSignTx',
    defaultPath: [0x8000002C, 0x800002CA, 0x80000000, 0, 0],
  },
  {
    id: 'ripple', chain: Chain.Ripple, coin: 'Ripple', symbol: 'XRP',
    chainFamily: 'xrp', color: '#23292F',
    rpcMethod: 'xrpGetAddress', signMethod: 'xrpSignTx',
    defaultPath: [0x8000002C, 0x80000090, 0x80000000, 0, 0],
  },
]

// Fallbacks for chains not fully covered by pioneer-caip
const CAIP_FALLBACKS: Record<string, string> = {
  BNB: 'binance:bnb-beacon-chain/slip44:714',
}
const DECIMAL_FALLBACKS: Record<string, number> = {
  BNB: 8,
}

// Derive CAIP identifiers from pioneer-caip — single source of truth
export const CHAINS: ChainDef[] = CONFIGS.map(c => ({
  ...c,
  networkId: ChainToNetworkId[c.chain as keyof typeof ChainToNetworkId],
  caip: ChainToCaip[c.chain as keyof typeof ChainToCaip] || CAIP_FALLBACKS[c.chain] || '',
  decimals: BaseDecimal[c.chain as keyof typeof BaseDecimal] ?? DECIMAL_FALLBACKS[c.chain] ?? 8,
}))
