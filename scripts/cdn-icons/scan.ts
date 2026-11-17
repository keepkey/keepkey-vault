/**
 * scan.ts — Find catalog assets whose CDN logo is missing (403/404).
 *
 * Mirrors caipToIcon() in projects/keepkey-vault/src/shared/assetLookup.ts:
 * assets with a bundled icon (LOCAL_ICONS, offlineAssetIcons.json) or an
 * explicit `icon` in assetData.json never hit the CDN, so they are skipped.
 * Everything else is probed with HEAD on the CDN object
 * coins/{btoa(caip) without padding}.png — the same key api.keepkey.info
 * redirects to.
 *
 * Usage:
 *   node scripts/cdn-icons/scan.ts                 # full catalog
 *   node scripts/cdn-icons/scan.ts --sample 300    # random sample (audit re-run)
 *   node scripts/cdn-icons/scan.ts --from scripts/cdn-icons/missing.json
 *                                                  # re-check a previous list
 *
 * Writes scripts/cdn-icons/missing.json (full / --from runs) and exits 1 when
 * anything is missing, so it doubles as the "0 failures" check.
 * No credentials needed.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DIR = import.meta.dirname
const ROOT = resolve(DIR, '../..')
const SHARED = join(ROOT, 'projects/keepkey-vault/src/shared')
const CDN = 'https://keepkey.sfo3.cdn.digitaloceanspaces.com'
const CONCURRENCY = 24

// Keep in sync with assetLookup.ts (LOCAL_ICONS keys and ICON_CAIP_ALIASES).
const LOCAL_ICON_CAIPS = new Set([
  'bip122:000000000019d6689c085ae165831e93/slip44:0',
  'eip155:8453/slip44:60',
  'bip122:00040fe8ec8471911baa1db1266ea15d/orchard:shielded',
  'monero:418015bb9ae982a1975da7d79277c270/slip44:128',
])
const ICON_CAIP_ALIASES: Record<string, string> = {
  'eip155:999/slip44:60': 'eip155:2868/slip44:60',
}

export function cdnKey(caip: string): string {
  const cdnCaip = ICON_CAIP_ALIASES[caip] || caip
  return `coins/${Buffer.from(cdnCaip, 'latin1').toString('base64').replace(/=+$/, '')}.png`
}

export interface MissingAsset {
  caip: string
  symbol: string
  name: string
  key: string
  status: number
}

interface AssetData { symbol?: string; name?: string; icon?: string }

function cdnBoundAssets(): MissingAsset[] {
  const data: Record<string, AssetData> = JSON.parse(readFileSync(join(SHARED, 'assetData.json'), 'utf8'))
  const offline: Record<string, string> = JSON.parse(readFileSync(join(SHARED, 'offlineAssetIcons.json'), 'utf8'))
  const out: MissingAsset[] = []
  for (const [caip, a] of Object.entries(data)) {
    if (a.icon || LOCAL_ICON_CAIPS.has(caip)) continue
    const norm = caip.startsWith('eip155:') ? caip.toLowerCase() : caip
    if (offline[norm] || offline[norm.replace('/spl:', '/token:')]) continue
    out.push({ caip, symbol: a.symbol || '', name: a.name || '', key: cdnKey(caip), status: 0 })
  }
  return out
}

async function head(key: string): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${CDN}/${key}`, { method: 'HEAD', signal: AbortSignal.timeout(15_000) })
      if (r.status < 500 && r.status !== 429) return r.status
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 1000 * (attempt + 1)))
  }
  return 0
}

async function main() {
  const args = process.argv.slice(2)
  const sampleIdx = args.indexOf('--sample')
  const fromIdx = args.indexOf('--from')

  let assets: MissingAsset[]
  if (fromIdx >= 0) {
    assets = JSON.parse(readFileSync(resolve(args[fromIdx + 1]), 'utf8'))
  } else {
    assets = cdnBoundAssets()
    if (sampleIdx >= 0) {
      const n = Number(args[sampleIdx + 1] || 300)
      assets = assets.map(a => [Math.random(), a] as const).sort((x, y) => x[0] - y[0]).slice(0, n).map(x => x[1])
    }
  }
  console.error(`Probing ${assets.length} CDN objects...`)

  let next = 0, done = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < assets.length) {
      const a = assets[next++]
      a.status = await head(a.key)
      if (++done % 1000 === 0) console.error(`  ${done}/${assets.length}`)
    }
  }))

  const missing = assets.filter(a => a.status !== 200)
  const byStatus: Record<number, number> = {}
  for (const a of missing) byStatus[a.status] = (byStatus[a.status] || 0) + 1
  console.log(`checked=${assets.length} ok=${assets.length - missing.length} missing=${missing.length} ${JSON.stringify(byStatus)}`)

  if (sampleIdx < 0) {
    missing.sort((a, b) => a.caip.localeCompare(b.caip))
    writeFileSync(join(DIR, 'missing.json'), JSON.stringify(missing, null, 1) + '\n')
    console.error(`Wrote ${join(DIR, 'missing.json')}`)
  } else {
    for (const a of missing) console.log(`  ${a.status} ${a.symbol}\t${a.caip}`)
  }
  process.exitCode = missing.length ? 1 : 0
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) await main()
