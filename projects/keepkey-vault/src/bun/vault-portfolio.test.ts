import { describe, expect, test } from 'bun:test'
import type { SafeAccount } from '../shared/safe-multisig'
import { BASE_ETH_CAIP, BASE_NETWORK, BASE_USDC_CAIP, BITCOIN_CAIP, BITCOIN_NETWORK, safeVaultIdentity, type VaultIdentity } from '../shared/vault-identity'
import { assertVaultPortfolioResponse, includedVaultTotal, type VaultPortfolio } from '../shared/vault-portfolio'
import { safeVaultPortfolio, VaultPortfolioService } from './vault-portfolio'

const account: SafeAccount = {
  address: '0x6717d97655d8fC9d05C2DD3F28b54f574309B473', name: 'Shared treasury',
  safeVersion: '1.5.0', owners: ['0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'],
  threshold: 2, nonce: '0', deployed: true, balanceEth: '0.125', balanceUsdc: '42.5',
}
const vault = safeVaultIdentity(account, false)
const prices = new Map([[BASE_ETH_CAIP, 2000], [BASE_USDC_CAIP, 0.998]])
const row = (): VaultPortfolio => ({ ...safeVaultPortfolio(vault, account, prices, 100), includeInTotal: true })

function service() {
  let now = 100
  let key = 'visible-wallet'
  let hidden = false
  let saved = '[]'
  let reads = 0
  let writes = 0
  let identities = [vault]
  let readSafe = async () => { reads++; return account }
  const instance = new VaultPortfolioService({
    scope: () => ({key, hidden}), list: () => identities,
    readSafe: () => readSafe(), price: async caip => prices.get(caip) || 0,
    readExcluded: () => saved, writeExcluded: ids => { saved = JSON.stringify(ids); writes++ }, now: () => now,
  })
  return {
    instance, reads: () => reads, writes: () => writes, saved: () => saved,
    hidden: (value: boolean) => { hidden = value; key = value ? 'hidden-wallet' : 'visible-wallet' },
    scope: (value: string) => { key = value }, advance: () => { now += 31_000 },
    identities: (value: VaultIdentity[]) => { identities = value },
    reader: (value: typeof readSafe) => { readSafe = value },
  }
}

describe('Vault portfolio identity and valuation', () => {
  test('uses the exact Safe amounts and both asset quotes, including a non-dollar USDC quote', () => {
    const p = row()
    expect(p.totalUsd).toBeCloseTo(292.415)
    expect(p.balance?.address).toBe(account.address)
    expect(p.balance?.chainId).toBe('base')
    expect(p.balance?.balance).toBe('0.125')
    expect(p.balance?.tokens?.[0]).toMatchObject({balance: '42.5', caip: BASE_USDC_CAIP, networkId: BASE_NETWORK, decimals: 6})
    expect(() => assertVaultPortfolioResponse(vault, p)).not.toThrow()
  })

  test('a missing USDC quote never silently assumes one dollar', () => {
    const p = safeVaultPortfolio(vault, account, new Map([[BASE_ETH_CAIP, 2000]]), 100)
    expect(p.totalUsd).toBeUndefined()
    expect(p.balance?.tokens?.[0].balance).toBe('42.5')
    expect(p.balance?.fiatValueState).toBe('unavailable')
    expect(p.error).toContain('price is unavailable')
  })

  test('an actually empty vault has zero value without requiring quotes', () => {
    const p = safeVaultPortfolio(vault, {...account, balanceEth: '0.0', balanceUsdc: '0.0'}, new Map(), 100)
    expect(p.totalUsd).toBe(0)
    expect(p.balance?.fiatValueState).toBeUndefined()
  })

  test('rejects a different Safe, owner configuration, or exact network', () => {
    expect(() => safeVaultPortfolio(vault, {...account, address: account.owners[0]}, prices, 100)).toThrow('configuration changed')
    expect(() => safeVaultPortfolio(vault, {...account, owners: [account.owners[0]], threshold: 1}, prices, 100)).toThrow('configuration changed')
    expect(() => safeVaultPortfolio({...vault, networkId: 'eip155:1'}, account, prices, 100)).toThrow('registered network')
  })

  test('refuses malformed balances rather than replacing them with zero', () => {
    for (const amount of [undefined, '', '-1', 'NaN', '1e10', '1.0000001']) {
      expect(() => safeVaultPortfolio(vault, {...account, balanceUsdc: amount}, prices, 100)).toThrow('Invalid vault asset balance')
    }
  })

  test('a response for a different address or token network cannot populate the view', () => {
    const wrongAddress = row()
    wrongAddress.balance!.address = account.owners[0]
    expect(() => assertVaultPortfolioResponse(vault, wrongAddress)).toThrow('different account')
    const wrongToken = row()
    wrongToken.balance!.tokens![0].networkId = 'eip155:1'
    expect(() => assertVaultPortfolioResponse(vault, wrongToken)).toThrow('different asset')
    const wrongContract = row()
    wrongContract.balance!.tokens![0].contractAddress = account.owners[0]
    expect(() => assertVaultPortfolioResponse(vault, wrongContract)).toThrow('different asset')
  })

  test('unknown balance never becomes a valued zero', () => {
    expect(() => assertVaultPortfolioResponse(vault, {identity: vault, includeInTotal: true, totalUsd: 0})).toThrow('no verified balance')
  })
})

