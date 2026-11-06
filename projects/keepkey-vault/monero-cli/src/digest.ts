import { createHash, randomBytes } from 'node:crypto'
import { Agent, request } from 'node:http'
import { parseExactJson } from './protocol'

const MAX_BODY = 8 * 1024 * 1024
const ALLOWED = new Set(['get_version', 'generate_from_keys', 'open_wallet', 'get_address', 'query_key', 'refresh', 'get_balance', 'get_transfers', 'get_height', 'stop_wallet'])
const md5 = (value: string) => createHash('md5').update(value).digest('hex')

export class RpcFailure extends Error {
  constructor(public code: number) { super('The Monero wallet RPC rejected the operation') }
}

export function parseDigest(value: string): Record<string, string> {
  if (!/^Digest\s+/i.test(value) || value.length > 8192) throw new Error('Invalid local wallet RPC authentication')
  const fields: Record<string, string> = {}
  const body = value.replace(/^Digest\s+/i, '')
  const pattern = /([a-zA-Z]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))\s*(?:,\s*|$)/g
  let cursor = 0, match: RegExpExecArray | null
  while ((match = pattern.exec(body))) {
    if (match.index !== cursor || fields[match[1].toLowerCase()] !== undefined) throw new Error('Invalid local wallet RPC authentication')
    fields[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\(.)/g, '$1')
    cursor = pattern.lastIndex
  }
  if (cursor !== body.length || !fields.realm || !fields.nonce ||
      !['MD5', 'MD5-sess', undefined].includes(fields.algorithm) || !fields.qop?.split(',').map(x => x.trim()).includes('auth')) {
    throw new Error('Unsupported local wallet RPC authentication')
  }
  return fields
}

export class DigestWalletRpc {
  private agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  private challenge: Record<string, string> | null = null
  private count = 0
  private id = 0
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private port: number, private username: string, private password: string) {}

  private authorization(): string | undefined {
    const c = this.challenge
    if (!c) return undefined
    const nc = (++this.count).toString(16).padStart(8, '0'), cnonce = randomBytes(16).toString('hex')
    const initial = md5(`${this.username}:${c.realm}:${this.password}`)
    const ha1 = c.algorithm === 'MD5-sess' ? md5(`${initial}:${c.nonce}:${cnonce}`) : initial
    const response = md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:auth:${md5('POST:/json_rpc')}`)
    const quoted = (v: string) => JSON.stringify(v)
    return `Digest username=${quoted(this.username)}, realm=${quoted(c.realm)}, nonce=${quoted(c.nonce)}, uri="/json_rpc", response="${response}", algorithm=${c.algorithm || 'MD5'}, qop=auth, nc=${nc}, cnonce="${cnonce}"${c.opaque ? `, opaque=${quoted(c.opaque)}` : ''}`
  }

  private exchange(body: string, timeout: number): Promise<{ status: number; challenge?: string; body: string }> {
    return new Promise((resolve, reject) => {
      const authorization = this.authorization()
      const req = request({ host: '127.0.0.1', port: this.port, method: 'POST', path: '/json_rpc', agent: this.agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(authorization ? { Authorization: authorization } : {}) } }, response => {
        const chunks: Uint8Array[] = []; let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > MAX_BODY) { response.destroy(new Error('Monero wallet RPC response exceeds its bound')); return }
          chunks.push(new Uint8Array(chunk))
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0,
          challenge: typeof response.headers['www-authenticate'] === 'string' ? response.headers['www-authenticate'] : undefined,
          body: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', () => reject(new Error('Monero wallet RPC response failed')))
      })
      // Core nonces belong to the TCP connection. Renegotiate on an actual
      // 401 rather than comparing Bun's per-request socket wrapper objects.
      req.setTimeout(timeout, () => req.destroy(new Error('Monero wallet RPC timed out')))
      req.on('error', () => { this.challenge = null; reject(new Error('The local Monero wallet RPC is unavailable')) })
      req.end(body)
    })
  }

  call(method: string, params: Record<string, unknown> = {}, timeout = 30000): Promise<any> {
    const operation = this.queue.then(() => this.performCall(method, params, timeout))
    this.queue = operation.catch(() => {})
    return operation
  }

  private async performCall(method: string, params: Record<string, unknown>, timeout: number): Promise<any> {
    if (!ALLOWED.has(method)) throw new Error('Operation is unavailable in the watch-only Monero sidecar')
    const id = String(++this.id), body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.exchange(body, timeout)
      if (response.status === 401 && response.challenge) {
        this.challenge = parseDigest(response.challenge); this.count = 0; continue
      }
      if (response.status !== 200) throw new Error('The local Monero wallet RPC is unavailable')
      const value = parseExactJson(response.body)
      if (value.id !== id || value.jsonrpc !== '2.0') throw new Error('Invalid Monero wallet RPC response')
      if (value.error) throw new RpcFailure(Number(value.error.code))
      if (!value.result || typeof value.result !== 'object') throw new Error('Invalid Monero wallet RPC response')
      return value.result
    }
    throw new Error('Cannot authenticate the local Monero wallet RPC')
  }

  close(): void { this.password = ''; this.username = ''; this.challenge = null; this.agent.destroy() }
}
