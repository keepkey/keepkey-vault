import { describe, expect, test } from 'bun:test'
import { Wallet, utils } from 'ethers'
import {
  FACTORY_ABI,
  SAFE_ABI,
  SafeMultisigService,
  describeSafeTransfer,
  validateSafeProposal,
} from './safe-multisig'
import { SAFE_USDC, type SafeProposal, type SafeAccount } from '../shared/safe-multisig'
import { SAFE_CREATE } from '../shared/safe-deployments'
import { SAFE_TX_TYPE, safeTxHash } from './safe-core'
import type { SafeTransactionQueue } from './safe-transaction-service'
import { safeVaultIdentity, safeAccountFromVault } from '../shared/vault-identity'
const SAFE_TYPES = { SafeTx: SAFE_TX_TYPE }
const DEPLOYED = { factory: SAFE_CREATE.factory.address, singleton: SAFE_CREATE.singleton.address, handler: SAFE_CREATE.fallbackHandler.address }
// Unmodified deployed bytecode from @safe-global/safe-contracts@1.4.1 build artifacts.
// Each fixture is checked against the pinned safe-deployments hash by the service.
import code from './safe-multisig.contracts.fixture.json'

const owner = new Wallet('0x' + '11'.repeat(32))
const coowner = new Wallet('0x' + '22'.repeat(32))
const outsider = new Wallet('0x' + '33'.repeat(32))
const SAFE = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
function harness(hidden = false, queue?: SafeTransactionQueue, options: { registeredAccounts?: () => SafeAccount[]; discover?: (owner: string) => Promise<string[]>; changed?: (s: unknown, accounts: SafeAccount[]) => void } = {}) {
  let key = 'session-a'
  let now = 1_000_000
  let safeNonce = '0'
  let badCode = false
  let sends = 0
  let owners = [owner.address, coowner.address]
  let connectedOwner = owner.address
  let holdCode: (() => Promise<void>) | undefined
  let executionSignatures = ''
  const controlBlocks: string[] = []
  const writes = new Map<string, string>()
  const rpc = async (method: string, params: any[]): Promise<any> => {
    if (method === 'eth_chainId') return '0x2105'
    if (method === 'eth_blockNumber') return '0x100'
    if (method === 'eth_getCode') {
      if (holdCode) await holdCode()
      if (badCode) return '0x6000'
      for (const [name, a] of Object.entries(DEPLOYED))
        if (a.toLowerCase() === params[0].toLowerCase())
          return code[name as 'factory' | 'singleton' | 'handler']
      return params[0] === SAFE ? code.proxy : '0x'
    }
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000'
    if (method === 'eth_estimateGas') return '0x493e0'
    if (method === 'eth_gasPrice') return '0xf4240'
    if (method === 'eth_getTransactionCount') return '0x0'
    if (method === 'eth_sendRawTransaction') {
      sends++
      return utils.keccak256(params[0])
    }
    if (method === 'eth_call') {
      const { to, data } = params[0]
      if (to.toLowerCase() === SAFE_USDC.toLowerCase())
        return utils.defaultAbiCoder.encode(['uint256'], [1_000_000])
      if (to.toLowerCase() === DEPLOYED.factory.toLowerCase()) {
        const parsed = FACTORY_ABI.parseTransaction({ data })
        if (parsed.name === 'proxyCreationCode')
          return FACTORY_ABI.encodeFunctionResult(parsed.name, [code.proxyCreationCode])
        const [singleton, init, nonce] = parsed.args
        const salt = utils.keccak256(
          utils.hexConcat([utils.keccak256(init), utils.hexZeroPad(nonce.toHexString(), 32)])
        )
        const predicted = utils.getCreate2Address(
          to,
          salt,
          utils.keccak256(
            utils.hexConcat([code.proxyCreationCode, utils.defaultAbiCoder.encode(['address'], [singleton])])
          )
        )
        return FACTORY_ABI.encodeFunctionResult(parsed.name, [predicted])
      }
      const parsed = SAFE_ABI.parseTransaction({ data })
      if (['masterCopy', 'VERSION', 'getOwners', 'getThreshold', 'nonce'].includes(parsed.name))
        controlBlocks.push(params[1])
      const result: Record<string, any[]> = {
        VERSION: ['1.4.1'],
        getOwners: [owners],
        getThreshold: [2],
        nonce: [safeNonce],
        masterCopy: [DEPLOYED.singleton],
      }
      if (parsed.name === 'getTransactionHash') {
        const t = Object.fromEntries(SAFE_TYPES.SafeTx.map((f, i) => [f.name, parsed.args[i]]))
        result.getTransactionHash = [
          utils._TypedDataEncoder.hash({ chainId: 8453, verifyingContract: to }, SAFE_TYPES, t),
        ]
      }
      if (parsed.name === 'execTransaction') {
        executionSignatures = parsed.args[9]
        result.execTransaction = [true]
      }
      return SAFE_ABI.encodeFunctionResult(parsed.name, result[parsed.name])
    }
    throw new Error(`Unexpected RPC ${method}`)
  }
  const service = new SafeMultisigService({
    queue,
    ...options,
    session: async () => ({
      key,
      scope: 'wallet-a',
      owner: connectedOwner,
      sessionOnly: hidden,
      nestedClearSign: true,
    }),
    currentKey: () => key,
    read: (s) => writes.get(s),
    write: (s, v) => {
      writes.set(s, v)
    },
    rpc,
    now: () => now,
  })
  return {
    service,
    writes,
    rpc,
    setKey: (v: string) => {
      key = v
    },
    setNow: (v: number) => {
      now = v
    },
    setNonce: (v: string) => {
      safeNonce = v
    },
    setBadCode: () => {
      badCode = true
    },
    setOwners: (v: string[]) => {
      owners = v
    },
    setConnectedOwner: (value: string) => { connectedOwner = value; key = `owner:${value}` },
    hold: (fn: () => Promise<void>) => {
      holdCode = fn
    },
    get sends() {
      return sends
    },
    get executionSignatures() {
      return executionSignatures
    },
    controlBlocks,
  }
}
async function imported(h = harness()) {
  await h.service.importAccount({
    address: SAFE,
    name: 'Shared treasury',
    expectedOwners: [owner.address, coowner.address],
    expectedThreshold: 2,
  })
  return h
}
async function propose(h: ReturnType<typeof harness>, asset: 'ETH' | 'USDC' = 'ETH') {
  return h.service.propose({ safe: SAFE, recipient: RECIPIENT, asset, amount: '0.5' })
}
async function sign(p: SafeProposal, wallet: Wallet) {
  return wallet._signTypedData({ chainId: 8453, verifyingContract: p.safe }, SAFE_TYPES, p.transaction)
}

