interface PortfolioObservation {
  fetchedAt?: unknown
  fetchedAtISO?: unknown
}

/** Observation time belongs to the source, not the time a cached reply arrived.
 * A caller may supply an explicit fallback for legacy live reads or a previous
 * cached observation. Missing age on any row prevents an unsupported fresh claim. */
export function portfolioObservedAt(
  rows: readonly (PortfolioObservation | null | undefined)[],
  readStartedAt: number,
  fallback?: number,
): number | undefined {
  if (!rows.length || !Number.isFinite(readStartedAt) || readStartedAt <= 0) return undefined
  const bounded = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, readStartedAt) : undefined
  const fallbackAt = bounded(fallback)
  let oldest = readStartedAt
  for (const row of rows) {
    const numeric = bounded(row?.fetchedAt)
    const iso = row?.fetchedAtISO
    const parsed = typeof iso === 'string' && iso.length <= 64
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(iso)
      ? bounded(Date.parse(iso)) : undefined
    const at = numeric !== undefined && parsed !== undefined ? Math.min(numeric, parsed) : numeric ?? parsed ?? fallbackAt
    if (at === undefined) return undefined
    oldest = Math.min(oldest, at)
  }
  return oldest
}
