/** Chain-neutral, evidence-labelled output from an unsigned transaction simulation. */
export type EffectConfidence = 'observed' | 'inferred' | 'unknown'

export interface EffectAssetChange {
  asset: { kind: 'native' | 'token' | 'nft'; id: string; symbol?: string; decimals?: number }
  account: string
  /** Signed base-unit delta encoded as decimal text. */
  delta: string
  confidence: EffectConfidence
}

export interface EffectAuthorityChange {
  kind: 'allowance' | 'operator' | 'delegate' | 'owner' | 'upgrade-authority' | 'session-key'
  assetOrAccount: string
  authority: string
  value?: string
  unlimited?: boolean
  revoked?: boolean
  confidence: EffectConfidence
}

export interface EffectCodeIdentity {
  address: string
  codeHash?: string
  invocation: 'top-level' | 'call' | 'delegatecall' | 'create' | 'program' | 'cpi'
}

export interface EffectFinding {
  code: string
  message: string
  severity: 'info' | 'warning' | 'danger'
}

export interface EffectReport {
  version: 1
  chain: 'Ethereum' | 'Solana'
  transactionFingerprint: string
  stateReference: { blockOrSlot?: string; endpoint: string }
  status: 'success' | 'revert' | 'incomplete' | 'unavailable'
  assetChanges: EffectAssetChange[]
  authorityChanges: EffectAuthorityChange[]
  invokedCode: EffectCodeIdentity[]
  warnings: EffectFinding[]
  unknowns: EffectFinding[]
  fee?: { asset: string; amount: string }
  completeness: {
    accountCoverage: 'complete' | 'partial' | 'unknown'
    innerExecution: 'complete' | 'partial' | 'unknown'
    tokenCoverage: 'complete' | 'partial' | 'unknown'
    /** Whether authority/delegate state changes were semantically interpreted. */
    authorityCoverage?: 'complete' | 'partial' | 'unknown'
  }
}
