import type { ClearSignCentralAssetAudit, ClearSignCentralAssetAuditHistory, ClearSignCentralAssetReview, ClearSignCentralAssetReviewResult, ClearSignCentralContractAudit, ClearSignCentralContractReview, ClearSignCentralRequest, ClearSignCentralStatus } from '../shared/types'

const SERVICE = 'https://keepkey-clearsign.bithighlander.workers.dev'
const TOKEN_PATH = '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'

async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  const body: any = await response.json()
  if (!response.ok) throw new Error(body?.error || `HTTP_${response.status}`)
  return body
}

/** Backend-only client. The operator bearer is never returned to the renderer. */
export async function getCentralClearSignStatus(): Promise<ClearSignCentralStatus> {
  const catalog = await json(`${SERVICE}/v1/catalog`)
  const sourceObservation = catalog?.ecosystem?.sourceObservation
  const sourceDrift = Boolean(sourceObservation && (sourceObservation.assetsHash !== catalog?.discovery?.source?.assetsSha256
    || sourceObservation.denylistHash !== catalog?.discovery?.source?.denylistSha256))
  let requests: ClearSignCentralRequest[] = []
  let assetCandidates: ClearSignCentralAssetAudit[] = []
  let reviewPolicy: ClearSignCentralStatus['reviewPolicy']
  try {
    const token = (await Bun.file(TOKEN_PATH).text()).trim()
    if (token.length >= 32) {
      const headers = { authorization: `Bearer ${token}` }
      const states = ['pending', 'auditing', 'awaiting-approval', 'approved', 'rejected']
      const pages = await Promise.all(states.map(status => json(
        `${SERVICE}/v1/admin/discovery/requests?status=${status}&limit=100`, { headers },
      )))
      requests = pages.flatMap(page => Array.isArray(page?.requests) ? page.requests : [])
      const assetPages = await Promise.all(['eip155', 'solana', 'tron', 'cosmos', 'bip122', 'binance', 'hive', 'ripple', 'xrpl', 'ton'].map(namespace => json(
        `${SERVICE}/v1/admin/discovery/assets/requests?status=candidate&namespace=${namespace}&limit=50`, { headers },
      )))
      assetCandidates = assetPages.flatMap(page => Array.isArray(page?.assets) ? page.assets : [])
      reviewPolicy = await json(`${SERVICE}/v1/admin/discovery/review-policy`, { headers })
    }
  } catch { /* public inventory remains visible if operator access is absent */ }
  return {
    available: Boolean(catalog?.ecosystem?.available),
    sourceHash: catalog?.ecosystem?.sourceHash,
    totalAssets: Number(catalog?.ecosystem?.totalAssets || 0),
    importedAssets: Number(catalog?.ecosystem?.importedAssets || 0),
    complete: Boolean(catalog?.ecosystem?.complete),
    byCoverage: catalog?.ecosystem?.byCoverage || {},
    byAssetAudit: catalog?.ecosystem?.byAssetAudit || {},
    byAssetApproval: catalog?.ecosystem?.byAssetApproval || {},
    contractQueue: catalog?.ecosystem?.contractQueue || {},
    certificateChainIds: Array.isArray(catalog?.discovery?.certificateChainIds) ? catalog.discovery.certificateChainIds : [],
    requests,
    assetCandidates,
    reviewPolicy,
    sourceObservation,
    sourceDrift,
  }
}

/** Fetch immutable audit evidence for human review. The operator token stays backend-only. */
export async function getCentralAssetAuditHistory(caip: string): Promise<ClearSignCentralAssetAuditHistory[]> {
  const normalized = String(caip || '').trim()
  if (normalized.length < 3 || normalized.length > 300) throw new Error('Invalid asset identity')
  const token = (await Bun.file(TOKEN_PATH).text()).trim()
  if (token.length < 32) throw new Error('ClearSign operator access is not configured')
  const result = await json(`${SERVICE}/v1/admin/discovery/assets/history?caip=${encodeURIComponent(normalized)}&limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return Array.isArray(result?.audits) ? result.audits : []
}

/** Submit an externally signed review. Vault never receives or handles the reviewer private key. */
export async function submitCentralAssetReview(review: ClearSignCentralAssetReview): Promise<ClearSignCentralAssetReviewResult> {
  const token = (await Bun.file(TOKEN_PATH).text()).trim()
  if (token.length < 32) throw new Error('ClearSign operator access is not configured')
  return json(`${SERVICE}/v1/admin/discovery/assets/review`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(review),
  })
}

export async function getCentralContractAudit(auditId: string): Promise<ClearSignCentralContractAudit> {
  if (!/^[0-9a-f]{64}$/.test(auditId)) throw new Error('Invalid contract audit identity')
  const token = (await Bun.file(TOKEN_PATH).text()).trim()
  if (token.length < 32) throw new Error('ClearSign operator access is not configured')
  return json(`${SERVICE}/v1/admin/discovery/audit?auditId=${auditId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

export async function submitCentralContractReview(review: ClearSignCentralContractReview): Promise<Record<string, unknown>> {
  const token = (await Bun.file(TOKEN_PATH).text()).trim()
  if (token.length < 32) throw new Error('ClearSign operator access is not configured')
  return json(`${SERVICE}/v1/admin/discovery/review`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(review),
  })
}
