import { utils as ethersUtils } from 'ethers'
import type { SigningRequestInfo } from '../shared/types'

// ERC-165: https://eips.ethereum.org/EIPS/eip-165; ERC-721 0x80ac58cd, ERC-1155 0xd9b67a26.
const ERC165 = new ethersUtils.Interface(['function supportsInterface(bytes4 interfaceId) view returns (bool)'])
const ERC20 = new ethersUtils.Interface(['function decimals() view returns (uint8)'])
export const ERC721_INTERFACE = '0x80ac58cd'
export const ERC1155_INTERFACE = '0xd9b67a26'
/** Contracts asked per order; the rest are marked unchecked. */
const MAX_CONTRACTS = 8

async function ethCall(chainId: number, to: string, data: string): Promise<string> {
  const [{ getEvmSimulationEndpoint }, { evmRpc }] = await Promise.all([import('./evm-simulation-config'), import('./evm-effects')])
  return evmRpc(getEvmSimulationEndpoint(chainId), 'eth_call', [{ to, data }, 'latest'])
}

type Call = (chainId: number, to: string, data: string) => Promise<string>
type Answer = { result: string } | { reverted: true } | { failed: true }
/** A token's ERC-20 decimals(); null when the contract has no decimals()
 *  answer (an NFT collection, or no contract). Throws when it could not be
 *  asked. */
export type Decimals = (chainId: number, token: string) => Promise<number | null>

function timed<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))])
}

/** Pioneer's GetTokenDecimals, which api.keepkey.info serves (it has no
 *  EvmReadRpc, so supportsInterface cannot be asked there). It answers
 *  {decimals: N} for a token, and 404 CONTRACT_NOT_FOUND when the contract
 *  has no decimals() (BAYC, ENS) or there is no contract. */
export function pioneerDecimals(pioneer: any): Decimals {
  return async (chainId, token) => {
    let response: any
    try {
      response = await pioneer.GetTokenDecimals({ networkId: `eip155:${chainId}`, contractAddress: token.toLowerCase() })
    } catch (e: any) {
      if (e?.status === 404 && e?.response?.body?.code === 'CONTRACT_NOT_FOUND') return null
      throw e
    }
    const decimals = response?.data?.decimals
    if (response?.data?.success === false || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error('Pioneer GetTokenDecimals: no decimals in the answer')
    }
    return decimals
  }
}

/** Pioneer's decimals, only where Pioneer is this chain's read path (never in
 *  place of the user's own RPC). */
async function defaultDecimals(chainId: number, token: string): Promise<number | null> {
  const [{ getEvmSimulationEndpoint }, { getPioneer }] = await Promise.all([import('./evm-simulation-config'), import('./pioneer')])
  if (!getEvmSimulationEndpoint(chainId).startsWith('eip155:')) throw new Error('the user RPC answered no contract read')
  return pioneerDecimals(await getPioneer())(chainId, token)
}

async function ask(call: Call, chainId: number, to: string, data: string): Promise<Answer> {
  try {
    return { result: await timed(call(chainId, to, data), 1500) }
  } catch (e: any) {
    // A revert is an answer: the contract has no such function.
    return /revert/i.test(String(e?.message ?? e)) ? { reverted: true } : { failed: true }
  }
}

/** Whether `token` says it supports `interfaceId`; undefined when it could not
 *  be asked. A revert, or no answer at all ("0x": no code there), is no. */
async function supports(call: Call, chainId: number, token: string, interfaceId: string): Promise<boolean | undefined> {
  const answer = await ask(call, chainId, token, ERC165.encodeFunctionData('supportsInterface', [interfaceId]))
  if ('failed' in answer) return undefined
  if ('reverted' in answer) return false
  try { return ERC165.decodeFunctionResult('supportsInterface', answer.result)[0] === true } catch { return false }
}

/** Ask every Seaport item's token contract what it is, before approval: ERC-165
 *  supportsInterface for ERC-721 and ERC-1155, and ERC-20 decimals(), read
 *  through the same path as the rest of the card (Pioneer's EvmReadRpc, or
 *  the user's own RPC). Without a contract read (production Pioneer has no
 *  EvmReadRpc) only decimals() is asked, through Pioneer's GetTokenDecimals:
 *  that is enough to see an NFT item naming a token. Seaport moves an item by
 *  its type whatever the contract is, so clearsign-risk.ts turns the card red
 *  when they disagree. Nothing is guessed: a contract that could not be asked
 *  is marked unchecked. Card only; never throws. */
export async function addSeaportItemContracts(info: SigningRequestInfo, call: Call = ethCall, decimalsOf: Decimals = defaultDecimals): Promise<void> {
  const decoded = info.typedDataDecoded
  const items = decoded?.isKnownType ? decoded.seaportItems : undefined
  const chainId = Number(info.chainId)
  if (!items?.length || !Number.isSafeInteger(chainId)) return
  const tokens = [...new Set(items
    .filter((i) => i.itemType >= 1 && i.itemType <= 5 && /^0x[0-9a-fA-F]{40}$/.test(i.token))
    .map((i) => i.token.toLowerCase()))]
  const facts = new Map<string, { erc721?: boolean; erc1155?: boolean; decimals?: number; decimalsOnly?: boolean; unchecked?: boolean }>()
  await Promise.all(tokens.map(async (token, n) => {
    if (n >= MAX_CONTRACTS) { facts.set(token, { unchecked: true }); return }
    const [erc721, erc1155, decimalsAnswer] = await Promise.all([
      supports(call, chainId, token, ERC721_INTERFACE),
      supports(call, chainId, token, ERC1155_INTERFACE),
      ask(call, chainId, token, ERC20.encodeFunctionData('decimals')),
    ])
    if (erc721 === undefined || erc1155 === undefined) {
      try {
        const decimals = await timed(decimalsOf(chainId, token), 3000)
        facts.set(token, { decimalsOnly: true, ...(decimals !== null ? { decimals } : {}) })
      } catch {
        facts.set(token, { unchecked: true })
      }
      return
    }
    let decimals: number | undefined
    if ('result' in decimalsAnswer) {
      try {
        const value = Number(ERC20.decodeFunctionResult('decimals', decimalsAnswer.result)[0])
        if (Number.isInteger(value) && value >= 0 && value <= 255) decimals = value
      } catch { /* no decimals() answer */ }
    }
    facts.set(token, { erc721, erc1155, ...(decimals !== undefined ? { decimals } : {}) })
  }))
  for (const item of items) {
    const fact = facts.get(item.token.toLowerCase())
    if (fact) Object.assign(item, fact)
  }
}
