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
