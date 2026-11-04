import type { PendingSwap, SwapTrackingStatus } from './types'

// Native 1Click asset identities are stable. Token identities/decimals come
// from the verified quote persisted before signing, never from status alone.
const nativeAssets: Record<string, [string, number]> = {
  'eip155:1/slip44:60': ['nep141:eth.omft.near', 18],
  'eip155:42161/slip44:60': ['nep141:arb.omft.near', 18],
  'eip155:8453/slip44:60': ['nep141:base.omft.near', 18],
  'eip155:10/slip44:60': ['nep245:v2_1.omni.hot.tg:10_11111111111111111111', 18],
  'eip155:43114/slip44:60': ['nep245:v2_1.omni.hot.tg:43114_11111111111111111111', 18],
  'eip155:56/slip44:60': ['nep245:v2_1.omni.hot.tg:56_11111111111111111111', 18],
  'eip155:137/slip44:60': ['nep245:v2_1.omni.hot.tg:137_11111111111111111111', 18],
  'eip155:100/slip44:60': ['nep141:gnosis.omft.near', 18],
  'bip122:000000000019d6689c085ae165831e93/slip44:0': ['nep141:btc.omft.near', 8],
  'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2': ['nep141:ltc.omft.near', 8],
  'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133': ['nep141:zec.omft.near', 8],
  'bip122:000007d91d1254d60e2dd1ae58038307/slip44:5': ['nep141:dash.omft.near', 8],
  'bip122:00000000001a91e3dace36e2be3bf030/slip44:3': ['nep141:doge.omft.near', 8],
  'bip122:000000000000000000651ef99cb9fcbe/slip44:145': ['nep141:bch.omft.near', 8],
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501': ['nep141:sol.omft.near', 9],
  'tron:0x2b6653dc/slip44:195': ['nep141:tron.omft.near', 6],
  'ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144': ['nep141:xrp.omft.near', 6],
  'ripple:0/slip44:144': ['nep141:xrp.omft.near', 6],
}
for (const [network, slip] of [['43114', '9000'], ['56', '714'], ['137', '966']]) {
  nativeAssets[`eip155:${network}/slip44:${slip}`] = nativeAssets[`eip155:${network}/slip44:60`]
}

export interface NearIntentsSettlement {
  status: SwapTrackingStatus
  nearTxHash?: string
  outboundTxid?: string
  receivedOutput?: string
  refundTxid?: string
  refundReason?: string
  error?: string
}

function sameAddress(caip: string, left: unknown, right: string): boolean {
  if (typeof left !== 'string' || !left || !right) return false
  if (caip.startsWith('eip155:')) return left.toLowerCase() === right.toLowerCase()
  if (caip.startsWith('bip122:000000000000000000651ef99cb9fcbe')) return left.replace(/^bitcoincash:/i, '').toLowerCase() === right.replace(/^bitcoincash:/i, '').toLowerCase()
  if (/^(?:bc1|ltc1)/i.test(left) && /^(?:bc1|ltc1)/i.test(right)) return left.toLowerCase() === right.toLowerCase()
  return left === right
}
function sameHash(caip: string, left: string, right: string): boolean {
  return /^(?:eip155:|bip122:|tron:|ripple:)/.test(caip)
    ? left.replace(/^0x/i, '').toLowerCase() === right.replace(/^0x/i, '').toLowerCase() : left === right
}
function validHash(caip: string, raw: unknown): raw is string {
  if (typeof raw !== 'string' || /^(?:0x)?0+$/i.test(raw)) return false
  if (caip.startsWith('eip155:')) return /^0x[0-9a-f]{64}$/i.test(raw)
  if (/^(?:bip122:|tron:|ripple:)/.test(caip)) return /^[0-9a-f]{64}$/i.test(raw)
  if (caip.startsWith('solana:')) return /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(raw)
  return false
}
function positive(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error('NEAR status has no positive settlement amount')
  return BigInt(raw)
}
function decimalUnits(raw: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('NEAR tracking is missing an exact amount')
  const [whole, fraction = ''] = raw.split('.')
  if (/[1-9]/.test(fraction.slice(decimals))) throw new Error('NEAR tracking amount exceeds asset precision')
  return positive(whole + fraction.slice(0, decimals).padEnd(decimals, '0'))
}
function decimal(raw: bigint, decimals: number): string {
  if (!decimals) return raw.toString()
  const padded = raw.toString().padStart(decimals + 1, '0')
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(/\.?0+$/, '')
}
function asset(caip: string, metadataId?: string, metadataDecimals?: number): [string, number] {
  const native = nativeAssets[caip]
  if (native) {
    if ((metadataId !== undefined && metadataId !== native[0]) || (metadataDecimals !== undefined && metadataDecimals !== native[1])) throw new Error('NEAR quote asset metadata does not match the selected native asset')
    return native
  }
  if (!metadataId || !Number.isInteger(metadataDecimals) || metadataDecimals! < 0 || metadataDecimals! > 255) throw new Error('NEAR tracking lacks verified token identity and decimals')
  return [metadataId, metadataDecimals!]
}

