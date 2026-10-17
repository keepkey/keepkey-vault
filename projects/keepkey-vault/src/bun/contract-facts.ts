import type { SigningRequestInfo } from '../shared/types'
import { getCachedBalances, getPriorEvmCalls } from './db'
import { getTokenMetadata } from './evm-rpc'
import { getEvmSimulationEndpoint } from './evm-simulation-config'

/** What this computer knows about the contract a blind EVM call goes to, for
 *  the approval card only (never for the caller): this account's earlier
 *  transactions to it, and the name the contract gives itself. Never throws.
 *  `deviceId` is left out for a passphrase wallet, like the balance cache. */
export async function addContractFacts(info: SigningRequestInfo, deviceId?: string): Promise<void> {
  const chainId = Number(info.chainId)
  const to = String(info.to || '').toLowerCase()
  if (info.method !== '/eth/sign-transaction' || !info.needsBlindSigning || !Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-f]{40}$/.test(to)) return
  if (info.from) info.priorUse = getPriorEvmCalls(String(info.from), to, chainId) ?? undefined
  try {
    // The portfolio already holds the name of a token this wallet owns.
    const caip = `eip155:${chainId}/erc20:${to}`
    const cached = deviceId ? getCachedBalances(deviceId)?.balances.flatMap((b) => b.tokens ?? []).find((t) => t.caip?.toLowerCase() === caip) : undefined
    const meta = cached ?? await Promise.race([
      getTokenMetadata(getEvmSimulationEndpoint(chainId), to),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ])
    if (meta.symbol) info.contractName = { name: meta.name || meta.symbol, symbol: meta.symbol }
  } catch { /* not a token, or no answer in time: say nothing */ }
}
