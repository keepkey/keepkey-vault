import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { utils } from 'ethers'
import { trustTestRoot } from '../../__tests__/support/clearsign-test-root'
import { describeErc7730TypedData, planErc7730TypedEmbeddedCalls } from './erc7730-describe'
import { resolveErc7730ForTypedData } from './erc7730-resolver'
import fixture from './erc7730-safe.fixtures.json'
import { decodeEIP712 } from './eip712-decoder'
import { assessSigningRisk } from '../shared/clearsign-risk'
import { withoutErc7730Description } from './evm-presign-report'
import type { SigningRequestInfo } from '../shared/types'

let restore: () => void
beforeAll(() => { restore = trustTestRoot(fixture.testRootPubkey) })
afterAll(() => restore())
const device = { firmwareVersion: '7.17.0', capabilities: [4, 28] }
const owner = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
const outer = fixture.definitions[0]
const service = (missing = false) => {
  const urls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url))
    const q = new URL(String(url)).searchParams
    const hit = fixture.definitions.find((d) => d.chainId === Number(q.get('chainId'))
      && d.contractAddress === q.get('contract') && d.selectorOrTypeHash === (q.get('typeHash') ?? q.get('selector'))
      && !(missing && d.kind === 1))
    return hit ? Response.json(hit) : new Response(null, { status: 404 })
  }) as typeof fetch
  return { urls, fetchImpl }
}

function batch(count = 2, operation = 0) {
  const doc = structuredClone(fixture.typedData)
  const entry = utils.hexConcat([utils.hexZeroPad(utils.hexlify(operation), 1), doc.message.to,
    utils.hexZeroPad('0x00', 32), utils.hexZeroPad(utils.hexlify(utils.arrayify(doc.message.data).length), 32), doc.message.data])
  const payload = utils.hexConcat(Array.from({ length: count }, () => entry))
  doc.message.to = '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761'
  doc.message.operation = 1
  doc.message.data = '0x8d80ff0a' + utils.defaultAbiCoder.encode(['bytes'], [payload]).slice(2)
  return doc
}

describe('Safe owner approvals with authenticated inner definitions', () => {
  test('attaches the exact Safe and inner definitions and describes the device fields', async () => {
    const s = service()
    const catalog = await resolveErc7730ForTypedData({ ...device, typedData: fixture.typedData }, s.fetchImpl)
    expect(catalog?.definitions).toHaveLength(2)
    expect(s.urls).toHaveLength(2)
    const description = describeErc7730TypedData(outer.envelope, fixture.typedData, '7.17.0', owner, catalog?.definitions)
    expect(description?.fields.some((f) => f.label === 'Amount' && f.value === '1.5 USDC')).toBe(true)
  })

  test('older firmware does not fetch Safe metadata', async () => {
    const s = service()
    expect(await resolveErc7730ForTypedData({ ...device, capabilities: [4], typedData: fixture.typedData }, s.fetchImpl)).toBeUndefined()
    expect(s.urls).toHaveLength(0)
  })

  test('missing or tampered inner metadata is not attached', async () => {
    expect(await resolveErc7730ForTypedData({ ...device, typedData: fixture.typedData }, service(true).fetchImpl)).toBeUndefined()
    const corrupted = (async (url: string | URL) => {
      const response = await service().fetchImpl(url)
      const d = await response.json() as any
      if (d.kind === 1) d.envelope = d.envelope.slice(0, -4) + '0000'
      return Response.json(d)
    }) as typeof fetch
    expect(await resolveErc7730ForTypedData({ ...device, typedData: fixture.typedData }, corrupted)).toBeUndefined()
  })

  test('every MultiSend call is described, with one definition lookup per target', async () => {
    const doc = batch(8)
    const s = service()
    const catalog = await resolveErc7730ForTypedData({ ...device, typedData: doc }, s.fetchImpl)
    expect(catalog?.definitions).toHaveLength(2)
    expect(s.urls).toHaveLength(2)
    const d = describeErc7730TypedData(outer.envelope, doc, '7.17.0', owner, catalog?.definitions)
    expect(d?.fields.filter((f) => f.label === 'Amount' && f.value === '1.5 USDC')).toHaveLength(8)
  })

  test('nested metadata returns to the batch and describes its following call', async () => {
    const doc = structuredClone(fixture.typedData)
    const token = doc.message.to
    const transfer = doc.message.data
    const forwarder = '0x3333333333333333333333333333333333333333'
    const forward = new utils.Interface(['function forward(address target,bytes data)'])
      .encodeFunctionData('forward', [token, transfer])
    const pack = (to: string, data: string) => utils.hexConcat(['0x00', to, utils.hexZeroPad('0x00', 32),
      utils.hexZeroPad(utils.hexlify(utils.arrayify(data).length), 32), data])
    doc.message.to = '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761'
    doc.message.operation = 1
    doc.message.data = '0x8d80ff0a' + utils.defaultAbiCoder.encode(['bytes'], [utils.hexConcat([
      pack(forwarder, forward), pack(token, transfer),
    ])]).slice(2)
    const catalog = await resolveErc7730ForTypedData({ ...device, typedData: doc }, service().fetchImpl)
    expect(catalog?.definitions).toHaveLength(3)
    const d = describeErc7730TypedData(outer.envelope, doc, '7.17.0', owner, catalog?.definitions)
    expect(d?.fields.filter((f) => f.label === 'Amount' && f.value === '1.5 USDC')).toHaveLength(2)
  })

  test('delegatecalls, unknown MultiSend targets and malformed batches are refused in preflight', () => {
    const docs = [batch(2, 1), batch(), batch(), batch(65)]
    docs[1].message.to = '0x9999999999999999999999999999999999999999'
    docs[2].message.data = docs[2].message.data.slice(0, -2)
    for (const doc of docs) expect(planErc7730TypedEmbeddedCalls(outer.envelope, doc, fixture.definitions).refused).toBeDefined()
  })

  test('a Safe deployment or schema substitution gets no metadata', async () => {
    const other = structuredClone(fixture.typedData)
    other.domain.verifyingContract = owner
    expect(await resolveErc7730ForTypedData({ ...device, typedData: other }, service().fetchImpl)).toBeUndefined()
    other.domain.verifyingContract = fixture.typedData.domain.verifyingContract
    other.types.SafeTx[3].type = 'uint256'
    expect(await resolveErc7730ForTypedData({ ...device, typedData: other }, service().fetchImpl)).toBeUndefined()
  })

  test('the card describes device review, and restores the raw-data explanation after refusal', async () => {
    const catalog = await resolveErc7730ForTypedData({ ...device, typedData: fixture.typedData }, service().fetchImpl)
    const info: SigningRequestInfo = {
      id: 'safe', method: '/eth/sign-typed-data', appName: 'Safe', chain: 'eth', chainId: 1,
      from: owner, firmwareVersion: '7.17.0', typedDataDecoded: decodeEIP712(fixture.typedData),
      erc7730: catalog, erc7730Description: describeErc7730TypedData(outer.envelope, fixture.typedData, '7.17.0', owner, catalog?.definitions),
    }
    const text = (req: SigningRequestInfo) => assessSigningRisk(req)?.reasons.map((r) => r.text).join('\n') ?? ''
    expect(text(info)).toContain('verify signed ClearSign definitions')
    expect(text(info)).not.toContain('only as raw hex')
    expect(text(withoutErc7730Description(info))).toContain('only as raw hex')
  })
})
