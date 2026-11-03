import type { EvmAddressChainBalance } from './types'

/** Reads are stamped when they start. A slow bulk refresh must not overwrite
 * a newer post-transaction response for the same owner and chain. */
export function shouldApplyOwnerBalanceSnapshot(
  existing: { updatedAt?: number } | undefined,
  incoming: { updatedAt?: number },
): boolean {
  if (existing?.updatedAt === undefined || !Number.isFinite(existing.updatedAt)) return true
  return incoming.updatedAt !== undefined && Number.isFinite(incoming.updatedAt)
    && incoming.updatedAt >= existing.updatedAt
}

export class OwnerBalanceWatermarks {
  private readonly reads = new Map<string, number>()
  private readonly ownerReads = new Map<string, number>()
  beginRead(owner: string, chainId: string | undefined, readStartedAt?: number): void {
    if (readStartedAt === undefined || !Number.isFinite(readStartedAt)) return
    const lower = owner.toLowerCase()
    const map = chainId === undefined ? this.ownerReads : this.reads
    const key = chainId === undefined ? lower : `${lower}:${chainId}`
    map.set(key, Math.max(map.get(key) ?? readStartedAt, readStartedAt))
  }
  accept(owner: string, chainId: string, incoming: { updatedAt?: number }): boolean {
    const key = `${owner.toLowerCase()}:${chainId}`
    const chainRead = this.reads.get(key), ownerRead = this.ownerReads.get(owner.toLowerCase())
    const previous = chainRead === undefined ? ownerRead : ownerRead === undefined ? chainRead : Math.max(chainRead, ownerRead)
    if (!shouldApplyOwnerBalanceSnapshot(previous === undefined ? undefined : { updatedAt: previous }, incoming)) return false
    if (incoming.updatedAt !== undefined && Number.isFinite(incoming.updatedAt)) this.reads.set(key, incoming.updatedAt)
    return true
  }
  clear(): void { this.reads.clear(); this.ownerReads.clear() }
}

/** A delayed refresh must preserve data already obtained by a newer read. */
export function resetOwnerChainBalances(
  balances: Record<string, EvmAddressChainBalance> | undefined,
  chainId?: string,
  readStartedAt?: number,
): Record<string, EvmAddressChainBalance> {
  return Object.fromEntries(Object.entries(balances || {}).filter(([id, balance]) =>
    (chainId !== undefined && id !== chainId)
    || (readStartedAt !== undefined && balance.updatedAt !== undefined && balance.updatedAt > readStartedAt)))
}
