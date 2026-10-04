import type { EvmSchemaSpec } from './evm-certified-schema'
import { buildTokenSchema } from './evm-token-schema'
import type { ClearSignCentralAssetAudit, ClearSignCentralAssetAuditHistory, ClearSignCentralContractAudit } from '../shared/types'

type EvmTokenEvidence = {
  version: 1; kind: 'evm-token-metadata'; result: 'candidate'; auditedAt: number
  caip: string; chainId: number; contract: string; codeHash: string
  symbol: string; decimals: number; blockNumber: number; rpcHost: string
}

/**
 * Join two independently reviewed facts before compiling a named token schema:
 * the requested call's ABI/code identity and the token's current on-chain identity.
 * This function neither signs nor publishes anything.
 */
export function compileApprovedErc20TokenSchema(input: {
  contractAudit: ClearSignCentralContractAudit
  asset: ClearSignCentralAssetAudit
  assetAudit: ClearSignCentralAssetAuditHistory
  now?: number
}): EvmSchemaSpec {
  const { contractAudit, asset, assetAudit } = input
  const now = input.now ?? Date.now()
  const token = assetAudit.evidence as unknown as EvmTokenEvidence
  const shape = contractAudit.shape
  const chainMatch = /^eip155:(\d+)$/.exec(shape.network)
  if (!chainMatch) throw new Error('TOKEN_PROMOTION_NOT_EVM')
  const chainId = Number(chainMatch[1])
  const contract = shape.contract.toLowerCase()

  if (asset.approval_status !== 'approved' || asset.audit_status !== 'candidate') throw new Error('TOKEN_IDENTITY_NOT_APPROVED')
  if (asset.current_asset_audit_id !== assetAudit.auditId || asset.audit_evidence_hash !== assetAudit.evidenceHash) {
    throw new Error('TOKEN_EVIDENCE_NOT_CURRENT')
  }
  if (!asset.next_recheck_at || asset.next_recheck_at <= now) throw new Error('TOKEN_EVIDENCE_EXPIRED')
  if (!token || token.version !== 1 || token.kind !== 'evm-token-metadata' || token.result !== 'candidate') {
    throw new Error('TOKEN_EVIDENCE_INVALID')
  }
  if (token.caip !== asset.caip || assetAudit.caip !== asset.caip || token.chainId !== chainId
    || token.contract.toLowerCase() !== contract || asset.network !== shape.network) {
    throw new Error('TOKEN_IDENTITY_SHAPE_MISMATCH')
  }
  if (token.auditedAt > assetAudit.submittedAt || !Number.isSafeInteger(token.blockNumber) || token.blockNumber < 1
    || !/^0x[0-9a-f]{64}$/i.test(token.codeHash) || !token.rpcHost) {
    throw new Error('TOKEN_EVIDENCE_INVALID')
  }
  const contractIdentity = (contractAudit.evidence as any)?.identities?.find((identity: any) =>
    identity?.role === 'contract' && String(identity.address).toLowerCase() === contract)
  if (!contractIdentity || String(contractIdentity.codeHash).toLowerCase() !== token.codeHash.toLowerCase()) {
    throw new Error('TOKEN_CODE_IDENTITY_CHANGED')
  }
  // buildTokenSchema is the firmware-format gate: long/non-printable symbols,
  // invalid decimals, nonstandard selectors, and incomplete calldata fail here.
  return buildTokenSchema(chainId, contract, shape.selector, shape.calldataLength, {
    symbol: token.symbol, decimals: token.decimals,
  })
}
