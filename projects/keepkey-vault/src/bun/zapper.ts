/**
 * Zapper DeFi positions client.
 *
 * The vault's normal token list comes from Pioneer's GetPortfolioBalances. DeFi
 * positions (staked / supplied / borrowed / LP / claimable balances held inside
 * protocol contracts) are a separate concern, served by the dedicated Zapper
 * proxy on the KeepKey API:
 *
 *   GET {base}/api/v1/zapper/portfolio/{address}
 *
 * `base` resolves the same way as every other Pioneer call (DB setting >
 * PIONEER_API_BASE env > https://api.keepkey.info), so pointing the app at a
 * local server moves DeFi lookups with it.
 *
 * An item is a DeFi position when ANY of these are present:
 *   - tokenType === 'contract-position'
 *   - appId
 *   - groupId
 *   - metaType
 *
 * Each item is normalized to a DefiPosition carrying `isDefi` and
 * `protocol` (= appId). Only DeFi items are returned to the UI — plain wallet
 * tokens stay served by the existing Pioneer path, so there is no duplication.
 */
import type { DefiPosition } from '../shared/types'

const ZAPPER_TIMEOUT_MS = 20_000

/** Pick the first defined, non-empty value from a list of candidates. */
function pick(...vals: any[]): any {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/**
 * Decide whether a raw Zapper item is a DeFi position and, if so, normalize it.
 * Pure — no I/O — so it can be unit-tested against captured fixtures.
 *
 * Returns null for plain wallet tokens (tokenType 'token'/'app-token' with no
 * DeFi markers) so the caller can drop them; those are already shown via
 * Pioneer's token list.
 */
export function classifyDefiPosition(raw: any): DefiPosition | null {
  if (!raw || typeof raw !== 'object') return null

  const tokenType = pick(raw.tokenType, raw.type)
  const appId = pick(raw.appId, raw.app?.id, raw.app?.slug) ?? null
  const groupId = pick(raw.groupId, raw.group?.id)
  const metaType = pick(raw.metaType, raw.group?.type) ?? null

  const isDefi =
    tokenType === 'contract-position' ||
    !!appId ||
    !!groupId ||
    !!metaType
  if (!isDefi) return null

  const display = raw.displayProps || raw.display || {}
  const name = String(
    pick(display.label, raw.label, raw.name, raw.displayLabel, raw.symbol, appId, 'DeFi Position'),
  )
  const symbol = String(pick(raw.symbol, raw.assetSymbol, name))
  const network = String(pick(raw.network, raw.networkId, raw.chain, '')).toLowerCase()
  const balance = String(pick(raw.balance, raw.tokenBalance, raw.context?.balance, '0'))
  const balanceUsd = Number(pick(raw.balanceUSD, raw.balanceUsd, raw.valueUsd, raw.value, 0)) || 0
  const icon = pick(
    Array.isArray(display.images) ? display.images[0] : undefined,
    raw.icon,
    raw.iconUrl,
  )

  return {
    isDefi: true,
    protocol: appId ? String(appId) : null,
    name,
    symbol,
    network,
    type: tokenType ? String(tokenType) : 'contract-position',
    metaType: metaType ? String(metaType) : null,
    balance,
    balanceUsd,
    icon: icon ? String(icon) : undefined,
  }
}

/**
 * Normalize a raw Zapper portfolio response into DeFi positions.
 * Tolerant of the response being a bare array, `{ positions }`, `{ balances }`,
 * or wrapped in `{ data }`.
 */
export function normalizeDefiPositions(json: any): DefiPosition[] {
  const items: any[] =
    (Array.isArray(json) && json) ||
    json?.positions ||
    json?.balances ||
    json?.data?.positions ||
    json?.data?.balances ||
    (Array.isArray(json?.data) && json.data) ||
    []
  if (!Array.isArray(items)) return []
  const out: DefiPosition[] = []
  for (const raw of items) {
    const pos = classifyDefiPosition(raw)
    if (pos) out.push(pos)
  }
  // Highest-value positions first — matches the token table sort.
  return out.sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0))
}

/**
 * Fetch DeFi positions for a single EVM address. Returns [] on any failure —
 * DeFi is supplementary, so a flaky endpoint never breaks the asset view.
 */
export async function fetchDefiPositions(address: string): Promise<DefiPosition[]> {
  if (!address) return []
  // Lazy import keeps the pure classify/normalize helpers above importable on
  // their own (./pioneer pulls in the Pioneer client + DB, which aren't needed
  // — and aren't installed — when unit-testing the classification logic).
  const { getPioneerApiBase } = await import('./pioneer')
  const base = getPioneerApiBase()
  const url = `${base}/api/v1/zapper/portfolio/${address}`
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(ZAPPER_TIMEOUT_MS),
    })
    if (!resp.ok) {
      console.warn(`[Zapper] ${resp.status} fetching positions for ${address}`)
      return []
    }
    const json = await resp.json()
    const positions = normalizeDefiPositions(json)
    console.log(`[Zapper] ${positions.length} DeFi positions for ${address.slice(0, 10)}…`)
    return positions
  } catch (e: any) {
    console.warn(`[Zapper] fetch failed for ${address}:`, e?.message || e)
    return []
  }
}
