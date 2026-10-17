import { beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  checkErc7730CalldataDefinition, erc7730CatalogDescribesCall, fetchErc7730CalldataDefinition, forgetRefusedErc7730Definitions, isErc7730Refusal,
  programHasEmbeddedCall, readErc7730Envelope, resolveErc7730ForCall, signWithErc7730Fallback,
} from './erc7730-resolver'
import { firmwareClearSigns } from './calldata-decoder'
// Two registry fixtures signed under a TEST root (public data, no keys): the
// sAVAX submit() program, and Safe createProxyWithNonce, which has an embedded call.
import fixtures from './erc7730-resolver.fixtures.json'

const plain = fixtures.plain
const embedded = fixtures.embedded
const GATE = { firmwareVersion: '7.16.0', capabilities: [1, 4] }

/** A fetch that answers every request with `answer` and records the URLs. */
function service(answer: () => Response) {
  const urls: string[] = []
  const impl = (async (url: any) => { urls.push(String(url)); return answer() }) as unknown as typeof fetch
  return { impl, urls }
}
const ok = (body: unknown) => () => Response.json(body)
beforeEach(() => forgetRefusedErc7730Definitions())

/** The same envelope with its program's section count changed, re-identified. */
const bytesOf = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))

function withSectionCount(envelopeHex: string, count: number) {
  const bytes = bytesOf(envelopeHex)
  bytes[10 + 178] = count
  return { envelope: Buffer.from(bytes).toString('hex'), definitionId: createHash('sha256').update(bytes).digest('hex') }
}

describe('ERC-7730 envelope header', () => {
  it('reads kind, chain, contract and selector from the program header', () => {
    const header = readErc7730Envelope(bytesOf(plain.definition.envelope))!
    expect(header.kind).toBe(1)
    expect(header.chainId).toBe(43114n)
    expect(header.contract).toBe(plain.tx.to)
    expect(header.selectorOrTypeHash).toBe(`0x5bcb2fc6${'0'.repeat(56)}`)
    expect(header.embeddedCall).toBe(false)
  })

  it('finds the embedded-call formatter in the program bytes', () => {
    expect(readErc7730Envelope(bytesOf(embedded.definition.envelope))!.embeddedCall).toBe(true)
    const bytes = bytesOf(plain.definition.envelope)
    const length = Buffer.from(bytes).readUInt32BE(6)
    expect(programHasEmbeddedCall(bytes.subarray(10, 10 + length))).toBe(false)
  })

  it('cannot tell when the sections do not parse', () => {
    const broken = withSectionCount(plain.definition.envelope, 255)
    expect(readErc7730Envelope(bytesOf(broken.envelope))!.embeddedCall).toBeUndefined()
  })

  it('is not an envelope without the K773 and C773 magic', () => {
    const bytes = bytesOf(plain.definition.envelope)
    bytes[0] = 0
    expect(readErc7730Envelope(bytes)).toBeUndefined()
  })
})

