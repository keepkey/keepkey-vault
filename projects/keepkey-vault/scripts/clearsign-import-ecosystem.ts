const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const directory = process.argv[2] || '../../docs/clearsign-ecosystem'
const token = (await Bun.file(tokenPath).text()).trim()
const summary = await Bun.file(`${directory}/summary.json`).json()
const sourceHash = String(summary.inventoryHash || '')
const rows = (await Bun.file(`${directory}/assets.jsonl`).text()).trim().split('\n').map(line => JSON.parse(line))
const recomputedHash = createHash('sha256').update(JSON.stringify({
  policyVersion: summary.policyVersion,
  sourceHashes: Array.isArray(summary.sources) ? summary.sources.map((source: any) => source?.sha256) : [],
  signedProvenance: summary.signedProvenance,
  rows,
})).digest('hex')
if (summary.version !== 2 || !Number.isSafeInteger(summary.policyVersion) || summary.policyVersion < 1
  || !/^[0-9a-f]{64}$/.test(sourceHash) || sourceHash !== recomputedHash
  || rows.length !== summary.totalAssets) {
  throw new Error('Inventory provenance or total is invalid')
}
async function post(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}
for (let offset = 0; offset < rows.length; offset += 100) {
  const result = await post('/v1/admin/discovery/assets/import', {
    sourceHash, totalAssets: rows.length, rows: rows.slice(offset, offset + 100),
  })
  if ((offset / 100) % 25 === 0 || result.complete) console.log(JSON.stringify({ importedAssets: result.importedAssets, totalAssets: rows.length }))
}
const complete = await post('/v1/admin/discovery/assets/complete', { sourceHash })
console.log(JSON.stringify(complete))
import { createHash } from 'node:crypto'
