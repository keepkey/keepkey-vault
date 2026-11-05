import { randomUUID } from 'node:crypto'
import { utils } from 'ethers'
import type { SafeAccount, VaultAddParams, VaultAddReview } from '../shared/safe-multisig'
import { safeVaultIdentity, type VaultIdentity } from '../shared/vault-identity'

interface ImportContext {
  key: string
  hidden: boolean
}
interface ImportDeps {
  context: () => ImportContext
  inspect: (params: VaultAddParams) => Promise<SafeAccount>
  save: (vault: VaultIdentity, context: ImportContext) => void
  now?: () => number
}
/** Public account import has no signing or device dependency. Reviews remain
 * session-bound so a hidden-wallet import cannot become a persisted public one. */
export class VaultImportService {
  private pending = new Map<
    string,
    { context: ImportContext; params: VaultAddParams; review: VaultAddReview }
  >()
  private now: () => number
  constructor(private deps: ImportDeps) {
    this.now = deps.now || Date.now
  }
  clear() {
    this.pending.clear()
  }
  private assertContext(context: ImportContext) {
    const current = this.deps.context()
    if (current.key !== context.key || current.hidden !== context.hidden)
      throw new Error('Wallet session changed. Verify the vault again.')
  }
  async preview(input: VaultAddParams): Promise<VaultAddReview> {
    if (input?.chainId !== 8453) throw new Error('Choose Base mainnet (eip155:8453) for this import')
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60)
      throw new Error('Enter a vault name (up to 60 characters)')
    if (typeof input.address !== 'string') throw new Error('Enter the Safe contract address')
    const address = utils.getAddress(input.address.trim())
    const url = new URL(input.rpcUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error('Enter an HTTP or HTTPS verification RPC URL without embedded credentials or fragments')
    const params: VaultAddParams = { chainId: 8453, address, name: input.name.trim(), rpcUrl: url.toString() }
    const context = { ...this.deps.context() }
    const account = await this.deps.inspect(params)
    this.assertContext(context)
    for (const [id, p] of this.pending)
      if (p.review.expiresAt < this.now() || p.context.key !== context.key) this.pending.delete(id)
    if (this.pending.size >= 20)
      throw new Error('Too many pending vault reviews. Finish or retry after five minutes.')
    const review: VaultAddReview = {
      id: randomUUID(),
      account,
      chainId: 8453,
      rpcHost: url.host,
      expiresAt: this.now() + 300_000,
      sessionOnly: context.hidden,
    }
    this.pending.set(review.id, { context, params, review: structuredClone(review) })
    return review
  }
  async confirm(params: { reviewId: string }): Promise<VaultIdentity> {
    const pending = this.pending.get(params.reviewId)
    if (!pending || pending.review.expiresAt < this.now())
      throw new Error('Vault review expired. Verify the address again.')
    this.assertContext(pending.context)
    const fresh = await this.deps.inspect(pending.params)
    this.assertContext(pending.context)
    const expected = pending.review.account
    const owners = (a: SafeAccount) =>
      a.owners
        .map((v) => v.toLowerCase())
        .sort()
        .join()
    if (
      fresh.address !== expected.address ||
      fresh.safeVersion !== expected.safeVersion ||
      fresh.threshold !== expected.threshold ||
      owners(fresh) !== owners(expected)
    ) {
      throw new Error('The vault configuration changed after review. Verify and review its owners again.')
    }
    fresh.reviewedAt = this.now()
    const vault = safeVaultIdentity(fresh, pending.context.hidden)
    this.deps.save(vault, pending.context)
    this.pending.delete(params.reviewId)
    return vault
  }
}
