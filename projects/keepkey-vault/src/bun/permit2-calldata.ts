import { utils as ethersUtils } from 'ethers'

import type { EffectFinding } from '../shared/transaction-effects'

const DETAIL = 'tuple(address token,uint160 amount,uint48 expiration,uint48 nonce)'
const PERMISSION = 'tuple(address token,uint256 amount)'
const TRANSFER = 'tuple(address to,uint256 requestedAmount)'
const PERMIT2 = new ethersUtils.Interface([
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
  `function permit(address owner,tuple(${DETAIL} details,address spender,uint256 sigDeadline) permitSingle,bytes signature)`,
  `function permit(address owner,tuple(${DETAIL}[] details,address spender,uint256 sigDeadline) permitBatch,bytes signature)`,
  'function transferFrom(address from,address to,uint160 amount,address token)',
  'function transferFrom(tuple(address from,address to,uint160 amount,address token)[] transferDetails)',
  'function lockdown(tuple(address token,address spender)[] approvals)',
  'function invalidateNonces(address token,address spender,uint48 newNonce)',
  `function permitTransferFrom(tuple(${PERMISSION} permitted,uint256 nonce,uint256 deadline) permit,${TRANSFER} transferDetails,address owner,bytes signature)`,
  `function permitTransferFrom(tuple(${PERMISSION}[] permitted,uint256 nonce,uint256 deadline) permit,${TRANSFER}[] transferDetails,address owner,bytes signature)`,
  `function permitWitnessTransferFrom(tuple(${PERMISSION} permitted,uint256 nonce,uint256 deadline) permit,${TRANSFER} transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)`,
  `function permitWitnessTransferFrom(tuple(${PERMISSION}[] permitted,uint256 nonce,uint256 deadline) permit,${TRANSFER}[] transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)`,
  'function invalidateUnorderedNonces(uint256 wordPos,uint256 mask)',
])

const ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3'
// Only chains whose current canonical Uniswap manifest explicitly records
// Permit2. Same-address deployments elsewhere still require runtime identity.
const MANIFEST_CHAINS = new Set([1, 10, 30, 56, 137, 10143, 42161, 42220, 43114, 4663, 5042, 8453, 57073, 59144, 81457, 11155111])
const UINT160_MAX = (1n << 160n) - 1n
const text = (value: any) => value?.toString?.() ?? String(value)
const address = (value: any) => String(value).toLowerCase()
const signatureBytes = (value: any) => (String(value).length - 2) / 2

export interface Permit2Call { method: string; signature: string; decoded: Record<string, any> }

export function isOfficialPermit2(chainId?: number, to?: string): boolean {
  return Boolean(chainId && MANIFEST_CHAINS.has(chainId) && to?.toLowerCase() === ADDRESS)
}

function detail(value: any) { return { token: address(value.token), amount: text(value.amount), expiration: text(value.expiration), nonce: text(value.nonce) } }
function permission(value: any) { return { token: address(value.token), amount: text(value.amount) } }
function transfer(value: any) { return { to: address(value.to), requestedAmount: text(value.requestedAmount) } }

export function decodePermit2Call(data: string): Permit2Call | undefined {
  if (!/^0x[0-9a-f]+$/i.test(data)) return undefined
  try {
    const parsed = PERMIT2.parseTransaction({ data })
    if (PERMIT2.encodeFunctionData(parsed.sighash, Array.from(parsed.args)).toLowerCase() !== data.toLowerCase()) return undefined
    const a: any = parsed.args
    if (parsed.name === 'approve') return { method: parsed.name, signature: parsed.signature, decoded: { token: address(a.token), spender: address(a.spender), amount: text(a.amount), expiration: text(a.expiration) } }
    if (parsed.name === 'permit') {
      const permit = a.permitSingle || a.permitBatch
      return { method: parsed.name, signature: parsed.signature, decoded: { owner: address(a.owner), spender: address(permit.spender), details: a.permitBatch ? Array.from(permit.details).map(detail) : [detail(permit.details)], sigDeadline: text(permit.sigDeadline), signatureBytes: signatureBytes(a.signature) } }
    }
    if (parsed.name === 'transferFrom') {
      const transfers = a.transferDetails
        ? Array.from(a.transferDetails).map((v: any) => ({ from: address(v.from), to: address(v.to), amount: text(v.amount), token: address(v.token) }))
        : [{ from: address(a.from), to: address(a.to), amount: text(a.amount), token: address(a.token) }]
      return { method: parsed.name, signature: parsed.signature, decoded: { transfers } }
    }
    if (parsed.name === 'lockdown') return { method: parsed.name, signature: parsed.signature, decoded: { approvals: Array.from(a.approvals).map((v: any) => ({ token: address(v.token), spender: address(v.spender) })) } }
    if (parsed.name === 'invalidateNonces') return { method: parsed.name, signature: parsed.signature, decoded: { token: address(a.token), spender: address(a.spender), newNonce: text(a.newNonce) } }
    if (parsed.name === 'invalidateUnorderedNonces') return { method: parsed.name, signature: parsed.signature, decoded: { wordPos: text(a.wordPos), mask: text(a.mask) } }
    if (parsed.name === 'permitTransferFrom' || parsed.name === 'permitWitnessTransferFrom') {
      const batch = typeof a.permit.permitted?.[0] !== 'string'
      const permissions = batch ? Array.from(a.permit.permitted).map(permission) : [permission(a.permit.permitted)]
      const transfers = batch ? Array.from(a.transferDetails).map(transfer) : [transfer(a.transferDetails)]
      return { method: parsed.name, signature: parsed.signature, decoded: {
        owner: address(a.owner), permissions, transfers, nonce: text(a.permit.nonce), deadline: text(a.permit.deadline),
        ...(a.witness !== undefined ? { witness: String(a.witness).toLowerCase(), witnessTypeString: String(a.witnessTypeString) } : {}),
        signatureBytes: signatureBytes(a.signature),
      } }
    }
    return undefined
  } catch { return undefined }
}

