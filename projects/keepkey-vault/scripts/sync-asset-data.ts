/**
 * Add every asset the installed pioneer-discovery catalogs to
 * src/shared/assetData.json, in its slim form (see shared/assetLookup.ts).
 *
 * Additive only — entries already in the bundle keep their local overrides.
 * Run `make sync-asset-data` after bumping @pioneer-platform/pioneer-discovery;
 * __tests__/asset-catalog-sync.test.ts fails until you do.
 */
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '..')
const discoveryPath = join(projectRoot, 'node_modules/@pioneer-platform/pioneer-discovery/lib/generatedAssetData.json')
const bundlePath = join(projectRoot, 'src/shared/assetData.json')

const discovery: Record<string, any> = await Bun.file(discoveryPath).json()
const bundle: Record<string, any> = await Bun.file(bundlePath).json()

let added = 0
for (const [caip, entry] of Object.entries(discovery)) {
  if (caip in bundle) continue
  const { assetId, chainId, icon, ...slim } = entry
  // Same derivation as caipToIcon(): only a non-derivable icon is stored.
  if (icon && icon !== `https://api.keepkey.info/coins/${btoa(caip).replace(/=+$/, '')}.png`) slim.icon = icon
  bundle[caip] = slim
  added++
}

await Bun.write(bundlePath, JSON.stringify(bundle))
console.log(`assetData.json: +${added} from pioneer-discovery, ${Object.keys(bundle).length} total`)
