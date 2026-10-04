import { hostname } from 'node:os'
import { utils } from 'ethers'
import snapshot from '../../../.worktrees/keepkey-vault-solana-certified/projects/keepkey-vault/clearsign-worker/src/evm-discovery-snapshot.json'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

async function rpc(endpoint: string, calls: Array<{ method: string; params: unknown[] }>) {
  const request = calls.map((call, index) => ({ jsonrpc: '2.0', id: index + 1, ...call }))
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const body: any = await response.json()
  if (!Array.isArray(body) || body.length !== calls.length) throw new Error('RPC_BATCH_INVALID')
  return request.map(item => {
    const answer = body.find(entry => entry?.id === item.id)
    if (!answer || answer.error || typeof answer.result !== 'string') throw new Error('RPC_RESULT_INVALID')
    return answer.result as string
  })
}

async function metadataRpc(endpoint: string, calls: Array<{ selector: '0x313ce567' | '0x95d89b41'; params: unknown[] }>) {
  const request = calls.map((call, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'eth_call', params: call.params }))
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const body: any = await response.json()
  if (!Array.isArray(body) || body.length !== calls.length) throw new Error('RPC_BATCH_INVALID')
  return request.map((item, index) => {
    const answer = body.find(entry => entry?.id === item.id)
    if (!answer) throw new Error('RPC_RESULT_INVALID')
    if (typeof answer.result === 'string') return { selector: calls[index].selector, result: answer.result }
    const code = answer?.error?.code
    const message = String(answer?.error?.message || '')
    if (!Number.isSafeInteger(code) || (code !== 3 && (code > -32000 || code < -32768))
      || !/(revert|execution|invalid opcode)/i.test(message)) throw new Error('RPC_RESULT_INVALID')
    return { selector: calls[index].selector, errorCode: code,
      errorHash: utils.keccak256(Buffer.from(JSON.stringify(answer.error))) }
  })
}

function decodeSymbol(value: string): string {
  try {
    const decoded = utils.defaultAbiCoder.decode(['string'], value)[0]
    if (typeof decoded === 'string' && decoded.length >= 1 && decoded.length <= 100) return decoded
  } catch {}
  if (/^0x[0-9a-f]{64}$/i.test(value)) {
    const decoded = Buffer.from(value.slice(2), 'hex').toString('utf8').replace(/\0+$/, '')
    if (decoded.length >= 1 && decoded.length <= 100 && /^[\x20-\x7e]+$/.test(decoded)) return decoded
  }
  throw new Error('TOKEN_SYMBOL_INVALID')
}

function decodeDecimals(value: string): number {
  if (!/^0x[0-9a-f]{1,64}$/i.test(value)) throw new Error('TOKEN_DECIMALS_INVALID')
  const decimals = Number(BigInt(value))
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('TOKEN_DECIMALS_INVALID')
  return decimals
}

async function evidenceFor(lease: any) {
  const match = String(lease.caip).match(/^eip155:(\d+)\/erc20:(0x[0-9a-f]{40})$/i)
  if (!match) throw new Error('ASSET_CAIP_UNSUPPORTED')
  const chainId = Number(match[1]); const contract = match[2].toLowerCase()
  const endpoints = (snapshot.rpc as Record<string, string[]>)[String(chainId)] || []
  if (!endpoints.length) throw new Error('RPC_UNAVAILABLE')
  let lastError: unknown
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('RPC_ENDPOINT_UNSAFE')
      const [reportedChain, latestBlock] = await rpc(endpoint, [
        { method: 'eth_chainId', params: [] }, { method: 'eth_blockNumber', params: [] },
      ])
      if (Number(BigInt(reportedChain)) !== chainId) throw new Error('RPC_CHAIN_MISMATCH')
      const blockNumber = Number(BigInt(latestBlock))
      if (!Number.isSafeInteger(blockNumber) || blockNumber < 1) throw new Error('RPC_BLOCK_INVALID')
      const [code] = await rpc(endpoint, [{ method: 'eth_getCode', params: [contract, latestBlock] }])
      const common = { version: 1, kind: 'evm-token-metadata', caip: lease.caip, chainId, contract,
        blockNumber, rpcHost: url.hostname, auditedAt: Date.now() }
      if (code === '0x' || code === '0x0') return { ...common, result: 'no-code', codeHash: `0x${'0'.repeat(64)}` }
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error('TOKEN_CODE_INVALID')
      const metadata = await metadataRpc(endpoint, [
        { selector: '0x313ce567', params: [{ to: contract, data: '0x313ce567' }, latestBlock] },
        { selector: '0x95d89b41', params: [{ to: contract, data: '0x95d89b41' }, latestBlock] },
      ])
      const metadataErrors = metadata.filter((item: any) => item.errorHash)
        .map(({ selector, errorCode, errorHash }: any) => ({ selector, errorCode, errorHash }))
      if (metadataErrors.length) return { ...common, result: 'metadata-unavailable',
        codeHash: utils.keccak256(code), metadataErrors }
      const decimalsRaw = metadata[0].result!; const symbolRaw = metadata[1].result!
      try {
        return { ...common, result: 'candidate', codeHash: utils.keccak256(code),
          symbol: decodeSymbol(symbolRaw), decimals: decodeDecimals(decimalsRaw) }
      } catch {
        return { ...common, result: 'metadata-unavailable', codeHash: utils.keccak256(code),
          metadataResults: metadata.map(({ selector, result }: any) => ({
            selector, resultHash: utils.keccak256(Buffer.from(String(result))),
          })) }
      }
    } catch (error) { lastError = error }
  }
  throw lastError || new Error('RPC_UNAVAILABLE')
}

async function auditOne(): Promise<boolean> {
  const claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-asset-auditor:${hostname()}`, namespace: 'eip155', kind: 'token',
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
const requested = Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || (daemon ? 5 : 1))
const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(100, requested)) : 1
do {
  let processed = 0
  while (processed < limit && await auditOne()) processed++
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
