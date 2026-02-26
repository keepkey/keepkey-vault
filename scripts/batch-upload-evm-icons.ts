/**
 * batch-upload-evm-icons.ts — Download EVM chain icons from chainlist.org and upload to KeepKey CDN
 *
 * Flow:
 *   1. Fetch all EVM chains from our discovery API
 *   2. Fetch chainlist.org chains.json (maps chainId → icon name)
 *   3. For each chain, resolve icon name → IPFS hash → download via gateway
 *   4. Upload to DigitalOcean Spaces as coins/{base64(caip)}.png
 *
 * Usage: bun run scripts/batch-upload-evm-icons.ts
 * Requires: .env with DO_SPACES_KEY, DO_SPACES_SECRET
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHmac, createHash } from 'crypto'

const DIR = import.meta.dir
const CACHE_DIR = join(DIR, '.icon-cache')
const PROGRESS_FILE = join(DIR, '.icon-upload-progress.json')

// Load env
const envPath = join(DIR, '../.env')
const envText = readFileSync(envPath, 'utf-8')
const env: Record<string, string> = {}
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/)
  if (m) env[m[1]] = m[2].trim()
}

const ACCESS_KEY = env.DO_SPACES_KEY
const SECRET_KEY = env.DO_SPACES_SECRET
const BUCKET = env.DO_SPACES_BUCKET || 'keepkey'
const REGION = 'sfo3'
const ENDPOINT = `https://${BUCKET}.${REGION}.digitaloceanspaces.com`

if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('Missing DO_SPACES_KEY or DO_SPACES_SECRET in .env')
  process.exit(1)
}

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })

const CONCURRENCY = 5
const IPFS_GATEWAY = 'https://cloudflare-ipfs.com/ipfs/'
const CHAINLIST_CHAINS = 'https://chainid.network/chains.json'
const CHAINLIST_ICONS_BASE = 'https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/icons/'
const DISCOVERY_API = 'https://api.keepkey.info/api/v1/discovery/search?q=mainnet&limit=2000'

// ─── AWS Signature V4 helpers ────────────────────────────────────────

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}
function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}
function getSignatureKey(key: string, ds: string, region: string, service: string): Buffer {
  let k = hmacSha256('AWS4' + key, ds)
  k = hmacSha256(k, region); k = hmacSha256(k, service); k = hmacSha256(k, 'aws4_request')
  return k
}

function signedHeaders(method: string, s3Key: string, body: Buffer | null, contentType?: string): Record<string, string> {
  const now = new Date()
  const ds = now.toISOString().replace(/[-:]/g, '').slice(0, 8)
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const payloadHash = body ? sha256Hex(body) : emptyHash
  const host = `${BUCKET}.${REGION}.digitaloceanspaces.com`
  const hl: [string, string][] = [['host', host], ['x-amz-content-sha256', payloadHash], ['x-amz-date', amzDate]]
  if (contentType) hl.push(['content-type', contentType])
  if (method === 'PUT') hl.push(['x-amz-acl', 'public-read'])
  hl.sort((a, b) => a[0].localeCompare(b[0]))
  const shn = hl.map(h => h[0]).join(';')
  const ch = hl.map(h => `${h[0]}:${h[1]}\n`).join('')
  const cr = [method, '/' + s3Key, '', ch, shn, payloadHash].join('\n')
  const cs = `${ds}/${REGION}/s3/aws4_request`
  const sts = ['AWS4-HMAC-SHA256', amzDate, cs, sha256Hex(cr)].join('\n')
  const sk = getSignatureKey(SECRET_KEY, ds, REGION, 's3')
  const sig = hmacSha256(sk, sts).toString('hex')
  const auth = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${cs}, SignedHeaders=${shn}, Signature=${sig}`
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, Authorization: auth }
  if (contentType) headers['content-type'] = contentType
  if (method === 'PUT') headers['x-amz-acl'] = 'public-read'
  return headers
}

async function s3Head(s3Key: string): Promise<boolean> {
  const headers = signedHeaders('HEAD', s3Key, null)
  try {
    const resp = await fetch(`${ENDPOINT}/${s3Key}`, { method: 'HEAD', headers, signal: AbortSignal.timeout(8000) })
    return resp.status === 200
  } catch { return false }
}

async function s3Put(s3Key: string, body: Buffer): Promise<boolean> {
  const headers = signedHeaders('PUT', s3Key, body, 'image/png')
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${ENDPOINT}/${s3Key}`, { method: 'PUT', headers, body })
      if (resp.ok) return true
      if (resp.status === 429 || resp.status === 503) {
        await Bun.sleep(1000 * Math.pow(2, attempt))
        continue
      }
      return false
    } catch {
      await Bun.sleep(1000 * Math.pow(2, attempt))
    }
  }
  return false
}

function caipToS3Key(caip: string): string {
  return 'coins/' + Buffer.from(caip).toString('base64').replace(/=+$/, '') + '.png'
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Batch Upload EVM Chain Icons ===\n')

  // Step 1: Get all EVM chains from our discovery API
  console.log('Step 1: Fetching EVM chains from discovery API...')
  const discoveryResp = await fetch(DISCOVERY_API, { signal: AbortSignal.timeout(15000) })
  const discoveryRaw: any[] = await discoveryResp.json()
  const evmChains = discoveryRaw
    .filter(e => e.chainId?.startsWith('eip155:') && e.assetId?.endsWith('/slip44:60'))
    .map(e => ({
      numericId: parseInt(e.chainId.replace('eip155:', ''), 10),
      caip: e.assetId as string,
      name: e.name as string,
      symbol: e.symbol as string,
    }))
    .filter(e => e.numericId > 0)
  // Deduplicate
  const seen = new Set<number>()
  const uniqueChains = evmChains.filter(c => { if (seen.has(c.numericId)) return false; seen.add(c.numericId); return true })
  console.log(`  Found ${uniqueChains.length} unique EVM chains\n`)

  // Step 2: Check which already exist on CDN
  console.log('Step 2: Checking which icons already exist on CDN...')
  let alreadyExist = 0
  const missing: typeof uniqueChains = []

  // Load progress
  let uploaded: Set<string>
  if (existsSync(PROGRESS_FILE)) {
    uploaded = new Set(JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8')))
  } else {
    uploaded = new Set()
  }

  for (let i = 0; i < uniqueChains.length; i += 20) {
    const batch = uniqueChains.slice(i, i + 20)
    const results = await Promise.all(batch.map(async c => {
      if (uploaded.has(c.caip)) return { chain: c, exists: true }
      const exists = await s3Head(caipToS3Key(c.caip))
      return { chain: c, exists }
    }))
    for (const r of results) {
      if (r.exists) { alreadyExist++; uploaded.add(r.chain.caip) }
      else missing.push(r.chain)
    }
    if ((i + 20) % 100 < 20) {
      console.log(`  Checked ${Math.min(i + 20, uniqueChains.length)}/${uniqueChains.length}...`)
    }
  }
  console.log(`  Already on CDN: ${alreadyExist}`)
  console.log(`  Missing: ${missing.length}\n`)

  if (missing.length === 0) {
    console.log('All icons exist! Nothing to do.')
    return
  }

  // Step 3: Fetch chainlist.org data for icon resolution
  console.log('Step 3: Fetching chainlist.org chain data...')
  const chainlistResp = await fetch(CHAINLIST_CHAINS, { signal: AbortSignal.timeout(15000) })
  const chainlistChains: any[] = await chainlistResp.json()
  // Map chainId → icon name
  const chainIdToIconName = new Map<number, string>()
  for (const c of chainlistChains) {
    if (c.icon && typeof c.icon === 'string') {
      chainIdToIconName.set(c.chainId, c.icon)
    }
  }
  console.log(`  Chainlist has ${chainIdToIconName.size} chains with icon names`)

  // Match missing chains to chainlist icon names
  const withIconName = missing.filter(c => chainIdToIconName.has(c.numericId))
  const noIconName = missing.filter(c => !chainIdToIconName.has(c.numericId))
  console.log(`  Matched: ${withIconName.length}`)
  console.log(`  No chainlist icon: ${noIconName.length}\n`)

  // Step 4: Resolve icon names → IPFS URLs, download, and upload
  console.log('Step 4: Downloading and uploading icons...\n')

  // Cache icon name → IPFS URL resolution
  const iconNameCache = new Map<string, string | null>()

  async function resolveIconUrl(iconName: string): Promise<string | null> {
    if (iconNameCache.has(iconName)) return iconNameCache.get(iconName)!
    try {
      const resp = await fetch(`${CHAINLIST_ICONS_BASE}${iconName}.json`, { signal: AbortSignal.timeout(8000) })
      if (resp.status !== 200) {
        iconNameCache.set(iconName, null)
        return null
      }
      const data: any[] = await resp.json()
      // Find first PNG entry
      const png = data.find(d => d.format === 'png' && d.url?.startsWith('ipfs://'))
      if (!png) {
        // Try SVG or any format
        const any = data.find(d => d.url?.startsWith('ipfs://'))
        if (!any) { iconNameCache.set(iconName, null); return null }
        const url = IPFS_GATEWAY + any.url.replace('ipfs://', '')
        iconNameCache.set(iconName, url)
        return url
      }
      const url = IPFS_GATEWAY + png.url.replace('ipfs://', '')
      iconNameCache.set(iconName, url)
      return url
    } catch {
      iconNameCache.set(iconName, null)
      return null
    }
  }

  let successCount = 0
  let failCount = 0
  let skipCount = 0

  function saveProgress() {
    writeFileSync(PROGRESS_FILE, JSON.stringify([...uploaded], null, 0))
  }

  for (let i = 0; i < withIconName.length; i += CONCURRENCY) {
    const batch = withIconName.slice(i, i + CONCURRENCY)

    await Promise.allSettled(batch.map(async (chain) => {
      const iconName = chainIdToIconName.get(chain.numericId)!
      const iconUrl = await resolveIconUrl(iconName)
      if (!iconUrl) { skipCount++; return }

      // Download icon
      try {
        const resp = await fetch(iconUrl, { signal: AbortSignal.timeout(15000) })
        if (!resp.ok) { failCount++; return }
        const data = Buffer.from(await resp.arrayBuffer())
        if (data.length < 100) { failCount++; return }

        // Upload to CDN
        const s3Key = caipToS3Key(chain.caip)
        const ok = await s3Put(s3Key, data)
        if (ok) {
          uploaded.add(chain.caip)
          successCount++
        } else {
          failCount++
        }
      } catch {
        failCount++
      }
    }))

    // Progress log every 25
    if ((i + CONCURRENCY) % 25 < CONCURRENCY) {
      const total = successCount + failCount + skipCount
      const pct = ((total / withIconName.length) * 100).toFixed(1)
      console.log(`  Progress: ${total}/${withIconName.length} (${pct}%) | uploaded=${successCount} failed=${failCount} skipped=${skipCount}`)
      saveProgress()
    }

    // Small delay to avoid rate limiting
    await Bun.sleep(200)
  }

  saveProgress()

  console.log('\n=== Upload Complete ===')
  console.log(`Uploaded: ${successCount}`)
  console.log(`Failed: ${failCount}`)
  console.log(`Skipped (no chainlist icon): ${skipCount + noIconName.length}`)
  console.log(`Already on CDN: ${alreadyExist}`)
  console.log(`Total coverage: ${alreadyExist + successCount}/${uniqueChains.length} (${(((alreadyExist + successCount) / uniqueChains.length) * 100).toFixed(1)}%)`)
}

main().catch(console.error)
