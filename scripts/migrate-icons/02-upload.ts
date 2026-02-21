/**
 * 02-upload.ts — Batch upload downloaded icons to DigitalOcean Spaces (S3-compatible)
 *
 * Uploads to: keepkey bucket → coins/<base64_caip>.png
 * The base64 encoding matches the keepkey.info URL convention (no padding).
 *
 * Features:
 *   - Chunked uploads with configurable concurrency
 *   - Skip already-uploaded (checks S3 HEAD)
 *   - Resumable with progress file
 *   - Rate limit backoff
 *
 * Usage: bun run scripts/migrate-icons/02-upload.ts
 * Requires: .env with DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createHmac, createHash } from 'crypto'

const DIR = import.meta.dir
const DOWNLOADS = join(DIR, 'downloads')
const MIGRATE_FILE = join(DIR, 'icons-to-migrate.json')
const UPLOAD_PROGRESS_FILE = join(DIR, 'upload-progress.json')

// Load env
const envPath = join(DIR, '../../.env')
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

const CONCURRENCY = 8
const CHUNK_LOG_EVERY = 50
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

interface MigrateEntry {
  caip: string
  source: string
  url: string
}

// CAIP → S3 key (matching keepkey.info convention: base64 without padding)
function caipToS3Key(caip: string): string {
  return 'coins/' + Buffer.from(caip).toString('base64').replace(/=+$/, '') + '.png'
}

// Filename used by 01-download.ts
function caipToFilename(caip: string): string {
  return Buffer.from(caip).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-') + '.png'
}

// ─── AWS Signature V4 (minimal S3 PUT/HEAD) ───────────────────────────

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Buffer {
  let k = hmacSha256('AWS4' + key, dateStamp)
  k = hmacSha256(k, region)
  k = hmacSha256(k, service)
  k = hmacSha256(k, 'aws4_request')
  return k
}

function signedHeaders(method: string, s3Key: string, body: Buffer | null, contentType?: string): Record<string, string> {
  const now = new Date()
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8)
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const payloadHash = body ? sha256Hex(body) : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' // empty hash

  const host = `${BUCKET}.${REGION}.digitaloceanspaces.com`
  const canonicalUri = '/' + s3Key
  const canonicalQuerystring = ''

  const headersList: [string, string][] = [
    ['host', host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate],
  ]
  if (contentType) headersList.push(['content-type', contentType])
  if (method === 'PUT') headersList.push(['x-amz-acl', 'public-read'])

  headersList.sort((a, b) => a[0].localeCompare(b[0]))
  const signedHeaderNames = headersList.map(h => h[0]).join(';')
  const canonicalHeaders = headersList.map(h => `${h[0]}:${h[1]}\n`).join('')

  const canonicalRequest = [method, canonicalUri, canonicalQuerystring, canonicalHeaders, signedHeaderNames, payloadHash].join('\n')
  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = getSignatureKey(SECRET_KEY, dateStamp, REGION, 's3')
  const signature = hmacSha256(signingKey, stringToSign).toString('hex')

  const authHeader = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`

  const headers: Record<string, string> = {
    'host': host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'Authorization': authHeader,
  }
  if (contentType) headers['content-type'] = contentType
  if (method === 'PUT') headers['x-amz-acl'] = 'public-read'
  return headers
}

async function s3Head(s3Key: string): Promise<boolean> {
  const headers = signedHeaders('HEAD', s3Key, null)
  const url = `${ENDPOINT}/${s3Key}`
  try {
    const resp = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(10000) })
    return resp.status === 200
  } catch {
    return false
  }
}

async function s3Put(s3Key: string, body: Buffer, contentType: string): Promise<boolean> {
  const headers = signedHeaders('PUT', s3Key, body, contentType)
  const url = `${ENDPOINT}/${s3Key}`

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(30000) })

      if (resp.status === 429 || resp.status === 503) {
        const wait = BASE_DELAY_MS * Math.pow(2, attempt)
        console.warn(`  ${resp.status} rate-limited on upload, waiting ${wait}ms...`)
        await Bun.sleep(wait)
        continue
      }

      if (resp.ok || resp.status === 200) return true

      const text = await resp.text().catch(() => '')
      console.warn(`  Upload ${resp.status} for ${s3Key}: ${text.slice(0, 200)}`)
      if (resp.status >= 500) {
        await Bun.sleep(BASE_DELAY_MS * Math.pow(2, attempt))
        continue
      }
      return false
    } catch (err: any) {
      if (attempt < MAX_RETRIES - 1) {
        await Bun.sleep(BASE_DELAY_MS * Math.pow(2, attempt))
      }
    }
  }
  return false
}

// ─── Main ─────────────────────────────────────────────────────────────

const entries: MigrateEntry[] = JSON.parse(readFileSync(MIGRATE_FILE, 'utf-8'))
const withUrl = entries.filter(e => e.url && e.source !== '(empty)' && e.source !== 'unknown')

// Load upload progress
let uploaded: Set<string>
if (existsSync(UPLOAD_PROGRESS_FILE)) {
  uploaded = new Set(JSON.parse(readFileSync(UPLOAD_PROGRESS_FILE, 'utf-8')))
} else {
  uploaded = new Set()
}

// Find downloaded files that need uploading
const toUpload: MigrateEntry[] = []
for (const e of withUrl) {
  if (uploaded.has(e.caip)) continue
  const fname = caipToFilename(e.caip)
  if (existsSync(join(DOWNLOADS, fname))) {
    toUpload.push(e)
  }
}

console.log(`Total with URL: ${withUrl.length}`)
console.log(`Already uploaded: ${uploaded.size}`)
console.log(`Downloaded & pending upload: ${toUpload.length}`)

function saveUploadProgress() {
  writeFileSync(UPLOAD_PROGRESS_FILE, JSON.stringify([...uploaded], null, 0))
}

let successCount = 0
let failCount = 0
let skipCount = 0

for (let i = 0; i < toUpload.length; i += CONCURRENCY) {
  const batch = toUpload.slice(i, i + CONCURRENCY)

  await Promise.allSettled(batch.map(async (entry) => {
    const s3Key = caipToS3Key(entry.caip)
    const fname = caipToFilename(entry.caip)
    const filePath = join(DOWNLOADS, fname)

    // Check if already in S3
    const exists = await s3Head(s3Key)
    if (exists) {
      uploaded.add(entry.caip)
      skipCount++
      return
    }

    const fileData = readFileSync(filePath)
    const ok = await s3Put(s3Key, Buffer.from(fileData), 'image/png')
    if (ok) {
      uploaded.add(entry.caip)
      successCount++
    } else {
      failCount++
    }
  }))

  if ((i + CONCURRENCY) % CHUNK_LOG_EVERY < CONCURRENCY) {
    saveUploadProgress()
    const total = successCount + failCount + skipCount
    const pct = ((total / toUpload.length) * 100).toFixed(1)
    console.log(`  Progress: ${total}/${toUpload.length} (${pct}%) | uploaded=${successCount} skipped=${skipCount} failed=${failCount}`)
  }

  // Small delay between batches
  await Bun.sleep(100)
}

saveUploadProgress()
console.log(`\n=== Upload complete ===`)
console.log(`Uploaded: ${successCount}`)
console.log(`Skipped (already in S3): ${skipCount}`)
console.log(`Failed: ${failCount}`)
console.log(`Total in S3: ${uploaded.size}/${withUrl.length}`)
