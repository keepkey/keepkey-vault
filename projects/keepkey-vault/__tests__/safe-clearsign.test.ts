/**
 * Safe requests as ClearSign coverage (gap rows G22, G12, G21).
 *
 * G22: Desktop's own Safe panel reviews a SafeTx with the same risk lines a
 * dapp's request gets, and records its signatures (and Safe creation) in
 * clearsign_observations.
 * G12: a personal_sign of a 32-byte safeTxHash, sent through REST, is named
 * for the pending SafeTx it confirms, or reads red when it matches none.
 * G21: approveHash(bytes32) to a Safe is named the same way, as permanent.
 *
 * Fixtures are real: the Safe DAO treasury's nonce-76 SafeTx (a delegatecall
 * to MultiSendCallOnly), a real approveHash transaction with the SafeTx it
 * approved, and a real Safe creation. The Safe service and chain reads are
 * served from those fixtures; the database is a fresh file in a temp dir.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ethers } from 'ethers'
import safedao from './fixtures/safe/safedao-nonce76.json'
import approved from './fixtures/safe/approvehash-22681.json'
import created from './fixtures/safe/create-385e.json'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import type { PendingSafeTx, SafeInfo, SigningRequestInfo } from '../src/shared/types'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-safe-clearsign-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const { startRestApi } = await import('../src/bun/rest-api')
const { reviewSafeTx, confirmSafeTx, observedSign, safeHashLink } = await import('../src/bun/safe-review')
const { safeTxHash, safeTypedData } = await import('../src/bun/safe-core')
const { decodeEIP712 } = await import('../src/bun/eip712-decoder')
const { observeEvmCall } = await import('../src/bun/clearsign-observation')

// Nothing leaves this machine: the REST preview's other lookups (Pioneer,
// simulation, ClearSign service) see a network that refuses them.
const originalFetch = globalThis.fetch
beforeAll(() => {
  db.initDb()
  db.setSetting('evm_simulation_rpc_urls', JSON.stringify({ '1': 'http://127.0.0.1:9/' }))
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.startsWith('http://127.0.0.1:')) return originalFetch(url, init)
    throw new Error('offline test')
  }) as unknown as typeof fetch
})
afterAll(() => { globalThis.fetch = originalFetch; db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const sink = {
  record: (draft: any) => db.insertClearSignObservation(draft, { deviceId: 'safe-clearsign-test', source: 'vault-rpc' }).id,
  finalize: db.finalizeClearSignObservation,
}
const observation = () => db.getDb()!.query(
  `SELECT source, request_kind, shape_json, outcome FROM clearsign_observations ORDER BY rowid DESC LIMIT 1`,
).get() as { source: string; request_kind: string; shape_json: string; outcome: string }

// ── fixtures as Desktop reads them ───────────────────────────────────
const daoTx = safedao as any
const daoOwners: string[] = Array.isArray(daoTx.owners) ? daoTx.owners : JSON.parse(String(daoTx.owners).replace(/'/g, '"'))
const daoInfo: SafeInfo = { chainId: 1, address: daoTx.safe, owners: daoOwners, threshold: 3, nonce: 76, version: daoTx.version, vetting: { codeProblem: null, extensions: [] } }
const fields = (t: any) => ({
  to: ethers.utils.getAddress(t.to), value: String(t.value), data: t.data ?? null, operation: Number(t.operation),
  safeTxGas: String(t.safeTxGas), baseGas: String(t.baseGas), gasPrice: String(t.gasPrice),
  gasToken: ethers.utils.getAddress(t.gasToken), refundReceiver: ethers.utils.getAddress(t.refundReceiver), nonce: String(t.nonce),
})
/** What safe.ts pendingSafeTxs returns: the hash recomputed here from the fields. */
const pending = (info: SafeInfo, t: any): PendingSafeTx => {
  const f = fields(t)
  const hash = safeTxHash(info.chainId, info.address, info.version, f)
  return { ...f, safeTxHash: hash, hashMatches: hash === t.safeTxHash, confirmedBy: [], unverifiedConfirmations: [], delegateCall: f.operation === 1, decoded: null, submittedAt: null }
}
const daoPending = pending(daoInfo, daoTx)
const ah = approved as any
const ahInfo: SafeInfo = { chainId: 1, address: ethers.utils.getAddress(ah.safe.address), owners: ah.safe.owners, threshold: ah.safe.threshold, nonce: Number(ah.safeTx.nonce), version: ah.safe.version, vetting: { codeProblem: null, extensions: [] } }
const ahPending = pending(ahInfo, ah.safeTx)
// A mutant of the real Safe DAO transaction with a gas refund set (no real refund capture found).
const refundTx = { ...daoTx, gasPrice: '20000000000', refundReceiver: '0x2222222222222222222222222222222222222222' }

