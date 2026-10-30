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
import { describeErc7730Call, planErc7730EmbeddedCalls } from './erc7730-describe'
import { makeErc7730DefinitionChunk } from '@keepkey/hdwallet-keepkey/dist/ethereum'
import * as Erc7730Proto from '@keepkey/hdwallet-keepkey/dist/ethereum-erc7730-proto'
import { ERC7730_EMBEDDED_MIN_FW, supportsErc7730EmbeddedCalls } from '../shared/erc7730-support'
import fixtures from './erc7730-embedded.fixtures.json'

type Def = (typeof fixtures.definitions)[keyof typeof fixtures.definitions]
const defs = fixtures.definitions
const txs = fixtures.transactions
const CAPS = [1, 4]

/** A stand-in ClearSign service: the fixture's definitions by (chain, contract, selector), else 422. */
function service(opts: { without?: string[]; extra?: Record<string, unknown> } = {}) {
  const urls: string[] = []
  const impl = (async (url: any) => {
    urls.push(String(url))
    const q = new URL(String(url)).searchParams
    const hit = Object.entries(defs).find(([name, d]: [string, Def]) => !opts.without?.includes(name)
      && `${d.chainId}:${d.contractAddress}:${d.selectorOrTypeHash}` === `${q.get('chainId')}:${q.get('contract')}:${q.get('selector')}`)?.[1]
    return hit ? Response.json({ ...hit, ...opts.extra }) : Response.json({ code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
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
    const flagged = service({ extra: { embeddedCalls: true } }).impl
    expect(await fetchErc7730CalldataDefinition(tx.chainId, tx.to, tx.data, flagged, '7.16.0', tx.value)).toBeUndefined()
    expect(await fetchErc7730CalldataDefinition(tx.chainId, tx.to, tx.data, flagged, '7.17.0', tx.value)).toBeDefined()
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
    // Fetched before it is attached: the outer definition, then Settler's.
    expect(urls.length).toBe(2)
    expect(catalog.definitions.map((d) => d.definitionId)).toEqual([`0x${defs.zeroex_exec.definitionId}`, `0x${defs.zeroex_settler.definitionId}`])
    let resolved: unknown
    await signWithErc7730Fallback({ ...tx, erc7730: catalog }, async (m: any) => {
      expect(typeof m.erc7730.resolveInner).toBe('function')
      resolved = await m.erc7730.resolveInner(1, defs.zeroex_settler.contractAddress, '0x1fff991f')
      return 'signed'
    }, undefined, undefined, impl)
    expect((resolved as any)?.definitionId).toBe(`0x${defs.zeroex_settler.definitionId}`)
    expect(urls.length).toBe(3)
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

// ── The card, the attach decision and the session block on 7.17 ──────────

/** The emulator's signer (TEST_MNEMONIC m/44'/60'/0'/0/0). */
const ME = '0x3f2329c9adfbccd9a84f52c906e936a42da18cb8'
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
/** The calldata with argument word `n` replaced. */
const withWord = (data: string, n: number, value: string) => data.slice(0, 10 + 64 * n) + word(value) + data.slice(10 + 64 * (n + 1))
const attach717 = (tx: { chainId: number; to: string; data: string; value: string }, impl: typeof fetch) =>
  resolveErc7730ForCall({ ...tx, firmwareVersion: '7.17.0', capabilities: CAPS }, impl)
/** The card for this call, from the catalog Desktop attached (TEST root). */
async function card(tx: { chainId: number; to: string; data: string; value: string }, from = ME) {
  const catalog = (await attach717(tx, service().impl))!
  expect(catalog).toBeDefined()
  return describeErc7730Call(catalog.definitions[0].envelope, { ...tx, from }, catalog.definitions, fixtures.testRootPubkey)
}

describe('the card says what 7.17 shows (embedded calls, RECIPIENT, TX_VALUE)', () => {
  it('Safe execTransaction: the inner ERC-20 transfer, recipient marked NOT this wallet', async () => {
    const d = (await card(txs.safe_exec_transfer))!
    expect(d.intent).toBe('sign multisig operation')
    expect(d.fields).toEqual([
      { label: 'Operation type', value: 'label set by signer\nCall (0)' },
      { label: 'From Safe', value: '0xE9619c0450Fd890E28a5baA09Ab2e83e6A02C3fD' },
      { label: 'Execution signer', value: '0x3f2329C9ADFbcCd9A84f52c906E936A42dA18CB8\n(this wallet)' },
      { label: 'Transaction', value: 'To 0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD\nFunction 0xa9059cbb\nData 68 bytes\nValue 0 Wei\nAs 0xE9619c0450Fd890E28a5baA09Ab2e83e6A02C3fD' },
      { label: 'Inner action', value: 'Send', depth: 1 },
      { label: 'To', value: '0xbd757963C857c884153d24B4589A94F45762e7D5\nNOT this wallet', depth: 1 },
      { label: 'Amount', value: '894300000000000000\nunknown token\n0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', note: 'This computer reads it as 0.8943 RLUSD.', depth: 1 },
      { label: 'Gas amount', value: '0' },
      { label: 'Gas price', value: 'Signer native alias:\n0x0000000000000000000000000000000000000000\n0 Wei' },
      { label: 'Gas receiver', value: '0x0000000000000000000000000000000000000000' },
    ])
  })

  it('0x, SwapRouter02, Safe creation, CoW, and a Safe running a multicall two levels down', async () => {
    const lines = async (tx: any) => (await card(tx))!.fields.map((f) => `${'>'.repeat(f.depth ?? 0)}${f.label}: ${f.value.replace(/\n/g, ' / ')}`)
    const zeroex = await lines(txs.zeroex_allowance_holder)
    expect(zeroex).toContain('Route: To 0x0cEf320d0c5793ade37964E2661a033771e53cd5 / Function 0x1fff991f / Data 2660 bytes / Value 10 ETH')
    expect(zeroex).toContain('>Inner action: Swap')
    expect(zeroex).toContain('>Receive at least: 22632.193356 USDC')
    const router = await lines(txs.router02_multicall)
    expect(router.filter((l) => l.startsWith('Step: To 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45')).length).toBe(2)
    expect(router).toContain('>Inner action: Swap exact input')
    expect(router).toContain('>Inner action: Unwrap WETH')
    expect(router).toContain('>Recipient: 0xB3ddeC0cCC5C3ba733FCdf5a15f98c95Ec5a5FdB / NOT this wallet')
    const create = await lines(txs.safe_create)
    expect(create).toContain('Account setup: To 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762 / Function 0xb63e800d / Data 388 bytes')
    expect(create).toContain('>Inner action: Setup Safe')
    expect(create).toContain('>Module: To 0x0000000000000000000000000000000000000000 / No data')
    expect(await lines(txs.cow_ethflow)).toContain('Receiver: 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 / NOT this wallet')
    const nested = await lines(txs.safe_exec_multicall)
    expect(nested).toContain('>Inner action: Swap')
    expect(nested).toContain('>>Inner action: Swap exact input')
    expect(nested).toContain('>>Inner action: Unwrap WETH')
    // No inner call is shown as a hex blob.
    for (const l of [...zeroex, ...router, ...create, ...nested]) expect(l).not.toMatch(/0x[0-9a-f]{200}/i)
  })

  it('RECIPIENT reads (this wallet) when the address is the signer', async () => {
    const receiver = '0x9858effd232b4033e47d90003d41ec34ecaeda94'
    expect((await card(txs.cow_ethflow, receiver))!.fields).toContainEqual({ label: 'Receiver', value: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94\n(this wallet)' })
    // Without a matched signer the device's line cannot be known: no description.
    const catalog = (await attach717(txs.cow_ethflow, service().impl))!
    expect(describeErc7730Call(catalog.definitions[0].envelope, txs.cow_ethflow, catalog.definitions, fixtures.testRootPubkey)).toBeUndefined()
  })

  it('TX_VALUE: an amount that is not the call value is refused, so neither attached nor described', async () => {
    const tx = { ...txs.cow_ethflow, value: '0x1' }
    expect(planErc7730EmbeddedCalls(defs.cow_ethflow.envelope, tx, []).refused).toBe('ERC-7730 value does not match the call')
    expect(describeErc7730Call(defs.cow_ethflow.envelope, { ...tx, from: ME }, [], fixtures.testRootPubkey)).toBeUndefined()
    expect(await attach717(tx, service().impl)).toBeUndefined()
  })

  it('an embedded call whose definition is not at hand gets no description, never a blob', () => {
    const tx = txs.safe_exec_transfer
    expect(describeErc7730Call(defs.safe_exec_a.envelope, { ...tx, from: ME }, [], fixtures.testRootPubkey)).toBeUndefined()
    // Only the KeepKey root (or the root given) makes a description.
    expect(describeErc7730Call(defs.safe_exec_a.envelope, { ...tx, from: ME }, Object.values(defs) as any)).toBeUndefined()
  })
})

describe('attached only when the device will clear-sign it (7.17)', () => {
  it('carries every inner definition the device will ask for, two levels deep', async () => {
    const ids = async (tx: any) => (await attach717(tx, service().impl))?.definitions.map((d) => d.definitionId.slice(2))
    expect(await ids(txs.safe_exec_multicall)).toEqual([defs.safe_exec_a, defs.router02_multicall, defs.router02_exact_input, defs.router02_unwrap].map((d) => d.definitionId))
    expect(await ids(txs.safe_exec_native)).toEqual([defs.safe_exec_b.definitionId]) // no data: nothing to fetch
  })

  it('a Safe DELEGATECALL (execTransaction operation 1, or setup with a module) is not attached', async () => {
    const batch = { ...txs.safe_exec_transfer, data: withWord(txs.safe_exec_transfer.data, 3, '0x1') }
    for (const tx of [batch, txs.safe_create_l2_setup]) {
      expect(await attach717(tx, service().impl)).toBeUndefined()
      expect(evmCallRequiresAdvancedMode(tx.to, tx.data, tx.chainId, false, undefined, undefined, '7.17.0', tx.value, CAPS)).toBe(true)
    }
    expect(planErc7730EmbeddedCalls(defs.safe_exec_a.envelope, batch, Object.values(defs) as any).refused).toBe('DELEGATECALL cannot be clear-signed')
  })

  it('an inner call the service does not serve is not attached', async () => {
    expect(await attach717(txs.safe_exec_transfer, service({ without: ['token_transfer'] }).impl)).toBeUndefined()
    expect(await attach717(txs.safe_exec_multicall, service({ without: ['router02_unwrap'] }).impl)).toBeUndefined()
    expect(await attach717(txs.zeroex_allowance_holder, service({ without: ['zeroex_settler'] }).impl)).toBeUndefined()
  })
})

describe('a refusal of one transaction does not block the contract for the session', () => {
  const refuse = (message: string) => async (m: any) => {
    if (m.erc7730) throw { message_enum: 3, message: { code: 9, message } }
    return 'signed'
  }

  for (const message of ['Inner call cannot be clear-signed', 'DELEGATECALL cannot be clear-signed', 'ERC-7730 inner definition does not match']) {
    it(`"${message}": the same call signs on the normal path from then on; the next swap still clear-signs`, async () => {
      const { impl } = service()
      const tx = txs.zeroex_allowance_holder
      const catalog = await attach717(tx, impl)
      expect(await signWithErc7730Fallback({ ...tx, erc7730: catalog }, refuse(message), undefined, undefined, impl)).toBe('signed')
      // The retry of this transaction (after the AdvancedMode opt-in) does not repeat the refused review.
      expect(await attach717(tx, impl)).toBeUndefined()
      // Another 0x swap (other amounts) still attaches, and the gate needs no AdvancedMode.
      const next = { ...tx, data: tx.data.slice(0, -2) + (tx.data.endsWith('01') ? '02' : '01') }
      const again = await attach717(next, impl)
      expect(again?.primaryDefinitionId).toBe(`0x${defs.zeroex_exec.definitionId}`)
      expect(evmCallRequiresAdvancedMode(next.to, next.data, next.chainId, false, undefined, again, '7.17.0', next.value, CAPS)).toBe(false)
    })
  }

  it('a refusal of the definition itself still blocks it for the session', async () => {
    const { impl } = service()
    const tx = txs.zeroex_allowance_holder
    await signWithErc7730Fallback({ ...tx, erc7730: await attach717(tx, impl) }, refuse('Invalid ERC-7730 execution program'), undefined, undefined, impl)
    const next = { ...tx, data: tx.data.slice(0, -2) + (tx.data.endsWith('01') ? '02' : '01') }
    expect(await attach717(next, impl)).toBeUndefined()
  })
})

describe('the pinned hdwallet answers the device two levels down', () => {
  it('serves a depth-2 inner definition from the catalog Desktop attaches', async () => {
    const catalog = (await attach717(txs.safe_exec_multicall, service().impl))!
    const unwrap = defs.router02_unwrap
    const request = new Erc7730Proto.EthereumClearSignDefinitionRequest()
    request.setKind(Erc7730Proto.EthereumClearSignDefinitionKind.ERC7730_CALLDATA)
    request.setChainId(1)
    request.setContractAddress(Uint8Array.from(Buffer.from(unwrap.contractAddress.slice(2), 'hex')))
    request.setSelectorOrTypeHash(Uint8Array.from(Buffer.from(unwrap.selectorOrTypeHash.slice(2), 'hex')))
    request.setRecursionDepth(2)
    request.setOffset(0)
    request.setLength(64)
    const chunk = await makeErc7730DefinitionChunk(catalog as any, request)
    expect(Buffer.from(chunk.getDefinitionId_asU8()).toString('hex')).toBe(unwrap.definitionId)
    expect(chunk.getTotalLength()).toBe(unwrap.envelope.length / 2)
  })
})
