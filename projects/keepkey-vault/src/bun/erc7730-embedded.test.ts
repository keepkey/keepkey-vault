/**
 * ERC-7730 embedded calls (firmware 7.17): Desktop attaches a definition with
 * an embedded call, or with formatter flags, only to 7.17+, and answers the
 * device's inner-definition requests from the same ClearSign service with the
 * same checks. 7.16 is unchanged: none of these is sent to it.
 *
 * Fixtures: real transactions (Safe creation, Safe execTransaction, SwapRouter02
 * multicall, 0x AllowanceHolder.exec into Settler, CoW EthFlow) and their
 * programs, signed under a TEST root (erc7730-embedded.fixtures.json).
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  checkErc7730CalldataDefinition, erc7730CatalogDescribesCall, fetchErc7730CalldataDefinition, forgetRefusedErc7730Definitions,
  isErc7730Refusal, readErc7730Envelope, resolveErc7730ForCall, resolveErc7730InnerDefinition, signWithErc7730Fallback,
} from './erc7730-resolver'
import { evmCallRequiresAdvancedMode } from './evm-signing-policy'
import { ERC7730_EMBEDDED_MIN_FW, supportsErc7730EmbeddedCalls } from '../shared/erc7730-support'
import fixtures from './erc7730-embedded.fixtures.json'

type Def = (typeof fixtures.definitions)[keyof typeof fixtures.definitions]
const defs = fixtures.definitions
const txs = fixtures.transactions
const CAPS = [1, 4]

/** A stand-in ClearSign service: the fixture's definitions by (chain, contract, selector), else 422. */
function service() {
  const urls: string[] = []
  const impl = (async (url: any) => {
    urls.push(String(url))
    const q = new URL(String(url)).searchParams
    const hit = Object.values(defs).find((d: Def) => `${d.chainId}:${d.contractAddress}:${d.selectorOrTypeHash}`
      === `${q.get('chainId')}:${q.get('contract')}:${q.get('selector')}`)
    return hit ? Response.json(hit) : Response.json({ code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
  }) as unknown as typeof fetch
  return { impl, urls }
}
const header = (d: Def) => readErc7730Envelope(Uint8Array.from(Buffer.from(d.envelope, 'hex')))!
beforeEach(() => forgetRefusedErc7730Definitions())

// Each target: the transaction and the definition the device starts from.
const TARGETS = [
  ['0x AllowanceHolder.exec -> Settler', txs.zeroex_allowance_holder, defs.zeroex_exec],
  ['Safe execTransaction', txs.safe_exec_transfer, defs.safe_exec_a],
  ['Safe createProxyWithNonce', txs.safe_create, defs.safe_factory],
  ['SwapRouter02 multicall', txs.router02_multicall, defs.router02_multicall],
  ['CoW EthFlow createOrder', txs.cow_ethflow, defs.cow_ethflow],
] as const

describe('the 7.17 gate', () => {
  it('is firmware version 7.17.0 and later, nothing else', () => {
    expect(ERC7730_EMBEDDED_MIN_FW).toBe('7.17.0')
    expect(supportsErc7730EmbeddedCalls('7.17.0')).toBe(true)
    expect(supportsErc7730EmbeddedCalls('7.18.2')).toBe(true)
    expect(supportsErc7730EmbeddedCalls('7.16.0')).toBe(false)
    expect(supportsErc7730EmbeddedCalls('7.16.9')).toBe(false)
    expect(supportsErc7730EmbeddedCalls(undefined)).toBe(false)
  })

  it('reads embedded calls and formatter flags from the program bytes', () => {
    expect([header(defs.zeroex_exec).embeddedCall, header(defs.zeroex_exec).formatterFlags]).toEqual([true, false])
    expect([header(defs.cow_ethflow).embeddedCall, header(defs.cow_ethflow).formatterFlags]).toEqual([false, true])
    expect([header(defs.safe_factory).embeddedCall, header(defs.safe_factory).formatterFlags]).toEqual([true, false])
  })
})

describe('the five targets', () => {
  for (const [what, tx, def] of TARGETS) {
    it(`${what}: attached on 7.17.0`, async () => {
      const { impl } = service()
      const catalog = await resolveErc7730ForCall({ ...tx, firmwareVersion: '7.17.0', capabilities: CAPS }, impl)
      expect(catalog?.primaryDefinitionId).toBe(`0x${def.definitionId}`)
      // The swap/REST gate agrees: no AdvancedMode for it on 7.17.
      expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, catalog, '7.17.0', tx.value, CAPS)).toBe(false)
    })

    it(`${what}: 7.16 unchanged, never attached`, async () => {
      const { impl } = service()
      for (const firmwareVersion of ['7.16.0', '7.16.1']) {
        expect(await resolveErc7730ForCall({ ...tx, firmwareVersion, capabilities: CAPS }, impl)).toBeUndefined()
      }
      const catalog = { primaryDefinitionId: def.definitionId, definitions: [{ ...def, kind: 1 as const }] }
      expect(erc7730CatalogDescribesCall(catalog, tx.chainId, tx.to, tx.data, '7.16.0')).toBe(false)
      expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, catalog, '7.16.0', tx.value, CAPS)).toBe(true)
    })
  }

  it('the service flag alone never lets an embedded definition reach 7.16', async () => {
    const tx = txs.zeroex_allowance_holder
    const flagged = (async () => Response.json({ ...defs.zeroex_exec, embeddedCalls: true })) as unknown as typeof fetch
    expect(await fetchErc7730CalldataDefinition(tx.chainId, tx.to, tx.data, flagged, '7.16.0')).toBeUndefined()
    expect(await fetchErc7730CalldataDefinition(tx.chainId, tx.to, tx.data, flagged, '7.17.0')).toBeDefined()
  })
})

