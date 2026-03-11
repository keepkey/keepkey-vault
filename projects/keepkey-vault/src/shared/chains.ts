import { Chain, ChainToNetworkId, ChainToCaip, BaseDecimal } from '@pioneer-platform/pioneer-caip'
import type { BtcScriptType, CustomChain } from './types'
import { versionCompare } from './firmware-versions'

export interface ChainDef {
  id: string
  chain: string           // Chain enum value: 'BTC', 'ETH', 'GAIA', etc.
  coin: string            // KeepKey hdwallet coin name
  symbol: string          // Display symbol: 'BTC', 'ATOM', 'RUNE'
  networkId: string       // CAIP-2 (derived from pioneer-caip)
  caip: string            // CAIP-19 (derived from pioneer-caip)
  decimals: number        // Base decimals (derived from pioneer-caip)
  chainFamily: 'utxo' | 'evm' | 'cosmos' | 'xrp' | 'solana' | 'zcash-shielded'
  color: string
  rpcMethod: string
  signMethod: string
  defaultPath: number[]
  scriptType?: string
  denom?: string
  chainId?: string
  explorerAddressUrl?: string  // e.g. "https://etherscan.io/address/{{address}}"
  explorerTxUrl?: string       // e.g. "https://etherscan.io/tx/{{txid}}"
  hidden?: boolean             // If true, hide from Dashboard grid (used for internal-only chains)
  minFirmware?: string         // Minimum firmware version required (e.g. '7.11.0')
}

// ── Bitcoin multi-account constants ─────────────────────────────────────
export const BTC_SCRIPT_TYPES: Array<{
  scriptType: BtcScriptType
  purpose: number
  xpubPrefix: 'xpub' | 'ypub' | 'zpub'
  label: string
  addressPrefix: string
}> = [
  { scriptType: 'p2pkh',       purpose: 44, xpubPrefix: 'xpub', label: 'Legacy',         addressPrefix: '1' },
  { scriptType: 'p2sh-p2wpkh', purpose: 49, xpubPrefix: 'ypub', label: 'SegWit',         addressPrefix: '3' },
  { scriptType: 'p2wpkh',      purpose: 84, xpubPrefix: 'zpub', label: 'Native SegWit',  addressPrefix: 'bc1' },
]

/** Build a BIP44/49/84 account-level path: m/purpose'/0'/accountIndex' */
export function btcAccountPath(purpose: number, accountIndex: number): number[] {
  return [purpose + 0x80000000, 0x80000000, accountIndex + 0x80000000]
}

// Minimal per-chain config — everything else derived from pioneer-caip
type ChainConfig = Omit<ChainDef, 'networkId' | 'caip' | 'decimals'>

