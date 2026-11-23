import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { requireVaultAsset } from '../shared/vault-asset-account'
import { BASE_ETH_CAIP, BASE_NETWORK, safeVaultIdentity } from '../shared/vault-identity'
import type { VaultWalletKey } from '../shared/vault-wallet-links'

// Execute the production RPC helpers with synthetic sessions, without loading
// index.ts's windows, USB, persistence or network startup.
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
function production<T>(name: string, context: Record<string, unknown>): T {
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!
  const compiled = ts.transpile(fn.getText(ast), { target: ts.ScriptTarget.ES2020 })
  return Function(...Object.keys(context), `${compiled}; return ${name}`)(...Object.values(context)) as T
}
const owner = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40)

test('active vault keys exclude stale managers and disconnected or locked wallets', () => {
  let state = 'ready', liveSeed = owner, stamp = other
  const engine = { wallet: {}, getDeviceState: () => ({ state }), get currentSeedEthAddress() { return liveSeed } }
  const keys = () => production<() => VaultWalletKey[]>('activeVaultWalletKeys', {
    engine, managersSeedOwner: stamp,
    evmAddresses: { toAddressSet: () => ({ addresses: [{ address: other }] }) },
    btcAccounts: { toAccountSet: () => ({ accounts: [{ xpubs: [{ xpub: 'current-account-xpub' }] }] }) },
  })()
  expect(keys()).toEqual([{ family: 'evm', address: owner, xpub: '' }])
  stamp = owner
  expect(keys().map(k => k.address || k.xpub)).toEqual([owner, other, 'current-account-xpub'])
  liveSeed = '0x' + '3'.repeat(40)
  expect(keys()).toEqual([{ family: 'evm', address: liveSeed, xpub: '' }])
  for (state of ['disconnected', 'needs_pin', 'needs_passphrase']) expect(keys()).toEqual([])
})

test('vaultAccountGet refuses non-cosigners before RPC and retires membership lost during a read', async () => {
  const account = { address: '0x' + '4'.repeat(40), name: 'Shared', owners: [owner, other], threshold: 2,
    nonce: '0', deployed: true, safeVersion: '1.5.0' as const }
  const vault = safeVaultIdentity(account, false)
  const request = { vaultId: vault.id, networkId: BASE_NETWORK, assetCaip: BASE_ETH_CAIP }
  let allowed = false, reads = 0
  const handler = production<(input: typeof request) => Promise<unknown>>('readVaultAssetAccount', {
    activitySessionEpoch: 1, watchOnlyViewBtcOnly: false, isBitcoinOnlyVariant: () => false,
    engine: { getDeviceState: () => ({ firmwareVariant: 'multi' }) }, requireVaultAsset,
    walletRegisteredVaults: () => allowed ? [vault] : [],
    readConfiguredSafeRpc: () => { throw new Error('Network forbidden') },
    inspectBaseSafe: async () => { reads++; allowed = false; return account },
  })
  await expect(handler(request)).rejects.toThrow('no longer registered')
  expect(reads).toBe(0)
  allowed = true
  await expect(handler(request)).rejects.toThrow('no longer registered')
  expect(reads).toBe(1)
})
