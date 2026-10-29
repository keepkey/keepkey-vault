/**
 * THORChain/Maya deposits on the approval card, from REAL requests:
 * router deposits KeepKey Desktop signed (owner wallet, realworld replay) and
 * two third-party ones, each with the Asgard vault list the network published
 * the block before it saw the deposit; native MsgDeposit swaps rebuilt from
 * their on-chain transactions. Sources are in each fixture's _source.
 *
 * Firmware 7.16 shows every router deposit as "Pays UNVERIFIED vault <hex>".
 * Desktop names the vault calmly only when every source lists it as an active
 * vault for that router, and the memo pays out to the user's own address.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SigningRequestInfo } from '../src/shared/types'
import fixtures from './fixtures/thorchain/router-deposits.json'
import natives from './fixtures/thorchain/native-deposits.json'

const dir = mkdtempSync(join(tmpdir(), 'vault-thor-deposit-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const { applyEvmTxPreview } = await import('../src/bun/evm-signing-preview')
const { addThorDepositFacts, checkThorVault, VAULT_SOURCES } = await import('../src/bun/thor-vaults')
const { assessSigningRisk } = await import('../src/shared/clearsign-risk')
const { addContractFacts } = await import('../src/bun/contract-facts')
const { CHAINS } = await import('../src/shared/chains')

beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

type Deposit = (typeof fixtures.deposits)[number]
const byName = (prefix: string) => fixtures.deposits.find((d) => d.name.startsWith(prefix))!
const OWN_ETH = byName('ETH -> ETH.USDT')
const OWN_BASE = byName('Base ETH')
const AVAX = byName('Avalanche')
const TO_BTC = byName('ETH -> BTC.BTC')
const TO_RUNE = byName('ETH -> THOR.RUNE')
const MAYA_ETH = byName('Maya: ETH')
const BSC = byName('BSC BNB')
const MAYA_ARB = byName('Maya: Arbitrum')
const RETIRED_LATER = byName('Base ETH -> ETH.USDT, vault 0x587c')
const vaultOf = (d: Deposit) => `0x${d.data.slice(34, 74)}`
const network = (id: string) => CHAINS.find((c) => c.id === id)!.networkId
const lists = (protocol: 'THORChain' | 'Mayachain') => Object.entries(fixtures.vaultsNow[protocol]) as [string, unknown][]

/** Every source answers with this list (history is served by one node per network). */
const all = (list: unknown) => async () => list
/** The two lists each network's sources returned on 2026-10-29. */
const now = (protocol: 'THORChain' | 'Mayachain') => async (url: string) => {
  expect(VAULT_SOURCES[protocol]).toContain(url)
  return Object.fromEntries(lists(protocol))[url]
}

async function card(d: Deposit, fetchJson: (url: string) => Promise<unknown>, isOwn?: typeof db.isOwnAddress, data = d.data) {
  const info: SigningRequestInfo = {
    id: d.txid, method: '/eth/sign-transaction', appName: 'KeepKey Desktop',
    from: d.from, to: d.to, value: d.value, data, chainId: d.chainId, firmwareVersion: '7.16.0',
  }
  await applyEvmTxPreview(info, d.to, data, d.chainId, '7.16.0')
  await addThorDepositFacts(info, 'dev', { fetchJson, isOwn })
  return info
}
const texts = (s: SigningRequestInfo) => assessSigningRisk(s)!.reasons.map((r) => r.text).join('\n')

