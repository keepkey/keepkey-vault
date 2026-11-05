import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { VaultImportService } from './vault-import'
import { inspectBaseSafe, SAFE_ABI } from './safe-multisig'
import { SAFE_SINGLETONS } from '../shared/safe-deployments'
const SAFE_L2_150 = SAFE_SINGLETONS.find(c => c.version === '1.5.0')!.address
import { VaultAddressBook } from './vault-addressbook'
import type { VaultAddParams } from '../shared/safe-multisig'
import type { VaultIdentity } from '../shared/vault-identity'
// Published @safe-global/safe-smart-account@1.5.0 build artifacts, not RPC-supplied trust roots.
import code from './safe-v150.contracts.fixture.json'
const address = '0x6717d97655d8fC9d05C2DD3F28b54f574309B473'
const owners = [2, 3, 4, 5].map((n) => '0x' + n.toString(16).padStart(40, '0'))
const params: VaultAddParams = {
  chainId: 8453,
  address,
  name: 'Shared Base vault',
  rpcUrl: 'https://mainnet.base.org',
}
function setup(hidden = false) {
  let context = { key: 'landing-session', hidden },
    now = 1000,
    chainId = '0x2105',
    version = '1.5.0',
    badCode = false,
    currentOwners = owners
  let inspectionCalls = 0
  const saved: VaultIdentity[] = []
  const rpc = async (method: string, args: any[]) => {
    if (method === 'eth_chainId') return chainId
    if (method === 'eth_blockNumber') return '0x123'
    if (method === 'eth_getCode')
      return badCode
        ? '0x6000'
        : args[0].toLowerCase() === address.toLowerCase()
        ? code.proxy
        : code.singleton
    if (method === 'eth_getBalance') return '0x0'
    if (method === 'eth_call') {
      const selector = args[0].data.slice(0, 10)
      if (selector === '0x70a08231') return '0x' + '0'.repeat(64)
      expect(args[1]).toBe('0x123')
      const fn = SAFE_ABI.parseTransaction({ data: args[0].data }).name
      const results: Record<string, any[]> = {
        masterCopy: [SAFE_L2_150],
        VERSION: [version],
        getOwners: [currentOwners],
        getThreshold: [2],
        nonce: [0],
      }
      return SAFE_ABI.encodeFunctionResult(fn, results[fn])
    }
    throw Error('Forbidden RPC ' + method)
  }
  const service = new VaultImportService({
    context: () => ({ ...context }),
    now: () => now,
    inspect: async (p) => {
      inspectionCalls++
      return inspectBaseSafe(rpc, p.address, p.name)
    },
    save: (v) => saved.push(v),
  })
  return {
    service,
    saved,
    rpc,
    changeContext: (v: typeof context) => {
      context = v
    },
    setNow: (v: number) => {
      now = v
    },
    setOwners: (v: string[]) => {
      currentOwners = v
    },
    badCode: () => {
      badCode = true
    },
    wrongChain: () => {
      chainId = '0x1'
    },
    badVersion: () => {
      version = '1.4.1'
    },
    get inspections() {
      return inspectionCalls
    },
  }
}
describe('Wallet-select vault import', () => {
  test('inspects the pinned v1.5.0 deployment as a 2-of-4 Base vault without a device or saving', async () => {
    const h = setup()
    const review = await h.service.preview(params)
    expect(review.account.safeVersion).toBe('1.5.0')
    expect(review.account.address).toBe(address)
    expect(review.account.threshold).toBe(2)
    expect(review.account.owners).toHaveLength(4)
    expect(review.chainId).toBe(8453)
    expect(review.rpcHost).toBe('mainnet.base.org')
    expect(h.saved).toHaveLength(0)
  })
  test('confirms by rechecking chain and owners, then saves the exact public identity to the directory', async () => {
    const h = setup(),
      review = await h.service.preview(params)
    const vault = await h.service.confirm({ reviewId: review.id })
    expect(h.inspections).toBe(2)
    expect(h.saved).toHaveLength(1)
    expect(vault.safeVersion).toBe('1.5.0')
    expect(vault.networkId).toBe('eip155:8453')
    expect(vault.accountId).toBe('eip155:8453:' + address)
    expect(vault.cosigners).toHaveLength(4)
    const db = new Database(':memory:'),
      book = new VaultAddressBook(db)
    book.sync({ walletId: 'vault-directory:' + vault.id, deviceId: '' }, 'safe', [vault])
    expect(book.list()[0].vault?.threshold).toBe(2)
    expect(book.list()[0].vault?.safeVersion).toBe('1.5.0')
    db.close()
    await expect(h.service.confirm({ reviewId: review.id })).rejects.toThrow('expired')
  })
  test('rejects a wrong chain, substituted bytecode, and spoofed version', async () => {
    for (const mode of ['wrongChain', 'badCode', 'badVersion'] as const) {
      const h = setup()
      h[mode]()
      await expect(h.service.preview(params)).rejects.toThrow()
      expect(h.saved).toHaveLength(0)
    }
  })
  test('changing owners between review and save requires a fresh review', async () => {
    const h = setup(),
      review = await h.service.preview(params)
    h.setOwners(owners.slice(0, 3))
    await expect(h.service.confirm({ reviewId: review.id })).rejects.toThrow('configuration changed')
    expect(h.saved).toHaveLength(0)
  })
  test('hidden-wallet review cannot be saved after switching to a public wallet', async () => {
    const h = setup(true),
      review = await h.service.preview(params)
    expect(review.sessionOnly).toBe(true)
    h.changeContext({ key: 'new-session', hidden: false })
    await expect(h.service.confirm({ reviewId: review.id })).rejects.toThrow('session changed')
    expect(h.saved).toHaveLength(0)
  })
  test('a hidden import remains session-only and an expired review cannot save', async () => {
    const h = setup(true),
      review = await h.service.preview(params),
      v = await h.service.confirm({ reviewId: review.id })
    expect(v.sessionOnly).toBe(true)
    const next = await h.service.preview(params)
    h.setNow(400000)
    await expect(h.service.confirm({ reviewId: next.id })).rejects.toThrow('expired')
    expect(h.saved).toHaveLength(1)
  })
  test('unsupported networks and malformed addresses never reach the RPC', async () => {
    const h = setup()
    await expect(h.service.preview({ ...params, chainId: 1 as 8453 })).rejects.toThrow('Base mainnet')
    await expect(h.service.preview({ ...params, address: 'not-an-address' })).rejects.toThrow()
    await expect(
      h.service.preview({ ...params, rpcUrl: 'https://name:password@example.com' })
    ).rejects.toThrow('credentials')
    expect(h.inspections).toBe(0)
  })
})
