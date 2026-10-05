import { describe, expect, it } from 'bun:test'
import bs58 from 'bs58'

import worker from './index'
import { syntheticPumpBuy } from '../../scripts/fixtures/solana-pump'
import { editSolanaTx } from '../../scripts/fixtures/solana-message'
import joinFixture from '../../__tests__/fixtures/solana/soltoshidice-blackjack-join.json'
import ceeloFixture from '../../__tests__/fixtures/solana/soltoshidice-ceelo-bet.json'
import pokerRegistrationFixture from '../../__tests__/fixtures/solana/soltoshidice-register-poker-tournament.json'
import livePokerFixture from '../../__tests__/fixtures/solana/soltoshidice-live-poker-session.json'

type Ix = { programIdIndex: number; accountIndices: number[]; data: Buffer }

/** Re-serialize the real legacy SoltoshiDICE join, optionally edited. */
const soltoshidiceJoin = (mutate?: (instructions: Ix[]) => void): string =>
  editSolanaTx(joinFixture.rawTxBase64, (m) => mutate?.(m.instructions))

/** Re-serialize the real legacy SoltoshiDICE Cee-lo bet, optionally edited. */
const soltoshidiceCeeloBet = (mutate?: (instructions: Ix[]) => void): string =>
  editSolanaTx(ceeloFixture.rawTxBase64, (m) => mutate?.(m.instructions))

const fetchWorker = (path: string, init?: RequestInit, env: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://clearsign.example${path}`, init), env)

function relayLegacyTx(options: { extraDataByte?: boolean; wrongProgram?: boolean } = {}): string {
  const program = options.wrongProgram
    ? Buffer.alloc(32, 0x77)
    : Buffer.from(bs58.decode('99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2'))
  const data = Buffer.concat([
    Buffer.from('0d9e0ddf5fd51c06', 'hex'),
    Buffer.alloc(8, 0x01),
    Buffer.alloc(32, 0x02),
    ...(options.extraDataByte ? [Buffer.from([0xff])] : []),
  ])
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]),
    Buffer.from([5]),
    Buffer.alloc(32, 0x10),
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x12),
    Buffer.alloc(32, 0x13),
    program,
    Buffer.alloc(32, 0x20),
    Buffer.from([1, 4, 4, 0, 1, 2, 3, data.length]),
    data,
  ])
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64')
}

const post = (path: string, body: unknown, env: Record<string, string> = {}) => fetchWorker(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}, env)

