/**
 * fix-missing-icons.ts — Upload missing chain icons to DigitalOcean Spaces
 *
 * Copies icons that exist with base64 padding to unpadded keys,
 * and fetches+uploads icons that are completely missing.
 *
 * Usage: bun run scripts/fix-missing-icons.ts
 * Requires: .env with DO_SPACES_KEY, DO_SPACES_SECRET
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { createHmac, createHash } from 'crypto'

// Load .env
const envPath = join(import.meta.dir, '../.env')
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

// ─── AWS Signature V4 helpers ────────────────────────────────────────

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
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const payloadHash = body ? sha256Hex(body) : emptyHash

  const host = `${BUCKET}.${REGION}.digitaloceanspaces.com`
  const canonicalUri = '/' + s3Key

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

  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaderNames, payloadHash].join('\n')
  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = getSignatureKey(SECRET_KEY, dateStamp, REGION, 's3')
  const signature = hmacSha256(signingKey, stringToSign).toString('hex')

  const authHeader = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: authHeader,
  }
  if (contentType) headers['content-type'] = contentType
  if (method === 'PUT') headers['x-amz-acl'] = 'public-read'
  return headers
}

async function s3Put(s3Key: string, body: Buffer): Promise<boolean> {
  const headers = signedHeaders('PUT', s3Key, body, 'image/png')
  const url = `${ENDPOINT}/${s3Key}`
  const resp = await fetch(url, { method: 'PUT', headers, body })
  if (resp.ok) return true
  const text = await resp.text().catch(() => '')
  console.error(`  PUT ${resp.status} for ${s3Key}: ${text.slice(0, 200)}`)
  return false
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

function caipToUnpaddedKey(caip: string): string {
  return 'coins/' + Buffer.from(caip).toString('base64').replace(/=+$/, '') + '.png'
}

function caipToPaddedKey(caip: string): string {
  return 'coins/' + Buffer.from(caip).toString('base64') + '.png'
}

// ─── Icons to fix ────────────────────────────────────────────────────

interface IconFix {
  symbol: string
  caip: string
  // If paddedExists is true, we download from padded key and re-upload to unpadded key
  // If fallbackUrl is set, we download from that URL instead
  paddedExists: boolean
  fallbackUrl?: string
}

const FIXES: IconFix[] = [
  {
    symbol: 'DGB',
    caip: 'bip122:4da631f2ac1bed857bd968c67c913978/slip44:20',
    paddedExists: true,
  },
  {
    symbol: 'MON',
    caip: 'eip155:143/slip44:60',
    paddedExists: true,
  },
  {
    symbol: 'BNB (Beacon)',
    caip: 'binance:bnb-beacon-chain/slip44:714',
    paddedExists: true,
  },
  {
    symbol: 'XRP',
    caip: 'cosmos:ripple/slip44:144',
    paddedExists: false,
    fallbackUrl: 'https://assets.coingecko.com/coins/images/44/standard/xrp-symbol-white-128.png',
  },
  {
    symbol: 'SOL',
    caip: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
    paddedExists: false,
    fallbackUrl: 'https://assets.coingecko.com/coins/images/4128/standard/solana.png',
  },
]

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Fix Missing Chain Icons ===\n')

  for (const fix of FIXES) {
    const unpaddedKey = caipToUnpaddedKey(fix.caip)
    const paddedKey = caipToPaddedKey(fix.caip)

    // Check if unpadded already exists
    const exists = await s3Head(unpaddedKey)
    if (exists) {
      console.log(`OK  ${fix.symbol} — already exists at ${unpaddedKey}`)
      continue
    }

    let imageData: Buffer | null = null

    if (fix.paddedExists) {
      // Download from padded key on CDN
      console.log(`    ${fix.symbol} — downloading from padded key...`)
      const url = `${ENDPOINT}/${paddedKey}`
      const resp = await fetch(url)
      if (resp.ok) {
        imageData = Buffer.from(await resp.arrayBuffer())
        console.log(`    ${fix.symbol} — got ${imageData.length} bytes from padded key`)
      } else {
        console.error(`    ${fix.symbol} — failed to download padded: ${resp.status}`)
      }
    }

    if (!imageData && fix.fallbackUrl) {
      console.log(`    ${fix.symbol} — downloading from fallback URL...`)
      const resp = await fetch(fix.fallbackUrl)
      if (resp.ok) {
        imageData = Buffer.from(await resp.arrayBuffer())
        console.log(`    ${fix.symbol} — got ${imageData.length} bytes from fallback`)
      } else {
        console.error(`    ${fix.symbol} — fallback download failed: ${resp.status}`)
      }
    }

    if (!imageData) {
      console.error(`FAIL ${fix.symbol} — no image data available`)
      continue
    }

    // Upload to unpadded key
    console.log(`    ${fix.symbol} — uploading to ${unpaddedKey}...`)
    const ok = await s3Put(unpaddedKey, imageData)
    if (ok) {
      console.log(`DONE ${fix.symbol} — uploaded successfully`)
    } else {
      console.error(`FAIL ${fix.symbol} — upload failed`)
    }
  }

  // Verify all
  console.log('\n=== Verification ===')
  for (const fix of FIXES) {
    const key = caipToUnpaddedKey(fix.caip)
    const cdnUrl = `https://keepkey.sfo3.cdn.digitaloceanspaces.com/${key}`
    const code = await fetch(cdnUrl, { method: 'HEAD' }).then(r => r.status).catch(() => 0)
    console.log(`${code === 200 ? 'OK' : 'FAIL'}  ${fix.symbol} → ${cdnUrl} (${code})`)
  }
}

main().catch(console.error)
