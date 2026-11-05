import { describe, expect, test } from 'bun:test'
import { Wallet, utils } from 'ethers'
import {
  FACTORY_ABI,
  SAFE_ABI,
  SafeMultisigService,
  describeSafeTransfer,
  validateSafeProposal,
} from './safe-multisig'
import { SAFE_USDC, type SafeProposal } from '../shared/safe-multisig'
import { SAFE_CREATE } from '../shared/safe-deployments'
import { SAFE_TX_TYPE } from './safe-core'
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
function harness(hidden = false) {
  let key = 'session-a'
  let now = 1_000_000
  let safeNonce = '0'
  let badCode = false
  let sends = 0
  let owners = [owner.address, coowner.address]
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
    session: async () => ({
      key,
      scope: 'wallet-a',
      owner: owner.address,
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
