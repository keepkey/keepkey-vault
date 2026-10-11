/** What a Cosmos-family amino sign request signs, read from the document
 * itself: every field of every message, plus fee and memo. No per-message
 * table, so a message type this file has never seen still shows its fields. */
export interface CosmosTxPreview {
  title: string
  messages: { type: string; rows: { label: string; value: string }[] }[]
  fee?: string
  memo?: string
}

const CHAINS: Record<string, string> = { cosmos: 'Cosmos', osmosis: 'Osmosis', thorchain: 'THORChain', mayachain: 'Maya' }

/** Base-unit decimals where the convention is fixed; undefined = show raw only. */
function decimalsFor(chain: string, denom: string): number | undefined {
  if (chain === 'thorchain') return 8
  if (chain === 'mayachain') return denom.toLowerCase() === 'cacao' ? 10 : 8
  return /^u[a-z]+$/.test(denom) ? 6 : undefined
}

function coin(chain: string, c: any): string | undefined {
  const denom = c?.denom ?? c?.asset
  if (typeof c?.amount !== 'string' || !/^\d+$/.test(c.amount) || typeof denom !== 'string') return undefined
  const decimals = decimalsFor(chain, denom)
  if (decimals === undefined) return `${c.amount} ${denom}`
  const units = BigInt(c.amount), scale = 10n ** BigInt(decimals)
  const frac = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  const symbol = (chain === 'cosmos' || chain === 'osmosis' ? denom.slice(1) : denom).toUpperCase()
  return `${units / scale}${frac ? '.' + frac : ''} ${symbol} (${c.amount} ${denom})`
}

const label = (key: string) => key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

function rows(chain: string, value: any, prefix = ''): { label: string; value: string }[] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, v]): { label: string; value: string }[] => {
    const name = prefix + label(key)
    if (v === null || v === undefined || v === '') return []
    if (typeof v !== 'object') return [{ label: name, value: String(v) }]
    const single = coin(chain, v)
    if (single) return [{ label: name, value: single }]
    if (Array.isArray(v)) {
      const coins = v.map(c => coin(chain, c))
      if (v.length > 0 && coins.every(Boolean)) return [{ label: name, value: coins.join(' + ') }]
      return v.flatMap((item, i) => typeof item === 'object'
        ? rows(chain, item, `${name} ${i + 1} · `)
        : [{ label: `${name} ${i + 1}`, value: String(item) }])
    }
    return rows(chain, v, `${name} · `)
  })
}

export function cosmosTxPreview(method: string, payload: unknown): CosmosTxPreview | undefined {
  const route = /^\/(cosmos|osmosis|thorchain|mayachain)\/sign-amino(?:-(.+))?$/.exec(method)
  if (!route || !payload || typeof payload !== 'object') return undefined
  const [, chain, action] = route
  const signDoc = (payload as any).signDoc
  const msgs = signDoc?.msgs ?? signDoc?.msg
  if (!Array.isArray(msgs) || msgs.length === 0) return undefined
  const fee = Array.isArray(signDoc?.fee?.amount)
    ? signDoc.fee.amount.map((c: any) => coin(chain, c)).filter(Boolean).join(' + ') || undefined
    : undefined
  return {
    title: `${CHAINS[chain]} ${action ? label(action.replace(/-/g, '_')) : 'sign'}`,
    messages: msgs.map((m: any) => ({ type: String(m?.type ?? 'unknown message'), rows: rows(chain, m?.value) })),
    fee,
    memo: typeof signDoc?.memo === 'string' && signDoc.memo ? signDoc.memo : undefined,
  }
}
