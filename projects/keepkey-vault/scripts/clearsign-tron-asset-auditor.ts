import { hostname } from 'node:os'
import { utils } from 'ethers'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const endpoint = process.env.CLEARSIGN_TRON_RPC_ENDPOINT || 'https://api.trongrid.io'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const MAINNET = 'tron:0x2b6653dc'

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

async function tron(path: string, body: unknown) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${endpoint}${path}`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    if (response.ok) return response.json() as Promise<any>
    if (response.status !== 429 || attempt === 2) throw new Error(`RPC_HTTP_${response.status}`)
    await Bun.sleep(2_000 * (attempt + 1))
  }
  throw new Error('RPC_UNAVAILABLE')
}

function constantResult(body: any): string {
  const value = body?.constant_result?.[0]
  if (body?.result?.result !== true || typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error('TOKEN_CONSTANT_CALL_INVALID')
  }
  return `0x${value}`
}

function decodeSymbol(value: string): string {
  const decoded = utils.defaultAbiCoder.decode(['string'], value)[0]
  if (typeof decoded !== 'string' || decoded.length < 1 || decoded.length > 100 || !/^[\x20-\x7e]+$/.test(decoded)) {
    throw new Error('TOKEN_SYMBOL_INVALID')
  }
  return decoded
}

function decodeDecimals(value: string): number {
  if (!/^0x[0-9a-f]{1,64}$/i.test(value)) throw new Error('TOKEN_DECIMALS_INVALID')
  const decimals = Number(BigInt(value))
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('TOKEN_DECIMALS_INVALID')
  return decimals
}

async function evidenceFor(lease: any) {
  const native = lease.caip === 'tron:0x2b6653dc/slip44:195'
  const match = String(lease.caip).match(/^tron:0x2b6653dc\/token:([1-9A-HJ-NP-Za-km-z]{34})$/)
  if (!native && !match) throw new Error('ASSET_CAIP_UNSUPPORTED')
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('RPC_ENDPOINT_UNSAFE')

  const block = await tron('/walletsolidity/getnowblock', { value: true })
  const blockNumber = block?.block_header?.raw_data?.number
  const blockHash = block?.blockID
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1 || !/^[0-9a-f]{64}$/i.test(String(blockHash))) {
    throw new Error('RPC_BLOCK_INVALID')
  }
  if (native) return { version: 1, kind: 'tron-native-asset', caip: lease.caip, network: MAINNET,
    symbol: 'TRX', decimals: 6, slip44: 195, blockNumber, blockHash: String(blockHash).toLowerCase(),
    rpcHost: url.hostname, auditedAt: Date.now(), result: 'candidate' }
  const contract = match![1]
  const state = await tron('/wallet/getcontract', { value: contract, visible: true })
  const common = { version: 1, kind: 'tron-token-contract', caip: lease.caip, network: MAINNET, contract,
    blockNumber, blockHash: String(blockHash).toLowerCase(), rpcHost: url.hostname, auditedAt: Date.now() }
  if (!state || Object.keys(state).length === 0) return { ...common, result: 'no-code', codeHash: `0x${'0'.repeat(64)}` }
  if (state.contract_address !== contract || !/^[0-9a-f]{64}$/i.test(String(state.code_hash))
    || !/^(?:[0-9a-f]{2})+$/i.test(String(state.bytecode))) throw new Error('TOKEN_CODE_INVALID')

  const call = (function_selector: string) => tron('/walletsolidity/triggerconstantcontract', {
    owner_address: contract, contract_address: contract, function_selector, parameter: '', visible: true,
  })
  const symbolRaw = await call('symbol()')
  const decimalsRaw = await call('decimals()')
  return { ...common, result: 'candidate', codeHash: `0x${String(state.code_hash).toLowerCase()}`,
    symbol: decodeSymbol(constantResult(symbolRaw)), decimals: decodeDecimals(constantResult(decimalsRaw)) }
}

async function auditOne(): Promise<boolean> {
  let claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-tron-asset-auditor:${hostname()}`, namespace: 'tron', kind: 'token',
  })
  if (!claimed.lease) claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-tron-asset-auditor:${hostname()}`, namespace: 'tron', kind: 'native',
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
const requested = Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || 1)
const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(10, requested)) : 1
do {
  let processed = 0
  while (processed < limit && await auditOne()) processed++
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
