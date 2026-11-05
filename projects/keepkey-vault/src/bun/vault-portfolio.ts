import type { SafeAccount } from '../shared/safe-multisig'
import type { ChainBalance } from '../shared/types'
import {
  BASE_ETH_CAIP, BASE_NETWORK, BASE_USDC_CAIP, BITCOIN_CAIP, BITCOIN_NETWORK,
  type VaultIdentity,
} from '../shared/vault-identity'
import { assertVaultControlSnapshot } from '../shared/vault-asset-account'
import { assertVaultPortfolioResponse, vaultPortfolioAccountKey, type VaultPortfolio } from '../shared/vault-portfolio'

export interface VaultPortfolioDependencies {
  scope: () => { key: string; hidden: boolean }
  list: () => VaultIdentity[]
  readSafe: (vault: VaultIdentity) => Promise<SafeAccount>
  price: (caip: string) => Promise<number>
  readExcluded: () => string | null
  writeExcluded: (ids: string[]) => void
  now?: () => number
}

function validateIdentity(vault: VaultIdentity): void {
  const safe = vault.type === 'safe'
  const network = safe ? BASE_NETWORK : BITCOIN_NETWORK
  const native = safe ? BASE_ETH_CAIP : BITCOIN_CAIP
  if (vault.networkId !== network || vault.chainId !== (safe ? 'base' : 'bitcoin') ||
      (safe ? vault.accountId.toLowerCase() !== `${network}:${vault.address}`.toLowerCase()
        : vault.accountId !== `${network}:${vault.address}`) ||
      !vault.supportedAssets.some(a => a.caip === native) ||
      vault.supportedAssets.some(a => !a.caip.startsWith(network + '/') ||
        (a.caip !== native && (!safe || a.caip.toLowerCase() !== BASE_USDC_CAIP.toLowerCase())))) {
    throw new Error('Vault identity does not match its registered network and assets')
  }
}

function units(value: string | undefined, decimals: number): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) ||
      (value.split('.')[1]?.length || 0) > decimals) throw new Error('Invalid vault asset balance')
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid vault asset balance')
  return number
}

/** Reads only the exact Safe deployment; USD quotes never come from owner balances. */
export function safeVaultPortfolio(
  identity: VaultIdentity, account: SafeAccount, prices: ReadonlyMap<string, number>, now: number,
): Omit<VaultPortfolio, 'includeInTotal'> {
  validateIdentity(identity)
  if (identity.type !== 'safe') throw new Error('Expected a Safe vault')
  assertVaultControlSnapshot(identity, account)
  const eth = units(account.balanceEth, 18)
  const usdc = units(account.balanceUsdc, 6)
  const quote = (caip: string) => {
    const price = prices.get(caip)
    return price !== undefined && Number.isFinite(price) && price > 0 ? price : undefined
  }
  const ethPrice = quote(BASE_ETH_CAIP)
  const usdcPrice = quote(BASE_USDC_CAIP)
  const priced = (eth === 0 || ethPrice !== undefined) && (usdc === 0 || usdcPrice !== undefined)
  const nativeUsd = eth * (ethPrice || 0)
  const usdcUsd = usdc * (usdcPrice || 0)
  if (!Number.isFinite(nativeUsd + usdcUsd)) throw new Error('Invalid vault valuation')
  const balance: ChainBalance = {
    chainId: 'base', symbol: 'ETH', address: identity.address,
    balance: account.balanceEth!, nativeBalanceUsd: nativeUsd, balanceUsd: nativeUsd + usdcUsd,
    tokens: [{
      symbol: 'USDC', name: 'USD Coin', balance: account.balanceUsdc!, balanceUsd: usdcUsd,
      priceUsd: usdcPrice || 0, caip: BASE_USDC_CAIP, networkId: BASE_NETWORK,
      decimals: 6, contractAddress: BASE_USDC_CAIP.split('/erc20:')[1], type: 'token', dataSource: 'rpc',
    }],
    updatedAt: now, syncState: 'confirmed', confirmedAssetCaips: [BASE_ETH_CAIP, BASE_USDC_CAIP],
    ...(!priced ? { fiatValueState: 'unavailable' as const } : {}),
  }
  return { identity, balance, updatedAt: now,
    ...(priced ? { totalUsd: nativeUsd + usdcUsd } : { error: 'A vault asset price is unavailable; its balance is excluded from the total until it can be valued.' }),
  }
}