describe('router deposits KeepKey Desktop signed', () => {
  test('to an active vault, paying the signer: green, vault named', async () => {
    for (const d of [OWN_ETH, OWN_BASE]) {
      const s = await card(d, all(d.vaults))
      expect(s.deviceClearSigns).toBe(true)
      expect(s.thorVault).toEqual({ status: 'current', protocol: 'THORChain', chain: d.chainId === 1 ? 'ETH' : 'BASE', sources: 2 })
      const r = assessSigningRisk(s)!
      expect(r.tier).toBe('green')
      expect(r.level).toBe('low')
      expect(texts(s)).toContain(`Pays vault ${vaultOf(d)}, one of THORChain's active ${s.thorVault!.chain} vaults in all 2 THORChain sources this computer asked.`)
      expect(texts(s)).toContain('one of your own addresses.')
    }
  })

  test('CONTROL: the same real deposits against vaults retired since then are red', async () => {
    for (const d of [AVAX, TO_BTC, TO_RUNE]) {
      // At its own height every one was an active vault.
      expect((await card(d, all(d.vaults))).thorVault!.status).toBe('current')
      const s = await card(d, now('THORChain'))
      expect(s.thorVault!.status).toBe('not-current')
      expect(assessSigningRisk(s)!.tier).toBe('red')
      expect(assessSigningRisk(s)!.level).toBe('critical')
      expect(texts(s)).toContain(`Pays vault ${vaultOf(d)}, which is NOT one of THORChain's active`)
    }
  })

  test('CONTROL: a real deposit with its vault word swapped for another address is red', async () => {
    const ATTACKER = '1111111111111111111111111111111111111111'
    const mutant = OWN_ETH.data.slice(0, 34) + ATTACKER + OWN_ETH.data.slice(74)
    const s = await card(OWN_ETH, all(OWN_ETH.vaults), undefined, mutant)
    expect(s.calldataDecoded?.dappName).toBe('THORChain')
    expect(s.thorVault!.status).toBe('not-current')
    expect(assessSigningRisk(s)!.tier).toBe('red')
    expect(texts(s)).toContain(`Pays vault 0x${ATTACKER}, which is NOT one of THORChain's active ETH vaults.`)
  })

  test('CONTROL: a vault the network lists only as retiring is red', async () => {
    // Active when Desktop signed it on 2026-10-10; RetiringVault after the churn a day later.
    expect((await card(RETIRED_LATER, all(RETIRED_LATER.vaults))).thorVault!.status).toBe('current')
    const s = await card(RETIRED_LATER, all(fixtures.vaultsDuringChurn.vaults))
    expect(fixtures.vaultsDuringChurn.vaults.find((v) => v.addresses.some((a) => a.address.toLowerCase() === vaultOf(RETIRED_LATER)))?.status).toBe('RetiringVault')
    expect(s.thorVault!.status).toBe('not-current')
    expect(assessSigningRisk(s)!.tier).toBe('red')
  })

  test('the router an active vault does not use is red', () => {
    const c = checkThorVault('THORChain', 8453, OWN_ETH.to, vaultOf(OWN_BASE), [OWN_BASE.vaults, OWN_BASE.vaults])
    expect(c).toEqual({ status: 'not-current', protocol: 'THORChain', chain: 'BASE', sources: 2, currentRouter: OWN_BASE.to })
  })

  test('a source that does not answer, or sources that disagree, leave it unchecked: yellow, never green', async () => {
    const one = await card(OWN_ETH, async (url) => { if (url === VAULT_SOURCES.THORChain[1]) throw new Error('offline'); return OWN_ETH.vaults })
    expect(one.thorVault).toMatchObject({ status: 'unchecked', reason: '1 of 2 sources did not answer' })
    const split = await card(TO_BTC, async (url) => url === VAULT_SOURCES.THORChain[0] ? TO_BTC.vaults : lists('THORChain')[0][1])
    expect(split.thorVault).toMatchObject({ status: 'unchecked', reason: 'the sources disagree' })
    for (const s of [one, split]) {
      const r = assessSigningRisk(s)!
      expect(r.tier).toBe('yellow')
      expect(r.level).toBe('medium')
      expect(texts(s)).toContain(`This computer could not check vault ${vaultOf(s === one ? OWN_ETH : TO_BTC)} against THORChain's active vaults`)
    }
    // A card nothing checked (a REST report, a stored review) reads the same.
    const plain: SigningRequestInfo = { id: 'r', method: '/eth/sign-transaction', appName: 'x', from: OWN_ETH.from, to: OWN_ETH.to, data: OWN_ETH.data, value: OWN_ETH.value, chainId: 1, firmwareVersion: '7.16.0' }
    await applyEvmTxPreview(plain, plain.to, plain.data, 1, '7.16.0')
    expect(assessSigningRisk(plain)!.tier).toBe('yellow')
  })

  test('payout to another chain: own address calm, not this wallet red, unknown asks to check', async () => {
    const seen: unknown[][] = []
    const ask = (answer: boolean | undefined) => (...args: Parameters<typeof db.isOwnAddress>) => { seen.push(args); return answer }
    const rune = await card(TO_RUNE, all(TO_RUNE.vaults), ask(false))
    expect(seen.pop()).toEqual(['dev', network('thorchain'), 'thor13d4tzmehhmt4r8w9s4n0g0lw7h3ggpyv9rhczx', 'cosmos'])
    expect(assessSigningRisk(rune)!.tier).toBe('red')
    expect(texts(rune)).toContain("The swap pays out to thor13d4tzmehhmt4r8w9s4n0g0lw7h3ggpyv9rhczx on THOR, which is NOT one of this wallet's addresses.")
    expect(assessSigningRisk(await card(TO_RUNE, all(TO_RUNE.vaults), ask(true)))!.tier).toBe('green')

    const btc = await card(TO_BTC, all(TO_BTC.vaults), ask(undefined))
    expect(seen.pop()).toEqual(['dev', network('bitcoin'), 'bc1q8w2ypqgx39gucxcypqv2m90wz9rvhmmrcnpdjs', 'utxo'])
    const r = assessSigningRisk(btc)!
    expect([r.tier, r.level]).toEqual(['green', 'medium'])
    expect(texts(btc)).toContain('This computer cannot tell whether bc1q8w2ypqgx39gucxcypqv2m90wz9rvhmmrcnpdjs on BTC is your address.')
  })

  test('own addresses come from this device\'s address book', () => {
    db.syncOwnAddressBook({ deviceId: 'dev', walletId: 'dev:w' }, [
      { address: 'thor13d4tzmehhmt4r8w9s4n0g0lw7h3ggpyv9rhczx', networkId: network('thorchain'), chainId: 'thorchain', chainFamily: 'cosmos', symbol: 'RUNE', label: 'RUNE' },
      { address: 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz', networkId: network('bitcoin'), chainId: 'bitcoin', chainFamily: 'utxo', symbol: 'BTC', label: 'BTC' },
    ] as any)
    expect(db.isOwnAddress('dev', network('thorchain'), 'thor13d4tzmehhmt4r8w9s4n0g0lw7h3ggpyv9rhczx', 'cosmos')).toBe(true)
    expect(db.isOwnAddress('dev', network('thorchain'), 'thor19qud0fs2lhcwr5a2l9l7uceym0cyvktf4s78c2', 'cosmos')).toBe(false)
    // An xpub lists no addresses; no entries at all is no answer either.
    expect(db.isOwnAddress('dev', network('bitcoin'), 'bc1q8w2ypqgx39gucxcypqv2m90wz9rvhmmrcnpdjs', 'utxo')).toBeUndefined()
    expect(db.isOwnAddress('dev', network('mayachain'), 'maya13d4tzmehhmt4r8w9s4n0g0lw7h3ggpyv95f55k', 'cosmos')).toBeUndefined()
    expect(db.isOwnAddress('other-device', network('thorchain'), 'thor13d4tzmehhmt4r8w9s4n0g0lw7h3ggpyv9rhczx', 'cosmos')).toBeUndefined()
  })

  test('Maya on Ethereum: vault named; its swap with no minimum stays red', async () => {
    const s = await card(MAYA_ETH, all(MAYA_ETH.vaults), () => true)
    expect(s.thorVault).toEqual({ status: 'current', protocol: 'Mayachain', chain: 'ETH', sources: 2 })
    expect(texts(s)).toContain(`Pays vault ${vaultOf(MAYA_ETH)}, one of Maya's active ETH vaults`)
    expect(texts(s)).toContain('Sets no minimum, so this swap can pay you back almost nothing.')
    expect(assessSigningRisk(s)!.tier).toBe('red')
    expect((await card(MAYA_ETH, now('Mayachain'))).thorVault!.status).toBe('not-current')
  })
})

describe('the approval card hook', () => {
  test('addContractFacts (REST and WalletConnect cards) checks the vault and the payout address', async () => {
    const real = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = (async (url: string) => { asked.push(url); return Response.json(TO_RUNE.vaults) }) as any
    try {
      const info: SigningRequestInfo = { id: 'h', method: '/eth/sign-transaction', appName: 'x', from: TO_RUNE.from, to: TO_RUNE.to, data: TO_RUNE.data, value: TO_RUNE.value, chainId: 1, firmwareVersion: '7.16.0' }
      await applyEvmTxPreview(info, info.to, info.data, 1, '7.16.0')
      await addContractFacts(info, 'dev', info.from)
      expect(asked.sort()).toEqual([...VAULT_SOURCES.THORChain].sort())
      expect(info.thorVault!.status).toBe('current')
      // thor13d4… is in this device's address book (test above).
      expect(info.memoDestinationOwn).toBe(true)
      expect(assessSigningRisk(info)!.tier).toBe('green')
    } finally { globalThis.fetch = real }
  })
})

describe('third-party router deposits on BSC and Arbitrum', () => {
  test('a THORChain BSC deposit decodes in BNB and its vault is checked', async () => {
    const s = await card(BSC, all(BSC.vaults))
    expect(s.calldataDecoded?.dappName).toBe('THORChain')
    expect(s.calldataDecoded?.fields.find((f) => f.name === 'Input amount')?.value).toMatch(/ BNB$/)
    expect(s.thorVault).toEqual({ status: 'current', protocol: 'THORChain', chain: 'BSC', sources: 2 })
    expect((await card(BSC, now('THORChain'))).thorVault!.status).toBe('current')
  })

  test('a Maya Arbitrum deposit decodes and pays out to the signer (DEST/REFUND memo)', async () => {
    const s = await card(MAYA_ARB, all(MAYA_ARB.vaults))
    expect(s.calldataDecoded?.dappName).toBe('Mayachain')
    expect(s.thorVault).toEqual({ status: 'current', protocol: 'Mayachain', chain: 'ARB', sources: 2 })
    expect(texts(s)).toContain('The swap pays out to 0x97dc38c3f83481a1F9D72Ba6Cd4Bae4c96BA7994 on ETH, one of your own addresses.')
  })
})

describe('native MsgDeposit swaps', () => {
  const [thor, maya] = natives.deposits
  const native = async (n: typeof thor, isOwn: () => boolean | undefined, body: unknown = n.body) => {
    const info: SigningRequestInfo = { id: 'n', method: n.method, appName: 'KeepKey Desktop', rawRequestBody: body as Record<string, unknown> }
    await addThorDepositFacts(info, 'dev', { isOwn })
    return info
  }

  test('RUNE to the user\'s own ETH address: green, the swap named', async () => {
    const s = await native(thor, () => true)
    expect(s.memoDestinationOwn).toBe(true)
    const r = assessSigningRisk(s)!
    expect([r.tier, r.level]).toEqual(['green', 'low'])
    expect(texts(s)).toContain('Swap 111.44055584 THOR.RUNE for at least 0.02234918 ETH via THORChain.')
    expect(texts(s)).toContain('The swap pays out to 0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E on ETH, one of your own addresses.')
  })

  test('CONTROL: the same deposit paying out to an address that is not this wallet\'s is red', async () => {
    expect(assessSigningRisk(await native(thor, () => false))!.tier).toBe('red')
  })

  test('two different memos in one deposit are red', async () => {
    const body = structuredClone(thor.body)
    body.signDoc.memo = '=:ETH.ETH:0x1111111111111111111111111111111111111111:2234918:keep:30'
    expect(texts(await native(thor, () => true, body))).toContain('This deposit carries two different memos.')
  })

  test('Maya CACAO swap with no minimum is red', async () => {
    const s = await native(maya, () => true)
    expect(assessSigningRisk(s)!.tier).toBe('red')
    expect(texts(s)).toContain('Swap 722.4007864600 MAYA.CACAO for ETH.ETH with NO MINIMUM via Maya.')
  })
})
