/** Read-only Relay coverage audit. Uses public catalog entries and bundled
 * unsigned Solana fixtures. Does not request review, sign, or broadcast.
 * bun scripts/audit-relay-clearsign.ts [output.json]
 */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { PRODUCTION_ROOT_PUBLIC_KEY } from '../src/bun/clearsign-alpha-ceremony'
import { buildEvmSchemaBody, certifiedEvmEnvelopeVerifies, findCertifiedEvmSchemaByShape } from '../src/bun/evm-certified-schema'

const base = 'https://keepkey-clearsign.bithighlander.workers.dev'
const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const router = '0x0729e2a4716d9f7dd17858d5d504426d228697f7'
const tycho = '0x1644d2477f809cc2c71bccfd6dc9497e3f83210d'
const usdt = '0xdac17f958d2ee523a2206206994597c13d831ec7'

async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  return { status: response.status, body: await response.json() as any }
}

const status = await request('/v1/status')
const catalog = await request('/v1/catalog')
if (status.status !== 200 || catalog.status !== 200 || !Array.isArray(catalog.body.entries)) throw new Error('ClearSign catalog/status unavailable')
const entries = catalog.body.entries.filter((entry: any) => entry.contract?.toLowerCase() === depository || entry.id === 'solana:relayDepositNative' || entry.id === 'solana:relayDepositToken')
const probes: Record<string, any>[] = []

async function schema(name: string, shape: Record<string, unknown>) {
  const result = await request('/v1/evm/schema', shape)
  const body = result.body
  const spec = findCertifiedEvmSchemaByShape(Number(shape.chainId), String(shape.contract), String(shape.selector), Number(shape.calldataLength), undefined, shape.token as string | undefined)
  const bytes = typeof body.signedPayload === 'string' ? Buffer.from(body.signedPayload.replace(/^0x/i, ''), 'hex') : undefined
  probes.push({
    name, request: shape, httpStatus: result.status, classification: body.classification, code: body.code,
    signed: !!bytes,
    ...(bytes ? {
      verifiesToPinnedProductionRoot: certifiedEvmEnvelopeVerifies(body.signedPayload, PRODUCTION_ROOT_PUBLIC_KEY),
      matchesVaultBody: !!spec && bytes.subarray(140, -65).equals(buildEvmSchemaBody(spec) as Uint8Array),
      envelopeSha256: createHash('sha256').update(bytes).digest('hex'),
    } : {}),
  })
}

// Every advertised Relay EVM entry must be retrievable and verify locally.
for (const entry of entries.filter((entry: any) => entry.family === 'evm')) {
  await schema(entry.id, {
    chainId: entry.chainId, contract: entry.contract, selector: entry.selector, calldataLength: entry.calldataLength,
    ...(entry.pinned?.[0] ? { token: entry.pinned[0] } : {}),
  })
}
// The host's Relay depository recognizer lists these chains, but the signed
// native-deposit catalog currently has no entry for them.
for (const chainId of [10, 56, 137, 43114]) {
  await schema(`native-deposit-chain-${chainId}`, { chainId, contract: depository, selector: '0x49290c1c', calldataLength: 68 })
}
await schema('ethereum-usdt-deposit', { chainId: 1, contract: depository, selector: '0xe8017952', calldataLength: 132, token: usdt })
await schema('relay-v3.2-multicall', { chainId: 1, contract: router, selector: '0xcd6e13f7', calldataLength: 2180 })
await schema('wrong-deposit-length', { chainId: 8453, contract: depository, selector: '0x49290c1c', calldataLength: 100 })
await schema('wrong-deposit-contract', { chainId: 8453, contract: router, selector: '0x49290c1c', calldataLength: 68 })

for (const [name, contract, selector] of [
  ['relay-v3.2-multicall-erc7730', router, '0xcd6e13f7'],
  ['relay-cleanup-native-erc7730', router, '0xa6bd8c96'],
  ['relay-cleanup-erc20-erc7730', router, '0x9bb43718'],
  ['tycho-sequential-swap-erc7730', tycho, '0x3c226834'],
]) {
  const q = new URLSearchParams({ kind: 'calldata', chainId: '1', contract, selector })
  const result = await request(`/v1/erc7730/definition?${q}`)
  probes.push({ name, contract, selector, httpStatus: result.status, classification: result.body.classification, code: result.body.code })
}

for (const name of ['relay-deposit-native-no-alt', 'relay-deposit-native-alt']) {
  const fixture = await Bun.file(resolve(import.meta.dir, `../__tests__/fixtures/solana/${name}.json`)).json()
  const result = await request('/v1/solana/certify', { rawTx: fixture.rawTxBase64, catalogKey: 'relayDepositNative' })
  probes.push({ name, fixture: `${name}.json`, httpStatus: result.status, classification: result.body.classification, code: result.body.code })
}

const report = {
  checkedAt: new Date().toISOString(), service: base,
  safety: 'Read-only lookups with public entries and bundled unsigned fixtures. No review jobs queued, keys accessed, transactions signed, or funds broadcast.',
  productionRoot: PRODUCTION_ROOT_PUBLIC_KEY,
  build: status.body.build, erc7730: status.body.erc7730,
  relayCatalogEntries: entries,
  probes,
  signatureFailures: probes.filter(probe => probe.signed && (!probe.verifiesToPinnedProductionRoot || !probe.matchesVaultBody)).map(probe => probe.name),
}
const output = process.argv[2] || '/private/tmp/relay-clearsign-live-audit.json'
await Bun.write(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ output, catalogEntries: entries.length, probes: probes.length, signatureFailures: report.signatureFailures }, null, 2))
if (report.signatureFailures.length) process.exitCode = 1
