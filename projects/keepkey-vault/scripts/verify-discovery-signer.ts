import { createHash } from 'node:crypto'
import { utils } from 'ethers'
import { inspectAlphaCertificate } from '../src/bun/clearsign-alpha-ceremony'
import { findCertifiedEvmSchema } from '../src/bun/evm-schema-registry'
import { buildEvmSchemaBody } from '../src/bun/evm-certified-schema'
import { buildTokenSchema } from '../src/bun/evm-token-schema'

const base = 'https://keepkey-clearsign.bithighlander.workers.dev'
const post = (body: unknown) => fetch(`${base}/v1/evm/schema`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
})
const catalog = await (await fetch(`${base}/v1/catalog`)).json() as any
if (catalog.entries.length !== 7 || catalog.discovery?.eligibleTokens !== 7192) throw new Error('Catalog coverage differs')
for (const [chainId, contract, selector, calldataLength] of [
  [1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0x095ea7b3', 68],
  [42161, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0xa9059cbb', 68],
  [42161, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0x23b872dd', 100],
] as const) {
  const response = await post({ chainId, contract, selector, calldataLength, symbol: 'FORGED', decimals: 18 })
  const body = await response.json() as any
  if (response.status !== 200 || body.classification !== 'VERIFIED' || body.keyId !== 128) throw new Error(JSON.stringify(body))
  if (body.tokenIdentity?.symbol !== 'USDC' || body.tokenIdentity?.decimals !== 6) throw new Error('Wrong token identity')
  const bytes = Buffer.from(body.signedPayload.slice(2), 'hex')
  const certificate = inspectAlphaCertificate(bytes.subarray(1, 140).toString('hex'))
  if (bytes[0] !== 3 || certificate.chainId !== chainId) throw new Error('Wrong certified scope')
  const schema = bytes.subarray(140, -65)
  if (!schema.equals(buildEvmSchemaBody(buildTokenSchema(chainId, contract, selector, calldataLength, body.tokenIdentity)))) throw new Error('Schema mismatch')
  const digest = createHash('sha256').update(schema).digest('hex')
  const recovered = utils.computePublicKey(utils.recoverPublicKey(`0x${digest}`, `0x${bytes.subarray(-65).toString('hex')}`), true).slice(2)
  if (recovered !== certificate.delegatePublicKey) throw new Error('Invalid delegate signature')
  const resolved = await findCertifiedEvmSchema(chainId, contract, `${selector}${'00'.repeat(calldataLength - 4)}`)
  if (!resolved || resolved.signedPayload !== body.signedPayload) throw new Error('Vault resolver did not select the certified schema')
  console.log(JSON.stringify({ chainId, contract, selector, method: resolved.method, block: body.tokenIdentity.block, certificateVerified: true, delegateVerified: true, vaultResolved: true }))
}
for (const shape of [
  { chainId: 56, contract: '0x5e0a1d876557cf43c66c08c8a247bc4954eca8bd', selector: '0x095ea7b3', calldataLength: 68 },
  { chainId: 1, contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', selector: '0x095ea7b3', calldataLength: 69 },
]) {
  const response = await post(shape)
  const body = await response.json() as any
  if (response.status !== 422 || body.signedPayload) throw new Error('Invalid shape was signed')
}
const usdt = await findCertifiedEvmSchema(42161, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', `0x095ea7b3${'00'.repeat(64)}`)
if (usdt?.method !== 'approve') throw new Error('Existing USDT coverage regressed')
console.log('PASS: live certified approval, transfer, transferFrom; forged labels ignored; denylist and malformed calls refused; existing USDT preserved')
