import { describe, expect, it } from 'bun:test'

import {
  buildEvmNameBody,
  buildEvmSchemaBody,
  CERTIFIED_EVM_NAMES,
  findEvmNameRecord,
  buildEvmV2SchemaBody,
  CERTIFIED_EVM_CATALOG,
  CERTIFIED_METADATA_KEY_ID,
  findCertifiedEvmSchemaByShape,
  findCertifiedEvmSchemaSpec,
  buildCertifiedEvmEnvelope,
} from './evm-certified-schema'
import capturedEnvelope from '../../../../docs/clearsign-case-studies/uniswap-usdt/certified-response.json'

const TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const DATA =
  '0x49290c1c' +
  '000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e' +
  '8a2c121197efc95c42f53142ab409735ee353287f877ed4d351f63094d5bfcb1'
const PORTALS = '0xbf5A7F3629fB325E2a8453D595AB103465F75E62'
const ACROSS = '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A'

describe('7.16 certified EVM schemas', () => {
  // Arbitrum USDT approve is described by the reviewed-token table (USDT0,
  // Permit2-pinned or generic spender), not a static catalog entry.
  const ARB_USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
  const permit2Approve = `0x095ea7b3${'000000000022d473030f116ddee9f6b43ac78ba3'.padStart(64, '0')}${'ff'.repeat(32)}`
  it('refuses the captured mainnet certificate for the Arbitrum schema before using the delegate key', () => {
    const spec = findCertifiedEvmSchemaSpec(42161, ARB_USDT, permit2Approve)!
    const certificate = Buffer.from(capturedEnvelope.signedPayload.slice(2), 'hex').subarray(1, 140).toString('hex')
    expect(() => buildCertifiedEvmEnvelope(spec, certificate, '00'.repeat(32))).toThrow(/scoped to 1, not chain 42161/)
  })
  it('binds Arbitrum USDT identity and allowance rendering metadata', () => {
    const spec = findCertifiedEvmSchemaSpec(42161, ARB_USDT, `0x095ea7b3${'00'.repeat(64)}`)!
    expect(spec.method).toBe('approve')
    expect(spec.args[1]).toMatchObject({ name: 'Allowance', format: 5, decimals: 6, symbol: 'USDT0' })
    expect(buildEvmSchemaBody(spec).includes(Buffer.from('USDT0'))).toBe(true)
  })
  it('serializes the Relay schema with a delegate sentinel trailer', () => {
    const spec = CERTIFIED_EVM_CATALOG[`1:${TO}:0x49290c1c`]
    const body = buildEvmV2SchemaBody(spec)
    expect(body[0]).toBe(0x05)
    expect(body[body.length - 1]).toBe(CERTIFIED_METADATA_KEY_ID)
    expect(body.subarray(1, 5).readUInt32BE()).toBe(1)
    expect(body.includes(Buffer.from('bridgeDeposit', 'ascii'))).toBe(true)
  })

  it('serializes the Relay intent (v0x05) byte-for-byte as the firmware unit test pins it', () => {
    const spec = CERTIFIED_EVM_CATALOG[`1:${TO}:0x49290c1c`]
    // Same bytes as fw unittests signed_metadata.cpp kRelayIntentBodyFromServer.
    expect(buildEvmSchemaBody(spec).toString('hex')).toBe(
      '05000000014cd00e387622c35bddb9b4c962c136462338bc3149290c1c000d6272696467654465706f73697402096465706f7369746f720100076f7264657249640300030552656c617936427269646765207b767d207468726f7567682052656c617920666f72207b307d3b2064656c69766572792069732062792052656c6179010000000080',
    )
  })

  it('refuses intents the firmware would reject', () => {
    const base = CERTIFIED_EVM_CATALOG[`1:${TO}:0x49290c1c`]
    const bad = (intent: Partial<NonNullable<typeof base.intent>>) => () =>
      buildEvmSchemaBody({ ...base, intent: { ...base.intent!, ...intent } })
    expect(bad({ template: 'Bridge through Relay for {0}' })).toThrow(/\{v\}/)
    expect(bad({ valueRole: 0 })).toThrow(/\{v\}/)
    expect(bad({ template: 'Bridge {v} for {1}' })).toThrow(/not displayable/)
    expect(bad({ template: 'Bridge {v} for {2}' })).toThrow(/out of range/)
    expect(bad({ template: '{v}{v}{v}{v}' })).toThrow(/firmware limit/)
    expect(bad({ valueRole: 2 })).toThrow(/value role/)
    expect(bad({ template: 'Bridge {v} for {0}, about 1 ETH' })).toThrow(/number of its own/)
  })

  it('serializes a Universal Router name record byte-for-byte as the firmware unit test pins it', () => {
    const record = findEvmNameRecord(1, '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af')
    expect(record?.name).toBe('Uniswap Universal Router')
    expect(record?.source).toBe('mainnet.json UniversalRouterV2')
    // Same bytes as fw unittests signed_metadata.cpp kNameBodyFromServer.
    expect(buildEvmNameBody(record!).toString('hex')).toBe('060000000166a9893cc07d91d95644aedd05d03f95e1dba8af18556e697377617020556e6976657273616c20526f75746572010000000080')
    expect(findEvmNameRecord(56, '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af')).toBeUndefined()
    for (const r of CERTIFIED_EVM_NAMES) expect(buildEvmNameBody(r).length).toBe(1 + 4 + 20 + 1 + r.name.length + 6)
  })

  it('matches only the complete reviewed Relay calldata shape', () => {
    expect(findCertifiedEvmSchemaSpec(1, TO, DATA)?.method).toBe('bridgeDeposit')
    expect(findCertifiedEvmSchemaSpec(1, TO, `${DATA}00`)).toBeUndefined()
    // Base and Arbitrum carry the same depository entry under its ABI name;
    // a chain with no certificate scope (Optimism) has none.
    expect(findCertifiedEvmSchemaSpec(8453, TO, DATA)?.method).toBe('depositNative')
    expect(findCertifiedEvmSchemaSpec(10, TO, DATA)).toBeUndefined()
    expect(findCertifiedEvmSchemaSpec(1, TO, `0xdeadbeef${DATA.slice(10)}`)).toBeUndefined()
  })

  it('matches the privacy-preserving call shape without argument values', () => {
    expect(findCertifiedEvmSchemaByShape(1, TO, '0x49290c1c', 68)?.method).toBe('bridgeDeposit')
    expect(findCertifiedEvmSchemaByShape(1, TO, '0x49290c1c', 100)).toBeUndefined()
    expect(findCertifiedEvmSchemaByShape(1, TO, '0xdeadbeef', 68)).toBeUndefined()
  })

  it('serializes and bounds the firmware-owned Portals dynamic decoder', () => {
    const spec = findCertifiedEvmSchemaByShape(1, PORTALS, '0xa2e42c65', 1476)
    expect(spec?.method).toBe('Portals swap')
    expect(findCertifiedEvmSchemaByShape(1, PORTALS, '0xa2e42c65', 1477)).toBeUndefined()
    expect(findCertifiedEvmSchemaByShape(1, PORTALS, '0xa2e42c65', 16_420)).toBeUndefined()
    const body = buildEvmSchemaBody(spec!)
    expect(body[0]).toBe(0x04)
    expect(body.includes(Buffer.from('Portals swap', 'ascii'))).toBe(true)
    expect(body[body.length - 1]).toBe(CERTIFIED_METADATA_KEY_ID)
  })

  it('selects the firmware-owned Across decoder for its non-padded ABI shape', () => {
    const spec = findCertifiedEvmSchemaByShape(42161, ACROSS, '0x7b939232', 429)
    expect(spec?.method).toBe('Across bridge')
    expect(spec?.decoder).toBe(2)
    expect(findCertifiedEvmSchemaByShape(1, ACROSS, '0x7b939232', 429)).toBeUndefined()
    expect(findCertifiedEvmSchemaByShape(42161, ACROSS, '0x7b939232', 419)).toBeUndefined()
    expect(findCertifiedEvmSchemaByShape(42161, ACROSS, '0x7b939232', 1025)).toBeUndefined()
    const body = buildEvmSchemaBody(spec!)
    expect(body[0]).toBe(0x04)
    expect(body.includes(Buffer.from('Across bridge', 'ascii'))).toBe(true)
  })
})

