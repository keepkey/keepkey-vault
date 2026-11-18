import { utils } from 'ethers'
import type { SafeProposal } from '../shared/safe-multisig'

const CONFIG_URL = 'https://safe-config.safe.global/api/v1/chains/?limit=200'
export interface SafeTransactionQueue {
  pending(chainId: number, safe: string, nonce: string): Promise<unknown[]>
  publish(proposal: SafeProposal, sender: string): Promise<void>
}

/** Discovery and transport only. All transaction and owner checks belong to the caller. */
export class SafeTransactionService implements SafeTransactionQueue {
  private cache?: { at: number; services: Map<number, string> }
  constructor(private request: typeof fetch = fetch, private apiKey?: string) {}
  async services(): Promise<Map<number, string>> {
    if (this.cache && Date.now() - this.cache.at < 3_600_000) return this.cache.services
    const resp = await this.request(CONFIG_URL, { signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) throw new Error(`Safe chain config HTTP ${resp.status}`)
    const body = await resp.json() as any
    if (!Array.isArray(body.results) || body.next) throw new Error('Incomplete Safe chain configuration')
    const services = new Map<number, string>()
    for (const c of body.results) {
      if (typeof c.transactionService === 'string' && /^https:\/\//.test(c.transactionService))
        services.set(Number(c.chainId), c.transactionService.replace(/\/+$/, ''))
    }
    this.cache = { at: Date.now(), services }
    return services
  }
  private async base(chainId: number) {
    const base = (await this.services()).get(chainId)
    if (!base) throw new Error(`Safe does not support chain ${chainId}`)
    return base
  }
  private headers() {
    return { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) }
  }
  async all(chainId: number, path: string): Promise<any[]> {
    const base = await this.base(chainId)
    const results: any[] = []
    let url: string | null = `${base}/api${path}`
    const visited = new Set<string>()
    for (let page = 0; url && page < 20; page++) {
      // Keep both credentials and requests inside the configured service's exact path.
      if (!new URL(url).href.startsWith(`${base}/api/`) || new URL(url).origin !== new URL(base).origin)
        throw new Error('Safe Transaction Service sent a page link outside its service')
      if (visited.has(url)) throw new Error('Safe Transaction Service repeated a page')
      visited.add(url)
      const resp = await this.request(url, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000) })
      if (!resp.ok) throw new Error(`Safe Transaction Service HTTP ${resp.status}`)
      const body = await resp.json() as any
      if (!Array.isArray(body.results) || (body.next != null && typeof body.next !== 'string'))
        throw new Error('Invalid Safe Transaction Service response')
      results.push(...body.results)
      url = body.next ?? null
    }
    if (url) throw new Error('Safe queue exceeds the pagination limit; review it on Safe')
    return results
  }
  private async post(chainId: number, path: string, body: object) {
    const base = await this.base(chainId)
    const resp = await this.request(`${base}/api${path}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    if (!resp.ok) throw new Error(`Safe Transaction Service HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  async confirm(chainId: number, hash: string, signature: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid Safe transaction hash')
    await this.post(chainId, `/v1/multisig-transactions/${hash}/confirmations/`, { signature })
  }
  async pending(chainId: number, safe: string, nonce: string) {
    if (!/^\d+$/.test(nonce)) throw new Error('Invalid Safe nonce')
    return this.all(chainId, `/v2/safes/${utils.getAddress(safe)}/multisig-transactions/?executed=false&nonce__gte=${nonce}&ordering=nonce&limit=20`)
  }
  async ownedSafes(chainId: number, owner: string): Promise<string[]> {
    const rows = await this.all(chainId, `/v2/owners/${utils.getAddress(owner)}/safes/`)
    return [...new Set(rows.map(row => utils.getAddress(row.address)))]
  }
  async publish(p: SafeProposal, sender: string) {
    const signer = utils.getAddress(sender)
    const signature = p.signatures[signer]
    if (!signature) throw new Error('Approve this proposal with the connected KeepKey before sharing it')
    const base = await this.base(p.chainId)
    const existing = await this.request(`${base}/api/v1/multisig-transactions/${p.hash}/`, {
      headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    if (existing.ok) return this.confirm(p.chainId, p.hash, signature)
    if (existing.status !== 404) throw new Error(`Safe Transaction Service HTTP ${existing.status}`)
    await this.post(p.chainId, `/v2/safes/${utils.getAddress(p.safe)}/multisig-transactions/`, {
      ...p.transaction, contractTransactionHash: p.hash, sender: signer, signature, origin: 'KeepKey Vault',
    })
  }
}

export const safeTransactionService = new SafeTransactionService(fetch, process.env.SAFE_TRANSACTION_SERVICE_API_KEY)