describe('inner definitions the device asks for', () => {
  it('are fetched by chain, callee and selector and checked like any other', async () => {
    const { impl, urls } = service()
    const settler = defs.zeroex_settler
    const entry = await resolveErc7730InnerDefinition(1, settler.contractAddress.toUpperCase().replace('0X', '0x'), '0x1FFF991F', impl)
    expect(entry).toEqual({
      definitionId: `0x${settler.definitionId}`, envelope: `0x${settler.envelope}`, kind: 1, chainId: 1,
      contractAddress: settler.contractAddress, selectorOrTypeHash: '0x1fff991f',
    })
    expect(urls[0]).toContain(`chainId=1&contract=${settler.contractAddress}&selector=0x1fff991f`)
    // A second level may embed calls itself (Safe -> multicall -> steps).
    expect(await resolveErc7730InnerDefinition(1, defs.router02_multicall.contractAddress, '0x5ae401dc', impl)).toBeDefined()
  })

  it('answer none for an unknown call, a service answer for another call, or a bad lookup', async () => {
    const { impl } = service()
    expect(await resolveErc7730InnerDefinition(1, defs.zeroex_settler.contractAddress, '0xdeadbeef', impl)).toBeUndefined()
    const lying = (async () => Response.json(defs.token_transfer)) as unknown as typeof fetch
    expect(await resolveErc7730InnerDefinition(1, defs.zeroex_settler.contractAddress, '0x1fff991f', lying)).toBeUndefined()
    expect(await resolveErc7730InnerDefinition(10, defs.zeroex_settler.contractAddress, '0x1fff991f', impl)).toBeUndefined()
    expect(await resolveErc7730InnerDefinition(1, '0x1234', '0x1fff991f', impl)).toBeUndefined()
  })

  it('go with the signature request only when the primary definition embeds a call', async () => {
    const { impl, urls } = service()
    const tx = txs.zeroex_allowance_holder
    const catalog = (await resolveErc7730ForCall({ ...tx, firmwareVersion: '7.17.0', capabilities: CAPS }, impl))!
    let resolved: unknown
    await signWithErc7730Fallback({ ...tx, erc7730: catalog }, async (m: any) => {
      expect(typeof m.erc7730.resolveInner).toBe('function')
      resolved = await m.erc7730.resolveInner(1, defs.zeroex_settler.contractAddress, '0x1fff991f')
      return 'signed'
    }, undefined, undefined, impl)
    expect((resolved as any)?.definitionId).toBe(`0x${defs.zeroex_settler.definitionId}`)
    expect(urls.length).toBe(2)
    // The caller's catalog is not changed.
    expect((catalog as any).resolveInner).toBeUndefined()

    const cow = txs.cow_ethflow
    const plain = (await resolveErc7730ForCall({ ...cow, firmwareVersion: '7.17.0', capabilities: CAPS }, impl))!
    await signWithErc7730Fallback({ ...cow, erc7730: plain }, async (m: any) => {
      expect(m.erc7730.resolveInner).toBeUndefined()
      return 'signed'
    }, undefined, undefined, impl)
  })
})

describe('7.17 refusals sign again on the normal path', () => {
  it('an inner DELEGATECALL is a refusal of the definition, not of the transaction', async () => {
    expect(isErc7730Refusal(new Error('DELEGATECALL cannot be clear-signed'))).toBe(true)
    expect(isErc7730Refusal(new Error('ERC-7730 value does not match the call'))).toBe(true)
    const { impl } = service()
    const tx = txs.safe_create
    const catalog = await resolveErc7730ForCall({ ...tx, firmwareVersion: '7.17.0', capabilities: CAPS }, impl)
    const sent: any[] = []
    const result = await signWithErc7730Fallback({ ...tx, erc7730: catalog }, async (m: any) => {
      sent.push(m)
      if (m.erc7730) throw { message_enum: 3, message: { code: 9, message: 'DELEGATECALL cannot be clear-signed' } }
      return 'signed'
    }, undefined, undefined, impl)
    expect(result).toBe('signed')
    expect(sent.length).toBe(2)
    expect(sent[1].erc7730).toBeUndefined()
  })
})

describe('checkErc7730CalldataDefinition', () => {
  it('refuses an embedded call or formatter flags unless the device takes them', () => {
    const tx = txs.zeroex_allowance_holder
    expect(checkErc7730CalldataDefinition(defs.zeroex_exec, tx)).toEqual({ reason: 'program has an embedded call' })
    expect('entry' in checkErc7730CalldataDefinition(defs.zeroex_exec, tx, true)).toBe(true)
    const cow = txs.cow_ethflow
    expect(checkErc7730CalldataDefinition(defs.cow_ethflow, cow)).toEqual({ reason: 'program uses formatter flags' })
    expect('entry' in checkErc7730CalldataDefinition(defs.cow_ethflow, cow, true)).toBe(true)
  })
})
