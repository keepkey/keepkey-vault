/** Read-only mainnet preflight. Never requests a key, signs, proposes or broadcasts. */
import { inspectBaseSafe } from '../src/bun/safe-multisig'
import { safeTransactionService } from '../src/bun/safe-transaction-service'

const address = process.argv[2]
if (!address) throw new Error('Usage: bun scripts/check-base-safe.ts <Base Safe address>')
const rpcUrl = process.env.BASE_SAFE_RPC_URL || 'https://mainnet.base.org'
const allowed = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getBalance'])
const account = await inspectBaseSafe(async (method, params) => {
  if (!allowed.has(method)) throw new Error('Preflight only permits public contract reads')
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Base RPC HTTP ${response.status}`)
  const body = await response.json() as any
  if (body.error || !Object.hasOwn(body, 'result')) throw new Error(body.error?.message || 'Invalid RPC response')
  return body.result
}, address, 'Practice preflight')
const pending = await safeTransactionService.pending(8453, account.address, account.nonce)
console.log(JSON.stringify({ chainId: 8453, safe: account.address, version: account.safeVersion,
  owners: account.owners, threshold: account.threshold, nonce: account.nonce,
  pending: pending.length, readOnly: true }, null, 2))
