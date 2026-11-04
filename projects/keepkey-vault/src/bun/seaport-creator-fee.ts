import { utils as ethersUtils } from 'ethers'
import type { SigningRequestInfo } from '../shared/types'

// ERC-2981: https://eips.ethereum.org/EIPS/eip-2981
const ERC2981 = new ethersUtils.Interface([
  'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)',
])

async function ethCall(chainId: number, to: string, data: string): Promise<string> {
  const [{ getEvmSimulationEndpoint }, { evmRpc }] = await Promise.all([import('./evm-simulation-config'), import('./evm-effects')])
  return evmRpc(getEvmSimulationEndpoint(chainId), 'eth_call', [{ to, data }, 'latest'])
}

/** A Seaport listing's creator fee, named by the collection itself: a read-only
 *  ERC-2981 royaltyInfo(tokenId, price) on the NFT being sold. Payments to the
 *  receiver it returns, no more in total than the amount it returns, become
 *  'creator-fee'. Every other payee stays unknown. When the call could not be
 *  made at all (no RPC here serves eth_call, no answer in time), the listing
 *  is marked creatorFeeUnchecked; a revert is an answer. Card only; never throws. */
export async function addSeaportCreatorFee(info: SigningRequestInfo, call = ethCall): Promise<void> {
  const listing = info.typedDataDecoded?.isKnownType ? info.typedDataDecoded.seaportListing : undefined
  const chainId = Number(info.chainId)
  if (!listing?.nft || !listing.payments.some((p) => p.role === 'other') || !Number.isSafeInteger(chainId)) return
  let result: string
  try {
    const data = ERC2981.encodeFunctionData('royaltyInfo', [listing.nft.id, listing.totalRaw])
    result = await Promise.race([
      call(chainId, listing.nft.token, data),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ])
  } catch (e: any) {
    if (!/revert/i.test(String(e?.message ?? e))) listing.creatorFeeUnchecked = true
    return
  }
  try {
    const [receiver, amount] = ERC2981.decodeFunctionResult('royaltyInfo', result)
    const to = String(receiver).toLowerCase()
    if (/^0x0{40}$/.test(to) || BigInt(amount.toString()) === 0n) return
    const paid = listing.payments.filter((p) => p.role === 'other' && p.recipient.toLowerCase() === to)
    if (paid.length && paid.reduce((sum, p) => sum + BigInt(p.raw), 0n) <= BigInt(amount.toString())) {
      for (const p of paid) p.role = 'creator-fee'
    }
  } catch { /* not an ERC-2981 answer: the payee stays unknown */ }
}
