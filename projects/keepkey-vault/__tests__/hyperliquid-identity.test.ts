import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { CHAINS, customChainToChainDef, evmChainLabel, findChainByNetwork, isStaleHyperliquidMetadata } from '../src/shared/chains'
import { buildEvmTx } from '../src/bun/txbuilder/evm'
import { evmSourceForChain, pioneerEvmRpc } from '../src/bun/pioneer-evm'
import { parseAssetsResponse } from '../src/bun/swap-parsing'
import { evmAssetReceiveUri } from '../src/shared/vault-asset-account'
import { buildAssetEntries, chainMetaForCaip2, networkDisplayName, synthesizeSwapAsset } from '../src/shared/swap-discovery'
import { _resetDynamicChains, _setDynamicChains, assessAvailability } from '../src/shared/swap-support-matrix'
import { getAsset, isAssetMapReady, registerCustomAsset, unregisterCustomAsset } from '../src/shared/assetLookup'

const chain = CHAINS.find(c => c.id === 'hyperliquid')!
const account = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'

// Execute the actual small callbacks without importing the native app entry or
// initializing its profile, API, USB, device or sidecars.
function productionFunction(path: string, name: string, bindings: Record<string, unknown> = {}): any {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!declaration) throw new Error(`Missing production callback ${name}`)
  const js = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(bindings), `${js}; return ${name}`)(...Object.values(bindings))
}

afterEach(() => _resetDynamicChains())

test('HyperEVM mainnet overrides stale SDK identity coherently; 2868 has no built-in identity', () => {
  expect(chain).toMatchObject({ chainId: '999', networkId: 'eip155:999', caip: 'eip155:999/slip44:60', decimals: 18, symbol: 'HYPE' })
  expect(evmChainLabel(999)).toEqual({ name: 'Hyperliquid', symbol: 'HYPE' })
  expect(evmChainLabel(2868)).toBeUndefined()
  expect(chainMetaForCaip2('eip155:2868')).toBeNull()
  expect(evmSourceForChain(chain)).toBe('eip155:999') // keep Pioneer node policy
})

test('actual native builder and signing callback dispatch chain 999, and Pioneer reads use 999', async () => {
  const calls: any[] = []
  const pioneer = {
    GetGasPriceByNetwork: async (p: any) => { calls.push(p); return { data: { average: '1' } } },
    GetNonceByNetwork: async (p: any) => { calls.push(p); return { data: { nonce: 7 } } },
    GetBalanceAddressByNetwork: async (p: any) => { calls.push(p); return { data: { balance: '10' } } },
  }
  const { fee, ...unsignedTx } = await buildEvmTx(pioneer, chain, { fromAddress: account, to: recipient, amount: '1', addressIndex: 2 })
  const signTx = productionFunction('../src/bun/txbuilder/index.ts', 'signTx')
  const signed: any[] = []
  await signTx({ ethSignTx: async (tx: any) => { signed.push(tx); return {} } }, chain, unsignedTx)
  expect(signed).toEqual([expect.objectContaining({ chainId: 999, addressNList: [0x8000002c, 0x8000003c, 0x80000002, 0, 0] })])
  expect(calls.every(c => c.networkId === 'eip155:999')).toBe(true)
  expect(await pioneerEvmRpc(pioneer, chain.networkId, 'eth_chainId', [])).toBe('0x3e7')
  expect(await pioneerEvmRpc(pioneer, chain.networkId, 'eth_getBalance', [account, 'latest'])).toBe('0x8ac7230489e80000')
  expect(Number(fee)).toBeGreaterThan(0)
})

test('Receive QR and incoming transaction attribution use 999 and reject an old 2868 asset', () => {
  expect(evmAssetReceiveUri(chain.networkId, chain.caip, account)).toBe(`ethereum:${account}@999`)
  expect(evmAssetReceiveUri(chain.networkId, `eip155:999/erc20:${token}`, account)).toBe(`ethereum:${token}@999/transfer?address=${account}`)
  expect(() => evmAssetReceiveUri(chain.networkId, 'eip155:2868/slip44:60', account)).toThrow('same EVM network')
  expect(findChainByNetwork('eip155:999', undefined)?.id).toBe('hyperliquid')
  expect(findChainByNetwork(undefined, `eip155:999/erc20:${token}`)?.id).toBe('hyperliquid')
  expect(findChainByNetwork('eip155:2868', 'eip155:2868/slip44:60')).toBeUndefined()
})

test('provider HYPE assets with conflicting network IDs are dropped rather than remapped', () => {
  const assets = parseAssetsResponse([
    { asset: 'HYPE.HYPE', caip: 'eip155:2868/slip44:60' },
    { asset: `HYPE.TOKEN-${token}`, caip: `eip155:2868/erc20:${token}` },
    { asset: 'HYPE.HYPE', caip: chain.caip },
    { asset: `HYPE.TOKEN-${token}`, caip: `eip155:999/erc20:${token}` },
  ])
  expect(assets.map(a => a.caip)).toEqual([chain.caip, `eip155:999/erc20:${token}`])
  expect(assets.every(a => a.chainId === 'hyperliquid')).toBe(true)
})

