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

/** Unknown code for a transfer with no call data: there is no call to simulate. */
export const PLAIN_TRANSFER_NOT_SIMULATED = 'PLAIN_TRANSFER_NOT_SIMULATED'

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

/** Shown on the approval card when no simulation ran. Provider and RPC error text stays in the log. */
export const SIMULATION_UNAVAILABLE_MESSAGE = 'This computer could not simulate this transaction, so it cannot predict what it will move.'
