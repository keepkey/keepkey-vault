import { utils } from 'ethers'
import type { SafeAccount } from './safe-multisig'
import { SAFE_USDC } from './safe-multisig'
import type { MultisigPolicyPreview } from './multisig-policy'

export const BASE_NETWORK = 'eip155:8453'
export const BITCOIN_NETWORK = 'bip122:000000000019d6689c085ae165831e93'
export const BASE_ETH_CAIP = `${BASE_NETWORK}/slip44:60`
export const BASE_USDC_CAIP = `${BASE_NETWORK}/erc20:${SAFE_USDC}`
export const BITCOIN_CAIP = `${BITCOIN_NETWORK}/slip44:0`
export interface VaultIdentity {
  safeVersion?: '1.4.1' | '1.5.0'
  id: string
  type: 'safe' | 'bitcoin-multisig'
  name: string
  chainId: 'base' | 'bitcoin'
  networkId: string
  accountId: string // CAIP-10; includes the exact chain and receive address.
  address: string
  threshold: number
  cosigners: Array<{ address?: string; fingerprint?: string; path?: string; xpub?: string }>
  supportedAssets: Array<{ caip: string; symbol: string; decimals: number; contract?: string }>
  receiveEnabled: boolean
  fundingBlockedReason?: string
  reviewedAt?: number
  sessionOnly: boolean
  certificationLabel?: string
  descriptor?: string
  policyId?: string
  scriptType?: string
}
export function safeVaultIdentity(a: SafeAccount, sessionOnly: boolean): VaultIdentity {
  const address = utils.getAddress(a.address)
  return {
    id: `${BASE_NETWORK}:${address.toLowerCase()}`,
    type: 'safe',
    safeVersion: a.safeVersion || '1.4.1',
    name: a.name,
    chainId: 'base',
    networkId: BASE_NETWORK,
    accountId: `${BASE_NETWORK}:${address}`,
    address,
    threshold: a.threshold,
    cosigners: a.owners.map((owner) => ({ address: utils.getAddress(owner) })),
    supportedAssets: [
      { caip: BASE_ETH_CAIP, symbol: 'ETH', decimals: 18 },
      { caip: BASE_USDC_CAIP, symbol: 'USDC', decimals: 6, contract: SAFE_USDC },
    ],
    receiveEnabled: a.deployed && !a.configurationChanged,
    ...(a.reviewedAt ? { reviewedAt: a.reviewedAt } : {}),
    sessionOnly,
    ...(!a.deployed
      ? { fundingBlockedReason: 'Deployment is not confirmed' }
      : a.configurationChanged
      ? { fundingBlockedReason: 'Owner configuration needs review' }
      : {}),
    // Firmware v1 certificates attest a destination label + network, not owners.
    certificationLabel: ('Base Safe ' + a.name.replace(/[^\x20-\x7e]|%/g, '').trim()).slice(0, 24),
  }
}
export function bitcoinVaultIdentity(p: MultisigPolicyPreview): VaultIdentity {
  if (!p.saved) throw new Error('Verify the Bitcoin vault policy on KeepKey first')
  return {
    id: `${BITCOIN_NETWORK}:policy:${p.id}`,
    type: 'bitcoin-multisig',
    name: p.name,
    chainId: 'bitcoin',
    networkId: BITCOIN_NETWORK,
    accountId: `${BITCOIN_NETWORK}:${p.address}`,
    address: p.address,
    threshold: p.threshold,
    cosigners: p.cosigners.map((c) => ({ fingerprint: c.fingerprint, path: c.path, xpub: c.xpub })),
    supportedAssets: [{ caip: BITCOIN_CAIP, symbol: 'BTC', decimals: 8 }],
    receiveEnabled: true,
    sessionOnly: p.sessionOnly,
    descriptor: p.descriptor,
    policyId: p.id,
    scriptType: p.scriptType,
  }
}
function addressEqual(a: string, b: string) {
  return /^0x/i.test(a) && /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b
}
/** A known vault never acquires another chain or token merely because its address matches. */
export function assertVaultDestination(
  vaults: VaultIdentity[],
  networkId: string,
  address: string,
  assetCaip: string
) {
  const matches = vaults.filter((v) => addressEqual(v.address, address.trim()))
  if (!matches.length) return
  const exact = matches.filter((v) => v.networkId === networkId)
  if (!exact.length)
    throw new Error(
      `Wrong network for this vault. Its registered network is ${matches
        .map((v) => v.networkId)
        .join(', ')}, not ${networkId}.`
    )
  const available = exact.filter((v) => v.receiveEnabled)
  if (!available.length)
    throw new Error(
      exact.some((v) => v.fundingBlockedReason === 'Owner configuration needs review')
        ? 'Vault owner configuration changed. Review its owners and threshold before funding.'
        : 'This Safe is not confirmed deployed. Refresh and verify it before sending funds.'
    )
  if (
    !assetCaip.startsWith(networkId + '/') ||
    !available.some((v) => v.supportedAssets.some((a) => a.caip.toLowerCase() === assetCaip.toLowerCase()))
  ) {
    throw new Error(
      `This asset is not supported for this vault in Vault. Expected ${available
        .flatMap((v) => v.supportedAssets.map((a) => a.caip))
        .join(' or ')}.`
    )
  }
}
