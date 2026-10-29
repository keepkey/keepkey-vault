/**
 * Where a THORChain/Maya router deposit pays is the `vault` word, chosen by
 * whoever built the transaction. Firmware cannot check it and labels it
 * "UNVERIFIED vault" (thortx.c). This computer checks it, as advice for the
 * approval card only: the vault must be one of the network's active Asgard
 * vaults, using this router on this chain, in every source asked. Not just the
 * inbound address: that rotates between the active vaults every few minutes,
 * and a quote's vault stays valid while it is active. A source that does not
 * answer leaves the vault unchecked: agreement between sources, not failover.
 */
import type { SigningRequestInfo, ThorVaultCheck } from '../shared/types'
import { cosmosDepositPreview } from '../shared/cosmosDepositPreview'
import { CHAINS } from '../shared/chains'
import { isOwnAddress } from './db'

type Protocol = ThorVaultCheck['protocol']
export interface AsgardVault {
  status: string
  addresses?: Array<{ chain: string; address: string }>
  routers?: Array<{ chain: string; router: string }>
}

// GET /thorchain/vaults/asgard (https://gitlab.com/thorchain/thornode/-/raw/develop/openapi/openapi.yaml)
// and /mayachain/vaults/asgard (https://gitlab.com/mayachain/mayanode/-/raw/develop/openapi/openapi.yaml),
// from two operators each.
export const VAULT_SOURCES: Record<Protocol, string[]> = {
  THORChain: [
    'https://gateway.liquify.com/chain/thorchain_api/thorchain/vaults/asgard',
    'https://rest.cosmos.directory/thorchain/thorchain/vaults/asgard',
  ],
  Mayachain: [
    'https://mayanode.mayachain.info/mayachain/vaults/asgard',
    'https://rest.cosmos.directory/mayachain/mayachain/vaults/asgard',
  ],
}

/** The network's chain name for each EVM chain whose router calldata-decoder names. */
const VAULT_CHAIN: Record<Protocol, Record<number, string>> = {
  THORChain: { 1: 'ETH', 56: 'BSC', 8453: 'BASE', 43114: 'AVAX' },
  Mayachain: { 1: 'ETH', 42161: 'ARB' },
}

/** A memo's chain prefix → Desktop chain id (shared/chains.ts). */
const MEMO_CHAIN: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', BSC: 'bsc', AVAX: 'avalanche', BASE: 'base', ARB: 'arbitrum',
  GAIA: 'cosmos', THOR: 'thorchain', MAYA: 'mayachain', LTC: 'litecoin', DOGE: 'dogecoin',
  BCH: 'bitcoincash', DASH: 'dash', ZEC: 'zcash', XRP: 'ripple', SOL: 'solana', TRON: 'tron',
}

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase()

/** One source's answer: the router of the active vault paid, or null when no active vault is it. */
function activeRouter(vaults: AsgardVault[], chain: string, vault: string): string | null {
  const v = vaults.find((x) => x.status === 'ActiveVault'
    && x.addresses?.some((a) => a.chain === chain && lower(a.address) === lower(vault)))
  return v ? lower(v.routers?.find((r) => r.chain === chain)?.router) : null
}

export function checkThorVault(protocol: Protocol, chainId: number | undefined, router: string, vault: string,
  lists: Array<AsgardVault[] | null>): ThorVaultCheck {
  const chain = chainId != null ? VAULT_CHAIN[protocol][chainId] : undefined
  const base = { protocol, chain, sources: lists.length }
  if (!chain) return { ...base, status: 'unchecked', reason: 'no vault list covers this chain' }
  const missing = lists.filter((l) => !l).length
  if (missing) return { ...base, status: 'unchecked', reason: `${missing} of ${lists.length} sources did not answer` }
  const answers = new Set(lists.map((l) => activeRouter(l!, chain, vault)))
  if (answers.size !== 1) return { ...base, status: 'unchecked', reason: 'the sources disagree' }
  const used = [...answers][0]
  if (used === null) return { ...base, status: 'not-current' }
  return used === lower(router) ? { ...base, status: 'current' } : { ...base, status: 'not-current', currentRouter: used }
}

type FetchJson = (url: string) => Promise<unknown>
const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function vaultList(url: string, get: FetchJson): Promise<AsgardVault[] | null> {
  try {
    const body = await get(url)
    return Array.isArray(body) && body.length > 0 && body.every((v) => typeof v?.status === 'string') ? body : null
  } catch { return null }
}

/** One of this device's addresses on the memo's output chain? Undefined when it cannot tell. */
export function memoDestinationOwn(deviceId: string, outputAsset: string, destination: string,
  isOwn: typeof isOwnAddress = isOwnAddress): boolean | undefined {
  const chain = CHAINS.find((c) => c.id === MEMO_CHAIN[outputAsset.split('.')[0].toUpperCase()])
  return chain?.networkId ? isOwn(deviceId, chain.networkId, destination, chain.chainFamily) : undefined
}

/** Sets thorVault (router deposits) and memoDestinationOwn (router and native
 *  MsgDeposit swaps) for the approval card. Never throws. */
export async function addThorDepositFacts(info: SigningRequestInfo, deviceId: string | undefined,
  deps: { fetchJson?: FetchJson; isOwn?: typeof isOwnAddress } = {}): Promise<void> {
  let outputAsset: string | undefined
  let destination: string | undefined
  const d = info.calldataDecoded
  if (info.method === '/eth/sign-transaction' && d?.source === 'local' && (d.dappName === 'THORChain' || d.dappName === 'Mayachain')) {
    const protocol = d.dappName
    const field = (n: string) => d.fields.find((f) => f.name === n)?.value
    const chainId = Number(info.chainId)
    const lists = VAULT_CHAIN[protocol][chainId]
      ? await Promise.all(VAULT_SOURCES[protocol].map((u) => vaultList(u, deps.fetchJson ?? fetchJson)))
      : []
    info.thorVault = checkThorVault(protocol, chainId, String(info.to ?? ''), field('Vault') ?? '', lists)
    outputAsset = field('Output asset')
    destination = field('Output destination')?.split('/')[0]
  } else if (info.method === '/thorchain/sign-amino-deposit' || info.method === '/mayachain/sign-amino-deposit') {
    const p = cosmosDepositPreview(info.rawRequestBody, info.method === '/thorchain/sign-amino-deposit' ? 'THORChain' : 'Maya')
    outputAsset = p?.outputAsset
    destination = p?.destination?.split('/')[0]
  } else return
  if (deviceId && outputAsset && destination && destination !== 'self') {
    info.memoDestinationOwn = memoDestinationOwn(deviceId, outputAsset, destination, deps.isOwn)
  }
}
