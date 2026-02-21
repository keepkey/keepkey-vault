/**
 * 01-download.ts — Batch download missing icons from source CDNs
 *
 * Downloads icons in chunks with rate-limit awareness:
 *   - Concurrency capped per source host
 *   - Exponential backoff on 429/5xx
 *   - Resumable: skips already-downloaded files
 *   - Progress tracking with periodic saves
 *
 * Usage: bun run scripts/migrate-icons/01-download.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const DIR = import.meta.dir
const DOWNLOADS = join(DIR, 'downloads')
const MIGRATE_FILE = join(DIR, 'icons-to-migrate.json')
const PROGRESS_FILE = join(DIR, 'download-progress.json')

mkdirSync(DOWNLOADS, { recursive: true })

interface MigrateEntry {
  caip: string
  source: string
  url: string
}

// Filename from CAIP: base64url-safe (no padding)
function caipToFilename(caip: string): string {
  return Buffer.from(caip).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-') + '.png'
}

// Rate limit config per host
const HOST_CONCURRENCY: Record<string, number> = {
  'assets.coingecko.com': 5,
  'coin-images.coingecko.com': 5,
  'rawcdn.githack.com': 8,
  'images.portals.fi': 5,
  'api.keepkey.info': 10,
  'raw.githubusercontent.com': 8,
}
const DEFAULT_CONCURRENCY = 5
const CHUNK_SIZE = 50   // save progress every N downloads
const MAX_RETRIES = 3
const BASE_DELAY_MS = 2000

// Load entries
const entries: MigrateEntry[] = JSON.parse(readFileSync(MIGRATE_FILE, 'utf-8'))
const downloadable = entries.filter(e => e.url && e.source !== '(empty)' && e.source !== 'unknown')

// Load progress (set of completed caips)
let completed: Set<string>
if (existsSync(PROGRESS_FILE)) {
  completed = new Set(JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8')))
} else {
  completed = new Set()
}

// Also check filesystem for already-downloaded
for (const e of downloadable) {
  const fname = caipToFilename(e.caip)
  if (existsSync(join(DOWNLOADS, fname))) {
    completed.add(e.caip)
  }
}

const pending = downloadable.filter(e => !completed.has(e.caip))
console.log(`Total downloadable: ${downloadable.length}`)
console.log(`Already done: ${completed.size}`)
console.log(`Pending: ${pending.length}`)

function saveProgress() {
  writeFileSync(PROGRESS_FILE, JSON.stringify([...completed], null, 0))
}

async function downloadOne(entry: MigrateEntry): Promise<boolean> {
  const fname = caipToFilename(entry.caip)
  const outPath = join(DOWNLOADS, fname)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(entry.url, {
        headers: { 'User-Agent': 'KeepKey-Icon-Migrator/1.0' },
        signal: AbortSignal.timeout(15000),
      })

      if (resp.status === 429) {
        const wait = BASE_DELAY_MS * Math.pow(2, attempt)
        console.warn(`  429 rate-limited on ${entry.source}, waiting ${wait}ms...`)
        await Bun.sleep(wait)
        continue
      }

      if (resp.status >= 500) {
        const wait = BASE_DELAY_MS * Math.pow(2, attempt)
        console.warn(`  ${resp.status} server error on ${entry.source}, retry in ${wait}ms...`)
        await Bun.sleep(wait)
        continue
      }

      if (!resp.ok) {
        console.warn(`  ${resp.status} for ${entry.caip} — skipping`)
        return false
      }

      const buf = await resp.arrayBuffer()
      if (buf.byteLength < 100) {
        console.warn(`  Tiny response (${buf.byteLength}b) for ${entry.caip} — skipping`)
        return false
      }

      await Bun.write(outPath, buf)
      return true
    } catch (err: any) {
      if (attempt < MAX_RETRIES - 1) {
        const wait = BASE_DELAY_MS * Math.pow(2, attempt)
        console.warn(`  Error ${err.message} for ${entry.caip}, retry in ${wait}ms...`)
        await Bun.sleep(wait)
      }
    }
  }
  console.warn(`  FAILED after ${MAX_RETRIES} retries: ${entry.caip}`)
  return false
}

// Group by host for per-host concurrency
const byHost = new Map<string, MigrateEntry[]>()
for (const e of pending) {
  const list = byHost.get(e.source) || []
  list.push(e)
  byHost.set(e.source, list)
}

let totalDone = 0
let totalFailed = 0

async function processHost(host: string, items: MigrateEntry[]) {
  const concurrency = HOST_CONCURRENCY[host] || DEFAULT_CONCURRENCY
  console.log(`\n[${host}] ${items.length} icons, concurrency=${concurrency}`)

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const results = await Promise.allSettled(batch.map(async (entry) => {
      const ok = await downloadOne(entry)
      if (ok) {
        completed.add(entry.caip)
        totalDone++
      } else {
        totalFailed++
      }
    }))

    // Save progress periodically
    if ((i + concurrency) % CHUNK_SIZE < concurrency) {
      saveProgress()
      const pct = ((completed.size / downloadable.length) * 100).toFixed(1)
      console.log(`  [${host}] ${Math.min(i + concurrency, items.length)}/${items.length} | overall ${completed.size}/${downloadable.length} (${pct}%)`)
    }

    // Small delay between batches to be nice
    await Bun.sleep(200)
  }
}

// Process hosts sequentially to avoid global overload
const hosts = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length)
for (const [host, items] of hosts) {
  await processHost(host, items)
}

saveProgress()
console.log(`\n=== Download complete ===`)
console.log(`Success: ${totalDone}`)
console.log(`Failed: ${totalFailed}`)
console.log(`Total completed: ${completed.size}/${downloadable.length}`)
