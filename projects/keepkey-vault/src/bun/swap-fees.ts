import assetData from '../shared/assetData.json'
import { CHAINS } from '../shared/chains'
import type { SwapQuoteFeeItem } from '../shared/types'

type Context = { fromCaip: string; toCaip: string; integration?: string; swapper?: string }
const assets = assetData as Record<string, { symbol: string; decimals?: number }>
const kinds = new Set(['affiliate', 'network', 'protocol', 'provider'])
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
const units = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value)
const bps = (value: unknown): number | undefined => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined

function human(value: string, decimals: number): string {
  const padded = BigInt(value).toString().padStart(decimals + 1, '0')
  if (!decimals) return padded
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(/\.?0+$/, '') || '0'
}
function metadata(caip: string): { symbol: string; decimals: number } | undefined {
  const asset = assets[caip] || assets[caip.toLowerCase()]
  if (asset?.symbol && Number.isInteger(asset.decimals)) return { symbol: asset.symbol, decimals: asset.decimals! }
  const chain = CHAINS.find(chain => chain.caip.toLowerCase() === caip.toLowerCase())
  return chain ? { symbol: chain.symbol, decimals: chain.decimals } : undefined
}
function currencyMeta(currency: any): { assetCaip: string; symbol: string; decimals: number } | undefined {
  if (!currency || typeof currency.symbol !== 'string' || !Number.isInteger(currency.decimals)) return undefined
  let caip = currency.assetCaip || currency.assetId || currency.caip
  if (!caip && Number.isInteger(currency.chainId)) {
    const network = currency.chainId === 792703809 ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : `eip155:${currency.chainId}`
    const native = currency.chainId === 792703809 ? currency.address === '11111111111111111111111111111111' : /^0x0{40}$/i.test(currency.address || '')
    caip = native ? CHAINS.find(chain => chain.networkId === network)?.caip
      : currency.chainId === 792703809 ? `${network}/token:${currency.address}`
      : /^0x[0-9a-f]{40}$/i.test(currency.address || '') ? `${network}/erc20:${currency.address.toLowerCase()}` : undefined
  }
  return typeof caip === 'string' && caip.includes('/') ? { assetCaip: caip, symbol: currency.symbol, decimals: currency.decimals } : undefined
}

function normalizeItem(value: any): SwapQuoteFeeItem | undefined {
  if (!value || !kinds.has(value.kind)) return undefined
  const rate = bps(value.bps)
  const assetCaip = typeof value.assetCaip === 'string' && value.assetCaip.includes('/') ? value.assetCaip : undefined
  const known = assetCaip ? metadata(assetCaip) : undefined
  const decimals = Number.isInteger(value.decimals) ? value.decimals : known?.decimals
  const symbol = typeof value.symbol === 'string' && value.symbol.length <= 32 ? value.symbol : known?.symbol
  let amount: string | undefined, amountBaseUnits: string | undefined
  if (assetCaip && symbol && Number.isInteger(decimals) && decimals! >= 0 && decimals! <= 255) {
    if (units(value.amountBaseUnits)) { amountBaseUnits = value.amountBaseUnits; amount = human(value.amountBaseUnits, decimals!) }
    else if (decimal(value.amount)) amount = value.amount
  }
  if (amount !== undefined && Number(amount) === 0) {
    amount = undefined
    amountBaseUnits = undefined
  }
  if (amount === undefined && !(rate && rate > 0)) return undefined
  return { kind: value.kind, ...(value.label ? { label: String(value.label).slice(0, 80) } : {}),
    ...(amount !== undefined ? { assetCaip, symbol, decimals, amount, ...(amountBaseUnits ? { amountBaseUnits } : {}) } : {}),
    ...(rate !== undefined ? { bps: rate } : {}),
    ...(typeof value.recipient === 'string' ? { recipient: value.recipient } : {}), ...(value.estimated === true ? { estimated: true } : {}) }
}

/** Prefer typed gateway costs. Normalize legacy provider objects only where
 * their unit contract is known; an untyped integer is never guessed by size. */
