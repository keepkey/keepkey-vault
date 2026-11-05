/** Public Safe account data. No private keys or issuer material belong here. */
export const SAFE_CHAIN_ID = 8453
export const SAFE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export interface SafeAccount {
  safeVersion?: '1.4.1' | '1.5.0'
  address: string
  name: string
  owners: string[]
  threshold: number
  nonce: string
  deployed: boolean
  deploymentTx?: string
  saltNonce?: string
  configurationChanged?: boolean
  reviewedAt?: number
  balanceEth?: string
  balanceUsdc?: string
}
export interface SafeTransaction {
  to: string
  value: string
  data: string
  operation: number
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: string
  refundReceiver: string
  nonce: string
}
export interface SafeProposal {
  format: 'keepkey-safe-v1'
  chainId: 8453
  safe: string
  hash: string
  transaction: SafeTransaction
  signatures: Record<string, string>
  executionTx?: string
}
export interface SafeTransfer {
  asset: 'ETH' | 'USDC'
  recipient: string
  amount: string
}
export interface SafeContext {
  owner: string
  session: string
  sessionOnly: boolean
  nestedClearSign: boolean
  rpcReady?: boolean
  rpcSource?: string
  accounts: SafeAccount[]
  proposals: SafeProposal[]
}
export interface SafeCreateParams {
  name: string
  otherOwners: string[]
  threshold: number
  saltNonce?: string
}
export interface VaultAddParams {
  chainId: 8453
  address: string
  name: string
  rpcUrl: string
}
export interface VaultAddReview {
  id: string
  account: SafeAccount
  chainId: 8453
  rpcHost: string
  expiresAt: number
  sessionOnly: boolean
}
export interface SafeTxReview {
  id: string
  kind: 'create' | 'execute'
  safe: SafeAccount
  proposal?: SafeProposal
  transfer?: SafeTransfer
  saltNonce?: string
  expiresAt: number
  maximumExecutionFeeEth: string
  ownerBalanceEth: string
  transaction: {
    chainId: number
    to: string
    value: string
    data: string
    nonce: string
    gasLimit: string
    gasPrice: string
    addressNList: number[]
  }
}
