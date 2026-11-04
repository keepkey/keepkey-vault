import type { SigningRequestInfo } from '../shared/types'
import { getCachedBalances, getPriorEvmCalls } from './db'
import { getTokenMetadata } from './evm-rpc'
import { getEvmSimulationEndpoint } from './evm-simulation-config'
import { addThorDepositFacts } from './thor-vaults'

/** A self-reported name as plain text: no quotes, control, bidi or zero-width
 *  characters, so it cannot pose as a Desktop sentence. */
export const plain = (s: unknown) => String(s ?? '').replace(/["'`\u2018\u2019\u201C\u201D\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 32)

/** What this computer knows about the contract a blind EVM call goes to, for
 *  the approval card only (never for the caller): `account`'s earlier on-chain
 *  transactions to it, and the token name it reports. `account` is the
 *  address known to be the signing key, or undefined when that is unchecked.
 *  Never throws. `deviceId` is left out for a passphrase wallet, like the
 *  balance cache. */
export async function addContractFacts(info: SigningRequestInfo, deviceId: string | undefined, account: string | undefined): Promise<void> {
  // A THORChain/Maya deposit the device shows still pays a vault it cannot check.
  await addThorDepositFacts(info, deviceId)
  const chainId = Number(info.chainId)
  const to = String(info.to || '').toLowerCase()
  if (info.method !== '/eth/sign-transaction' || !info.needsBlindSigning || !Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-f]{40}$/.test(to)) return
  if (account) info.priorUse = getPriorEvmCalls(account, to, chainId) ?? undefined
  try {
    // The portfolio already holds the name of a token this wallet owns.
    const caip = `eip155:${chainId}/erc20:${to}`
    const cached = deviceId ? getCachedBalances(deviceId)?.balances.flatMap((b) => b.tokens ?? []).find((t) => t.caip?.toLowerCase() === caip) : undefined
    const meta = cached ?? await Promise.race([
      getTokenMetadata(getEvmSimulationEndpoint(chainId), to),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ])
    const symbol = plain(meta.symbol)
    if (symbol) info.contractName = { name: plain(meta.name) || symbol, symbol }
  } catch { /* not a token, or no answer in time: say nothing */ }
}