const texts = (r: { reasons: { text: string }[] } | null) => (r?.reasons ?? []).map(x => x.text)

describe('G22: the panel reviews a SafeTx as a dapp request', () => {
  test('both real fixtures recompute to the hash Safe published', () => {
    expect(daoPending.hashMatches).toBe(true)
    expect(ahPending.hashMatches).toBe(true)
  })

  test('the Safe DAO delegatecall gets the dapp card\'s exact risk', () => {
    const { risk } = reviewSafeTx(daoInfo, daoPending, { firmwareVersion: '7.16.0' })
    const dapp = assessSigningRisk({ id: 'd', method: '/eth/sign-typed-data', appName: 'dapp', chainId: 1, firmwareVersion: '7.16.0', typedDataDecoded: decodeEIP712(safeTypedData(1, daoTx.safe, daoTx.version, daoPending)) })
    expect(risk).toEqual(dapp)
    expect(texts(risk)).toContain('Runs code from 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D inside your Safe (delegatecall). That code can do anything with what the Safe holds.')
  })

  test('a gas refund and an unreadable inner call each get their line', () => {
    expect(texts(reviewSafeTx(daoInfo, fields(refundTx), {}).risk).some(t => t.startsWith('Pays a gas refund out of your Safe when it is executed, to 0x2222222222222222222222222222222222222222.'))).toBe(true)
    expect(texts(reviewSafeTx(ahInfo, ahPending, {}).risk).some(t => t.startsWith('Makes your Safe call 0x36c6C69A6186D4475fc5c21181CD980Bd6E5e11F with data'))).toBe(true)
  })

  // A test key stands in for the KeepKey, listed as one more owner.
  const device = ethers.Wallet.createRandom()
  const ownerInfo = { ...daoInfo, owners: [...daoOwners, device.address] }
  const confirmDeps = (sign: (typedData: any) => Promise<any>, posted: string[]) => ({
    ...sink, sign,
    readSafe: async () => ownerInfo,
    pendingSafeTxs: async () => [daoPending],
    postConfirmation: async (_c: number, hash: string) => { posted.push(hash) },
  })
  const deviceSign = async (td: any) => {
    const { EIP712Domain, ...types } = td.types
    return { signature: await device._signTypedData(td.domain, types, td.message) }
  }

  test('Sign on KeepKey: reviewed, recorded as a SafeTx observation, signed and posted', async () => {
    const posted: string[] = []
    const r = await confirmSafeTx({ chainId: 1, address: daoTx.safe, safeTxHash: daoTx.safeTxHash }, device.address, '7.16.0', confirmDeps(deviceSign, posted))
    expect(texts(r.risk).some(t => t.includes('(delegatecall)'))).toBe(true)
    expect(posted).toEqual([daoTx.safeTxHash])
    const o = observation()
    expect(o).toMatchObject({ source: 'vault-rpc', request_kind: 'evm-typed-data', outcome: 'signed' })
    expect(JSON.parse(o.shape_json)).toMatchObject({ chainId: 1, primaryType: 'SafeTx', verifyingContract: daoTx.safe.toLowerCase() })
  })

  test('rejected on the device: recorded as rejected, nothing posted', async () => {
    const posted: string[] = []
    const reject = async () => { throw { message_type: 'FAILURE', message: { code: 4, message: 'Action cancelled by user' } } }
    await expect(confirmSafeTx({ chainId: 1, address: daoTx.safe, safeTxHash: daoTx.safeTxHash }, device.address, '7.16.0', confirmDeps(reject, posted))).rejects.toBeDefined()
    expect(posted).toEqual([])
    expect(observation().outcome).toBe('rejected')
  })

  test('Create a Safe: the real factory call is recorded', async () => {
    const draft = observeEvmCall({ chainId: 1, to: created.to, data: created.input, hostDecoded: true })
    await observedSign(draft, sink, async () => ({ serialized: '0xf8' }))
    const o = observation()
    expect(o).toMatchObject({ request_kind: 'evm-call', outcome: 'signed' })
    expect(JSON.parse(o.shape_json)).toMatchObject({ contract: created.to, selector: '0x1688f0b9' })
  })
})