function remote(p: SafeProposal) {
  return { ...p.transaction, safe: p.safe, safeTxHash: p.hash, isExecuted: false,
    confirmations: Object.entries(p.signatures).map(([owner, signature]) => ({ owner, signature })) }
}
function queueHarness() {
  let rows: unknown[] = []
  let error = false
  let hold: (() => Promise<void>) | undefined
  const published: SafeProposal[] = []
  const queue: SafeTransactionQueue = {
    pending: async () => { if (hold) await hold(); if (error) throw new Error('Safe HTTP 429'); return rows },
    publish: async p => { published.push(structuredClone(p)); rows = [remote(p)] },
  }
  return { queue, published, setRows: (v: unknown[]) => { rows = v }, fail: () => { error = true },
    hold: (v: () => Promise<void>) => { hold = v } }
}

describe('saved directory restoration and owner discovery', () => {
  const snapshot = (): SafeAccount => ({ address: SAFE, name: 'Saved on another wallet',
    owners: [owner.address, coowner.address], threshold: 2, nonce: '0', deployed: true,
    safeVersion: '1.4.1', reviewedAt: 1234 })
  test('restores a reviewed directory Safe into the connected cosigner wallet without another import', async () => {
    let directory = [safeAccountFromVault(safeVaultIdentity(snapshot(), false))]
    const h = harness(false, undefined, {
      registeredAccounts: () => directory,
      changed: (_s, accounts) => { directory = accounts.map(a => safeAccountFromVault(safeVaultIdentity(a, false))) },
    })
    h.writes.set('another-wallet', JSON.stringify({ accounts: [snapshot()], proposals: [] }))
    const context = await h.service.list()
    expect(context.accounts).toHaveLength(1)
    expect(context.accounts[0]).toMatchObject({ address: SAFE, name: snapshot().name, reviewedAt: 1234 })
    expect(h.writes.has('wallet-a')).toBe(true)
    expect(h.sends).toBe(0)
  })
  test('global records for other owners are not loaded into this wallet', async () => {
    const h = harness(false, undefined, { registeredAccounts: () => [{ ...snapshot(), owners: [coowner.address, outsider.address] }] })
    expect((await h.service.list()).accounts).toEqual([])
    expect(h.writes.size).toBe(0)
  })
  test('discovery verifies the on-chain owner and requires review for a newly found Safe', async () => {
    const h = harness(false, undefined, { discover: async address => { expect(address).toBe(owner.address); return [SAFE] } })
    expect((await h.service.discover()).discovered).toBe(1)
    const account = (await h.service.list()).accounts[0]!
    expect(account).toMatchObject({ address: SAFE, configurationChanged: true, threshold: 2 })
    expect(account.reviewedAt).toBeUndefined()
    expect(safeVaultIdentity(account, false).receiveEnabled).toBe(false)
    await expect(propose(h)).rejects.toThrow('Review and confirm')
    await h.service.importAccount({ address: SAFE, name: account.name, expectedOwners: account.owners, expectedThreshold: account.threshold })
    expect((await h.service.list()).accounts[0]!.configurationChanged).toBeUndefined()
    expect(h.sends).toBe(0)
  })
  test('the saved four-versus-five owner case retains the reviewed baseline and appears with a review flag', async () => {
    const saved = { ...snapshot(), owners: [owner.address, coowner.address, outsider.address, '0x' + '44'.repeat(20)] }
    let directory = [safeAccountFromVault(safeVaultIdentity(saved, false))]
    const h = harness(false, undefined, { registeredAccounts: () => directory, discover: async () => [SAFE],
      changed: (_s, accounts) => { directory = accounts.map(a => safeAccountFromVault(safeVaultIdentity(a, false))) } })
    h.setOwners([...saved.owners, '0x' + '55'.repeat(20)])
    await h.service.discover()
    const account = (await h.service.list()).accounts[0]!
    expect(account.owners).toHaveLength(5)
    expect(account.reviewedConfiguration).toEqual({ owners: saved.owners, threshold: 2 })
    expect(account.reviewedAt).toBe(1234)
    expect(account.configurationChanged).toBe(true)
    expect(safeVaultIdentity(account, false).reviewedConfiguration).toEqual(account.reviewedConfiguration)
  })
  test('stale local ownership cannot override the directory after an owner is removed', async () => {
    let directory = [snapshot()]
    const h = harness(false, undefined, { registeredAccounts: () => directory })
    await h.service.list()
    directory = [{ ...snapshot(), owners: [coowner.address, outsider.address], configurationChanged: true }]
    expect((await h.service.list()).accounts).toEqual([])
    const stored = JSON.parse(h.writes.get('wallet-a')!).accounts[0]
    expect(stored.owners).toEqual([coowner.address, outsider.address])
  })
  test('an unavailable discovery service preserves DB-loaded accounts and reports the failure', async () => {
    const h = harness(false, undefined, { registeredAccounts: () => [snapshot()], discover: async () => { throw new Error('Safe HTTP 429') } })
    expect((await h.service.discover()).serviceError).toBe('Safe HTTP 429')
    expect((await h.service.list()).accounts).toHaveLength(1)
  })
  test('indexer hints cannot import a non-owner Safe or a contract with the wrong bytecode', async () => {
    const h = harness(false, undefined, { discover: async () => [SAFE] })
    h.setOwners([coowner.address, outsider.address])
    expect((await h.service.discover()).issues).toHaveLength(1)
    expect((await h.service.list()).accounts).toEqual([])
    h.setOwners([owner.address, coowner.address]); h.setBadCode()
    expect((await h.service.discover({ force: true })).issues[0]!.reason).toContain('bytecode')
    expect((await h.service.list()).accounts).toEqual([])
  })
  test('duplicate discovery requests share work, cache briefly and allow an explicit refresh', async () => {
    let calls = 0
    const h = harness(false, undefined, { discover: async () => { calls++; return [SAFE] } })
    await Promise.all([h.service.discover(), h.service.discover()])
    await h.service.discover()
    expect(calls).toBe(1)
    await h.service.discover({ force: true })
    expect(calls).toBe(2)
  })
  test('hidden-wallet discovery stays in RAM and a late response cannot cross wallet sessions', async () => {
    const hidden = harness(true, undefined, { discover: async () => [SAFE] })
    await hidden.service.discover()
    expect((await hidden.service.list()).accounts).toHaveLength(1)
    expect(hidden.writes.size).toBe(0)
    hidden.setKey('new-hidden-wallet')
    expect((await hidden.service.list()).accounts).toEqual([])
    let release!: () => void, started!: () => void
    const reached = new Promise<void>(resolve => { started = resolve })
    const h = harness(false, undefined, { discover: async () => { started(); await new Promise<void>(resolve => { release = resolve }); return [SAFE] } })
    const pending = h.service.discover()
    await reached; h.setKey('different-wallet'); release()
    await expect(pending).rejects.toThrow('Wallet changed')
    expect(h.writes.size).toBe(0)
  })
})

