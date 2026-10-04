import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import snapshot from '../../../.worktrees/keepkey-vault-solana-certified/projects/keepkey-vault/clearsign-worker/src/evm-discovery-snapshot.json'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const assetsPath = process.env.PIONEER_ASSETS_PATH || '../../../pioneer/modules/pioneer/pioneer-discovery/src/generatedAssetData.json'
const denylistPath = process.env.PIONEER_DENYLIST_PATH || '../../../pioneer/modules/pioneer/pioneer-discovery/src/denylist.json'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')

async function digest(path: string) {
  const text = await Bun.file(path).text()
  JSON.parse(text)
  return createHash('sha256').update(text).digest('hex')
}
const [assetsHash, denylistHash] = await Promise.all([digest(assetsPath), digest(denylistPath)])
const response = await fetch(`${service}/v1/admin/discovery/assets/source-observation`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ assetsHash, denylistHash, observer: `vault-source-monitor:${hostname()}` }),
  signal: AbortSignal.timeout(30_000),
})
const result: any = await response.json()
if (!response.ok) throw new Error(result?.error || `HTTP_${response.status}`)
const drift = assetsHash !== snapshot.source.assetsSha256 || denylistHash !== snapshot.source.denylistSha256
console.log(JSON.stringify({ observed: true, drift, assetsHash, denylistHash,
  pinnedAssetsHash: snapshot.source.assetsSha256, pinnedDenylistHash: snapshot.source.denylistSha256,
  observationId: result.id }))
if (drift) process.exitCode = 2