describe('fetchErc7730CalldataDefinition', () => {
  it('asks the ClearSign service by chain, contract and selector, and checks the answer', async () => {
    const { impl, urls } = service(ok(plain.definition))
    const catalog = await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, impl)
    expect(urls).toEqual([
      `https://keepkey-clearsign.bithighlander.workers.dev/v1/erc7730/definition?kind=calldata&chainId=43114&contract=${plain.tx.to}&selector=0x5bcb2fc6`,
    ])
    expect(catalog).toEqual({
      primaryDefinitionId: `0x${plain.definition.definitionId}`,
      definitions: [{
        definitionId: `0x${plain.definition.definitionId}`,
        envelope: `0x${plain.definition.envelope}`,
        kind: 1, chainId: 43114, contractAddress: plain.tx.to, selectorOrTypeHash: '0x5bcb2fc6',
      }],
    })
  })

  it('is none for 404 (route not deployed), 422 (not in the signed catalog), other errors and bad JSON', async () => {
    for (const answer of [
      () => Response.json({ error: 'not found' }, { status: 404 }),
      () => Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 }),
      () => Response.json({ error: 'boom' }, { status: 500 }),
      () => new Response('<html>', { status: 200 }),
      () => Response.json(null),
    ]) {
      expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, service(answer).impl)).toBeUndefined()
    }
    const offline = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, offline)).toBeUndefined()
  })

  it('is none when the id is not sha256(envelope)', async () => {
    const answer = ok({ ...plain.definition, definitionId: 'ab'.repeat(32) })
    expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, service(answer).impl)).toBeUndefined()
  })

  it('is none when the signed header names another chain, contract or selector', async () => {
    const { impl } = service(ok(plain.definition))
    const other = '0x1111111111111111111111111111111111111111'
    expect(await fetchErc7730CalldataDefinition(1, plain.tx.to, plain.tx.data, impl)).toBeUndefined()
    expect(await fetchErc7730CalldataDefinition(43114, other, plain.tx.data, impl)).toBeUndefined()
    expect(await fetchErc7730CalldataDefinition(43114, plain.tx.to, '0xdeadbeef', impl)).toBeUndefined()
  })

  it('is none when the service JSON disagrees with the signed header', async () => {
    for (const lie of [{ kind: 2 }, { chainId: 1 }, { contractAddress: '0x1111111111111111111111111111111111111111' }, { selectorOrTypeHash: '0xdeadbeef' }]) {
      const answer = ok({ ...plain.definition, ...lie })
      expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, service(answer).impl)).toBeUndefined()
    }
  })

  it('is none for a malformed envelope', async () => {
    for (const envelope of ['zz', 'abc', '00'.repeat(17_501)]) {
      const answer = ok({ ...plain.definition, envelope })
      expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, service(answer).impl)).toBeUndefined()
    }
  })

  it('skips a definition with an embedded call, by its bytes or by the service flag', async () => {
    const e = embedded.tx
    expect(await fetchErc7730CalldataDefinition(e.chainId, e.to, e.data, service(ok(embedded.definition)).impl)).toBeUndefined()
    const flagged = ok({ ...plain.definition, embeddedCalls: true })
    expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, service(flagged).impl)).toBeUndefined()
    // When the sections cannot be read, it does not attach.
    const broken = withSectionCount(plain.definition.envelope, 255)
    const unsure = ok({ ...plain.definition, ...broken })
    expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, service(unsure).impl)).toBeUndefined()
  })

  it('never asks for approve, increaseAllowance, or arguments that are not whole words', async () => {
    const spender = '000000000022d473030f116ddee9f6b43ac78ba3'.padStart(64, '0')
    for (const data of [
      `0x095ea7b3${spender}${'ff'.repeat(32)}`,
      `0x39509351${spender}${'ff'.repeat(32)}`,
      `0x5bcb2fc6${'00'.repeat(33)}`,
      '0x5bcb2f',
    ]) {
      const { impl, urls } = service(ok(plain.definition))
      expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, data, impl)).toBeUndefined()
      expect(urls).toEqual([])
    }
  })
})

describe('resolveErc7730ForCall', () => {
  const call = { chainId: plain.tx.chainId, to: plain.tx.to, data: plain.tx.data, value: plain.tx.value }

  it('asks only a 7.16+ device that reports CAPABILITY_ERC7730_RUNTIME_REVIEW', async () => {
    for (const gate of [
      { firmwareVersion: '7.15.0', capabilities: [4] },
      { firmwareVersion: '7.16.0', capabilities: [] },
      { firmwareVersion: '7.16.0', capabilities: undefined },
      { firmwareVersion: undefined, capabilities: [4] },
    ]) {
      const { impl, urls } = service(ok(plain.definition))
      expect(await resolveErc7730ForCall({ ...call, ...gate }, impl)).toBeUndefined()
      expect(urls).toEqual([])
    }
    const { impl } = service(ok(plain.definition))
    expect((await resolveErc7730ForCall({ ...call, ...GATE }, impl))?.primaryDefinitionId).toBe(`0x${plain.definition.definitionId}`)
  })

  it('never when kind-1 metadata already describes the call', async () => {
    const { impl, urls } = service(ok(plain.definition))
    expect(await resolveErc7730ForCall({ ...call, ...GATE, txMetadata: { signedPayload: '0x03', keyId: 0x80 } }, impl)).toBeUndefined()
    expect(urls).toEqual([])
  })

  it('never for a call the firmware decodes natively', async () => {
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const transfer = `0xa9059cbb${'11'.repeat(20).padStart(64, '0')}${'01'.padStart(64, '0')}`
    expect(firmwareClearSigns(usdc, transfer, 1, '7.16.0')).toBe(true)
    const { impl, urls } = service(ok(plain.definition))
    expect(await resolveErc7730ForCall({ chainId: 1, to: usdc, data: transfer, ...GATE }, impl)).toBeUndefined()
    expect(urls).toEqual([])
  })
})

