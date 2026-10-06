import { createHash } from 'node:crypto'
import { ECOSYSTEM_INVENTORY_POLICY_VERSION, inventoryDiscovery } from '../src/bun/clearsign-ecosystem-inventory'
import { verifyPioneerSignatures } from '../src/bun/pioneer-signature-verifier'
import manifest from '@pioneer-platform/pioneer-discovery/signatures/manifest'
import tokenSignatures from '@pioneer-platform/pioneer-discovery/signatures/tokens'
import cosmosSignatures from '@pioneer-platform/pioneer-discovery/signatures/cosmos'
import evmSignatures from '@pioneer-platform/pioneer-discovery/descriptors/signed-blobs'

const [assetsPath, denylistPath, snapshotPath, catalogPath, outputDirectory] = process.argv.slice(2)
if (!outputDirectory) throw new Error('Usage: assets.json denylist.json snapshot.json live-catalog.json output-directory')
const sources = await Promise.all([assetsPath, denylistPath, snapshotPath, catalogPath].map(async path => {
  const text = await Bun.file(path).text()
  return { path, sha256: createHash('sha256').update(text).digest('hex'), data: JSON.parse(text) }
}))
const [assets, denylist, snapshot, catalog] = sources.map(source => source.data)
if (sources[0].sha256 !== snapshot.source.assetsSha256 || sources[1].sha256 !== snapshot.source.denylistSha256) {
  throw new Error('Snapshot does not match the inventory sources; regenerate before reporting coverage')
}
const inventory = inventoryDiscovery({ assets, denied: Object.keys(denylist.assets), tokens: snapshot.tokens,
  rpcChains: Object.keys(snapshot.rpc), certificateChains: catalog.discovery.certificateChainIds })
const signedProvenance = verifyPioneerSignatures(manifest.publicKey, [
  { kind: 'token-metadata', source: tokenSignatures, declared: manifest.files['signatures/token-signatures.json'].count },
  { kind: 'cosmos-msg-types', source: cosmosSignatures, declared: manifest.files['signatures/cosmos-signatures.json'].count },
  { kind: 'evm-selector-blobs', source: evmSignatures, declared: manifest.files['descriptors/evm-signed-blobs.json'].count },
])
const inventoryHash = createHash('sha256').update(JSON.stringify({
  policyVersion: ECOSYSTEM_INVENTORY_POLICY_VERSION,
  sourceHashes: sources.map(source => source.sha256),
  signedProvenance,
  rows: inventory.rows,
})).digest('hex')
await Bun.write(`${outputDirectory}/assets.jsonl`, inventory.rows.map(row => JSON.stringify(row)).join('\n') + '\n')
const summary = { version: 2, policyVersion: ECOSYSTEM_INVENTORY_POLICY_VERSION, inventoryHash,
  generatedAt: new Date().toISOString(), sources: sources.map(({ path, sha256 }) => ({ path, sha256 })),
  signedProvenance,
  ...inventory.summary,
  note: 'Eligibility is not device verification or approval of contract behavior. Every source entry is accounted for; blockers may overlap.' }
await Bun.write(`${outputDirectory}/summary.json`, JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
