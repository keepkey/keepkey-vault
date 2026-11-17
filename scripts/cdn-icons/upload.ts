/**
 * upload.ts — Upload the logos collected by collect.py to DigitalOcean Spaces.
 *
 * Reads scripts/cdn-icons/manifest.json (icons/) and manifest-generic.json
 * (generic/, placeholders from generic.py), checks every file against
 * its sha256, skips objects that already exist (never overwrites), and PUTs
 * the rest as public-read image/png.
 *
 * Usage:
 *   bun run scripts/cdn-icons/upload.ts            # dry run: lists what would be uploaded
 *   bun run scripts/cdn-icons/upload.ts --apply    # upload
 *   (node 23+ also runs it: node scripts/cdn-icons/upload.ts --apply)
 *
 * Requires (only with --apply): .env at the repo root with DO_SPACES_KEY,
 * DO_SPACES_SECRET (same as scripts/fix-missing-icons.ts).
 * Afterwards: node scripts/cdn-icons/scan.ts --from scripts/cdn-icons/missing.json
 */
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DIR = import.meta.dirname
const APPLY = process.argv.includes('--apply')
const REGION = 'sfo3'
const CONCURRENCY = 6

interface ManifestEntry { caip: string; symbol: string; key: string; source: string; sha256: string }

function loadEnv(): Record<string, string> {
  const envPath = resolve(DIR, '../../.env')
  const env: Record<string, string> = {}
  if (!existsSync(envPath)) return env
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/)
    if (m) env[m[1]] = m[2].trim()
  }
  return env
}

const env = loadEnv()
const ACCESS_KEY = env.DO_SPACES_KEY
const SECRET_KEY = env.DO_SPACES_SECRET
const BUCKET = env.DO_SPACES_BUCKET || 'keepkey'
const HOST = `${BUCKET}.${REGION}.digitaloceanspaces.com`

const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest()
const sha256Hex = (d: Buffer | string) => createHash('sha256').update(d).digest('hex')

function sign(method: 'PUT' | 'HEAD', key: string, body: Buffer | null): Record<string, string> {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const date = now.slice(0, 8)
  const payloadHash = sha256Hex(body ?? '')
  const headers: [string, string][] = [
    ['host', HOST],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', now],
  ]
  if (method === 'PUT') {
    headers.push(['cache-control', 'public, max-age=86400'])
    headers.push(['content-type', 'image/png'])
    headers.push(['x-amz-acl', 'public-read'])
  }
  headers.sort((a, b) => a[0].localeCompare(b[0]))
  const signed = headers.map(h => h[0]).join(';')
  const canonical = [method, '/' + key, '', headers.map(([k, v]) => `${k}:${v}\n`).join(''), signed, payloadHash].join('\n')
  const scope = `${date}/${REGION}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256Hex(canonical)].join('\n')
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + SECRET_KEY, date), REGION), 's3'), 'aws4_request')
  const signature = hmac(kSigning, toSign).toString('hex')
  return {
    ...Object.fromEntries(headers),
    Authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  }
}

async function exists(key: string): Promise<boolean> {
  const r = await fetch(`https://${HOST}/${key}`, { method: 'HEAD', headers: sign('HEAD', key, null) })
  return r.status === 200
}

async function put(key: string, body: Buffer): Promise<void> {
  const r = await fetch(`https://${HOST}/${key}`, { method: 'PUT', headers: sign('PUT', key, body), body })
  if (!r.ok) throw new Error(`PUT ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
}

async function main() {
  // Real logos first, then generic placeholders (generic.py) for whatever is left.
  const manifest: ManifestEntry[] = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'))
  const genericPath = join(DIR, 'manifest-generic.json')
  if (existsSync(genericPath)) {
    const real = new Set(manifest.map(e => e.key))
    for (const e of JSON.parse(readFileSync(genericPath, 'utf8')) as ManifestEntry[]) {
      if (real.has(e.key)) throw new Error(`${e.key} is in both manifests; re-run generic.py`)
      manifest.push(e)
    }
  }

  // Integrity check first: upload exactly what was reviewed.
  const files = new Map<string, Buffer>()
  for (const e of manifest) {
    // Keys are signed and stored as-is; '/' or '+' (possible in standard
    // base64) would need path handling this script doesn't do.
    if (!/^coins\/[A-Za-z0-9]+\.png$/.test(e.key)) throw new Error(`unexpected key: ${e.key}`)
    const body = readFileSync(join(DIR, e.source === 'generic' ? 'generic' : 'icons', e.key.slice('coins/'.length)))
    if (sha256Hex(body) !== e.sha256) throw new Error(`sha256 mismatch for ${e.caip} (${e.key})`)
    if (!body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error(`not a PNG: ${e.key}`)
    }
    files.set(e.key, body)
  }
  console.log(`${manifest.length} icons verified against manifest.json + manifest-generic.json`)

  if (!APPLY) {
    const bySource: Record<string, number> = {}
    for (const e of manifest) bySource[e.source.split(':')[0]] = (bySource[e.source.split(':')[0]] || 0) + 1
    console.log('Dry run, nothing uploaded. By source:', bySource)
    console.log('Run with --apply (needs DO_SPACES_KEY / DO_SPACES_SECRET in .env) to upload.')
    return
  }
  if (!ACCESS_KEY || !SECRET_KEY) {
    console.error('Missing DO_SPACES_KEY or DO_SPACES_SECRET in .env')
    process.exit(1)
  }

  let next = 0, uploaded = 0, skipped = 0
  const failed: string[] = []
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < manifest.length) {
      const e = manifest[next++]
      try {
        if (await exists(e.key)) { skipped++; continue }
        await put(e.key, files.get(e.key)!)
        uploaded++
      } catch (err) {
        failed.push(`${e.caip}: ${(err as Error).message}`)
      }
    }
  }))
  console.log(`uploaded=${uploaded} skipped(existing)=${skipped} failed=${failed.length}`)
  for (const f of failed) console.log('  FAIL', f)
  process.exitCode = failed.length ? 1 : 0
}

await main()