export function permit2ReportFindings(data: string, chainId?: number, to?: string): { findings: EffectFinding[]; limitations: EffectFinding[]; complete: boolean } {
  const call = decodePermit2Call(data)
  if (!call) return { findings: [], limitations: [], complete: false }
  const official = isOfficialPermit2(chainId, to)
  const v = call.decoded
  const findings: EffectFinding[] = [{ code: 'PERMIT2_CALL', message: `${official ? 'Canonical Uniswap Permit2' : 'Permit2-format'} call: ${call.method}.`, severity: 'info' }]
  if (call.method === 'approve') findings.push({ code: 'PERMIT2_ALLOWANCE', message: `Authorize ${v.spender} to spend ${BigInt(v.amount) === UINT160_MAX ? 'an unlimited amount' : `${v.amount} base units`} of ${v.token} until ${v.expiration}.`, severity: 'warning' })
  if (call.method === 'permit') for (const d of v.details) findings.push({ code: 'PERMIT2_SIGNED_ALLOWANCE', message: `Submit signed allowance from ${v.owner}: ${d.amount} base units of ${d.token} to ${v.spender} until ${d.expiration}; allowance nonce ${d.nonce}, signature deadline ${v.sigDeadline}.`, severity: 'warning' })
  if (call.method === 'transferFrom') for (const t of v.transfers) findings.push({ code: 'PERMIT2_ALLOWANCE_TRANSFER', message: `Move ${t.amount} base units of ${t.token} from ${t.from} to ${t.to} using an existing Permit2 allowance.`, severity: 'warning' })
  if (call.method === 'permitTransferFrom' || call.method === 'permitWitnessTransferFrom') v.permissions.forEach((p: any, index: number) => findings.push({ code: 'PERMIT2_SIGNATURE_TRANSFER', message: `Consume nonce ${v.nonce} to move up to ${p.amount} base units of ${p.token} from ${v.owner}; requested transfer ${v.transfers[index]?.requestedAmount ?? 'missing'} to ${v.transfers[index]?.to ?? 'missing'}; deadline ${v.deadline}${v.witness ? `; witness ${v.witness} (${v.witnessTypeString})` : ''}.`, severity: 'warning' }))
  if (call.method === 'lockdown') findings.push({ code: 'PERMIT2_LOCKDOWN', message: `Revoke ${v.approvals.length} token/spender allowance pair${v.approvals.length === 1 ? '' : 's'}.`, severity: 'info' })
  if (call.method === 'invalidateNonces' || call.method === 'invalidateUnorderedNonces') findings.push({ code: 'PERMIT2_NONCE_INVALIDATION', message: call.method === 'invalidateNonces' ? `Advance ${v.token} allowance nonce for ${v.spender} to ${v.newNonce}.` : `Invalidate unordered nonce bitmap word ${v.wordPos} with mask ${v.mask}.`, severity: 'warning' })
  const limitations: EffectFinding[] = []
  if (!official) limitations.push({ code: 'PERMIT2_IDENTITY_UNVERIFIED', message: 'The target is not Permit2 in the bundled canonical Uniswap deployment manifest for this chain.', severity: 'danger' })
  if ((v.deadline && BigInt(v.deadline) < BigInt(Math.floor(Date.now() / 1000))) || (v.sigDeadline && BigInt(v.sigDeadline) < BigInt(Math.floor(Date.now() / 1000)))) limitations.push({ code: 'PERMIT2_DEADLINE_EXPIRED', message: `The Permit2 ${v.deadline ? 'transfer' : 'signature'} deadline has expired; execution should revert.`, severity: 'danger' })
  if (v.permissions && v.permissions.length !== v.transfers.length) limitations.push({ code: 'PERMIT2_BATCH_LENGTH_MISMATCH', message: 'Permit2 batch permission and transfer-detail lengths differ; execution should revert.', severity: 'danger' })
  return { findings, limitations, complete: official && limitations.length === 0 }
}
