import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import bs58 from 'bs58'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const endpoint = process.env.CLEARSIGN_SOLANA_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
// CAIP-2 uses the 32-character Solana reference; RPC returns the full genesis hash.
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

let nextId = 1
async function rpc(method: string, params: unknown[] = []) {
  const id = nextId++
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const body: any = await response.json()
  if (body?.id !== id || body?.error || !Object.prototype.hasOwnProperty.call(body || {}, 'result')) {
    throw new Error('RPC_RESULT_INVALID')
  }
  return body.result
}

function authority(data: Buffer, offset: number): string | null {
  const tag = data.readUInt32LE(offset)
  if (tag === 0) return null
  if (tag !== 1) throw new Error('MINT_AUTHORITY_INVALID')
  return bs58.encode(data.subarray(offset + 4, offset + 36))
}

let cachedChainState: { expiresAt: number; genesis: string; slot: number } | undefined
async function chainState() {
  if (cachedChainState && cachedChainState.expiresAt > Date.now()) return cachedChainState
  const genesis = await rpc('getGenesisHash')
  if (genesis !== MAINNET_GENESIS_HASH) throw new Error('RPC_CHAIN_MISMATCH')
  const slot = await rpc('getSlot', [{ commitment: 'finalized' }])
  if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('RPC_SLOT_INVALID')
  cachedChainState = { expiresAt: Date.now() + 30_000, genesis, slot }
  return cachedChainState
}

async function evidenceFor(lease: any) {
  const nativeCaip = `${'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'}/slip44:501`
  const native = lease.caip === nativeCaip
  const match = String(lease.caip).match(/^solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp\/token:([1-9A-HJ-NP-Za-km-z]{32,44})$/)
  if (!native && !match) throw new Error('ASSET_CAIP_UNSUPPORTED')
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('RPC_ENDPOINT_UNSAFE')
  const { genesis, slot } = await chainState()
  if (native) return { version: 1, kind: 'solana-native-asset', caip: lease.caip,
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', genesisHash: genesis, symbol: 'SOL', decimals: 9,
    slip44: 501, slot, rpcHost: url.hostname, auditedAt: Date.now(), result: 'candidate' }
  const account = await rpc('getAccountInfo', [match![1], { encoding: 'base64', commitment: 'finalized', minContextSlot: slot }])
  const common = { version: 1, kind: 'solana-token-mint', caip: lease.caip, mint: match![1], slot,
    rpcHost: url.hostname, auditedAt: Date.now() }
  if (account?.context?.slot < slot) throw new Error('RPC_CONTEXT_REGRESSION')
  if (account?.value === null) return { ...common, result: 'no-account', ownerProgram: '', dataLength: 0,
    dataHash: `0x${'0'.repeat(64)}` }
  const value = account?.value
  if (!value || !Array.isArray(value.data) || value.data[1] !== 'base64' || typeof value.data[0] !== 'string'
    || typeof value.owner !== 'string') throw new Error('MINT_ACCOUNT_INVALID')
  const data = Buffer.from(value.data[0], 'base64')
  if (data.toString('base64') !== value.data[0] || data.length < 82 || data.length > 10000) throw new Error('MINT_DATA_INVALID')
  return { ...common, result: 'candidate', ownerProgram: value.owner, dataLength: data.length,
    dataHash: `0x${createHash('sha256').update(data).digest('hex')}`, decimals: data[44], initialized: data[45] === 1,
    mintAuthority: authority(data, 0), freezeAuthority: authority(data, 46) }
}

async function auditOne(): Promise<boolean> {
  let claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-solana-asset-auditor:${hostname()}`, namespace: 'solana', kind: 'native',
  })
  if (!claimed.lease) claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-solana-asset-auditor:${hostname()}`, namespace: 'solana', kind: 'token',
  })
  const lease = claimed.lease
  if (!lease) return false
  try {
    const evidence = await evidenceFor(lease)
    const submitted = await operator('/v1/admin/discovery/assets/audit', { caip: lease.caip,
      leaseToken: lease.leaseToken, evidence })
    console.log(JSON.stringify({ audited: true, caip: lease.caip, auditStatus: submitted.auditStatus,
      coverageStatus: submitted.coverageStatus, evidenceHash: submitted.evidenceHash }))
  } catch (error: any) {
    const errorClass = String(error?.message || 'AUDIT_FAILED').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 64)
    await operator('/v1/admin/discovery/assets/fail', { caip: lease.caip, leaseToken: lease.leaseToken, errorClass }).catch(() => {})
    console.error(JSON.stringify({ audited: false, caip: lease.caip, errorClass }))
  }
  return true
}

const daemon = process.argv.includes('--daemon')
const requested = Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || (daemon ? 3 : 1))
const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(50, requested)) : 1
do {
  let processed = 0
  while (processed < limit && await auditOne()) processed++
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