describe('Safe web and Vault queue interoperability', () => {
  test('Vault approval is shared, a web personal_sign approval is verified, and execution uses both signatures', async () => {
    const q = queueHarness(), h = await imported(harness(false, q.queue)), p = await propose(h)
    await expect(h.service.publish({ hash: p.hash })).rejects.toThrow('Approve this proposal')
    await h.service.addSignature({ hash: p.hash, signature: await sign(p, owner) })
    await h.service.publish({ hash: p.hash })
    expect(q.published).toHaveLength(1)
    const webSignature = await coowner.signMessage(utils.arrayify(p.hash))
    const safeWebSignature = webSignature.slice(0, -2) + (parseInt(webSignature.slice(-2), 16) + 4).toString(16)
    q.setRows([remote({ ...q.published[0]!, signatures: { ...q.published[0]!.signatures, [coowner.address]: safeWebSignature } })])
    const result = await h.service.sync({ address: SAFE })
    expect(result).toMatchObject({ pending: 1, imported: 1, issues: [] })
    const merged = (await h.service.list()).proposals[0]!
    expect(Object.keys(merged.signatures).sort()).toEqual([owner.address, coowner.address].sort())
    expect(merged.signatures[coowner.address]).toBe(safeWebSignature)
    const review = await h.service.prepareExecute({ hash: p.hash })
    expect(review.kind).toBe('execute')
    expect(utils.arrayify(h.executionSignatures)).toHaveLength(130)
    expect(h.sends).toBe(0)
  })
  test('a web-originated proposal is discovered without a local proposal or file import', async () => {
    const q = queueHarness(), source = await imported(), p = await propose(source)
    p.signatures[coowner.address] = await sign(p, coowner)
    q.setRows([remote(p)])
    const h = await imported(harness(false, q.queue))
    expect((await h.service.list()).proposals).toHaveLength(0)
    expect((await h.service.sync({ address: SAFE })).imported).toBe(1)
    await h.service.addSignature({ hash: p.hash, signature: await sign(p, owner) })
    await h.service.publish({ hash: p.hash })
    expect(Object.keys(q.published[0]!.signatures)).toHaveLength(2)
    expect(h.sends).toBe(0)
  })
  test('forged hashes, other Safes, delegatecalls and invalid confirmations cannot count toward execution', async () => {
    const q = queueHarness(), source = await imported(), p = await propose(source)
    const row = remote(p)
    q.setRows([{ ...row, safeTxHash: '0x' + 'ff'.repeat(32) }, { ...row, safe: RECIPIENT },
      { ...row, operation: 1 }, { ...row, confirmations: [{ owner: coowner.address, signature: await sign(p, outsider) }] }])
    const h = await imported(harness(false, q.queue)), result = await h.service.sync({ address: SAFE })
    expect(result.pending).toBe(4)
    expect(result.imported).toBe(1)
    expect(result.issues).toHaveLength(4)
    expect((await h.service.list()).proposals[0]!.signatures).toEqual({})
    await expect(h.service.prepareExecute({ hash: p.hash })).rejects.toThrow('Need 2')
  })
  test('future nonce proposals are visible but cannot be signed or executed early', async () => {
    const q = queueHarness(), source = await imported(), p = await propose(source)
    p.transaction.nonce = '2'
    p.hash = safeTxHash(8453, SAFE, '1.4.1', p.transaction)
    q.setRows([remote(p)])
    const h = await imported(harness(false, q.queue))
    expect((await h.service.sync({ address: SAFE })).imported).toBe(1)
    await expect(h.service.signingData({ hash: p.hash })).rejects.toThrow('nonce changed')
    await expect(h.service.prepareExecute({ hash: p.hash })).rejects.toThrow('nonce changed')
  })
  test('automatic observation saves the changed configuration and keeps the reviewed owners until explicit acceptance', async () => {
    const q = queueHarness(), h = await imported(harness(false, q.queue)), p = await propose(h)
    h.setOwners([owner.address, coowner.address, outsider.address])
    await h.service.sync({ address: SAFE })
    await h.service.sync({ address: SAFE })
    const account = (await h.service.list()).accounts[0]!
    expect(account.owners).toHaveLength(3)
    expect(account.reviewedConfiguration?.owners).toEqual([owner.address, coowner.address])
    expect(account.configurationChanged).toBe(true)
    await expect(h.service.signingData({ hash: p.hash })).rejects.toThrow('changed')
    const reviewed = await h.service.importAccount({ address: SAFE, name: account.name,
      expectedOwners: account.owners, expectedThreshold: account.threshold })
    expect(reviewed.configurationChanged).toBeUndefined()
    expect(reviewed.reviewedConfiguration?.owners).toHaveLength(3)
    expect(h.writes.size).toBe(1)
  })
  test('removing the connected owner retires the Safe and its proposals from the wallet', async () => {
    const h = await imported(harness(false, queueHarness().queue))
    await propose(h)
    h.setOwners([coowner.address, outsider.address])
    await h.service.sync({ address: SAFE })
    expect((await h.service.list()).accounts).toEqual([])
    expect((await h.service.list()).proposals).toEqual([])
    expect(JSON.parse(h.writes.get('wallet-a')!).accounts[0].owners).toEqual([coowner.address, outsider.address])
  })
  test('an API failure preserves local approvals and reports unavailable rather than an empty remote queue', async () => {
    const q = queueHarness(), h = await imported(harness(false, q.queue)), p = await propose(h)
    await h.service.addSignature({ hash: p.hash, signature: await sign(p, owner) })
    q.fail()
    expect((await h.service.sync({ address: SAFE })).serviceError).toBe('Safe HTTP 429')
    expect(Object.keys((await h.service.list()).proposals[0]!.signatures)).toEqual([owner.address])
  })
  test('a late remote response cannot import into a different wallet session', async () => {
    const q = queueHarness(), h = await imported(harness(false, q.queue)), p = await propose(h)
    let release!: () => void, started!: () => void
    const reached = new Promise<void>(resolve => { started = resolve })
    q.hold(async () => { started(); await new Promise<void>(resolve => { release = resolve }) })
    q.setRows([remote(p)])
    const syncing = h.service.sync({ address: SAFE })
    await reached
    const before = h.writes.get('wallet-a')
    h.setKey('another-wallet')
    release()
    await expect(syncing).rejects.toThrow('Wallet changed')
    expect(h.writes.get('wallet-a')).toBe(before)
  })
})

