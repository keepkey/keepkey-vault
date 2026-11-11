import { expect, test } from 'bun:test'
import { swapNetworkIdentity, sameSwapAsset } from '../src/shared/swap-network-identity'
import { CHAINS } from '../src/shared/chains'

test('same-symbol ETH routes show distinct Ethereum and Arbitrum network identities', () => {
  const source = { chainId: 'ethereum', asset: 'ETH.ETH', caip: 'eip155:1/slip44:60' }
  const destination = { chainId: 'arbitrum', asset: 'ETH.ETH', caip: 'eip155:42161/slip44:60' }
  expect(swapNetworkIdentity(source)).toMatchObject({ name: 'Ethereum', networkId: 'eip155:1', conflict: false })
  expect(swapNetworkIdentity(destination)).toMatchObject({ name: 'Arbitrum', networkId: 'eip155:42161', conflict: false })
  expect(sameSwapAsset(source, destination)).toBe(false)
})
test('the full token identity is preserved separately from its network label', () => {
  const caip = 'eip155:8453/erc20:0xAbCd000000000000000000000000000000000001'
  expect(swapNetworkIdentity({ chainId: 'base', caip, contractAddress: caip.split(':').at(-1) }))
    .toMatchObject({ name: 'Base', networkId: 'eip155:8453', assetCaip: caip, conflict: false })
})
test('a mismatched chain id cannot quietly relabel a destination asset', () => {
  expect(swapNetworkIdentity({ chainId: 'ethereum', caip: 'eip155:42161/slip44:60' }))
    .toMatchObject({ name: 'Arbitrum', networkId: 'eip155:42161', conflict: true })
})
test('native assets without CAIP use their canonical chain identity', () => {
  const bitcoin = CHAINS.find(chain => chain.id === 'bitcoin')!
  expect(swapNetworkIdentity({ chainId: 'bitcoin', asset: 'BTC.BTC' }))
    .toMatchObject({ name: 'Bitcoin', assetCaip: bitcoin.caip, networkId: bitcoin.networkId, conflict: false })
})
test('same assets compare canonical CAIPs rather than tickers or route strings', () => {
  expect(sameSwapAsset({ chainId: 'ethereum', caip: 'eip155:1/erc20:0xABC' }, { chainId: 'ethereum', caip: 'eip155:1/erc20:0xabc' })).toBe(true)
  expect(sameSwapAsset({ chainId: 'ethereum', asset: 'ETH.ETH' }, { chainId: 'base', asset: 'ETH.ETH' })).toBe(false)
  expect(sameSwapAsset({ chainId: 'bitcoin', asset: 'BTC.BTC' }, { chainId: 'bitcoin', asset: 'BTC.BTC' })).toBe(true)
})

test('accepted TRON encodings resolve to one network and asset identity', () => {
  for (const network of ['tron:27Lqcw', 'tron:27lqcw', 'tron:0x2b6653dc']) {
    const asset = { chainId: 'tron', caip: `${network}/slip44:195` }
    expect(swapNetworkIdentity(asset)).toMatchObject({ name: 'Tron', networkId: 'tron:0x2b6653dc', assetCaip: 'tron:0x2b6653dc/slip44:195', conflict: false })
    expect(sameSwapAsset(asset, { chainId: 'tron', caip: 'tron:0x2b6653dc/slip44:195' })).toBe(true)
  }
})

test('BSC token aliases compare equally while base58 token case remains significant', () => {
  expect(sameSwapAsset({ chainId: 'bsc', caip: 'eip155:56/bep20:0xABC' }, { chainId: 'bsc', caip: 'eip155:56/erc20:0xabc' })).toBe(true)
  expect(sameSwapAsset({ chainId: 'solana', caip: 'solana:mainnet/token:AbCd' }, { chainId: 'solana', caip: 'solana:mainnet/token:abcd' })).toBe(false)
})