const CONFIGS: ChainConfig[] = [
  {
    id: 'bitcoin', chain: Chain.Bitcoin, coin: 'Bitcoin', symbol: 'BTC',
    chainFamily: 'utxo', color: '#F7931A',
    rpcMethod: 'btcGetAddress', signMethod: 'btcSignTx',
    defaultPath: [0x8000002C, 0x80000000, 0x80000000, 0, 0], scriptType: 'p2pkh',
  },
  {
    id: 'ethereum', chain: Chain.Ethereum, coin: 'Ethereum', symbol: 'ETH',
    chainFamily: 'evm', color: '#627EEA',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '1',
  },
  {
    id: 'polygon', chain: Chain.Polygon, coin: 'Polygon', symbol: 'MATIC',
    chainFamily: 'evm', color: '#8247E5',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '137',
  },
  {
    id: 'arbitrum', chain: Chain.Arbitrum, coin: 'Arbitrum', symbol: 'ETH',
    chainFamily: 'evm', color: '#28A0F0',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '42161',
  },
  {
    id: 'optimism', chain: Chain.Optimism, coin: 'Optimism', symbol: 'ETH',
    chainFamily: 'evm', color: '#FF0420',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '10',
  },
  {
    id: 'avalanche', chain: Chain.Avalanche, coin: 'Avalanche', symbol: 'AVAX',
    chainFamily: 'evm', color: '#E84142',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '43114',
  },
  {
    id: 'bsc', chain: Chain.BinanceSmartChain, coin: 'BNB Smart Chain', symbol: 'BNB',
    chainFamily: 'evm', color: '#F0B90B',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '56',
  },
  {
    id: 'base', chain: Chain.Base, coin: 'Base', symbol: 'ETH',
    chainFamily: 'evm', color: '#0052FF',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '8453',
  },
  {
    id: 'monad', chain: Chain.Monad, coin: 'Monad', symbol: 'MON',
    chainFamily: 'evm', color: '#1F70FF',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '143',
  },
  {
    id: 'hyperliquid', chain: Chain.Hyperliquid, coin: 'Hyperliquid', symbol: 'HYPE',
    chainFamily: 'evm', color: '#00D084',
    rpcMethod: 'ethGetAddress', signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0], chainId: '2868',
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
    id: 'zcash', chain: Chain.Zcash, coin: 'Zcash', symbol: 'ZEC',
    chainFamily: 'utxo', color: '#ECB244',
    rpcMethod: 'btcGetAddress', signMethod: 'btcSignTx',
    defaultPath: [0x8000002C, 0x80000085, 0x80000000, 0, 0], scriptType: 'p2pkh',
    minFirmware: '7.11.0',
  },
  {
    id: 'zcash-shielded', chain: Chain.Zcash, coin: 'Zcash', symbol: 'ZEC',
    chainFamily: 'zcash-shielded', color: '#ECB244',
    rpcMethod: 'zcashGetOrchardFvk', signMethod: 'zcashSignPczt',
    defaultPath: [0x80000020, 0x80000085, 0x80000000], // m/32'/133'/0' (ZIP-32 Orchard)
    hidden: true, // Shown via Privacy tab on Zcash AssetPage, not as separate Dashboard card
    minFirmware: '7.11.0',
  },
  {
    id: 'digibyte', chain: Chain.Digibyte, coin: 'DigiByte', symbol: 'DGB',
    chainFamily: 'utxo', color: '#315BCA',
    rpcMethod: 'btcGetAddress', signMethod: 'btcSignTx',
    defaultPath: [0x8000002C, 0x80000014, 0x80000000, 0, 0], scriptType: 'p2pkh',
  },
  {
    id: 'ripple', chain: Chain.Ripple, coin: 'Ripple', symbol: 'XRP',
    chainFamily: 'xrp', color: '#23292F',
    rpcMethod: 'xrpGetAddress', signMethod: 'xrpSignTx',
    defaultPath: [0x8000002C, 0x80000090, 0x80000000, 0, 0],
  },
  {
    id: 'solana', chain: Chain.Solana, coin: 'Solana', symbol: 'SOL',
    chainFamily: 'solana', color: '#14F195',
    rpcMethod: 'solanaGetAddress', signMethod: 'solanaSignTx',
    defaultPath: [0x8000002C, 0x800001F5, 0x80000000, 0x80000000],
    explorerAddressUrl: 'https://solscan.io/account/{{address}}',
    explorerTxUrl: 'https://solscan.io/tx/{{txid}}',
  },
]

// Fallbacks for chains not fully covered by pioneer-caip
const CAIP_FALLBACKS: Record<string, string> = {}
const DECIMAL_FALLBACKS: Record<string, number> = {}

// Derive CAIP identifiers from pioneer-caip — single source of truth
export const CHAINS: ChainDef[] = CONFIGS.map(c => ({
  ...c,
  networkId: ChainToNetworkId[c.chain as keyof typeof ChainToNetworkId],
  caip: ChainToCaip[c.chain as keyof typeof ChainToCaip] || CAIP_FALLBACKS[c.chain] || '',
  decimals: BaseDecimal[c.chain as keyof typeof BaseDecimal] ?? DECIMAL_FALLBACKS[c.chain] ?? 8,
}))

/** Check if a chain is supported by the given firmware version. Chains without minFirmware are always supported. */
export function isChainSupported(chain: ChainDef, firmwareVersion?: string): boolean {
  if (!chain.minFirmware) return true
  if (!firmwareVersion) return false
  return versionCompare(firmwareVersion, chain.minFirmware) >= 0
}

/** Convert a user-added custom EVM chain into a ChainDef */
export function customChainToChainDef(c: CustomChain): ChainDef {
  return {
    id: `evm-custom-${c.chainId}`,
    chain: `CUSTOM_${c.chainId}`,
    coin: c.name,
    symbol: c.symbol,
    networkId: `eip155:${c.chainId}`,
    caip: `eip155:${c.chainId}/slip44:60`,
    decimals: 18,
    chainFamily: 'evm',
    color: '#888888',
    rpcMethod: 'ethGetAddress',
    signMethod: 'ethSignTx',
    defaultPath: [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
    chainId: String(c.chainId),
  }
}
