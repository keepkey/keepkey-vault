import type { PendingSwap } from './types'

// Legacy Pioneer accepts the aggregator enum; the underlying protocol remains
// explicit in swapper so both old and gateway trackers select the right watcher.
const PIONEER_INTEGRATION_ALIAS: Record<string, string> = {
  shapeshiftSwap: 'shapeshift',
  nearIntents: 'shapeshift',
}

function decimalBaseUnits(amount: string, decimals?: number): string | undefined {
  if (!Number.isInteger(decimals) || decimals! < 0 || decimals! > 36 || !/^\d+(?:\.\d+)?$/.test(amount)) return undefined
  const [whole, fraction = ''] = amount.split('.')
  if (fraction.length > decimals! && /[1-9]/.test(fraction.slice(decimals))) return undefined
  return BigInt(whole + fraction.slice(0, decimals).padEnd(decimals!, '0')).toString()
}

/** Exact wire payload used for new registrations and retries after restart. */
export function buildPioneerSwapRegistration(swap: PendingSwap): Record<string, any> {
  // CAIP comes straight from the swap record — no asset-string round-trip
  // needed. PendingSwap.fromCaip is populated by trackSwap() from the picker's
  // selection and is the canonical identifier Pioneer's tracker keys on.
  const sellCaip = swap.fromCaip
  const buyCaip = swap.toCaip
  if (!sellCaip || !buyCaip) {
    throw new Error(`registerWithPioneer: missing CAIP (from=${sellCaip}, to=${buyCaip}) for ${swap.txid}`)
  }

  const integration = PIONEER_INTEGRATION_ALIAS[swap.integration] || swap.integration

  // CAIP-2 is the first segment of the CAIP-19 ("eip155:8453" from "eip155:8453/erc20:0x...").
  // Using it directly avoids the legacy chain-id string bug (networkId: "base" → monitor falls
  // back to Ethereum mainnet RPC and never finds the Base tx).
  const sellNetworkId = sellCaip.split('/')[0]
  const buyNetworkId  = buyCaip.split('/')[0]

  // For NEAR Intents ERC-20, the address that actually receives the funds is the 1Click
  // depositAddress — NOT the token contract stored in inboundAddress.
  const near = swap.trackingContext?.nearIntents
  const isNear = swap.swapper === 'NEAR Intents' || swap.integration === 'nearIntents'
  const sellAddress = near?.depositAddress || swap.nearIntentsDepositAddress || swap.inboundAddress || ''
  const sender = swap.trackingContext?.fromAddress || ''
  const minimumAmountOut = swap.minimumOutput || near?.minimumAmountOut

  const body: Record<string, any> = {
    txHash: swap.txid,
    addresses: [],
    sellAsset: {
      caip: sellCaip,
      symbol: swap.fromSymbol,
      amount: swap.fromAmount,
      amountBaseUnits: swap.trackingContext?.fromAmountBaseUnits || swap.fromAmountBaseUnits
        || (isNear ? decimalBaseUnits(swap.fromAmount, near?.sourceDecimals) : swap.fromAmount),
      address: integration === 'uniswap' || isNear ? sender : sellAddress,
      networkId: sellNetworkId,
    },
    buyAsset: {
      caip: buyCaip,
      symbol: swap.toSymbol,
      amount: swap.expectedOutput,
      amountBaseUnits: isNear ? decimalBaseUnits(swap.expectedOutput, near?.destinationDecimals) : swap.expectedOutput,
      address: swap.trackingContext?.toAddress || (buyCaip.startsWith('eip155:') && swap.walletId?.includes(':')
        ? swap.walletId.slice(swap.walletId.indexOf(':') + 1)
        : ''),
      networkId: buyNetworkId,
    },
    quote: {
      id: swap.txid,
      ...(swap.providerQuoteId ? {
        quoteId: swap.providerQuoteId,
        raw: { source: 'shapeshift', quoteId: swap.providerQuoteId },
      } : {}),
      integration,
      expectedAmountOut: swap.expectedOutput,
      minimumAmountOut: minimumAmountOut || swap.expectedOutput,
      slippage: (swap.slippageBps ?? 100) / 100,
      fees: { affiliate: '0', protocol: '0', network: '0' },
      memo: swap.memo,
    },
    integration,
    swapper: swap.swapper,
  }
  // Forward the Relay request id when we have one. Pioneer's swap-monitor
  // (checkRelaySwap) keys on relayData.requestId; without it Pioneer falls
  // back to a confirmation-only watcher that never reaches a terminal status
  // for Relay's off-chain settlement model.
  if (swap.relayRequestId) {
    body.relayData = { requestId: swap.relayRequestId,
      ...(swap.trackingContext?.relaySolverDeposit ? { executionMode: 'solver-deposit' } : {}) }
  }
  if (isNear && sellAddress) {
    // Source wallet and deposit channel are distinct addresses. Never infer a
    // refund wallet from the channel on legacy records without sender context.
    body.nearIntentsData = {
      ...near, depositAddress: sellAddress, refundTo: sender || undefined,
      recipient: swap.trackingContext?.toAddress || near?.recipient,
      minimumAmountOut,
    }
  }
  return body
}
