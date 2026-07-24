/**
 * Build the offline token-icon pack.
 *
 * Selection is CAIP-first: all supported native assets plus every chain
 * variant of a curated CoinGecko asset set. Images are downloaded as bounded
 * raster files, content-hashed for deduplication, and mapped back to exact
 * CAIP-19 ids in a small runtime manifest.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

interface DiscoveryAsset {
  assetId?: string
  icon?: string
  isNative?: boolean
  symbol?: string
}

const projectRoot = resolve(import.meta.dir, '..')
const discoveryRoot = join(projectRoot, 'node_modules/@pioneer-platform/pioneer-discovery/lib')
const catalogPath = join(discoveryRoot, 'assets-top500.json')
const mappingPath = join(discoveryRoot, 'coingecko-mapping.json')
const outputDir = join(projectRoot, 'src/mainview/public/assets/token-icons')
const manifestPath = join(projectRoot, 'src/shared/offlineAssetIcons.json')

// Broad enough to cover the assets users commonly hold or swap, while
// avoiding thousands of obscure/spam-token images in every desktop binary.
const CORE_COINGECKO_IDS = new Set([
  '0x', '1inch', 'aave', 'akash-network', 'algorand', 'ankr', 'apecoin',
  'arbitrum', 'arweave', 'avalanche-2', 'axelar', 'balancer',
  'basic-attention-token', 'bitcoin', 'bitcoin-cash', 'bitcoin-sv',
  'binance-usd', 'binancecoin', 'bittensor', 'blur', 'bonk', 'cardano',
  'celo', 'chainlink', 'compound-governance-token', 'convex-finance',
  'cosmos', 'crv', 'curve-dao-token', 'dai', 'dash', 'decentraland',
  'digibyte', 'dogecoin', 'dogwifcoin', 'dydx-chain', 'echelon-prime',
  'enjincoin', 'ens', 'ethereum', 'ethereum-name-service',
  'ethena', 'ethena-staked-usde', 'ethena-usde', 'ether-fi',
  'ether-fi-staked-eth', 'fetch-ai', 'filecoin', 'first-digital-usd',
  'frax', 'frax-ether', 'gala', 'gemini-dollar', 'gho', 'hedera-hashgraph',
  'hive', 'immutable-x', 'injective-protocol', 'internet-computer',
  'jito-governance-token', 'jito-staked-sol', 'jupiter-exchange-solana',
  'kaspa', 'lido-dao', 'lido-staked-ether', 'litecoin', 'liquity-usd',
  'maker', 'mantle', 'marinade-staked-sol', 'matic-network', 'monero',
  'near', 'near-protocol', 'ondo-finance', 'optimism', 'orca',
  'osmosis', 'pancakeswap-token', 'pax-gold', 'paxos-standard',
  'paypal-usd', 'pepe', 'pendle', 'polkadot', 'polygon-ecosystem-token',
  'pyth-network', 'quant-network', 'raydium', 'render-token', 'ripple',
  'rocket-pool-eth', 'shiba-inu', 'sky', 'solana', 'stacks',
  'stellar', 'stepn', 'staked-frax-ether', 'sui', 'sushi',
  'synthetix-network-token', 'tether', 'tether-gold', 'tezos',
  'the-graph', 'the-sandbox', 'thorchain', 'toncoin', 'tron', 'true-usd',
  'uniswap', 'usd-coin', 'usdd', 'usds', 'vechain', 'woo-network',
  'worldcoin-wld', 'wormhole', 'wrapped-bitcoin', 'wrapped-eeth',
  'wrapped-solana', 'wrapped-steth', 'yearn-finance', 'zcash',
])

// Canonical assets whose catalog mapping has historically changed names.
const ALWAYS_INCLUDE_CAIPS = new Set([
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
])

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}
const MAX_ICON_BYTES = 768 * 1024
const CONCURRENCY = 8

async function downloadIcon(url: string): Promise<{ bytes: Uint8Array; extension: string }> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'KeepKey-Vault-Asset-Vendor/1.0' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const extension = MIME_EXTENSIONS[mime]
      if (!extension) throw new Error(`unsupported content type ${mime || 'unknown'}`)
      const declaredSize = Number(response.headers.get('content-length') || 0)
      if (declaredSize > MAX_ICON_BYTES) throw new Error(`file is ${declaredSize} bytes`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
        throw new Error(`file is ${bytes.length} bytes`)
      }
      return { bytes, extension }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as Record<string, DiscoveryAsset>
const coingeckoMapping = JSON.parse(await readFile(mappingPath, 'utf8')) as Record<string, string>
const fallbackIconByCoingeckoId = new Map<string, string>()
for (const [key, asset] of Object.entries(catalog)) {
  const caip = asset.assetId || key
  const coingeckoId = coingeckoMapping[caip]
  if (coingeckoId && asset.icon && !fallbackIconByCoingeckoId.has(coingeckoId)) {
    fallbackIconByCoingeckoId.set(coingeckoId, asset.icon)
  }
}
const selected = Object.entries(catalog)
  .filter(([key, asset]) => {
    const caip = asset.assetId || key
    const coingeckoId = coingeckoMapping[caip]
    return !!(asset.icon || (coingeckoId && fallbackIconByCoingeckoId.has(coingeckoId))) && (
      asset.isNative === true
      || !caip.startsWith('eip155:')
      || ALWAYS_INCLUDE_CAIPS.has(caip)
      || CORE_COINGECKO_IDS.has(coingeckoId)
    )
  })
  .map(([key, asset]) => {
    const caip = asset.assetId || key
    return {
      caip,
      url: asset.icon || fallbackIconByCoingeckoId.get(coingeckoMapping[caip])!,
    }
  })

for (const caip of ALWAYS_INCLUDE_CAIPS) {
  if (selected.some(item => item.caip === caip)) continue
  const fallbackUrl = fallbackIconByCoingeckoId.get(coingeckoMapping[caip])
  if (fallbackUrl) selected.push({ caip, url: fallbackUrl })
}
selected.sort((a, b) => a.caip.localeCompare(b.caip))

await mkdir(outputDir, { recursive: true })
await mkdir(dirname(manifestPath), { recursive: true })
const previousManifest = await readFile(manifestPath, 'utf8')
  .then(value => JSON.parse(value) as Record<string, string>)
  .catch(() => ({}))

const urlPromises = new Map<string, Promise<string>>()
const failures: Array<{ caip: string; reason: string }> = []
let priorFilesRetained = 0
let cursor = 0

async function storeUrl(url: string): Promise<string> {
  const existing = urlPromises.get(url)
  if (existing) return existing
  const promise = (async () => {
    const { bytes, extension } = await downloadIcon(url)
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
    const filename = `${hash}${extension}`
    await writeFile(join(outputDir, filename), bytes)
    return filename
  })()
  urlPromises.set(url, promise)
  return promise
}

const manifestEntries: Array<[string, string]> = []
async function worker(): Promise<void> {
  while (true) {
    const index = cursor++
    if (index >= selected.length) return
    const item = selected[index]
    try {
      manifestEntries.push([item.caip, await storeUrl(item.url)])
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const priorFilename = previousManifest[item.caip]
      const priorExists = priorFilename
        ? await stat(join(outputDir, priorFilename)).then(value => value.isFile()).catch(() => false)
        : false
      if (priorFilename && priorExists) {
        manifestEntries.push([item.caip, priorFilename])
        priorFilesRetained++
      }
      failures.push({ caip: item.caip, reason: `${reason}${priorExists ? ' (kept prior file)' : ''}` })
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

manifestEntries.sort(([a], [b]) => a.localeCompare(b))
const manifest = Object.fromEntries(manifestEntries)
const uniqueFiles = new Set(Object.values(manifest))
const criticalMissing = [...ALWAYS_INCLUDE_CAIPS].filter(caip => !manifest[caip])
// Transactional guard: a network outage must never replace a working offline
// pack with an empty manifest or prune its files.
if (criticalMissing.length) {
  throw new Error(`Critical offline icons missing: ${criticalMissing.join(', ')}`)
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
let staleFilesRemoved = 0
for (const filename of await readdir(outputDir)) {
  if (!/^[a-f0-9]{24}\.(?:png|jpg|webp|gif)$/.test(filename)) continue
  if (uniqueFiles.has(filename)) continue
  await unlink(join(outputDir, filename))
  staleFilesRemoved++
}
console.log(`[vendor-asset-icons] ${Object.keys(manifest).length}/${selected.length} CAIPs, ${uniqueFiles.size} deduplicated files${priorFilesRetained ? `, ${priorFilesRetained} prior files retained` : ''}${staleFilesRemoved ? `, ${staleFilesRemoved} stale files removed` : ''}`)
if (failures.length) {
  console.warn(`[vendor-asset-icons] ${failures.length} downloads skipped`)
  for (const failure of failures.slice(0, 12)) console.warn(`  ${failure.caip}: ${failure.reason}`)
}
