import manifest from '@pioneer-platform/pioneer-discovery/signatures/manifest'
import tokenSignatures from '@pioneer-platform/pioneer-discovery/signatures/tokens'
import cosmosSignatures from '@pioneer-platform/pioneer-discovery/signatures/cosmos'
import evmSignatures from '@pioneer-platform/pioneer-discovery/descriptors/signed-blobs'
import { verifyPioneerSignatures } from '../src/bun/pioneer-signature-verifier'

const verified = verifyPioneerSignatures(manifest.publicKey, [
  { kind: 'token-metadata', source: tokenSignatures, declared: manifest.files['signatures/token-signatures.json'].count },
  { kind: 'cosmos-msg-types', source: cosmosSignatures, declared: manifest.files['signatures/cosmos-signatures.json'].count },
  { kind: 'evm-selector-blobs', source: evmSignatures, declared: manifest.files['descriptors/evm-signed-blobs.json'].count },
])
console.log(JSON.stringify({ manifestVersion: manifest.version, publicKey: manifest.publicKey,
  generated: manifest.generated, total: verified.total, results: verified.results }, null, 2))