describe('erc7730CatalogDescribesCall', () => {
  const catalog = {
    primaryDefinitionId: plain.definition.definitionId,
    definitions: [{ ...plain.definition, kind: 1 as const }],
  }

  it('holds for the call the definition names', () => {
    expect(erc7730CatalogDescribesCall(catalog, plain.tx.chainId, plain.tx.to, plain.tx.data)).toBe(true)
  })

  it('fails for any other call, an approval, unaligned arguments, or a broken catalog', () => {
    expect(erc7730CatalogDescribesCall(catalog, 1, plain.tx.to, plain.tx.data)).toBe(false)
    expect(erc7730CatalogDescribesCall(catalog, plain.tx.chainId, plain.tx.to, `0x5bcb2fc6${'00'.repeat(3)}`)).toBe(false)
    expect(erc7730CatalogDescribesCall(catalog, plain.tx.chainId, plain.tx.to, `0x095ea7b3${'00'.repeat(64)}`)).toBe(false)
    expect(erc7730CatalogDescribesCall({ ...catalog, primaryDefinitionId: '00'.repeat(32) }, plain.tx.chainId, plain.tx.to, plain.tx.data)).toBe(false)
    expect(erc7730CatalogDescribesCall({ primaryDefinitionId: '0x11', definitions: [] }, plain.tx.chainId, plain.tx.to, plain.tx.data)).toBe(false)
    const e = { primaryDefinitionId: embedded.definition.definitionId, definitions: [{ ...embedded.definition, kind: 1 as const }] }
    expect(erc7730CatalogDescribesCall(e, embedded.tx.chainId, embedded.tx.to, embedded.tx.data)).toBe(false)
  })

  it('takes ids and envelopes with or without 0x', () => {
    const checked = checkErc7730CalldataDefinition(
      { definitionId: `0x${plain.definition.definitionId.toUpperCase()}`, envelope: `0x${plain.definition.envelope}` },
      plain.tx,
    )
    expect('entry' in checked).toBe(true)
  })
})

describe('a refused definition falls back to the normal path', () => {
  // 7.16's own words (fsm_msg_ethereum.h) and hdwallet's preload check.
  const REFUSALS = [
    'Value too long to clear-sign',
    'Inner call cannot be clear-signed',
    'ERC-7730 definition does not match transaction',
    'Invalid ERC-7730 execution program',
    'AdvancedMode required for ERC-7730',
    'ERC-7730 approval not supported',
    'ERC-7730 definition was not used by the device',
  ]
  const failure = (message: string) => ({ message_type: 'FAILURE', message_enum: 3, message: { code: 9, message } })
  const msg = { to: plain.tx.to, data: plain.tx.data, erc7730: { primaryDefinitionId: '0x11', definitions: [] } }

  for (const text of REFUSALS) {
    it(`signs again without the definition after "${text}"`, async () => {
      for (const thrown of [failure(text), new Error(text)]) {
        expect(isErc7730Refusal(thrown)).toBe(true)
        const sent: any[] = []
        const gated: any[] = []
        const result = await signWithErc7730Fallback(msg, async (m) => {
          sent.push(m)
          if (m.erc7730) throw thrown
          return 'signed'
        }, (plainMsg, reason) => { gated.push([plainMsg, reason]) })
        expect(result).toBe('signed')
        expect(sent.length).toBe(2)
        expect(sent[0].erc7730).toBeDefined()
        expect(sent[1]).toEqual({ to: msg.to, data: msg.data })
        expect(gated).toEqual([[{ to: msg.to, data: msg.data }, text]])
      }
    })
  }

  it('stops when the normal gate stops it (the user declines the blind-sign card)', async () => {
    let calls = 0
    await expect(signWithErc7730Fallback(msg, async (m) => {
      calls++
      if (m.erc7730) throw new Error('Inner call cannot be clear-signed')
      return 'signed'
    }, () => { throw new Error('Signing rejected by user') })).rejects.toThrow('Signing rejected by user')
    expect(calls).toBe(1)
  })

  it('never retries a cancel or any other failure', async () => {
    for (const thrown of [new Error('Action cancelled by user'), failure('Blind signing disabled by policy'), new Error('timeout')]) {
      expect(isErc7730Refusal(thrown)).toBe(false)
      let calls = 0
      await expect(signWithErc7730Fallback(msg, async () => { calls++; throw thrown })).rejects.toBe(thrown)
      expect(calls).toBe(1)
    }
  })

  it('signs once when no definition is attached', async () => {
    let calls = 0
    const { erc7730: _none, ...bare } = msg
    expect(await signWithErc7730Fallback(bare, async () => { calls++; return 'signed' })).toBe('signed')
    expect(calls).toBe(1)
  })
})

describe('a definition the device refused', () => {
  it('is not sent again this session', async () => {
    const { impl } = service(ok(plain.definition))
    const catalog = await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, impl)
    expect(catalog).toBeDefined()
    await signWithErc7730Fallback({ ...plain.tx, erc7730: catalog }, async (m: any) => {
      if (m.erc7730) throw new Error('Value too long to clear-sign')
      return 'signed'
    })
    expect(await fetchErc7730CalldataDefinition(plain.tx.chainId, plain.tx.to, plain.tx.data, impl)).toBeUndefined()
  })
})
