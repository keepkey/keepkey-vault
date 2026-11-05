import { nearIntentsDepositFindings } from './swap-parsing'

/** A plain deposit has no on-chain swap instruction. Check its independently
 * registered refund and payout before returning a quote AND before building
 * an execution submitted over RPC/REST. A prior quote check is not a lease. */
export async function assertNearIntentsPlainDeposit(expected: {
  depositAddress: string; from: string; recipient: string
}): Promise<void> {
  const bare = (address: string) => address.startsWith('bitcoincash:')
    ? address.slice('bitcoincash:'.length) : address
  const from = bare(expected.from.trim())
  if (!from || !expected.depositAddress || !expected.recipient.trim()) {
    throw new Error('NEAR Intents: missing deposit, sender or recipient — cannot verify refund and payout safety.')
  }
  try {
    const response = await fetch(
      `https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(expected.depositAddress)}`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (!response.ok) {
      throw new Error(`NEAR Intents: 1Click returned ${response.status} for deposit address — cannot verify refund address. Do not proceed.`)
    }
    const status = await response.json() as any
    const rawRefund = status?.quoteResponse?.quoteRequest?.refundTo
    const refund = typeof rawRefund === 'string' ? rawRefund.trim() : ''
    if (!refund) {
      throw new Error('NEAR Intents: 1Click response missing quoteRequest.refundTo — cannot verify refund safety.')
    }
    if (bare(refund) !== from) {
      throw new Error(`NEAR Intents 1Click refundTo mismatch — 1Click has "${rawRefund}" but your wallet address is "${expected.from}". Do not proceed: a refund would not return to your wallet.`)
    }
    const memo = status?.quoteResponse?.quote?.depositMemo
    if (memo != null && String(memo).trim() !== '') {
      throw new Error('NEAR Intents: this deposit requires a memo/destination tag, which KeepKey Desktop does not send with a plain deposit. Do not proceed: the deposit would not be credited.')
    }
    if (status?.quoteResponse?.quoteRequest?.depositType !== 'ORIGIN_CHAIN') {
      throw new Error('NEAR Intents: 1Click deposit is not on the source chain. Get a new quote.')
    }
    const verification = nearIntentsDepositFindings(status, {
      ...expected, from, recipient: expected.recipient.trim(),
    })
    const unsafe = verification.findings.find(finding => finding.severity === 'danger')
    if (unsafe) throw new Error(`NEAR Intents: ${unsafe.message}`)
    if (verification.limitations.length > 0) {
      throw new Error('NEAR Intents: cannot confirm deposit details with 1Click. Get a new quote.')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('NEAR Intents')) throw error
    throw new Error(`NEAR Intents: failed to verify refund address with 1Click API: ${message}`)
  }
}