describe('reviewed ERC-20 token schemas', () => {
  const { REVIEWED_EVM_TOKENS, findReviewedTokenSchema, findCertifiedEvmSchemaByShape: byShape, buildEvmSchemaBody: body } =
    require('./evm-certified-schema') as typeof import('./evm-certified-schema')

  it('serializes approve and transfer for every reviewed token under the firmware intent rules', () => {
    for (const key of Object.keys(REVIEWED_EVM_TOKENS)) {
      const [chainId, contract] = key.split(':')
      for (const selector of ['0x095ea7b3', '0xa9059cbb']) {
        const spec = byShape(Number(chainId), contract, selector, 68)!
        expect(spec.chainId).toBe(Number(chainId))
        expect(() => body(spec)).not.toThrow()
      }
    }
  })

  it('lays out the Base USDC approve exactly as the v0x05 format', () => {
    const b = body(findReviewedTokenSchema(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x095ea7b3', 68)!)
    let o = 0
    const take = (n: number) => b.subarray(o, (o += n))
    expect(take(1)[0]).toBe(0x05)
    expect(take(4).readUInt32BE(0)).toBe(8453)
    expect(take(20).toString('hex')).toBe('833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    expect(take(4).toString('hex')).toBe('095ea7b3')
    expect(take(take(2).readUInt16BE(0)).toString()).toBe('approve')
    expect(take(1)[0]).toBe(2) // args
    expect(take(take(1)[0]).toString()).toBe('Spender')
    expect([...take(2)]).toEqual([1, 0]) // address, role 0
    expect(take(take(1)[0]).toString()).toBe('Allowance')
    expect(take(1)[0]).toBe(5) // token amount
    expect(take(1)[0]).toBe(6) // decimals
    expect(take(take(1)[0]).toString()).toBe('USDC')
    expect(take(1)[0]).toBe(6) // role: allowance
    expect(take(1)[0]).toBe(0) // value role
    expect(take(take(1)[0]).toString()).toBe('Token approval')
    expect(take(take(1)[0]).toString()).toBe('Allow {0} to spend up to {1}; only approve apps you trust')
    expect([...take(6)]).toEqual([1, 0, 0, 0, 0, CERTIFIED_METADATA_KEY_ID])
    expect(o).toBe(b.length)
  })

  const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

  it('lays out the Base USDC Permit2 approve with the pinned spender (format 6 + 20 bytes, role 0)', () => {
    const b = body(findReviewedTokenSchema(8453, BASE_USDC, '0x095ea7b3', 68, PERMIT2.toUpperCase().replace('0X', '0x'))!)
    let o = 0
    const take = (n: number) => b.subarray(o, (o += n))
    expect(take(1)[0]).toBe(0x05)
    expect(take(4).readUInt32BE(0)).toBe(8453)
    expect(take(20).toString('hex')).toBe('833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    expect(take(4).toString('hex')).toBe('095ea7b3')
    expect(take(take(2).readUInt16BE(0)).toString()).toBe('approve')
    expect(take(1)[0]).toBe(2) // args
    expect(take(take(1)[0]).toString()).toBe('Spender')
    expect(take(1)[0]).toBe(6) // ADDRESS_PINNED
    expect(take(20).toString('hex')).toBe('000000000022d473030f116ddee9f6b43ac78ba3')
    expect(take(1)[0]).toBe(0) // role 0
    expect(take(take(1)[0]).toString()).toBe('Allowance')
    expect([...take(2)]).toEqual([5, 6]) // token amount, decimals
    expect(take(take(1)[0]).toString()).toBe('USDC')
    expect(take(1)[0]).toBe(6) // role: allowance
    expect(take(1)[0]).toBe(0) // value role
    expect(take(take(1)[0]).toString()).toBe('Uniswap')
    expect(take(take(1)[0]).toString()).toBe('Let the Uniswap approval contract spend up to {1} for trades you sign')
    expect([...take(6)]).toEqual([1, 0, 0, 0, 0, CERTIFIED_METADATA_KEY_ID])
    expect(o).toBe(b.length)
  })

  it('routes approve by spender: Permit2 pinned, any other or absent generic', () => {
    const pinned = byShape(42161, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0x095ea7b3', 68, PERMIT2)!
    expect(pinned.intent?.title).toBe('Uniswap')
    expect(pinned.args[0]).toMatchObject({ format: 6, pinned: PERMIT2 })
    for (const spender of [undefined, '0x0000000000000000000000000000000000000001']) {
      const generic = byShape(42161, '0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0x095ea7b3', 68, spender)!
      expect(generic.intent?.title).toBe('Token approval')
      expect(generic.args[0].format).toBe(1)
    }
    // transfer ignores a spender
    expect(byShape(8453, BASE_USDC, '0xa9059cbb', 68, PERMIT2)?.intent?.title).toBe('Token transfer')
    // From full calldata the spender word is read locally.
    const word = (a: string) => a.replace(/^0x/, '').padStart(64, '0')
    const approve = (spender: string) => `0x095ea7b3${word(spender)}${'f'.repeat(64)}`
    const { findCertifiedEvmSchemaSpec: fromData } = require('./evm-certified-schema') as typeof import('./evm-certified-schema')
    expect(fromData(8453, BASE_USDC, approve(PERMIT2))?.intent?.title).toBe('Uniswap')
    expect(fromData(8453, BASE_USDC, approve('0x0000000000000000000000000000000000000001'))?.intent?.title).toBe('Token approval')
    // A dirty upper word pins nothing.
    expect(fromData(8453, BASE_USDC, `0x095ea7b3ff${word(PERMIT2).slice(2)}${'f'.repeat(64)}`)?.intent?.title).toBe('Token approval')
  })

  it('every reviewed token entry reads within the firmware template rules', () => {
    for (const key of Object.keys(REVIEWED_EVM_TOKENS)) {
      const [chainId, contract] = key.split(':')
      for (const [selector, spender] of [['0x095ea7b3', PERMIT2], ['0x095ea7b3', undefined], ['0xa9059cbb', undefined]] as const) {
        const spec = byShape(Number(chainId), contract, selector, 68, spender)!
        const { title, template } = spec.intent!
        expect(title.length).toBeGreaterThanOrEqual(1)
        expect(title.length).toBeLessThanOrEqual(20)
        expect(template.length).toBeLessThanOrEqual(96)
        expect(template.replace(/\{\d\}/g, '')).not.toMatch(/[0-9%]/)
        expect(() => body(spec)).not.toThrow()
      }
    }
  })

  it('refuses pinned arguments and templates the firmware would reject', () => {
    const base = findReviewedTokenSchema(8453, BASE_USDC, '0x095ea7b3', 68, PERMIT2)!
    const withArg0 = (arg: object) => () => body({ ...base, args: [{ ...base.args[0], ...arg }, base.args[1]] })
    expect(withArg0({ pinned: undefined })).toThrow(/pinned/)
    expect(withArg0({ pinned: '0x1234' })).toThrow(/20 bytes/)
    expect(withArg0({ pinned: '000000000022d473030f116ddee9f6b43ac78ba3' })).toThrow(/20 bytes/)
    expect(withArg0({ pinned: '0x000000000022d473030f116ddee9f6b43ac78bzz' })).toThrow(/20 bytes/)
    expect(withArg0({ format: 1 })).toThrow(/pinned/) // pinned value on a plain address
    expect(withArg0({ role: 5 })).toThrow(/invalid role/)
    const intent = (template: string) => () => body({ ...base, intent: { ...base.intent!, template } })
    expect(intent('Let Uniswap Permit2 spend up to {1}')).toThrow(/number of its own/)
    expect(intent('Let Uniswap spend your tokens')).toThrow(/must state amount Allowance/)
    expect(intent('Let {0} spend up to {1}')).not.toThrow() // a pinned address may sit in the sentence (width 13)
    expect(intent('Spend all % of {1}')).toThrow(/will not render/)
  })

  it('certifies only exact reviewed shapes', () => {
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    expect(byShape(8453, usdc, '0x23b872dd', 100)).toBeUndefined() // transferFrom
    expect(byShape(8453, usdc, '0x095ea7b3', 100)).toBeUndefined() // trailing calldata
    expect(byShape(42161, usdc, '0x095ea7b3', 68)).toBeUndefined() // other chain
    expect(byShape(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0x095ea7b3', 68)).toBeUndefined() // mainnet: firmware token table
  })
})

describe('Relay depositErc20 (one entry per reviewed token)', () => {
  const relay = require('../../__tests__/fixtures/relay/depository-deposits.json').transactions as Array<{ chainId: number; hash: string; data: string }>
  const { evmEntryId, relayErc20DepositEntries, validateEvmIntent } = require('./evm-certified-schema')

  it('selects the entry from the real calldata token word and pins it', () => {
    const base = relay.find((t) => t.hash.startsWith('0xb397762233'))!
    const spec = findCertifiedEvmSchemaSpec(8453, TO, base.data)!
    expect(spec.method).toBe('depositErc20')
    expect(spec.args.map((a) => a.name)).toEqual(['depositor', 'token', 'amount', 'orderId'])
    expect(spec.args[1].pinned).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    expect(spec.args[2]).toMatchObject({ symbol: 'USDC', decimals: 6, role: 3 })
    expect(spec.intent).toMatchObject({ title: 'Relay', template: 'Bridge {2} through Relay for {0}; delivery is by Relay', valueRole: 0 })
    expect(evmEntryId(spec)).toBe(`eip155:8453:${TO}:0xe8017952:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`)
    const body = buildEvmSchemaBody(spec)
    expect(body[0]).toBe(0x05)
    // v0x05 arg block: name, format 6 + 20 pinned bytes, role 0.
    expect(body.toString('hex')).toContain(`05${Buffer.from('token').toString('hex')}06${spec.args[1].pinned!.slice(2)}00`)
  })

  it('refuses unreviewed tokens, trailing bytes, dirty words and other chains', () => {
    for (const t of relay.filter((t) => t.data.startsWith('0xe8017952'))) {
      const width = (t.data.length - 2) / 2
      const spec = findCertifiedEvmSchemaSpec(t.chainId, TO, t.data)
      // Ethereum has no reviewed tokens; Arbitrum USDC and Base USDC do.
      if (width !== 132 || t.chainId === 1) expect(spec).toBeUndefined()
      else expect(spec?.method).toBe('depositErc20')
    }
    const base = relay.find((t) => t.hash.startsWith('0xb397762233'))!
    const dirty = `${base.data.slice(0, 74)}ff${base.data.slice(76)}`
    expect(findCertifiedEvmSchemaSpec(8453, TO, dirty)).toBeUndefined()
    expect(findCertifiedEvmSchemaSpec(10, TO, base.data)).toBeUndefined()
    expect(findCertifiedEvmSchemaSpec(8453, '0x1111111111111111111111111111111111111111', base.data)).toBeUndefined()
    expect(findCertifiedEvmSchemaByShape(8453, TO, '0xe8017952', 132)).toBeUndefined()
  })

  it('every entry serializes and passes the firmware intent rules', () => {
    const entries = relayErc20DepositEntries()
    expect(entries).toHaveLength(11)
    for (const spec of entries) {
      expect(() => validateEvmIntent(spec, spec.intent!)).not.toThrow()
      expect(buildEvmSchemaBody(spec).length).toBeLessThan(200)
    }
  })

  it('depositNative on Base and Arbitrum uses the Ethereum description under the ABI name', () => {
    for (const chainId of [8453, 42161]) {
      const spec = findCertifiedEvmSchemaSpec(chainId, TO, DATA)!
      expect(spec.method).toBe('depositNative')
      expect(spec.intent).toEqual({ ...CERTIFIED_EVM_CATALOG[`1:${TO}:0x49290c1c`].intent!, valueRole: 3 })
      expect(buildEvmSchemaBody(spec)[0]).toBe(0x05)
    }
  })
})
