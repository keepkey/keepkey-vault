import { readFile } from 'node:fs/promises'
import type { ClearSignCentralAssetReview, ClearSignCentralContractReview } from '../shared/types'

type Role = 'semantics-review' | 'security-review'
type Statement = Omit<ClearSignCentralAssetReview, 'signature'> | Omit<ClearSignCentralContractReview, 'signature'>
export type ReviewerIdentity = { role: Role; publicKey: string; fingerprint: string }

function setting(role: Role, suffix: 'URL' | 'TOKEN_FILE') {
  return `CLEARSIGN_${role === 'semantics-review' ? 'SEMANTICS' : 'SECURITY'}_REVIEW_SIGNER_${suffix}`
}

function signerUrl(role: Role, env: Record<string, string | undefined>) {
  if (!['semantics-review', 'security-review'].includes(role)) throw new Error('Invalid reviewer role')
  const configured = String(env[setting(role, 'URL')] || '').trim().replace(/\/+$/, '')
  if (!configured) throw new Error(`${role} signer is not configured`)
  const url = new URL(configured)
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:'
    && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) || url.username || url.password
    || url.search || url.hash) throw new Error('Reviewer signer URL is unsafe')
  return configured
}

export async function getConfiguredReviewerIdentity(role: Role, options: {
  env?: Record<string, string | undefined>; fetcher?: typeof fetch
} = {}): Promise<ReviewerIdentity> {
  const configured = signerUrl(role, options.env || process.env)
  const response = await (options.fetcher || fetch)(`${configured}/identity`, {
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  })
  const result: any = await response.json().catch(() => undefined)
  const publicKey = String(result?.publicKey || '').toLowerCase()
  const fingerprint = String(result?.fingerprint || '').toLowerCase()
  if (!response.ok || result?.role !== role || !/^(02|03)[0-9a-f]{64}$/.test(publicKey)
    || !/^[0-9a-f]{16}$/.test(fingerprint)) throw new Error('Reviewer signer identity is invalid')
  return { role, publicKey, fingerprint }
}

export async function signCentralReview(statement: Statement, options: {
  env?: Record<string, string | undefined>; fetcher?: typeof fetch; readToken?: (path: string) => Promise<string>
} = {}): Promise<ClearSignCentralAssetReview | ClearSignCentralContractReview> {
  const env = options.env || process.env
  const role = statement?.role as Role
  const configured = signerUrl(role, env)
  const tokenPath = String(env[setting(role, 'TOKEN_FILE')] || '').trim()
  if (!tokenPath) throw new Error(`${role} signer is not configured`)
  const token = (await (options.readToken || (path => readFile(path, 'utf8')))(tokenPath)).trim()
  if (token.length < 32) throw new Error('Reviewer signer credential is missing')
  const response = await (options.fetcher || fetch)(`${configured}/sign-review`, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(statement), signal: AbortSignal.timeout(10_000) })
  const result: any = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(`Reviewer signer rejected the statement: ${result?.error || `HTTP ${response.status}`}`)
  const expected = JSON.stringify(statement)
  const { signature, digest: _digest, kind: _kind, ...returned } = result || {}
  if (JSON.stringify(returned) !== expected || !/^[0-9a-f]{130}$/i.test(String(signature))) {
    throw new Error('Reviewer signer returned a mismatched statement or signature')
  }
  return { ...statement, signature: String(signature).toLowerCase() } as any
}
