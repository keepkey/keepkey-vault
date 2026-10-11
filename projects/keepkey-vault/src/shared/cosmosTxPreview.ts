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

/** The only denoms converted to whole units: each chain's own coin, whose
 * decimals are fixed. Every other denom is shown exactly as signed, because a
 * guessed decimal count would put a wrong amount on an approval screen. */
const NATIVE: Record<string, { denoms: string[]; decimals: number; symbol: string }> = {
  cosmos: { denoms: ['uatom'], decimals: 6, symbol: 'ATOM' },
  osmosis: { denoms: ['uosmo'], decimals: 6, symbol: 'OSMO' },
  thorchain: { denoms: ['rune', 'THOR.RUNE'], decimals: 8, symbol: 'RUNE' },
  mayachain: { denoms: ['cacao', 'MAYA.CACAO'], decimals: 10, symbol: 'CACAO' },
}

const digits = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d+$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined

function format(chain: string, amount: string, denom: string): string {
  const native = NATIVE[chain]
  if (!native.denoms.includes(denom)) return `${amount} ${denom}`
  const units = BigInt(amount), scale = 10n ** BigInt(native.decimals)
  const frac = (units % scale).toString().padStart(native.decimals, '0').replace(/0+$/, '')
  return `${units / scale}${frac ? '.' + frac : ''} ${native.symbol} (${amount} ${denom})`
}

/** A bare coin object: exactly a denom (or asset) and an amount, nothing else to hide. */
function coin(chain: string, c: any): string | undefined {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return undefined
  const keys = Object.keys(c)
  const denom = c.denom ?? c.asset
  const amount = digits(c.amount)
  if (keys.length !== 2 || amount === undefined || typeof denom !== 'string') return undefined
  return format(chain, amount, denom)
}

/** hdwallet sends only the first fee amount and the firmware signs it in the
 * chain's own coin, so that is the only fee this card can state as fact. */
function feeRow(chain: string, fee: any): string | undefined {
  const first = Array.isArray(fee?.amount) ? fee.amount[0] : undefined
  const amount = digits(first?.amount)
  if (amount === undefined) return undefined
  const native = NATIVE[chain].denoms[0]
  if (first.denom === native) return format(chain, amount, native)
  return `${amount} ${String(first.denom)} requested; your KeepKey shows the fee it signs`
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
  return {
    title: `${CHAINS[chain]} ${action ? label(action.replace(/-/g, '_')) : 'sign'}`,
    messages: msgs.map((m: any) => ({ type: String(m?.type ?? 'unknown message'), rows: rows(chain, m?.value) })),
    fee: feeRow(chain, signDoc?.fee),
    memo: typeof signDoc?.memo === 'string' && signDoc.memo ? signDoc.memo : undefined,
  }
}