// ── G12 / G21: a 32-byte confirmation through REST ───────────────────
const DAO_OWNER = ethers.utils.getAddress(daoOwners[0])
const STRANGER = '0x1111111111111111111111111111111111111111'
const lookupDeps = (opts: { fail?: boolean } = {}) => ({
  chains: async () => [1, 8453],
  ownedSafes: async (chainId: number, owner: string) => {
    if (opts.fail) throw new Error('Safe Transaction Service HTTP 503')
    if (chainId !== 1) return []
    return [daoInfo, ahInfo].filter(i => i.owners.some(o => o.toLowerCase() === owner.toLowerCase())).map(i => i.address)
  },
  readSafe: async (_c: number, address: string) => {
    const info = [daoInfo, ahInfo].find(i => i.address.toLowerCase() === address.toLowerCase())
    if (!info) throw new Error('call reverted')
    return info
  },
  pendingSafeTxs: async (info: SafeInfo) => info.address === daoInfo.address ? [daoPending] : [ahPending],
})

async function restCard(path: '/eth/sign' | '/eth/sign-transaction', body: any, from: string, deps = lookupDeps()): Promise<SigningRequestInfo> {
  const cards: SigningRequestInfo[] = []
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, currentSeedEthAddress: from,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: '7.16.0', capabilities: [1, 4], deviceId: 'safe-clearsign-test' }),
    getCachedFeaturesSnapshot: () => undefined,
    wallet: {
      getFeatures: async () => ({ majorVersion: 7, minorVersion: 16, patchVersion: 0, policiesList: [] }),
      ethSignMessage: async () => ({ address: from, signature: '0x' + '11'.repeat(65) }),
      ethSignTx: async () => ({ v: 37, r: '0x01', s: '0x02', serialized: '0xf8' }),
    },
  })
  const addressNList = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]
  const auth: any = { requireAuth: () => ({ name: 'dapp', url: 'https://dapp.example' }), extractBearerToken: () => 'test', validate: () => true, getAccount: () => ({ addressNList }) }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    lookupSafeHash: (info: SigningRequestInfo) => safeHashLink(info, deps),
    onSigningRequest: async (info: SigningRequestInfo) => { cards.push(structuredClone(info)); return { approved: false } as any },
    onSigningDismissed: () => {},
  } as any)
  try {
    await originalFetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify({ addressNList, ...body }),
    })
    return cards[0]
  } finally {
    server.stop(true)
  }
}
const flip = (hash: string) => hash.slice(0, -1) + (hash.endsWith('0') ? '1' : '0')