/** Only a bound origin deposit plus a destination payout establishes success.
 * A quote's estimate and a source transaction receipt are not received output. */
export function classifyNearIntentsStatus(swap: PendingSwap, data: any): NearIntentsSettlement {
  const near = swap.trackingContext?.nearIntents
  const sourceCaip = swap.fromCaip || '', destinationCaip = swap.toCaip || ''
  const deposit = near?.depositAddress || swap.nearIntentsDepositAddress || swap.inboundAddress
  const sender = swap.trackingContext?.fromAddress || '', recipient = swap.trackingContext?.toAddress || ''
  if (!sourceCaip || !destinationCaip || !deposit || !sender || !recipient || sameAddress(sourceCaip, deposit, sender)) throw new Error('NEAR tracking lacks the actual sender, recipient or deposit address')
  if ((near?.refundTo && !sameAddress(sourceCaip, near.refundTo, sender)) || (near?.recipient && !sameAddress(destinationCaip, near.recipient, recipient))) throw new Error('NEAR tracking customer addresses conflict')
  const [originAsset, sourceDecimals] = asset(sourceCaip, near?.originAsset, near?.sourceDecimals)
  const [destinationAsset, destinationDecimals] = asset(destinationCaip, near?.destinationAsset, near?.destinationDecimals)
  const input = decimalUnits(swap.fromAmount, sourceDecimals)
  const minimum = decimalUnits(swap.minimumOutput || near?.minimumAmountOut || swap.expectedOutput, destinationDecimals)
  const request = data?.quoteResponse?.quoteRequest, terms = data?.quoteResponse?.quote
  if (!request || !terms || request.dry !== false || request.swapType !== 'EXACT_INPUT' || request.depositMode !== 'SIMPLE'
    || request.depositType !== 'ORIGIN_CHAIN' || request.refundType !== 'ORIGIN_CHAIN' || request.recipientType !== 'DESTINATION_CHAIN'
    || request.originAsset !== originAsset || request.destinationAsset !== destinationAsset || request.amount !== input.toString()
    || !sameAddress(sourceCaip, request.refundTo, sender) || !sameAddress(destinationCaip, request.recipient, recipient)
    || !sameAddress(sourceCaip, terms.depositAddress, deposit) || terms.amountIn !== input.toString()
    || (terms.depositMemo != null && terms.depositMemo !== '') || positive(terms.minAmountOut) < minimum) throw new Error('NEAR status does not match the signed swap intent')
  const details = data?.swapDetails || {}, state = String(data?.status || '').toUpperCase()
  const origins: string[] = Array.isArray(details.originChainTxHashes) ? details.originChainTxHashes.map((tx: any) => tx?.hash).filter((hash: any) => validHash(sourceCaip, hash)) : []
  const destinations: string[] = Array.isArray(details.destinationChainTxHashes) ? details.destinationChainTxHashes.map((tx: any) => tx?.hash).filter((hash: any) => validHash(destinationCaip, hash)) : []
  const sourceKnown = origins.some(hash => sameHash(sourceCaip, hash, swap.txid))
  const payout = destinations.find(hash => !sameHash(sourceCaip, hash, swap.txid))
  const nearTxHash = typeof details.nearTxHashes?.[0] === 'string' ? details.nearTxHashes[0] : undefined
  if (state === 'SUCCESS') {
    if (!sourceKnown || !payout || positive(details.depositedAmount) < input || positive(details.amountOut) < minimum
      || positive(details.amountOut) < positive(terms.minAmountOut)) throw new Error('NEAR success lacks a bound deposit and minimum destination payout')
    return { status: 'completed', outboundTxid: payout, receivedOutput: decimal(positive(details.amountOut), destinationDecimals), nearTxHash }
  }
  if (state === 'REFUNDED') {
    const refund = origins.find(hash => !sameHash(sourceCaip, hash, swap.txid))
    if (!sourceKnown || !refund || positive(details.refundedAmount) <= 0n) throw new Error('NEAR refund lacks a bound deposit and source-chain refund payout')
    return { status: 'refunded', refundTxid: refund, refundReason: details.refundReason || 'NEAR Intents returned the deposit', nearTxHash }
  }
  if (state === 'FAILED') {
    if (!sourceKnown) throw new Error('NEAR has not identified the signed source transaction')
    return { status: 'failed', error: details.refundReason || 'NEAR Intents execution failed', nearTxHash }
  }
  if (['PROCESSING', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT'].includes(state)) return { status: 'confirming', nearTxHash: sourceKnown ? nearTxHash : undefined }
  if (state === 'PENDING_DEPOSIT') return { status: swap.status }
  throw new Error('NEAR returned an unknown execution status')
}
