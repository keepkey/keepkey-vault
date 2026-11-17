import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { evmAddressPath } from '../src/shared/chains'
import { paidProviderRefreshOptions, type ProviderRefreshReason } from '../src/shared/provider-refresh'

// Execute the actual method without importing EvmAddressManager or its DB module.
// Both "wallet" and Pioneer below are public synthetic in-memory stubs.
const file = ts.createSourceFile('evm-addresses.ts', readFileSync(new URL('../src/bun/evm-addresses.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const manager = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'EvmAddressManager') as ts.ClassDeclaration
const method = manager?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === 'autoDiscover')
if (!method) throw new Error('Production EVM autoDiscover method is missing')
const compiled = ts.transpileModule(`const extracted = { ${method.getText(file)} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const autoDiscover = new Function('evmAddressPath', 'paidProviderRefreshOptions', `${compiled}; return extracted.autoDiscover`)(evmAddressPath, paidProviderRefreshOptions)
const chains = [{ id: 'ethereum', caip: 'eip155:1/slip44:60', symbol: 'ETH', networkId: 'eip155:1' }]
const address = '0x1111111111111111111111111111111111111111'

function fixture(failFirst = false) {
  const requests: any[] = [], derivations: any[] = []
  const context = { addresses: [], discoveryDone: false,
    persistIndices() { throw new Error('This empty synthetic discovery must not persist') },
    emit() { throw new Error('This empty synthetic discovery must not emit') },
  }
  const wallet = { ethGetAddress: async (params: any) => { derivations.push(params); return { address } } }
  const pioneer = { GetPortfolioBalances: async (body: any) => {
    requests.push(body)
    if (failFirst && requests.length === 1) throw new Error('Synthetic cache unavailable')
    return { data: { balances: [{ caip: chains[0].caip, pubkey: address, balance: '0', valueUsd: 0 }] } }
  } }
  return { context, requests, derivations, run: (reason?: ProviderRefreshReason) => autoDiscover.call(context, wallet, pioneer, chains, 0, reason) }
}

test('EVM address auto-discovery defaults to cache-only instead of paid provider discovery', async () => {
  const f = fixture()
  expect(await f.run()).toEqual({ discovered: [] })
  expect(f.requests).toEqual([{ pubkeys: [{ caip: chains[0].caip, pubkey: address }], refreshReason: 'automatic', providerRefreshPolicy: 'cache-only' }])
  expect(f.derivations).toEqual([{ addressNList: evmAddressPath(0), showDisplay: false, coin: 'Ethereum' }])
})

test.each(['manual', 'wallet-open'] as const)('%s explicitly permits on-demand EVM discovery', async reason => {
  const f = fixture()
  await f.run(reason)
  expect(f.requests[0]).toMatchObject({ refreshReason: reason, providerRefreshPolicy: 'on-demand' })
})

test.each(['automatic', 'focus', 'degraded-retry', 'swap-reconcile'] as const)('%s EVM discovery cannot trigger a paid refresh', async reason => {
  const f = fixture()
  await f.run(reason)
  expect(f.requests[0]).toMatchObject({ refreshReason: reason, providerRefreshPolicy: 'cache-only' })
})

test('retrying a failed automatic discovery preserves cache-only provider policy', async () => {
  const f = fixture(true)
  await f.run()
  expect(f.context.discoveryDone).toBe(false)
  await f.run()
  expect(f.requests).toHaveLength(2)
  expect(f.requests.every(body => body.refreshReason === 'automatic' && body.providerRefreshPolicy === 'cache-only')).toBe(true)
})