describe('Base Safe account and transaction boundary', () => {
  test('account-scoped proposal import refuses another Safe or another selected asset', async () => {
    const h=await imported(),p=await propose(h)
    await expect(h.service.importProposal({json:JSON.stringify(p),expectedSafe:RECIPIENT,expectedAsset:'ETH'})).rejects.toThrow('different vault account')
    await expect(h.service.importProposal({json:JSON.stringify(p),expectedSafe:SAFE,expectedAsset:'USDC'})).rejects.toThrow('selected vault asset')
    expect(h.sends).toBe(0)
  })
  test('contract, owner and threshold inspection uses one fixed Base block', async () => {
    const h = harness()
    await h.service.inspectAccount({ address: SAFE, name: 'Snapshot' })
    expect(h.controlBlocks.length).toBe(5)
    expect(new Set(h.controlBlocks)).toEqual(new Set(['0x100']))
  })
  test('prepares the previously reviewed 2-of-2 address without broadcasting or persisting a draft', async () => {
    const h = harness()
    const connected = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'
    // Canonical numeric owner order matches the operator-approved handoff.
    const s = new SafeMultisigService({
      session: async () => ({
        key: 'k',
        scope: 's',
        owner: connected,
        sessionOnly: false,
        nestedClearSign: false,
      }),
      currentKey: () => 'k',
      read: () => null,
      write: () => {
        throw new Error('Preparation must not persist')
      },
      rpc: h.rpc,
    })
    const r = await s.prepareCreate({
      name: 'Base Safe',
      otherOwners: ['0x6C3D4902D23D0D9708EFC0977Fa4Da3c33Bd385f'],
      threshold: 2,
      saltNonce: '2026110401',
    })
    expect(r.safe.address).toBe('0x57c193Ea42ae3992D1350099670D672c4dA4f9D9')
    expect(r.safe.owners).toEqual(['0x6C3D4902D23D0D9708EFC0977Fa4Da3c33Bd385f', connected])
    expect(h.sends).toBe(0)
  })
  test('rejects duplicate owners and an insecure or impossible creation threshold', async () => {
    const h = harness()
    await expect(
      h.service.prepareCreate({ name: 'Safe', otherOwners: [owner.address], threshold: 2 })
    ).rejects.toThrow('unique')
    for (const threshold of [0, 1, 3, 2.5])
      await expect(
        h.service.prepareCreate({ name: 'Safe', otherOwners: [coowner.address], threshold })
      ).rejects.toThrow('threshold')
  })
  test('verifies bytecode before saving imported accounts', async () => {
    const h = harness()
    h.setBadCode()
    await expect(
      h.service.importAccount({
        address: SAFE,
        name: 'Spoof',
        expectedOwners: [owner.address, coowner.address],
        expectedThreshold: 2,
      })
    ).rejects.toThrow('bytecode')
    expect(h.writes.size).toBe(0)
  })
  test('import requires the reviewed owner configuration and rechecks it at confirmation', async () => {
    const h = harness()
    const preview = await h.service.inspectAccount({ address: SAFE, name: 'Reviewed Safe' })
    expect(h.writes.size).toBe(0)
    h.setOwners([owner.address, outsider.address])
    await expect(
      h.service.importAccount({
        address: SAFE,
        name: 'Reviewed Safe',
        expectedOwners: preview.owners,
        expectedThreshold: preview.threshold,
      })
    ).rejects.toThrow('owners or threshold changed')
    expect(h.writes.size).toBe(0)
  })
  test('funding verification fails if a recipient Safe has changed control', async () => {
    const h = harness()
    await h.service.verifyRecipient({ address: SAFE, owners: [owner.address, coowner.address], threshold: 2 })
    h.setOwners([owner.address, outsider.address])
    await expect(
      h.service.verifyRecipient({ address: SAFE, owners: [owner.address, coowner.address], threshold: 2 })
    ).rejects.toThrow('owners or threshold changed')
    expect(h.sends).toBe(0)
  })
  test('a refreshed owner change stays blocked until explicitly re-reviewed and confirmed', async () => {
    const h = await imported()
    h.setOwners([owner.address, outsider.address])
    expect((await h.service.refresh({ address: SAFE })).configurationChanged).toBe(true)
    await expect(propose(h)).rejects.toThrow('owners or threshold changed')
    expect((await h.service.list()).accounts[0].configurationChanged).toBe(true)
    const current = await h.service.inspectAccount({ address: SAFE, name: 'Reviewed Safe' })
    await h.service.importAccount({
      address: SAFE,
      name: current.name,
      expectedOwners: current.owners,
      expectedThreshold: current.threshold,
    })
    expect((await h.service.list()).accounts[0].configurationChanged).toBeUndefined()
    await expect(propose(h)).resolves.toHaveProperty('hash')
  })
  test('saving a reviewed setup creates an undeployed vault without signing or broadcast', async () => {
    const h = harness()
    const review = await h.service.prepareCreate({
      name: 'Draft Safe',
      otherOwners: [coowner.address],
      threshold: 2,
      saltNonce: '42',
    })
    const draft = await h.service.saveSetup({ reviewId: review.id })
    expect(draft.deployed).toBe(false)
    expect(draft.saltNonce).toBe('42')
    expect(draft.deploymentTx).toBeUndefined()
    expect((await h.service.list()).accounts).toHaveLength(1)
    expect(h.sends).toBe(0)
  })
  test('keeps hidden-wallet accounts and proposals in RAM and discards them on session change', async () => {
    const h = await imported(harness(true))
    await propose(h)
    expect((await h.service.list()).proposals).toHaveLength(1)
    expect(h.writes.size).toBe(0)
    h.setKey('next-hidden-wallet')
    expect((await h.service.list()).accounts).toHaveLength(0)
    expect((await h.service.list()).proposals).toHaveLength(0)
  })
  test('a saved Safe and its proposals are not listed for an unrelated connected owner', async () => {
    const h = await imported()
    await propose(h)
    h.setConnectedOwner(outsider.address)
    expect((await h.service.list()).accounts).toEqual([])
    expect((await h.service.list()).proposals).toEqual([])
    h.setConnectedOwner(coowner.address)
    expect((await h.service.list()).accounts).toHaveLength(1)
    expect((await h.service.list()).proposals).toHaveLength(1)
  })
  test('an asynchronous wallet switch prevents persistence', async () => {
    const h = harness()
    h.hold(async () => {
      h.setKey('other-device')
    })
    await expect(
      h.service.importAccount({
        address: SAFE,
        name: 'Race',
        expectedOwners: [owner.address, coowner.address],
        expectedThreshold: 2,
      })
    ).rejects.toThrow('Wallet changed')
    expect(h.writes.size).toBe(0)
  })
  test('USDC proposal reviews the exact native Base token recipient and amount', async () => {
    const h = await imported()
    const p = await propose(h, 'USDC')
    expect(describeSafeTransfer(p.transaction)).toEqual({
      asset: 'USDC',
      amount: '0.5',
      recipient: RECIPIENT,
    })
    expect(p.transaction.to.toLowerCase()).toBe(SAFE_USDC)
    expect(h.sends).toBe(0)
  })
  test('rejects tampered hashes, wrong chain, delegated calls, refunds, hidden fields and trailing calldata', async () => {
    const h = await imported()
    const p = await propose(h, 'USDC')
    const variants = [
      { ...p, chainId: 1 },
      { ...p, hash: '0x' + '00'.repeat(32) },
      { ...p, title: 'Free mint' },
      ...[{ operation: 1 }, { gasPrice: '1' }, { data: p.transaction.data + '00' }, { value: '01' }].map(
        (t) => ({ ...p, transaction: { ...p.transaction, ...t } })
      ),
    ]
    for (const v of variants) expect(() => validateSafeProposal(v)).toThrow()
  })
  test('rejects signatures from nonowners and signatures over altered amounts', async () => {
    const h = await imported()
    const p = await propose(h)
    const importedProposal = { ...p, signatures: { [outsider.address]: await sign(p, outsider) } }
    await expect(h.service.importProposal({ json: JSON.stringify(importedProposal) })).rejects.toThrow(
      'current Safe owner'
    )
    await expect(
      h.service.addSignature({ hash: p.hash, signature: await sign(p, outsider) })
    ).rejects.toThrow('connected KeepKey')
    expect(() =>
      validateSafeProposal({
        ...p,
        transaction: { ...p.transaction, value: '7' },
        signatures: { [owner.address]: '0x' + '11'.repeat(65) },
      })
    ).toThrow()
  })
  test('merges two independently exported approvals and sorts signatures by owner address before execution', async () => {
    const h = await imported()
    const p = await propose(h)
    const one = await sign(p, owner)
    const two = await sign(p, coowner)
    await h.service.addSignature({ hash: p.hash, signature: one })
    await expect(h.service.prepareExecute({ hash: p.hash })).rejects.toThrow('2 owner approvals')
    await h.service.importProposal({ json: JSON.stringify({ ...p, signatures: { [coowner.address]: two } }) })
    const r = await h.service.prepareExecute({ hash: p.hash })
    const sorted = [
      [owner.address, one],
      [coowner.address, two],
    ].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
    expect(h.executionSignatures).toBe(utils.hexConcat(sorted.map(([, sig]) => sig)))
    expect(r.proposal?.signatures).toHaveProperty(owner.address)
    expect(r.transfer?.amount).toBe('0.5')
    expect(h.sends).toBe(0)
  })
  test('revalidates Safe nonce and current owners before approval and execution', async () => {
    const h = await imported()
    const p = await propose(h)
    await h.service.addSignature({ hash: p.hash, signature: await sign(p, owner) })
    h.setNonce('1')
    await expect(h.service.signingData({ hash: p.hash })).rejects.toThrow('nonce changed')
    h.setNonce('0')
    h.setOwners([coowner.address, outsider.address])
    await expect(h.service.prepareExecute({ hash: p.hash })).rejects.toThrow('owners or threshold changed')
  })
  test('broadcasts only the exact reviewed signer, data, value, chain, nonce and fees; retries do not send twice', async () => {
    const h = harness()
    const r = await h.service.prepareCreate({ name: 'Safe', otherOwners: [coowner.address], threshold: 2 })
    const { addressNList: _, ...unsigned } = r.transaction
    for (const altered of [
      { to: RECIPIENT },
      { data: '0x' },
      { value: '0x1' },
      { chainId: 1 },
      { nonce: '0x1' },
      { gasPrice: '0x1' },
      { gasLimit: '0x5208' },
    ]) {
      const signedTx = await owner.signTransaction({ ...unsigned, ...altered })
      await expect(h.service.broadcast({ reviewId: r.id, signedTx })).rejects.toThrow('differs')
    }
    await expect(
      h.service.broadcast({ reviewId: r.id, signedTx: await outsider.signTransaction(unsigned) })
    ).rejects.toThrow('differs')
    expect(h.sends).toBe(0)
    const signedTx = await owner.signTransaction(unsigned)
    const sent = await h.service.broadcast({ reviewId: r.id, signedTx })
    expect(sent.txid).toBe(utils.keccak256(signedTx))
    expect(h.sends).toBe(1)
    await h.service.broadcast({ reviewId: r.id, signedTx })
    expect(h.sends).toBe(1)
    expect((await h.service.list()).accounts[0].deployed).toBe(false)
  })
  test('expired reviews and reviews from another session cannot broadcast', async () => {
    const h = harness()
    const r = await h.service.prepareCreate({ name: 'Safe', otherOwners: [coowner.address], threshold: 2 })
    const { addressNList: _, ...unsigned } = r.transaction
    const signedTx = await owner.signTransaction(unsigned)
    h.setNow(2_000_000)
    await expect(h.service.broadcast({ reviewId: r.id, signedTx })).rejects.toThrow('expired')
    h.setKey('next-session')
    await expect(h.service.broadcast({ reviewId: r.id, signedTx })).rejects.toThrow('not found')
    expect(h.sends).toBe(0)
  })
})
