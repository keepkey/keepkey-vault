import type { ExecuteSwapParams, SwapAsset, SwapQuote, SwapQuoteParams } from '../shared/types'
import type { SwapRisk } from '../shared/swap-risk'
import { canonicalizeCaip } from '../shared/swap-discovery'
import { CONFIRM_SLIPPAGE_BPS } from '../shared/slippage'
import { computeEffectiveSlippageBps } from '../shared/swap-warnings'

const assetKey = (value: string) => {
  const key = canonicalizeCaip(value)
  return key.startsWith('eip155:') ? key.toLowerCase() : key
}

const stable = (value: any): string => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))) : row)
const routeFields = ['memo', 'inboundAddress', 'router', 'expiry', 'expectedOutput', 'integration', 'swapper', 'relayTx'] as const
/** Device prompts that carry no rate (swap.ts wrapSign operations / protectSign
 * kinds): the ERC-20 approval and the ClearSign signer trust before it. Any
 * other step, including one added later, stays bound to the quote's age. */
const APPROVAL_STEPS = new Set(['approval', 'erc20Approve'])
const RATE_FREE_STEPS = new Set([...APPROVAL_STEPS, 'loadClearsignSigner'])

/** Wallet-session-local, immutable, bounded quotes. Claim synchronously before
 * any await, and recheck immediately before each device signature: the session
 * always, the age only for quote-bound steps. Pre-sign build failures can
 * retry; an attempted signature consumes the quote even if the device or
 * broadcast response is lost. */
export function createSwapQuoteLeases(now = Date.now, id = () => crypto.randomUUID()) {
  type Entry = { params: SwapQuoteParams; quote: SwapQuote; from: SwapAsset; to: SwapAsset; session: number; consumed: boolean }
  const entries = new Map<string, Entry>()
  let active: string | undefined
  function issue(params: SwapQuoteParams, quote: SwapQuote, from: SwapAsset, to: SwapAsset, session: number, risk: SwapRisk): SwapQuote {
    if (!Number.isFinite(Number(quote.expectedOutput)) || Number(quote.expectedOutput) <= 0
      || !Number.isFinite(Number(quote.minimumOutput)) || Number(quote.minimumOutput) < 0
      || Number(quote.minimumOutput) > Number(quote.expectedOutput)) throw new Error('Invalid swap output amounts. Get a new quote.')
    for (const [key, row] of entries) if (row.quote.quoteExpiresAt! <= now() && key !== active) entries.delete(key)
    while (entries.size >= 100) {
      const oldest = [...entries.keys()].find(key => key !== active)
      if (!oldest) throw new Error('Swap quote storage is busy')
      entries.delete(oldest)
    }
    const created = now()
    const expires = Math.min(created + risk.quoteMaxAgeMs, quote.expiry == null ? Infinity : quote.expiry * 1000)
    if (!Number.isFinite(expires) || expires <= created) throw new Error('Swap quote has expired. Get a new quote.')
    const result = { ...quote, quoteId: id(), quoteCreatedAt: created, quoteExpiresAt: expires, risk }
    entries.set(result.quoteId, structuredClone({ params, quote: result, from, to, session, consumed: false }))
    return result
  }
  function claim(input: ExecuteSwapParams, session: number) {
    const row = input.quoteId ? entries.get(input.quoteId) : undefined
    if (!row) throw new Error('A fresh Vault quoteId is required. Get a new quote before executing.')
    let attempted = false, approved = false
    const fresh = (currentSession: number, quoteBound = true) => {
      if (currentSession !== row.session) throw new Error('Wallet or API session changed. Get a new quote.')
      // Reaching the swap after an approval step means that approval was broadcast.
      if (quoteBound && now() >= row.quote.quoteExpiresAt!) throw new Error(approved
        ? 'The approval was sent, but the swap quote expired while it confirmed. Get a new quote to finish the swap.'
        : 'Swap quote has expired. Review a new quote before signing.')
    }
    fresh(session)
    if (row.consumed) throw new Error('This swap quote was already used. Check transaction history before retrying.')
    if (active) throw new Error('Another swap execution is already in progress.')
    const { params, quote, from, to } = row
    const same = (key: string, expected: unknown, actual: unknown) => {
      if (stable(actual) !== stable(expected)) throw new Error(`Swap quote mismatch: ${key}. Review a new quote.`)
    }
    same('fromCaip', assetKey(params.fromCaip), assetKey(input.fromCaip))
    same('toCaip', assetKey(params.toCaip), assetKey(input.toCaip))
    same('fromChainId', from.chainId, input.fromChainId)
    same('toChainId', to.chainId, input.toChainId)
    if (input.amount !== params.amount && input.amount !== quote.netFromAmount) throw new Error('Swap quote mismatch: amount. Review a new quote.')
    same('isMax', !!params.isMax, !!input.isMax)
    if (input.feeLevel != null) same('feeLevel', params.feeLevel ?? 5, input.feeLevel)
    if (input.fromAddressOverride != null) same('source address', params.fromAddress, input.fromAddressOverride)
    if (input.toAddressOverride != null) same('destination address', params.toAddress, input.toAddressOverride)
    same('source account', params.fromEvmAddressIndex ?? 0, input.fromEvmAddressIndex ?? 0)
    if (input.tokenDecimals != null) same('token decimals', from.decimals, input.tokenDecimals)
    for (const key of routeFields) same(key, quote[key], input[key])
    if (quote.risk!.blocked) throw new Error('This route exceeds the 5% cost limit for trades of $1,000 or more.')
    if (quote.risk!.requiresAcknowledgment && input.riskAcknowledged !== true) throw new Error('Review and acknowledge the cost risk for this quote before signing.')
    // The dialog's high-slippage checkbox, enforced here so REST callers meet it too (audit v4 V1).
    if (computeEffectiveSlippageBps(quote.slippageBps, params.slippageBps ?? 0) > CONFIRM_SLIPPAGE_BPS && input.slippageAcknowledged !== true) {
      throw new Error(`Slippage tolerance above ${CONFIRM_SLIPPAGE_BPS / 100}% must be acknowledged (slippageAcknowledged) before signing.`)
    }
    active = input.quoteId
    return {
      quote: structuredClone(quote),
      params: structuredClone({ ...input, ...Object.fromEntries(routeFields.map(key => [key, quote[key]])), fromCaip: params.fromCaip, toCaip: params.toCaip, amount: quote.netFromAmount ?? params.amount,
        isMax: quote.netFromAmount ? false : params.isMax, feeLevel: params.feeLevel ?? 5,
        fromAddressOverride: params.fromAddress, toAddressOverride: params.toAddress,
        tokenDecimals: from.decimals }) as ExecuteSwapParams,
      /** `step` is the wrapSign operation or protectSign kind about to prompt the device. */
      beforeSign(currentSession: number, step = 'swap') {
        fresh(currentSession, !RATE_FREE_STEPS.has(step))
        attempted = true
        approved ||= APPROVAL_STEPS.has(step)
      },
      finish(succeeded: boolean) { row.consumed ||= attempted || succeeded; if (active === input.quoteId) active = undefined },
    }
  }
  return { issue, claim }
}
