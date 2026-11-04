/**
 * Typed-data ERC-7730 definitions: Desktop asks the ClearSign service for one
 * only on firmware 7.17.0+, and attaches it only after checking that its signed
 * header names this document's chain, verifying contract and typeHash.
 *
 * The request is a real 0x Permit2 quote (Base); the definition is the
 * production batch-4 envelope for Permit2 PermitTransferFrom on Base (public
 * data, see the fixture's _source).
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { utils } from 'ethers'
import {
  checkErc7730TypedDataDefinition, eip712TypeHash, erc7730TypedDataKey, forgetRefusedErc7730Definitions,
  resolveErc7730ForTypedData, signWithErc7730Fallback, withErc7730TypedData,
} from './erc7730-resolver'
import fixture from './erc7730-typed-data.fixtures.json'
import calldataFixtures from './erc7730-resolver.fixtures.json'

const { typedData, definition } = fixture
const DEVICE_717 = { firmwareVersion: '7.17.0', capabilities: [1, 4] }
const DEVICE_716 = { firmwareVersion: '7.16.0', capabilities: [1, 4] }
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const TYPEHASH = '0x939c21a48a8dbe3a9a2404a1d46691e4d39f6583d6ec6b35714604c986d80106'

function service(answer: (url: string) => Response) {
  const urls: string[] = []
  const impl = (async (url: any) => { urls.push(String(url)); return answer(String(url)) }) as unknown as typeof fetch
  return { impl, urls }
}
const serves = (body: unknown) => service(() => Response.json(body))
beforeEach(() => forgetRefusedErc7730Definitions())

describe('the fixture', () => {
  it('is the real 0x request: its EIP-712 digest is the one 0x returned', () => {
    const { EIP712Domain: _domain, ...types } = typedData.types
    expect(utils._TypedDataEncoder.hash(typedData.domain, types, typedData.message)).toBe(fixture.zeroXPermit2Hash)
  })

  it('typeHash is keccak256(encodeType), with member structs sorted after the primary type', () => {
    expect(eip712TypeHash(typedData.types, 'PermitTransferFrom')).toBe(TYPEHASH)
    expect(eip712TypeHash(typedData.types, 'PermitTransferFrom'))
      .toBe(utils.keccak256(utils.toUtf8Bytes('PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)')))
    expect(eip712TypeHash(typedData.types, 'Missing')).toBeUndefined()
  })
})

describe('which typed data is looked up', () => {
  it('the domain chain and verifying contract, and the primary typeHash', () => {
    expect(erc7730TypedDataKey(typedData)).toEqual({ chainId: 8453, contract: PERMIT2, typeHash: TYPEHASH })
  })

  it('never PermitSingle (the native Permit2 review), a domain-only signature, or a domain without chain or contract', () => {
    expect(erc7730TypedDataKey({ ...typedData, primaryType: 'PermitSingle' })).toEqual({ reason: 'PermitSingle keeps the native Permit2 review' })
    expect(erc7730TypedDataKey({ ...typedData, primaryType: 'EIP712Domain' })).toEqual({ reason: 'domain-only signature' })
    expect(erc7730TypedDataKey({ ...typedData, domain: { name: 'Permit2', verifyingContract: PERMIT2 } })).toEqual({ reason: 'domain has no chain' })
    expect(erc7730TypedDataKey({ ...typedData, domain: { name: 'Permit2', chainId: 8453 } })).toEqual({ reason: 'domain has no verifying contract' })
  })
})

describe('the firmware gate', () => {
  it('7.16: nothing is requested and nothing attached', async () => {
    const svc = serves(definition)
    expect(await resolveErc7730ForTypedData({ typedData, ...DEVICE_716 }, svc.impl)).toBeUndefined()
    expect(svc.urls).toEqual([])
  })

  it('7.17: the service is asked for this document and its definition is attached', async () => {
    const svc = serves(definition)
    const catalog = await resolveErc7730ForTypedData({ typedData, ...DEVICE_717 }, svc.impl)
    expect(svc.urls).toHaveLength(1)
    expect(svc.urls[0]).toEndWith(`/v1/erc7730/definition?kind=eip712&chainId=8453&contract=${PERMIT2}&typeHash=${TYPEHASH}`)
    expect(catalog).toEqual({
      primaryDefinitionId: definition.definitionId,
      definitions: [{
        definitionId: definition.definitionId, envelope: definition.envelope, kind: 2,
        chainId: 8453, contractAddress: PERMIT2, selectorOrTypeHash: TYPEHASH,
      }],
    })
  })

  it('7.17 without the ERC-7730 capability: nothing requested', async () => {
    const svc = serves(definition)
    expect(await resolveErc7730ForTypedData({ typedData, firmwareVersion: '7.17.0', capabilities: [1] }, svc.impl)).toBeUndefined()
    expect(svc.urls).toEqual([])
  })

  it('withErc7730TypedData leaves the params alone on 7.16 and adds the catalog on 7.17', async () => {
    const params = { addressNList: [0x8000002c, 0x8000003c, 0x80000000, 0, 0], typedData }
    expect(await withErc7730TypedData(params, DEVICE_716, serves(definition).impl)).toBe(params)
    const sent = await withErc7730TypedData(params, DEVICE_717, serves(definition).impl)
    expect(sent.erc7730?.primaryDefinitionId).toBe(definition.definitionId)
    expect(sent.typedData).toBe(typedData)
  })
})

describe('only a definition for exactly this document', () => {
  it('none beside a Permit2 name record (one description per signature)', async () => {
    const svc = serves(definition)
    expect(await resolveErc7730ForTypedData({ typedData, ...DEVICE_717, txMetadata: { signedPayload: '0x00', keyId: 0x80 } }, svc.impl)).toBeUndefined()
    expect(svc.urls).toEqual([])
  })

  it('none for PermitSingle, even on 7.17', async () => {
    const svc = serves(definition)
    expect(await resolveErc7730ForTypedData({ typedData: { ...typedData, primaryType: 'PermitSingle' }, ...DEVICE_717 }, svc.impl)).toBeUndefined()
    expect(svc.urls).toEqual([])
  })

  it('the Base envelope is not attached to the same document on Ethereum', async () => {
    const onEthereum = { ...typedData, domain: { ...typedData.domain, chainId: 1 } }
    expect(await resolveErc7730ForTypedData({ typedData: onEthereum, ...DEVICE_717 }, serves(definition).impl)).toBeUndefined()
    expect(checkErc7730TypedDataDefinition(definition, { chainId: 1, contract: PERMIT2, typeHash: TYPEHASH }))
      .toEqual({ reason: 'envelope chain 8453 is not 1' })
  })

  it('a document whose types hash differently gets no definition', async () => {
    const renamed = { ...typedData, types: { ...typedData.types, TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }] } }
    expect(await resolveErc7730ForTypedData({ typedData: renamed, ...DEVICE_717 }, serves(definition).impl)).toBeUndefined()
  })

  it('a calldata envelope, a mislabelled id, or a service claim that differs is refused', () => {
    const key = { chainId: 8453, contract: PERMIT2, typeHash: TYPEHASH }
    const plain = calldataFixtures.plain.definition
    expect(checkErc7730TypedDataDefinition(plain, key)).toEqual({ reason: 'envelope kind 1 is not EIP-712' })
    expect(checkErc7730TypedDataDefinition({ ...definition, definitionId: `0x${'00'.repeat(32)}` }, key)).toEqual({ reason: 'definition id is not sha256(envelope)' })
    expect(checkErc7730TypedDataDefinition({ ...definition, chainId: 1 }, key)).toEqual({ reason: 'service chain differs' })
    expect(checkErc7730TypedDataDefinition({ ...definition, kind: 'calldata' }, key)).toEqual({ reason: 'service kind is not eip712' })
  })

  it('422, 404, an outage or bad JSON: nothing attached, nothing thrown', async () => {
    for (const answer of [
      () => Response.json({ code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 }),
      () => new Response('', { status: 404 }),
      () => new Response('oops', { status: 500 }),
      () => new Response('not json', { status: 200 }),
      () => { throw new Error('offline') },
    ]) {
      expect(await resolveErc7730ForTypedData({ typedData, ...DEVICE_717 }, service(answer).impl)).toBeUndefined()
    }
  })
})

describe('the device refuses the definition', () => {
  it('signs again without it, and the definition is not offered again this session', async () => {
    const params = await withErc7730TypedData({ addressNList: [0], typedData }, DEVICE_717, serves(definition).impl)
    const sent: any[] = []
    const result = await signWithErc7730Fallback(params, async (p: any) => {
      sent.push(p)
      if (p.erc7730) throw new Error('ERC-7730 domain constraint does not match')
      return { address: '0x', signature: '0x01' }
    })
    expect(result.signature).toBe('0x01')
    expect(sent.map((p) => !!p.erc7730)).toEqual([true, false])
    expect(sent[1].typedData).toBe(typedData)
    expect(await resolveErc7730ForTypedData({ typedData, ...DEVICE_717 }, serves(definition).impl)).toBeUndefined()
  })

  it('a cancel on the device is the answer: no second signature', async () => {
    const params = await withErc7730TypedData({ addressNList: [0], typedData }, DEVICE_717, serves(definition).impl)
    let calls = 0
    await expect(signWithErc7730Fallback(params, async () => { calls++; throw new Error('EIP-712 cancelled') })).rejects.toThrow('cancelled')
    expect(calls).toBe(1)
  })
})