describe('ClearSign Worker public surface', () => {
  it('reports online but fail-closed until at least one scope is provisioned', async () => {
    const health = await (await fetchWorker('/health')).json() as any
    expect(health.ok).toBe(true)
    expect(health.ready).toBe(false)

    const ready = await fetchWorker('/ready')
    expect(ready.status).toBe(503)
    const status = await (await fetchWorker('/v1/status')).json() as any
    expect(status.status).toBe('provisioning')
    expect(status.scopes).toEqual({ ethereum: 'provisioning', solana: 'provisioning', evmChains: [] })
    expect(status.privacy.note).toContain('unsigned transaction')
  })

  it('publishes human-readable provenance for Ethereum and Solana flows', async () => {
    const response = await fetchWorker('/v1/catalog')
    const body = await response.json() as any
    expect(response.status).toBe(200)
    expect(body.entries).toHaveLength(72)
    expect(body.entries.filter((entry: any) => entry.family === 'evm')).toHaveLength(45)
    expect(body.entries.filter((entry: any) => entry.protocol === 'Uniswap')).toHaveLength(9)
    expect(body.entries.filter((entry: any) => entry.protocol === 'ERC-20')).toHaveLength(33)
    expect(body.entries.filter((entry: any) => entry.family === 'solana')).toHaveLength(27)
    for (const entry of body.entries) {
      expect(['Relay', 'Portals', 'Across', 'Pump', 'SoltoshiDICE', 'ERC-20', 'Uniswap']).toContain(entry.protocol)
      expect(entry.provenance.protocol).toMatch(/^https:\/\//)
    }
    const join = body.entries.find((entry: any) => entry.id === 'solana:soltoshidiceBlackjackJoin')
    expect(join.instructionLength).toBe(82)
    expect(join.discriminator).toBe('51')
    // The Cee-lo bet: what the device will put on screen, in plain words.
    const ceelo = body.entries.find((entry: any) => entry.id === 'solana:soltoshidiceCeeloBet')
    expect(ceelo.instructionLength).toBe(26)
    expect(ceelo.discriminator).toBe('36')
    expect(ceelo.method).toBe('Cee-lo place bet')
    expect(ceelo.action).toContain('refundable SOL deposit')
    expect(ceelo.fieldsShownByKeepKey).toEqual(['Round', 'Wager', 'Protocol', 'SOL deposit'])
    const registration = body.entries.find((entry: any) => entry.id === 'solana:soltoshidiceRegisterPokerTournament')
    expect(registration.instructionLength).toBe(8)
    expect(registration.method).toBe('Register tournament')
    expect(registration.fieldsShownByKeepKey).toEqual(['Player', 'Arena', 'Tournament'])
  })

  it('publishes the exact device screens for every EVM entry', async () => {
    const body = await (await fetchWorker('/v1/catalog')).json() as any
    const evm = body.entries.filter((entry: any) => entry.family === 'evm')
    expect(new Set(evm.map((entry: any) => entry.id)).size).toBe(evm.length)
    const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    const permit2 = evm.find((entry: any) => entry.id === `eip155:8453:${usdc}:0x095ea7b3:permit2`)
    expect(permit2.spender).toBe('0x000000000022d473030f116ddee9f6b43ac78ba3')
    expect(permit2.screens.map((screen: any) => screen.title)).toEqual(['Uniswap', 'Limits', 'Contract', 'Spender', 'KeepKey ClearSign'])
    expect(permit2.screens[0].body).toBe('Let the Uniswap approval contract spend up to 25 USDC for trades you sign')
    expect(permit2.screens[0].unlimited).toBe('Let the Uniswap approval contract spend up to UNLIMITED USDC for trades you sign')
    expect(permit2.screens[1]).toMatchObject({ body: 'Can spend up to\n25 USDC', unlimited: 'Can spend up to\nUNLIMITED USDC' })
    expect(permit2.screens[3].body).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
    expect(permit2.screens[4].body).toBe('Described by KeepKey Alpha 716 a9531b9d\ncertified by KeepKey')
    const generic = evm.find((entry: any) => entry.id === `eip155:8453:${usdc}:0x095ea7b3`)
    expect(generic.screens[0].body).toBe('Allow 0x909E...F82E to spend up to 25 USDC; only approve apps you trust')
    const transfer = evm.find((entry: any) => entry.id === `eip155:8453:${usdc}:0xa9059cbb`)
    expect(transfer.screens.map((screen: any) => [screen.title, screen.body])).toEqual([
      ['Token transfer', 'Send 25 USDC to 0x909E...F82E'],
      ['Limits', 'You spend\n25 USDC'],
      ['Contract', 'transfer\n0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
      ['Recipient', '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'],
      ['KeepKey ClearSign', 'Described by KeepKey Alpha 716 a9531b9d\ncertified by KeepKey'],
    ])
    // Portals carries no intent and has no 7.16 decoder: no screens, flagged.
    const portals = evm.find((entry: any) => entry.protocol === 'Portals')
    expect(portals.screens).toEqual([])
    expect(portals.screensNote).toContain('cannot verify on 7.16')
    // Across is the same kind of decoder-only (no intent) entry.
    const across = evm.find((entry: any) => entry.protocol === 'Across')
    expect(across.screens).toEqual([])
    expect(across.screensNote).toContain('cannot verify on 7.16')
    for (const entry of evm.filter((e: any) => e.protocol !== 'Portals' && e.protocol !== 'Across')) expect(entry.screens.length).toBeGreaterThan(3)
  })

  it('EXPECTED-SCREENS.md states every Base USDC screen the catalog publishes', async () => {
    const doc = await Bun.file(new URL('../EXPECTED-SCREENS.md', import.meta.url)).text()
    const body = await (await fetchWorker('/v1/catalog')).json() as any
    const usdc = body.entries.filter((entry: any) => entry.id?.startsWith('eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:'))
    expect(usdc).toHaveLength(3)
    for (const entry of usdc) {
      expect(doc).toContain(entry.template)
      for (const screen of entry.screens) {
        for (const text of [screen.body, screen.unlimited].filter(Boolean)) {
          for (const line of text.split('\n')) expect(doc).toContain(line)
        }
      }
    }
  })

  it('routes an approve by its spender and rejects a malformed spender', async () => {
    const baseUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const shape = { chainId: 8453, contract: baseUsdc, selector: '0x095ea7b3', calldataLength: 68 }
    const entry = async (extra: object) => (await (await post('/v1/evm/schema', { ...shape, ...extra })).json() as any).entry
    const id = `eip155:8453:${baseUsdc.toLowerCase()}:0x095ea7b3`
    expect(await entry({ spender: '0x000000000022D473030F116dDEE9F6B43aC78BA3' })).toBe(`${id}:permit2`)
    expect(await entry({ spender: '0x0000000000000000000000000000000000000001' })).toBe(id)
    expect(await entry({})).toBe(id)
    for (const spender of ['0x1234', 'not-an-address', 42]) {
      expect((await post('/v1/evm/schema', { ...shape, spender })).status).toBe(400)
    }
    const status = await (await fetchWorker('/v1/status')).json() as any
    expect(status.privacy.ethereumRequest).toContain('spender (ERC-20 approve only, optional)')
  })

  it('rejects unknown EVM shapes before checking signer readiness', async () => {
    const response = await post('/v1/evm/schema', {
      chainId: 1,
      contract: '0x0000000000000000000000000000000000000001',
      selector: '0x49290c1c',
      calldataLength: 68,
    })
    expect(response.status).toBe(422)
  })

  it('returns unavailable for an exact reviewed EVM shape without signing', async () => {
    const response = await post('/v1/evm/schema', {
      chainId: 1,
      contract: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
      selector: '0x49290c1c',
      calldataLength: 68,
    })
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
  })

  it('lists one Uniswap swap entry per reviewed router, with the device review', async () => {
    const body = await (await fetchWorker('/v1/catalog')).json() as any
    const router = '0x6ff5693b99212da76ad316178a184ab56d299b43'
    const entry = body.entries.find((e: any) => e.id === `eip155:8453:${router}:uniswap-ur`)
    expect(entry).toMatchObject({ family: 'evm', protocol: 'Uniswap', network: 'Base', method: 'execute', contract: router, selectors: ['0x3593564c', '0x24856bc3'] })
    expect(entry.decoder).toMatchObject({ id: 1, innerVersion: 7 })
    expect(entry.provenance.deployment).toContain('base.json UniversalRouterV2')
    expect(entry.screens.map((s: any) => s.title)).toEqual(['Uniswap', 'Limits', 'Limits', 'Recipient', 'Allowance', 'Fee', 'Contract', 'KeepKey ClearSign'])
    expect(entry.screens[0]).toMatchObject({ body: 'Swap {in} for at least {out}', exactOut: 'Swap at most {in} for {out}' })
    expect(entry.screens[6].body).toBe('execute\n0x6fF5693b99212Da76ad316178A184AB56D299b43')
    for (const s of entry.screens.filter((s: any) => ['Recipient', 'Allowance', 'Fee'].includes(s.title))) expect(s.when).toBeTruthy()
    // V4 (and its hook screens) only through UR 2.1.2 on Base.
    expect(entry.supportedShape).toContain('V4_SWAP refused')
    const v4 = body.entries.find((e: any) => e.id === 'eip155:8453:0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40:uniswap-ur')
    expect(v4.screens.map((s: any) => s.title)).toEqual(['Uniswap', 'Limits', 'Limits', 'Recipient', 'Allowance', 'Fee', 'Pool hook', 'Contract', 'KeepKey ClearSign'])
    expect(v4.screens[6]).toMatchObject({ body: 'The swap runs this hook contract\n{hook, full EIP-55}', numbered: 'Pool hook {i}/{n}' })
    expect(v4.supportedShape).toContain('V4_SWAP: SWAP_EXACT_IN/OUT')
    expect(v4.calldataLength).not.toHaveProperty('max')
    const status = await (await fetchWorker('/v1/status')).json() as any
    expect(status.endpoints.evmSwap).toBe('https://clearsign.example/v1/evm/swap')
  })

  it('EXPECTED-SCREENS.md states every Uniswap swap screen the catalog publishes', async () => {
    const doc = await Bun.file(new URL('../EXPECTED-SCREENS.md', import.meta.url)).text()
    const body = await (await fetchWorker('/v1/catalog')).json() as any
    for (const entry of body.entries.filter((e: any) => e.id.endsWith(':uniswap-ur'))) for (const screen of entry.screens) {
      for (const text of [screen.body, screen.exactOut, screen.unlimited, screen.numbered].filter(Boolean)) {
        for (const line of text.split('\n')) expect(doc).toContain(line)
      }
    }
  })

  it('certifies a Uniswap swap only for a reviewed router, selector, and reviewed tokens', async () => {
    const shape = { chainId: 8453, contract: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', selector: '0x3593564c' }
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const WETH = '0x4200000000000000000000000000000000000006'
    // Exact reviewed shape: refused only for lack of the chain's certificate.
    const ok = await post('/v1/evm/swap', { ...shape, tokens: [USDC, WETH] })
    expect(ok.status).toBe(503)
    expect(await ok.json()).toMatchObject({ classification: 'UNAVAILABLE', entry: 'eip155:8453:0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad:uniswap-ur' })
    expect((await post('/v1/evm/swap', { ...shape, selector: '0x24856bc3', tokens: [USDC] })).status).toBe(503)
    // UR 2.1.2, the router the Uniswap app sends to, is reviewed.
    expect((await post('/v1/evm/swap', { ...shape, contract: '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40', tokens: [USDC] })).status).toBe(503)
    for (const bad of [
      { ...shape, contract: '0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7', tokens: [USDC] }, // UR 2.1.1: not reviewed
      { ...shape, chainId: 42161, tokens: [USDC] }, // the UR 1.2 address is not the Arbitrum one
      { ...shape, selector: '0x095ea7b3', tokens: [USDC] },
      { ...shape, tokens: ['0x41b481c3d2e3960f8f312212adfeecf6ce7c35ef'] }, // unreviewed token
      { ...shape, tokens: [USDC, USDC] },
      { ...shape, tokens: [] },
      { ...shape, tokens: [USDC, WETH, '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'] },
    ]) {
      const response = await post('/v1/evm/swap', bad)
      expect(response.status).toBe(422)
      expect((await response.json() as any).classification).toBe('OPAQUE')
    }
    for (const tokens of [undefined, 'x', ['0x1234'], [42]]) {
      expect((await post('/v1/evm/swap', { ...shape, tokens })).status).toBe(400)
    }
    // A malformed certificate map provisions nothing: still 503, never a signature.
    const env = { CLEARSIGN_EVM_CERTIFICATES_JSON: JSON.stringify({ 8453: 'not-a-certificate' }) }
    expect((await post('/v1/evm/swap', { ...shape, tokens: [USDC] }, env)).status).toBe(503)
  })

  it('names only reviewed Universal Router deployments, and signs nothing unprovisioned', async () => {
    const unknown = await post('/v1/evm/name', { chainId: 1, address: '0x0000000000000000000000000000000000000001' })
    expect(unknown.status).toBe(422)
    const router = await post('/v1/evm/name', { chainId: 1, address: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af' })
    expect(router.status).toBe(503)
    // A deployment on one chain is not a name on another.
    const wrongChain = await post('/v1/evm/name', { chainId: 8453, address: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af' })
    expect(wrongChain.status).toBe(422)
  })

  it('recognizes reviewed ERC-20 approve/transfer by exact address, and signs nothing without that chain\'s certificate', async () => {
    const baseUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    const approve = await post('/v1/evm/schema', { chainId: 8453, contract: baseUsdc, selector: '0x095ea7b3', calldataLength: 68 })
    expect(approve.status).toBe(503)
    expect((await approve.json() as any).error).toContain('chain 8453')
    const transfer = await post('/v1/evm/schema', { chainId: 8453, contract: baseUsdc, selector: '0xa9059cbb', calldataLength: 68 })
    expect(transfer.status).toBe(503)
    // Same address on another chain, transferFrom, trailing calldata, an unlisted token: not reviewed.
    for (const shape of [
      { chainId: 42161, contract: baseUsdc, selector: '0x095ea7b3', calldataLength: 68 },
      { chainId: 8453, contract: baseUsdc, selector: '0x23b872dd', calldataLength: 100 },
      { chainId: 8453, contract: baseUsdc, selector: '0x095ea7b3', calldataLength: 100 },
      { chainId: 8453, contract: '0x0000000000000000000000000000000000000001', selector: '0x095ea7b3', calldataLength: 68 },
    ]) {
      expect((await post('/v1/evm/schema', shape)).status).toBe(422)
    }
  })

  it('never lets an Ethereum certificate stand in for another chain', async () => {
    // A malformed or wrong-scope map entry provisions nothing for that chain.
    const env = { CLEARSIGN_EVM_CERTIFICATES_JSON: JSON.stringify({ 8453: 'not-a-certificate' }) }
    const status = await (await fetchWorker('/v1/status', undefined, env)).json() as any
    expect(status.scopes.evmChains).toEqual([])
    const broken = await (await fetchWorker('/v1/status', undefined, { CLEARSIGN_EVM_CERTIFICATES_JSON: '{' })).json() as any
    expect(broken.status).toBe('provisioning')
  })

  it('catalogs the exact Arbitrum USDT Permit2 approval but fails closed without provisioning', async () => {
    const response = await post('/v1/evm/schema', {
      chainId: 42161,
      contract: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      selector: '0x095ea7b3',
      calldataLength: 68,
    })
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
  })

  it('recognizes the dynamic Portals shape but rejects non-word-aligned calldata', async () => {
    const exact = await post('/v1/evm/schema', {
      chainId: 1,
      contract: '0xbf5A7F3629fB325E2a8453D595AB103465F75E62',
      selector: '0xa2e42c65',
      calldataLength: 1476,
    })
    expect(exact.status).toBe(503)
    const malformed = await post('/v1/evm/schema', {
      chainId: 1,
      contract: '0xbf5A7F3629fB325E2a8453D595AB103465F75E62',
      selector: '0xa2e42c65',
      calldataLength: 1477,
    })
    expect(malformed.status).toBe(422)
  })

  it('parses and exact-matches a reviewed Solana instruction before provisioning', async () => {
    const response = await post('/v1/solana/certify', {
      rawTx: relayLegacyTx(),
      catalogKey: 'relayDepositNative',
    })
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
  })

  it('without a catalog key, certifies a Pump buy only when firmware will apply the schema', async () => {
    // 9 instructions with the signer's own WSOL create, sync and close: the
    // device applies the schema, so it reaches provisioning.
    const full = await post('/v1/solana/certify', { rawTx: syntheticPumpBuy().rawTx })
    expect(full.status).toBe(503)
    // Closing the wrapped SOL to a non-signer: the device would refuse a
    // certified envelope, so it stays opaque.
    const stranger = editSolanaTx(syntheticPumpBuy().rawTx, (m) => { m.instructions[8].accountIndices = [5, 6, 0] })
    const refused = await post('/v1/solana/certify', { rawTx: stranger })
    expect(refused.status).toBe(422)
    expect((await refused.json() as any).classification).toBe('OPAQUE')
    // The same buy beside ComputeBudget only is still discovered from its bytes.
    const bare = editSolanaTx(syntheticPumpBuy().rawTx, (m) => { m.instructions = [m.instructions[0], m.instructions[7]] })
    const response = await post('/v1/solana/certify', { rawTx: bare })
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
    // An explicit catalog key keeps its existing behavior.
    expect((await post('/v1/solana/certify', { rawTx: syntheticPumpBuy().rawTx, catalogKey: 'pumpAmmBuy' })).status).toBe(503)
  })

  it('rejects Pump layout, bool, fixed-program, and explicit catalog mismatches', async () => {
    for (const options of [{ invalidBoolean: true }, { wrongFeeProgram: true }, { extraData: true }]) {
      expect((await post('/v1/solana/certify', { rawTx: syntheticPumpBuy(undefined, options).rawTx, catalogKey: 'pumpAmmBuy' })).status).toBe(422)
    }
    expect((await post('/v1/solana/certify', { rawTx: syntheticPumpBuy().rawTx, catalogKey: 'relayDepositNative' })).status).toBe(422)
  })

  it('discovers the real SoltoshiDICE join from raw bytes without a client catalog key', async () => {
    expect(soltoshidiceJoin()).toBe(joinFixture.rawTxBase64)
    const response = await post('/v1/solana/certify', { rawTx: joinFixture.rawTxBase64 })
    // Reached provisioning: the program, 0x51 tag, and exact 82-byte length matched.
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
    expect((await post('/v1/solana/certify', { rawTx: joinFixture.rawTxBase64, catalogKey: 'soltoshidiceBlackjackJoin' })).status).toBe(503)
  })

  it('refuses SoltoshiDICE joins that the reviewed schema does not describe exactly', async () => {
    const join = (ixs: Ix[]) => ixs[2]
    for (const mutate of [
      (ixs: Ix[]) => { join(ixs).data = Buffer.concat([join(ixs).data, Buffer.from([0])]) }, // uncovered byte
      (ixs: Ix[]) => { join(ixs).data = join(ixs).data.subarray(0, 81) }, // short
      (ixs: Ix[]) => { join(ixs).data[0] = 0x50 }, // another instruction tag
      (ixs: Ix[]) => { join(ixs).accountIndices = join(ixs).accountIndices.slice(0, 3) }, // no mint account 3
      (ixs: Ix[]) => { ixs.push({ ...join(ixs) }) }, // two joins: firmware would refuse the ambiguity
    ]) {
      const response = await post('/v1/solana/certify', { rawTx: soltoshidiceJoin(mutate) })
      expect(response.status).toBe(422)
      expect((await response.json() as any).classification).toBe('OPAQUE')
    }
    expect((await post('/v1/solana/certify', { rawTx: joinFixture.rawTxBase64, catalogKey: 'pumpAmmBuy' })).status).toBe(422)
  })

  it('without a catalog key, refuses a SoltoshiDICE join beside an ATA created for another owner', async () => {
    const withAtaCreate = editSolanaTx(joinFixture.rawTxBase64, (m) => {
      m.staticAccounts.push(Buffer.from(bs58.decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')))
      m.header[2]++
      m.instructions.splice(2, 0, { programIdIndex: m.staticAccounts.length - 1, accountIndices: [0, 6, 6, 8, 7, 12], data: Buffer.from([1]) })
    })
    const response = await post('/v1/solana/certify', { rawTx: withAtaCreate })
    expect(response.status).toBe(422)
    expect((await response.json() as any).classification).toBe('OPAQUE')
    expect((await post('/v1/solana/certify', { rawTx: withAtaCreate, catalogKey: 'soltoshidiceBlackjackJoin' })).status).toBe(503)
  })

  it('discovers the real SoltoshiDICE Cee-lo bet from raw bytes, and not as the join', async () => {
    expect(soltoshidiceCeeloBet()).toBe(ceeloFixture.rawTxBase64)
    // Reached provisioning: the program, 0x36 tag, and exact 26-byte length
    // matched, beside a ComputeBudget SetComputeUnitLimit companion.
    const response = await post('/v1/solana/certify', { rawTx: ceeloFixture.rawTxBase64 })
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
    expect((await post('/v1/solana/certify', { rawTx: ceeloFixture.rawTxBase64, catalogKey: 'soltoshidiceCeeloBet' })).status).toBe(503)
    // The two SoltoshiDICE entries share a program, so neither may claim the
    // other's instruction.
    expect((await post('/v1/solana/certify', { rawTx: ceeloFixture.rawTxBase64, catalogKey: 'soltoshidiceBlackjackJoin' })).status).toBe(422)
    expect((await post('/v1/solana/certify', { rawTx: joinFixture.rawTxBase64, catalogKey: 'soltoshidiceCeeloBet' })).status).toBe(422)
  })

  it('discovers the captured poker registration from raw bytes', async () => {
    const response = await post('/v1/solana/certify', { rawTx: pokerRegistrationFixture.rawTxBase64 })
    expect(response.status).toBe(503)
    expect((await response.json() as any).classification).toBe('UNAVAILABLE')
    expect((await post('/v1/solana/certify', {
      rawTx: pokerRegistrationFixture.rawTxBase64,
      catalogKey: 'soltoshidiceRegisterPokerTournament',
    })).status).toBe(503)
  })

  for (const [name, fixture] of Object.entries(livePokerFixture)) {
    it(`discovers the captured live poker ${name} operation`, async () => {
      const response = await post('/v1/solana/certify', { rawTx: fixture.rawTxBase64 })
      expect(response.status).toBe(503)
      expect((await response.json() as any).classification).toBe('UNAVAILABLE')
      expect((await post('/v1/solana/certify', {
        rawTx: fixture.rawTxBase64,
        catalogKey: fixture.catalogKey,
      })).status).toBe(503)
    })
  }

  it('refuses Cee-lo bets that the reviewed schema does not describe exactly', async () => {
    const bet = (ixs: Ix[]) => ixs[1]
    for (const mutate of [
      (ixs: Ix[]) => { bet(ixs).data = Buffer.concat([bet(ixs).data, Buffer.from([0])]) }, // uncovered byte
      (ixs: Ix[]) => { bet(ixs).data = bet(ixs).data.subarray(0, 25) }, // short
      (ixs: Ix[]) => { bet(ixs).data[0] = 0x29 }, // tag 41, the non-tournament bet: no entry yet
      (ixs: Ix[]) => { bet(ixs).accountIndices = bet(ixs).accountIndices.slice(0, 5) }, // no mint account 5
      (ixs: Ix[]) => { ixs.push({ ...bet(ixs) }) }, // two bets: firmware would refuse the ambiguity
    ]) {
      const response = await post('/v1/solana/certify', { rawTx: soltoshidiceCeeloBet(mutate) })
      expect(response.status).toBe(422)
      expect((await response.json() as any).classification).toBe('OPAQUE')
    }
  })

  it('refuses malformed, wrong-program, wrong-length, and unknown Solana requests', async () => {
    expect((await post('/v1/solana/certify', { rawTx: 'not base64', catalogKey: 'relayDepositNative' })).status).toBe(422)
    expect((await post('/v1/solana/certify', { rawTx: relayLegacyTx({ wrongProgram: true }), catalogKey: 'relayDepositNative' })).status).toBe(422)
    expect((await post('/v1/solana/certify', { rawTx: relayLegacyTx({ extraDataByte: true }), catalogKey: 'relayDepositNative' })).status).toBe(422)
    expect((await post('/v1/solana/certify', { rawTx: relayLegacyTx(), catalogKey: 'unknown' })).status).toBe(422)
  })

  it('exposes a plain-language service page without claiming Solana transaction privacy', async () => {
    const response = await fetchWorker('/')
    const html = await response.text()
    expect(html).toContain('unsigned transaction')
    expect(html).toContain('You still approve the final transaction on the device')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
  })
})
