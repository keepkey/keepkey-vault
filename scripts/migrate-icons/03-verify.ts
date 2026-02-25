/**
 * 03-verify.ts — Verify all icons exist in S3 and update assetData.json
 *
 * For every entry in icons-to-migrate.json:
 *   1. Check if the canonical keepkey.info URL exists (HEAD request)
 *   2. Report pass/fail
 *   3. If all pass, regenerate assetData.json stripping ALL icon fields
 *
 * Usage: bun run scripts/migrate-icons/03-verify.ts
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const DIR = import.meta.dir
const MIGRATE_FILE = join(DIR, 'icons-to-migrate.json')
const ASSET_DATA_SRC = join(DIR, '..', '..', '..', 'pioneer', 'modules', 'pioneer', 'pioneer-discovery', 'src', 'generatedAssetData.json')
const ASSET_DATA_OUT = join(DIR, '..', '..', 'projects', 'keepkey-vault', 'src', 'shared', 'assetData.json')

const CONCURRENCY = 20
const BASE_URL = 'https://api.keepkey.info/coins'

interface MigrateEntry {
  caip: string
  source: string
  url: string
}

function caipToIconUrl(caip: string): string {
  return `${BASE_URL}/${Buffer.from(caip).toString('base64').replace(/=+$/, '')}.png`
}

const entries: MigrateEntry[] = JSON.parse(readFileSync(MIGRATE_FILE, 'utf-8'))
const withUrl = entries.filter(e => e.url && e.source !== '(empty)' && e.source !== 'unknown')

console.log(`Verifying ${withUrl.length} icons exist at keepkey.info...`)

let passCount = 0
let failCount = 0
const failures: { caip: string; url: string; status: number }[] = []

for (let i = 0; i < withUrl.length; i += CONCURRENCY) {
  const batch = withUrl.slice(i, i + CONCURRENCY)

  await Promise.allSettled(batch.map(async (entry) => {
    const url = caipToIconUrl(entry.caip)
    try {
      const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
      if (resp.status === 200) {
        passCount++
      } else {
        failCount++
        failures.push({ caip: entry.caip, url, status: resp.status })
      }
    } catch (err: any) {
      failCount++
      failures.push({ caip: entry.caip, url, status: 0 })
    }
  }))

  if ((i + CONCURRENCY) % 200 < CONCURRENCY) {
    const total = passCount + failCount
    console.log(`  ${total}/${withUrl.length} checked (${passCount} pass, ${failCount} fail)`)
  }

  await Bun.sleep(50)
}

console.log(`\n=== Verification ===`)
console.log(`Pass: ${passCount}/${withUrl.length}`)
console.log(`Fail: ${failCount}/${withUrl.length}`)

if (failures.length > 0) {
  const failFile = join(DIR, 'verify-failures.json')
  writeFileSync(failFile, JSON.stringify(failures, null, 2))
  console.log(`\nFailures written to: ${failFile}`)
  console.log(`First 10:`)
  for (const f of failures.slice(0, 10)) {
    console.log(`  ${f.caip} → ${f.status}`)
  }
}

if (failCount === 0) {
  console.log(`\nAll icons verified! Regenerating assetData.json with ALL icons stripped...`)

  // Re-read original and strip everything derivable
  const original = JSON.parse(readFileSync(ASSET_DATA_SRC, 'utf-8'))
  const slim: Record<string, any> = {}

  for (const [caip, entry] of Object.entries(original) as [string, any][]) {
    const chainId = entry.chainId || ''
    if (chainId.startsWith('solana:')) continue

    const out: any = {}
    for (const [k, v] of Object.entries(entry)) {
      if (k === 'assetId' || k === 'icon' || k === 'chainId') continue
      out[k] = v
    }
    slim[caip] = out
  }

  const compact = JSON.stringify(slim)
  writeFileSync(ASSET_DATA_OUT, compact)
  console.log(`Written: ${ASSET_DATA_OUT}`)
  console.log(`Size: ${(compact.length / 1024 / 1024).toFixed(2)} MB (all icons now derivable!)`)
} else {
  console.log(`\n${failCount} icons still missing — fix those before regenerating.`)
}
