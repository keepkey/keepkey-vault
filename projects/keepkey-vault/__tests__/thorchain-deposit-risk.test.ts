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
/** depositWithExpiry/deposit calldata's memo, and the same call with another memo. */
const memoAt = (data: string) => 10 + (data.startsWith('0x44bc937b') ? 5 : 4) * 64
const memoOf = (data: string) => {
  const n = parseInt(data.slice(memoAt(data), memoAt(data) + 64), 16)
  return Buffer.from(data.slice(memoAt(data) + 64, memoAt(data) + 64 + n * 2), 'hex').toString('utf8')
}
const withMemo = (data: string, memo: string) => {
  const hex = Buffer.from(memo).toString('hex')
  return data.slice(0, memoAt(data)) + (hex.length / 2).toString(16).padStart(64, '0') + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
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

  test('a vault every source lists as retiring is a medium line: still accepted during the migration', async () => {
    // Active when Desktop signed it on 2026-10-10; RetiringVault after the churn a day later.
    expect((await card(RETIRED_LATER, all(RETIRED_LATER.vaults))).thorVault!.status).toBe('current')
    const s = await card(RETIRED_LATER, all(fixtures.vaultsDuringChurn.vaults))
    expect(fixtures.vaultsDuringChurn.vaults.find((v) => v.addresses.some((a) => a.address.toLowerCase() === vaultOf(RETIRED_LATER)))?.status).toBe('RetiringVault')
    expect(s.thorVault).toEqual({ status: 'retiring', protocol: 'THORChain', chain: 'BASE', sources: 2 })
    const vaultLine = (c: SigningRequestInfo) => assessSigningRisk(c)!.reasons.find((x) => x.text.startsWith(`Pays vault ${vaultOf(RETIRED_LATER)}`))!
    expect(vaultLine(s).level).toBe('medium')
    expect(vaultLine(s).text).toContain('which THORChain is retiring')
    expect(texts(s)).not.toContain('can be lost')
    // Its input is canonical Base USDC, which Desktop names: nothing else is high.
    expect(assessSigningRisk(s)!.level).toBe('medium')
    // A month later no source lists it at all: critical.
    const gone = await card(RETIRED_LATER, now('THORChain'))
    expect(vaultLine(gone).level).toBe('critical')
    expect(assessSigningRisk(gone)!.level).toBe('critical')
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
    // A card nothing checked (a stored review) is yellow too, and says it was not checked.
    const plain: SigningRequestInfo = { id: 'r', method: '/eth/sign-transaction', appName: 'x', from: OWN_ETH.from, to: OWN_ETH.to, data: OWN_ETH.data, value: OWN_ETH.value, chainId: 1, firmwareVersion: '7.16.0' }
    await applyEvmTxPreview(plain, plain.to, plain.data, 1, '7.16.0')
    expect(assessSigningRisk(plain)!.tier).toBe('yellow')
    expect(texts(plain)).toContain(`Vault ${vaultOf(OWN_ETH)} was not checked against THORChain's active vaults here`)
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
    // Not named calmly: a payout this computer cannot attribute is yellow.
    const r = assessSigningRisk(btc)!
    expect([r.tier, r.level]).toEqual(['yellow', 'medium'])
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

  test('CONTROL: an action this computer does not decode is never green, even to an active vault', async () => {
    const good = await card(OWN_ETH, all(OWN_ETH.vaults))
    expect(assessSigningRisk(good)!.tier).toBe('green')
    for (const memo of [
      'TRADE+:thor19qud0fs2lhcwr5a2l9l7uceym0cyvktf4s78c2',
      `=:ETH~ETH:${OWN_ETH.from}`,
      `swap:ETH.ETH:${OWN_ETH.from}`,
    ]) {
      const s = await card(OWN_ETH, all(OWN_ETH.vaults), undefined, withMemo(OWN_ETH.data, memo))
      expect(s.calldataDecoded?.fields.find((f) => f.name === 'Memo (exact)')?.value).toBe(memo)
      expect(s.deviceClearSigns).toBe(true)
      expect(s.thorVault!.status).toBe('current')
      expect(assessSigningRisk(s)!.tier).toBe('red')
      expect(texts(s)).toContain('an action this computer does not decode')
    }
  })

  test('affiliate fee: a wallet\'s fee named calmly, over 1% red', async () => {
    const own = await card(OWN_ETH, all(OWN_ETH.vaults))
    expect(texts(own)).toContain('Affiliate fee: 0.30% of this swap goes to keep.')
    // CONTROL: the same real deposit with its fee raised to 1000 bps.
    const memo = memoOf(OWN_ETH.data).replace(/:keep:30$/, ':evil:1000')
    expect(memo).toEndWith(':evil:1000')
    const s = await card(OWN_ETH, all(OWN_ETH.vaults), undefined, withMemo(OWN_ETH.data, memo))
    const r = assessSigningRisk(s)!
    expect([r.tier, r.level]).toEqual(['red', 'high'])
    expect(texts(s)).toContain('10.00% of this swap goes to evil, not to you.')
    // Several affiliates: the fees add up (third-party Maya Arbitrum deposit, _/t1:0/70).
    expect(texts(await card(MAYA_ARB, all(MAYA_ARB.vaults)))).toContain('Affiliate fee: 0.70% of this swap goes to _/t1.')
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

describe('the in-app swap card (buildEvmReportForTx)', () => {
  test('checks the vault, as the approval overlay does', async () => {
    const real = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = (async (url: string) => {
      if (!VAULT_SOURCES.THORChain.includes(String(url))) throw new Error('offline')
      asked.push(url)
      return Response.json(OWN_ETH.vaults)
    }) as any
    try {
      const { buildEvmReportForTx } = await import('../src/bun/evm-presign-report')
      const { report, signingInfo } = await buildEvmReportForTx({
        tx: { chainId: 1, from: OWN_ETH.from, to: OWN_ETH.to, data: OWN_ETH.data, value: OWN_ETH.value },
        firmwareVersion: '7.16.0', endpoint: 'http://127.0.0.1:9/', signerVerdict: true, deviceId: 'dev',
        measure: async () => { throw new Error('offline') },
      })
      expect(asked.sort()).toEqual([...VAULT_SOURCES.THORChain].sort())
      expect(signingInfo.thorVault!.status).toBe('current')
      const lines = report.findings.map((f) => f.message).join('\n')
      expect(lines).toContain(`Pays vault ${vaultOf(OWN_ETH)}, one of THORChain's active ETH vaults`)
      expect(lines).not.toContain('could not check')
      expect(assessSigningRisk(signingInfo)!.tier).toBe('green')
    } finally { globalThis.fetch = real }
  })
})

describe('vault sources', () => {
  test('two different operators per network, never a proxy of the same nodes', () => {
    for (const urls of Object.values(VAULT_SOURCES)) {
      const hosts = urls.map((u) => new URL(u).hostname)
      expect(new Set(hosts).size).toBe(hosts.length)
      expect(hosts.length).toBeGreaterThanOrEqual(2)
      // rest.cosmos.directory proxies the chain-registry nodes, including the other source.
      expect(hosts).not.toContain('rest.cosmos.directory')
    }
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

// Normal swaps that read red before (emulator legs 2026-10-30, thor group):
// canonical Base USDC in, a THORChain short code ('e' = ETH.ETH), and a
// ticker with no contract (the network's own pool asset).
describe('normal memos and input tokens are decoded, not flagged', () => {
  const field = (s: SigningRequestInfo, name: string) => s.calldataDecoded?.fields.find((f) => f.name === name)?.value
  const FAKE = 'may be a fake'

  test('canonical Base USDC in is named, not "a token KeepKey does not recognize"', async () => {
    const s = await card(RETIRED_LATER, all(RETIRED_LATER.vaults))
    expect(field(s, 'Input amount')).toBe('3100.967501 USDC')
    expect(field(s, 'Input token')).toBe('Verified Base USDC contract')
    expect(texts(s)).not.toContain(FAKE)
    expect(assessSigningRisk(s)!.tier).toBe('green')
    // CONTROL: the same deposit paying in a token Desktop does not pin.
    const other = RETIRED_LATER.data.replace('833589fcd6edb6e08f4c7c32d4f71b54bda02913', '1111111111111111111111111111111111111111')
    expect(other).not.toBe(RETIRED_LATER.data)
    const u = await card(RETIRED_LATER, all(RETIRED_LATER.vaults), undefined, other)
    expect(field(u, 'Input token warning')).toBe('UNVERIFIED input token contract 0x1111111111111111111111111111111111111111')
    expect(texts(u)).toContain(FAKE)
    expect(assessSigningRisk(u)!.tier).toBe('red')
  })

  test("a THORChain short code ('=:e:') decodes as ETH.ETH and its payout is checked", async () => {
    expect(memoOf(BSC.data)).toStartWith('=:e:0x12C44CFC630E3d03f160Cdc893AC4167D541a3e6/')
    const s = await card(BSC, all(BSC.vaults))
    expect(field(s, 'Output asset')).toBe('ETH.ETH')
    expect(field(s, 'Action')).toStartWith('Swap 0.1 BNB for at least 0.02933463 ETH on ETH via THORChain')
    expect(texts(s)).not.toContain('does not decode')
    expect(texts(s)).toContain('The swap pays out to 0x12C44CFC630E3d03f160Cdc893AC4167D541a3e6 on ETH, one of your own addresses.')
    // CONTROL: the same short-code memo paying someone else is red.
    const stranger = '0x2222222222222222222222222222222222222222'
    const m = await card(BSC, all(BSC.vaults), () => false, withMemo(BSC.data, memoOf(BSC.data).replace(/0x12C44CFC630E3d03f160Cdc893AC4167D541a3e6/g, stranger)))
    const payout = assessSigningRisk(m)!.reasons.find((r) => r.text.startsWith(`The swap pays out to ${stranger}, which is NOT the account signing this`))
    expect(payout?.level).toBe('high')
    // Maya's codes are its own: 'a' is ARB.ETH there, AVAX.AVAX on THORChain.
    const maya = await card(MAYA_ARB, all(MAYA_ARB.vaults), undefined, withMemo(MAYA_ARB.data, memoOf(MAYA_ARB.data).replace('=:ETH.USDC:', '=:e:')))
    expect(field(maya, 'Output asset')).toBe('ETH.ETH')
    const arb = await card(MAYA_ARB, all(MAYA_ARB.vaults), undefined, withMemo(MAYA_ARB.data, memoOf(MAYA_ARB.data).replace('=:ETH.USDC:', '=:a:')))
    expect(field(arb, 'Output asset')).toBe('ARB.ETH')
    // A code neither network defines stays undecoded.
    const unknown = await card(BSC, all(BSC.vaults), undefined, withMemo(BSC.data, memoOf(BSC.data).replace('=:e:', '=:zz:')))
    expect(texts(unknown)).toContain('an action this computer does not decode')
  })

  test('a ticker with no contract (ETH.USDC) is the pool asset, not a fake token', async () => {
    expect(memoOf(MAYA_ARB.data)).toStartWith('=:ETH.USDC:')
    const s = await card(MAYA_ARB, all(MAYA_ARB.vaults))
    expect(field(s, 'Token warning')).toBeUndefined()
    expect(texts(s)).not.toContain(FAKE)
    expect(assessSigningRisk(s)!.tier).toBe('green')
    // CONTROL: the same memo naming another USDC contract, in full or by a suffix it does not end with.
    for (const [asset, warning] of [
      ['ETH.USDC-0x1111111111111111111111111111111111111111', 'UNVERIFIED USDC token contract 0x1111111111111111111111111111111111111111'],
      ['ETH.USDC-dead', 'UNVERIFIED USDC token contract (memo names -dead)'],
    ]) {
      const m = await card(MAYA_ARB, all(MAYA_ARB.vaults), undefined, withMemo(MAYA_ARB.data, memoOf(MAYA_ARB.data).replace('ETH.USDC', asset)))
      expect(field(m, 'Token warning')).toBe(warning)
      expect(texts(m)).toContain(FAKE)
      expect(assessSigningRisk(m)!.tier).toBe('red')
    }
    // The real contract's own suffix is fine.
    const ok = await card(MAYA_ARB, all(MAYA_ARB.vaults), undefined, withMemo(MAYA_ARB.data, memoOf(MAYA_ARB.data).replace('ETH.USDC', 'ETH.USDC-eb48')))
    expect(field(ok, 'Token warning')).toBeUndefined()
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

  test('CONTROL: the same deposit with a zero limit, plain or streaming, is red', async () => {
    for (const limit of ['0', '0/1/0', '0e3', 'abc']) {
      const body = structuredClone(thor.body)
      const memo = body.signDoc.memo.replace(':2234918:', `:${limit}:`)
      body.signDoc.memo = memo
      body.signDoc.msgs[0].value.memo = memo
      const s = await native(thor, () => true, body)
      const r = assessSigningRisk(s)!
      expect([r.tier, r.level]).toEqual(['red', 'high'])
      expect(texts(s)).toContain('Sets no minimum, so this swap can pay you back almost nothing.')
      expect(texts(s)).toContain('for ETH.ETH with NO MINIMUM via THORChain')
    }
    // A streaming swap with a real limit is not.
    const body = structuredClone(thor.body)
    body.signDoc.memo = body.signDoc.msgs[0].value.memo = body.signDoc.memo.replace(':2234918:', ':2234918/1/0:')
    expect(assessSigningRisk(await native(thor, () => true, body))!.tier).toBe('green')
  })

  test('CONTROL: a payout this computer cannot attribute is yellow, not green', async () => {
    const s = await native(thor, () => undefined)
    expect(s.memoDestinationOwn).toBeUndefined()
    const r = assessSigningRisk(s)!
    expect([r.tier, r.level]).toEqual(['yellow', 'medium'])
    expect(texts(s)).toContain('This computer cannot tell whether 0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E on ETH is your address.')
  })

  test('CONTROL: the same deposit with its affiliate fee raised to 1000 bps is red', async () => {
    expect(texts(await native(thor, () => true))).toContain('Affiliate fee: 0.30% of this swap goes to keep.')
    const body = structuredClone(thor.body)
    body.signDoc.memo = body.signDoc.msgs[0].value.memo = body.signDoc.memo.replace(':keep:30', ':evil:1000')
    const s = await native(thor, () => true, body)
    expect(assessSigningRisk(s)!.tier).toBe('red')
    expect(texts(s)).toContain('10.00% of this swap goes to evil, not to you.')
  })

  test('Maya CACAO swap with no minimum is red', async () => {
    const s = await native(maya, () => true)
    expect(assessSigningRisk(s)!.tier).toBe('red')
    expect(texts(s)).toContain('Swap 722.4007864600 MAYA.CACAO for ETH.ETH with NO MINIMUM via Maya.')
  })
})