export function parseSwapFeeDisclosure(raw: any, quote: any, context: Context): { items: SwapQuoteFeeItem[]; reportedTotalBps?: number } {
  const fees = raw?.fees || quote?.fees || {}
  let reportedTotalBps = bps(fees.total_bps ?? fees.totalBps)
  const typed = fees.items
  if (Array.isArray(typed) && typed.some(item => kinds.has(item?.kind))) return { items: typed.map(normalizeItem).filter(Boolean) as SwapQuoteFeeItem[], reportedTotalBps }
  const items: SwapQuoteFeeItem[] = []
  const add = (entry: any) => { const item = normalizeItem(entry); if (item) items.push(item) }
  const route = `${context.integration || ''} ${context.swapper || ''}`.toLowerCase()
  if (/relay/.test(route)) {
    for (const [key, kind, label] of [['app', 'affiliate', 'Relay app fee'], ['gas', 'network', 'Source network fee (estimate)'], ['relayer', 'provider', 'Relay execution fee']] as const) {
      const fee = fees[key], meta = currencyMeta(fee?.currency)
      if (meta && units(fee?.amount)) add({ kind, label, ...meta, amountBaseUnits: fee.amount, estimated: key !== 'app' })
    }
  } else if (/near/.test(route) && raw?.quoteRequest?.appFees && raw?.quote) {
    const input = metadata(context.fromCaip), output = metadata(context.toCaip)
    const amountIn = String(raw.quote.amountIn ?? raw.quoteRequest.amount ?? '')
    const appFees = raw.quoteRequest.appFees
    if (input && units(amountIn) && Array.isArray(appFees)) {
      reportedTotalBps = appFees.reduce((total: number, fee: any) => total + (bps(fee.fee) ?? 0), 0)
      for (const fee of appFees) {
        const rate = bps(fee.fee)
        if (rate === undefined || !Number.isInteger(rate)) continue
        const numerator = BigInt(amountIn) * BigInt(rate)
        add({ kind: 'affiliate', label: 'NEAR app fee', assetCaip: context.fromCaip, ...input,
          amountBaseUnits: (numerator / 10000n).toString(), bps: rate, recipient: fee.recipient, estimated: numerator % 10000n !== 0n })
      }
    }
    if (output && units(String(raw.quote.withdrawFee ?? ''))) add({ kind: 'network', label: 'Destination withdrawal fee', assetCaip: context.toCaip, ...output, amountBaseUnits: String(raw.quote.withdrawFee) })
  } else if (/thor|maya/.test(route)) {
    const output = metadata(context.toCaip)
    // THORNode fees are protocol base units (1e8), even for USDC (1e6).
    // Maya's native CACAO denomination is 1e10.
    const protocolDecimals = /maya/i.test(route) && /^cosmos:mayachain.*\/slip44:931$/i.test(context.toCaip) ? 10 : 8
    if (output) for (const [key, kind, label] of [['affiliate', 'affiliate', 'Affiliate fee'], ['outbound', 'network', 'Outbound fee']] as const) {
      const value = String(fees[key] ?? '')
      if (units(value)) add({ kind, label, assetCaip: context.toCaip, ...output, amount: human(value, protocolDecimals) })
      else if (decimal(value)) add({ kind, label, assetCaip: context.toCaip, ...output, amount: value })
    }
  } else if (/uniswap/.test(route)) {
    const output = metadata(context.toCaip)
    if (output && decimal(String(fees.affiliate ?? ''))) add({ kind: 'affiliate', label: 'Affiliate fee', assetCaip: context.toCaip, ...output, amount: String(fees.affiliate) })
  } else if (/0x|zeroex/.test(route)) {
    const network = context.toCaip.split('/')[0]
    const integrator = fees.integratorFees || (fees.integratorFee ? [fees.integratorFee] : [])
    for (const [entries, kind, label] of [[integrator, 'affiliate', 'Affiliate fee'], [fees.zeroExFee ? [fees.zeroExFee] : [], 'provider', '0x fee']] as const) {
      for (const fee of entries) {
        const assetCaip = typeof fee.token === 'string' ? `${network}/erc20:${fee.token.toLowerCase()}` : ''
        const meta = metadata(assetCaip)
        if (meta && units(String(fee.amount))) add({ kind, label, assetCaip, ...meta, amountBaseUnits: String(fee.amount) })
      }
    }
  }
  // ShapeShift reports these two rates independently; no destination amount
  // can be inferred from them or from an untyped source-network integer.
  if (/shapeshift/.test(route)) {
    for (const [key, label] of [['partner', 'Partner fee'], ['shapeshift', 'ShapeShift fee']] as const) {
      const rate = bps(quote?.meta?.feeBreakdown?.[key]?.bps)
      if (rate !== undefined) add({ kind: key === 'partner' ? 'affiliate' : 'provider', label, bps: rate })
    }
  }
  // Some aggregators expose rates without any fee currency. Preserve that
  // disclosure, but leave the amount unknown instead of assuming buy units.
  if (!items.length && Array.isArray(typed)) for (const entry of typed) {
    const rate = bps(entry?.amountBps)
    if (rate !== undefined) add({ kind: entry.type === 'affiliate' ? 'affiliate' : 'provider', label: entry.type === 'affiliate' ? 'Affiliate fee' : 'Provider fee', bps: rate })
  }
  return { items, reportedTotalBps }
}