test('actual custom-chain discovery callback drops stale native HYPE only', () => {
  const parseRawEntry = productionFunction('../src/bun/index.ts', 'parseRawEntry', {
    BUILTIN_EVM_CHAIN_IDS: new Set(CHAINS.filter(c => c.chainFamily === 'evm').map(c => Number(c.chainId))),
    isStaleHyperliquidMetadata,
  })
  const stale = { chainId: 'eip155:2868', assetId: 'eip155:2868/slip44:60', symbol: 'HYPE', name: 'Hyperliquid' }
  expect(parseRawEntry(stale)).toBeNull()
  expect(parseRawEntry({ ...stale, assetId: chain.caip })).toBeNull()
  expect(parseRawEntry({ ...stale, chainId: chain.networkId, assetId: chain.caip })).toBeNull() // already built in
  expect(parseRawEntry({ ...stale, symbol: 'OTHER', name: 'Unrelated chain' })).toMatchObject({ chainId: 2868, symbol: 'OTHER' })
  expect(isStaleHyperliquidMetadata(`eip155:2868/erc20:${token}`, 'HYPE')).toBe(false)
  expect(isStaleHyperliquidMetadata(`eip155:1/erc20:${token}`, 'HYPE')).toBe(false)
})

test('bundled picker metadata exposes one correct native HYPE and preserves unrelated custom HYPE tokens', async () => {
  const entries = await buildAssetEntries({
    balances: [{ chainId: 'hyperliquid', balance: '3', nativeBalanceUsd: 12 } as any],
    swappable: [{ asset: 'HYPE.HYPE', chainId: 'hyperliquid', symbol: 'HYPE', name: 'Hyperliquid', caip: 'eip155:2868/slip44:60' } as any],
    customTokens: [{ networkId: 'eip155:2868', contractAddress: token, symbol: 'HYPE', decimals: 18 } as any],
  })
  const native = entries.filter(e => e.isNative && e.symbol === 'HYPE')
  expect(native.map(e => e.caip)).toEqual([chain.caip])
  expect(native[0].balance).toEqual({ amount: '3', usd: 12 })
  expect(synthesizeSwapAsset(native[0])).toMatchObject({ chainId: 'hyperliquid', caip: chain.caip })
  expect(synthesizeSwapAsset({ ...native[0], caip: 'eip155:2868/slip44:60' })).toBeNull()
  expect(entries.find(e => e.caip === `eip155:2868/erc20:${token}`)).toMatchObject({ symbol: 'HYPE', chainId: 'eip155:2868' })
  expect(networkDisplayName('eip155:2868')).toBe('eip155:2868')
  expect(networkDisplayName('eip155:999')).toBe('Hyperliquid')
  expect(entries.find(e => e.caip === 'eip155:137/slip44:60')?.symbol).toBe('POL')
  expect(entries.find(e => e.caip === 'eip155:8453/slip44:60')?.symbol).toBe('ETH')
})

test('correct mainnet can use explicit provider coverage without treating 2868 as an alias', () => {
  _setDynamicChains({ thorchain: [], mayachain: [], relay: ['eip155:999'], zeroex: [], chainflip: [], shapeshift: [] })
  expect(assessAvailability(chain.caip)).toMatchObject({ status: 'swappable', providers: ['relay'] })
  expect(assessAvailability('eip155:2868/slip44:60').status).toBe('unsupported_chain')
})

test('native asset lookup uses the curated symbol/explorer metadata while custom 2868 remains independent', async () => {
  for (let i = 0; i < 100 && !isAssetMapReady(); i++) await Bun.sleep(1)
  expect(isAssetMapReady()).toBe(true)
  expect(getAsset(chain.caip)).toMatchObject({ symbol: 'HYPE', chainId: 'eip155:999', explorerTxLink: 'https://hyperevmscan.io/tx/{{txid}}', explorerAddressLink: 'https://hyperevmscan.io/address/{{address}}' })
  expect(getAsset('eip155:2868/slip44:60')).toBeUndefined()
  expect(getAsset('eip155:137/slip44:60')?.symbol).toBe('POL')
  expect(getAsset('eip155:8453/slip44:60')?.symbol).toBe('ETH')
  expect(getAsset('eip155:143/slip44:60')?.explorerTxLink).toBe('https://monadscan.com/tx/{{txid}}')
  registerCustomAsset('eip155:2868/slip44:60', { symbol: 'CUSTOM', name: 'Unrelated custom chain' })
  try {
    expect(getAsset('eip155:2868/slip44:60')).toMatchObject({ chainId: 'eip155:2868', symbol: 'CUSTOM' })
    const custom = customChainToChainDef({ chainId: 2868, name: 'Unrelated', symbol: 'CUSTOM', rpcUrl: 'https://example.invalid' } as any)
    expect(custom).toMatchObject({ chainId: '2868', networkId: 'eip155:2868' })
  } finally { unregisterCustomAsset('eip155:2868/slip44:60') }
})