describe('G12: personal_sign of a safeTxHash', () => {
  test('names the Safe DAO transaction it approves, with that SafeTx\'s own risk lines', async () => {
    const card = await restCard('/eth/sign', { address: DAO_OWNER, message: daoTx.safeTxHash }, DAO_OWNER)
    expect(card.safeHashLink).toMatchObject({ status: 'match', safe: daoTx.safe, nonce: '76', chainId: 1 })
    const lines = texts(assessSigningRisk(card))
    expect(lines).toContain('Approves Safe transaction #76 of your Safe 0x8CF60B289f8d31F737049B590b5E4285Ff0Bd1D1 on Ethereum: delegatecall to 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D.')
    expect(lines.some(t => t.includes('(delegatecall)'))).toBe(true)
    expect(lines.some(t => t.startsWith('You are signing a 32-byte code'))).toBe(false)
  }, 30_000)

  test('CONTROL: one byte changed links nothing and reads red, naming the Safe', async () => {
    const card = await restCard('/eth/sign', { address: DAO_OWNER, message: flip(daoTx.safeTxHash) }, DAO_OWNER)
    expect(card.safeHashLink).toEqual({ status: 'no-match', safes: [daoTx.safe] })
    const risk = assessSigningRisk(card)!
    expect(risk.tier).toBe('red')
    expect(texts(risk)[0]).toStartWith('This hash is not a pending transaction of your Safe 0x8CF60B289f8d31F737049B590b5E4285Ff0Bd1D1')
  }, 30_000)

  test('an account that owns no Safe keeps the generic 32-byte line', async () => {
    const card = await restCard('/eth/sign', { address: STRANGER, message: daoTx.safeTxHash }, STRANGER)
    expect(card.safeHashLink).toBeUndefined()
    expect(texts(assessSigningRisk(card))[0]).toStartWith('You are signing a 32-byte code')
  }, 30_000)

  test('a failed lookup says it could not check, in red', async () => {
    const card = await restCard('/eth/sign', { address: DAO_OWNER, message: daoTx.safeTxHash }, DAO_OWNER, lookupDeps({ fail: true }))
    expect(card.safeHashLink).toEqual({ status: 'unchecked', error: 'Safe Transaction Service HTTP 503' })
    expect(assessSigningRisk(card)!.tier).toBe('red')
  }, 30_000)

  test('text that is not 32 bytes is never looked up', async () => {
    const card = await restCard('/eth/sign', { address: DAO_OWNER, message: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Sign in to example.com')) }, DAO_OWNER)
    expect(card.safeHashLink).toBeUndefined()
  }, 30_000)
})

describe('G21: approveHash to a Safe', () => {
  const req = ah.request
  test('the real approveHash names the SafeTx it approves, as permanent', async () => {
    const card = await restCard('/eth/sign-transaction', req, req.from)
    expect(card.safeHashLink).toMatchObject({ status: 'match', safe: ahInfo.address, nonce: '22681' })
    const risk = assessSigningRisk(card)!
    const lines = texts(risk)
    expect(lines.some(t => t.startsWith(`Permanently approves Safe transaction #22681 of your Safe ${ahInfo.address} on Ethereum: call to 0x36c6C69A6186D4475fc5c21181CD980Bd6E5e11F.`))).toBe(true)
    expect(lines.some(t => t.startsWith('Once mined, this approval cannot be withdrawn'))).toBe(true)
    expect(lines.some(t => t.includes('You would be signing blind'))).toBe(false)
  }, 30_000)

  test('CONTROL: an approveHash of a hash the Safe has not proposed reads red and permanent', async () => {
    const card = await restCard('/eth/sign-transaction', { ...req, data: flip(req.data) }, req.from)
    expect(card.safeHashLink).toEqual({ status: 'no-match', safes: [ahInfo.address] })
    const risk = assessSigningRisk(card)!
    expect(risk.tier).toBe('red')
    expect(texts(risk).some(t => t.includes('cannot be withdrawn once mined'))).toBe(true)
  }, 30_000)

  test('from an account that is not an owner (the call reverts): no link', async () => {
    const card = await restCard('/eth/sign-transaction', { ...req, from: STRANGER }, STRANGER)
    expect(card.safeHashLink).toBeUndefined()
  }, 30_000)
})