describe('Vault portfolio inclusion and refresh', () => {
  test('includes by default and persists an explicit exclusion without another chain read', async () => {
    const s = service()
    expect((await s.instance.get())[0].includeInTotal).toBe(true)
    s.instance.setInclusion(vault.id, false)
    expect((await s.instance.get())[0].includeInTotal).toBe(false)
    expect(s.saved()).toBe(JSON.stringify([vault.id]))
    expect(s.reads()).toBe(1)
    s.instance.setInclusion(vault.id, true)
    expect((await s.instance.get())[0].includeInTotal).toBe(true)
    expect(s.saved()).toBe('[]')
  })

  test('hidden-wallet preferences stay in session memory and clear on session change', async () => {
    const s = service()
    s.instance.setInclusion(vault.id, false)
    const writes = s.writes()
    s.hidden(true)
    expect((await s.instance.get())[0].includeInTotal).toBe(true)
    s.instance.setInclusion(vault.id, false)
    expect((await s.instance.get())[0].includeInTotal).toBe(false)
    expect(s.writes()).toBe(writes)
    s.scope('another-hidden-wallet')
    expect((await s.instance.get())[0].includeInTotal).toBe(true)
  })

  test('deduplicates shared vaults even when several cosigner records name them', async () => {
    const s = service()
    s.identities([vault, {...vault}])
    expect(await s.instance.get()).toHaveLength(1)
    expect(s.reads()).toBe(1)
    expect(includedVaultTotal([row(), row()]).totalUsd).toBeCloseTo(292.415)
  })

  test('coalesces concurrent reads, reuses fresh cache, then refreshes expired data', async () => {
    const s = service()
    await Promise.all([s.instance.get(), s.instance.get(true)])
    expect(s.reads()).toBe(1)
    await s.instance.get()
    expect(s.reads()).toBe(1)
    s.advance()
    await s.instance.get()
    expect(s.reads()).toBe(2)
  })

  test('failed reads remain explicitly unavailable and mark included totals partial', async () => {
    const s = service()
    s.reader(async () => { throw new Error('Base provider unavailable') })
    const portfolios = await s.instance.get()
    expect(portfolios[0].balance).toBeUndefined()
    expect(portfolios[0].totalUsd).toBeUndefined()
    expect(portfolios[0].error).toBe('Base provider unavailable')
    expect(includedVaultTotal(portfolios)).toEqual({totalUsd: 0, partial: true})
    s.instance.setInclusion(vault.id, false)
    expect(includedVaultTotal(await s.instance.get())).toEqual({totalUsd: 0, partial: false})
  })

  test('does not return an old session result after the wallet changes', async () => {
    const s = service()
    let finish!: (value: SafeAccount) => void
    s.reader(() => new Promise(resolve => { finish = resolve }))
    const loading = s.instance.get()
    s.scope('different-wallet')
    finish(account)
    expect(loading).rejects.toThrow('Wallet changed')
    await loading.catch(() => {})
  })

  test('Bitcoin policy balances are unavailable until a policy-aware monitor supplies them', async () => {
    const s = service()
    s.identities([{
      ...vault, id: `${BITCOIN_NETWORK}:policy:test`, type: 'bitcoin-multisig', chainId: 'bitcoin', networkId: BITCOIN_NETWORK,
      address: 'bc1qexample', accountId: `${BITCOIN_NETWORK}:bc1qexample`, supportedAssets: [{caip: BITCOIN_CAIP, symbol: 'BTC', decimals: 8}],
    }])
    const p = (await s.instance.get())[0]
    expect(p.totalUsd).toBeUndefined()
    expect(p.error).toContain('Bitcoin vault balance monitoring')
    expect(s.reads()).toBe(0)
  })

  test('an absent vault cannot acquire an inclusion preference', () => {
    const s = service()
    expect(() => s.instance.setInclusion('missing', false)).toThrow('no longer registered')
    expect(s.writes()).toBe(0)
  })
})