export class VaultPortfolioService {
  private cache = new Map<string, { expires: number; fingerprint: string; value: Omit<VaultPortfolio, 'includeInTotal'> }>()
  private inFlight = new Map<string, Promise<Omit<VaultPortfolio, 'includeInTotal'>>>()
  private sessionExcluded = new Set<string>()
  private scopeKey = ''
  private now: () => number
  constructor(private deps: VaultPortfolioDependencies) { this.now = deps.now || Date.now }

  private scope() {
    const scope = this.deps.scope()
    if (scope.key !== this.scopeKey) {
      this.cache.clear(); this.inFlight.clear(); this.sessionExcluded.clear()
      this.scopeKey = scope.key
    }
    return scope
  }
  private excluded(): Set<string> {
    try {
      const parsed: unknown = JSON.parse(this.deps.readExcluded() || '[]')
      return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, 1000) : [])
    } catch { return new Set() }
  }
  setInclusion(vaultId: string, include: boolean): void {
    const scope = this.scope()
    if (typeof vaultId !== 'string' || typeof include !== 'boolean') throw new Error('Invalid vault total preference')
    const vault = this.deps.list().find(v => v.id === vaultId)
    if (!vault) throw new Error('Vault is no longer registered')
    validateIdentity(vault)
    const excluded = scope.hidden || vault.sessionOnly ? this.sessionExcluded : this.excluded()
    if (include) excluded.delete(vaultId)
    else excluded.add(vaultId)
    if (!scope.hidden && !vault.sessionOnly) this.deps.writeExcluded([...excluded])
  }

  async get(refresh = false): Promise<VaultPortfolio[]> {
    const scope = this.scope()
    const unique = new Map<string, VaultIdentity>()
    for (const vault of this.deps.list()) {
      validateIdentity(vault)
      const account = vaultPortfolioAccountKey(vault)
      if (!unique.has(account)) unique.set(account, vault)
    }
    const rows = await Promise.all([...unique.values()].map(async identity => {
      const fingerprint = JSON.stringify(identity)
      const cached = this.cache.get(identity.id)
      let value: Omit<VaultPortfolio, 'includeInTotal'>
      if (!refresh && cached?.fingerprint === fingerprint && cached.expires > this.now()) value = cached.value
      else {
        const taskKey = `${identity.id}:${fingerprint}`
        let task = this.inFlight.get(taskKey)
        if (!task) {
          task = this.read(identity).then(value => {
            if (this.deps.scope().key === scope.key) {
              this.cache.set(identity.id, { fingerprint, value, expires: this.now() + (value.balance ? 30_000 : 5_000) })
            }
            return value
          }).finally(() => { if (this.inFlight.get(taskKey) === task) this.inFlight.delete(taskKey) })
          this.inFlight.set(taskKey, task)
        }
        value = await task
      }
      const result = { ...value, includeInTotal: !(scope.hidden || identity.sessionOnly ? this.sessionExcluded : this.excluded()).has(identity.id) }
      assertVaultPortfolioResponse(identity, result)
      return result
    }))
    if (this.deps.scope().key !== scope.key) throw new Error('Wallet changed while loading vault balances')
    return rows
  }

  private async read(identity: VaultIdentity): Promise<Omit<VaultPortfolio, 'includeInTotal'>> {
    if (identity.type !== 'safe') return { identity, error: 'Bitcoin vault balance monitoring is not available yet.' }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const quotes = Promise.all([BASE_ETH_CAIP, BASE_USDC_CAIP].map(async caip => {
        try { return [caip, await this.deps.price(caip)] as const } catch { return [caip, 0] as const }
      }))
      const read = Promise.all([this.deps.readSafe(identity), quotes]).then(([account, quotes]) =>
        safeVaultPortfolio(identity, account, new Map(quotes), this.now()))
      return await Promise.race([read, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Vault balance refresh timed out')), 15_000)
      })])
    } catch (e) {
      return { identity, error: e instanceof Error ? e.message : 'Vault balance is unavailable' }
    } finally { if (timer) clearTimeout(timer) }
  }
}
