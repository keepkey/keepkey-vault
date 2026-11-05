import { BigNumber, utils } from 'ethers'
import { randomUUID } from 'node:crypto'
import { evmAddressPath } from '../shared/chains'
import {
  SAFE_CHAIN_ID,
  SAFE_USDC,
  type SafeAccount,
  type SafeContext,
  type SafeCreateParams,
  type SafeProposal,
  type SafeTransaction,
  type SafeTransfer,
  type SafeTxReview,
} from '../shared/safe-multisig'

// safe-global/safe-deployments@685f22be940739259cfc4148db3df7048f39a4e8,
// canonical Base v1.4.1. Proxy runtime: @safe-global/safe-contracts@1.4.1 artifact.
export const SAFE_DEPLOYMENTS = {
  factory: [
    '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
    '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317',
  ],
  singleton: [
    '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
    '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff',
  ],
  handler: [
    '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
    '0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9',
  ],
} as const
const PROXY_HASH = '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c'
const ZERO = '0x0000000000000000000000000000000000000000'
export const SAFE_ABI = new utils.Interface([
  'function setup(address[],uint256,address,bytes,address,address,uint256,address)',
  'function VERSION() view returns (string)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function masterCopy() view returns (address)',
  'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)',
  'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)',
])
export const FACTORY_ABI = new utils.Interface([
  'function proxyCreationCode() view returns (bytes)',
  'function createProxyWithNonce(address,bytes,uint256) returns (address)',
])
const TOKEN_ABI = new utils.Interface([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])
export const SAFE_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
}
export function safeTypedData(proposal: SafeProposal) {
  return {
    domain: { chainId: SAFE_CHAIN_ID, verifyingContract: proposal.safe },
    primaryType: 'SafeTx',
    types: {
      EIP712Domain: [
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...SAFE_TYPES,
    },
    message: proposal.transaction,
  }
}
function txArgs(t: SafeTransaction) {
  return [
    t.to,
    t.value,
    t.data,
    t.operation,
    t.safeTxGas,
    t.baseGas,
    t.gasPrice,
    t.gasToken,
    t.refundReceiver,
    t.nonce,
  ]
}
function address(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Enter a valid Ethereum address')
  const a = utils.getAddress(v.trim())
  if (a === ZERO || a.toLowerCase() === '0x0000000000000000000000000000000000000001')
    throw new Error('Zero and sentinel addresses are not allowed')
  return a
}
function uint(v: unknown): string {
  if (typeof v !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(v) || BigInt(v) >= 2n ** 256n)
    throw new Error('Invalid uint256 value')
  return v
}
function label(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 60)
    throw new Error('Enter a Safe name (up to 60 characters)')
  return v.trim()
}
function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}
function exactKeys(v: any, keys: string[]) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== keys.sort().join())
    throw new Error('Unsupported proposal fields')
}
/** Derive the review exclusively from signed calldata, never from imported labels. */
export function describeSafeTransfer(t: SafeTransaction): SafeTransfer {
  if (
    t.operation !== 0 ||
    t.safeTxGas !== '0' ||
    t.baseGas !== '0' ||
    t.gasPrice !== '0' ||
    t.gasToken !== ZERO ||
    t.refundReceiver !== ZERO
  ) {
    throw new Error('This release supports CALL transfers without Safe gas refunds only')
  }
  if (t.data === '0x' && BigInt(t.value) > 0n)
    return { asset: 'ETH', recipient: address(t.to), amount: utils.formatEther(t.value) }
  if (same(t.to, SAFE_USDC) && t.value === '0') {
    const [recipient, amount] = TOKEN_ABI.decodeFunctionData('transfer', t.data)
    if (
      TOKEN_ABI.encodeFunctionData('transfer', [recipient, amount]).toLowerCase() !== t.data.toLowerCase() ||
      amount.isZero()
    )
      throw new Error('Noncanonical token transfer')
    return { asset: 'USDC', recipient: address(recipient), amount: utils.formatUnits(amount, 6) }
  }
  throw new Error('Unsupported Safe transaction: only ETH and native Base USDC transfers are supported')
}
export function validateSafeProposal(input: unknown): SafeProposal {
  const p = clone(input) as SafeProposal
  exactKeys(p, [
    'format',
    'chainId',
    'safe',
    'hash',
    'transaction',
    'signatures',
    ...(p?.executionTx ? ['executionTx'] : []),
  ])
  if (p.format !== 'keepkey-safe-v1' || p.chainId !== SAFE_CHAIN_ID)
    throw new Error('Proposal must be a Base Safe proposal')
  p.safe = address(p.safe)
  exactKeys(p.transaction, [
    'to',
    'value',
    'data',
    'operation',
    'safeTxGas',
    'baseGas',
    'gasPrice',
    'gasToken',
    'refundReceiver',
    'nonce',
  ])
  const t = p.transaction
  t.to = address(t.to)
  for (const field of ['value', 'safeTxGas', 'baseGas', 'gasPrice', 'nonce'] as const)
    t[field] = uint(t[field])
  if (typeof t.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(t.data) || t.data.length > 1024)
    throw new Error('Invalid calldata')
  describeSafeTransfer(t)
  const hash = utils._TypedDataEncoder.hash(
    { chainId: SAFE_CHAIN_ID, verifyingContract: p.safe },
    SAFE_TYPES,
    t
  )
  if (p.hash !== hash) throw new Error('Proposal hash does not match its transaction')
  if (
    !p.signatures ||
    typeof p.signatures !== 'object' ||
    Array.isArray(p.signatures) ||
    Object.keys(p.signatures).length > 20
  )
    throw new Error('Invalid signatures')
  const signatures: Record<string, string> = {}
  for (const [owner, sig] of Object.entries(p.signatures)) {
    const signer = address(owner)
    if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig))
      throw new Error('Expected a 65-byte EIP-712 signature')
    const parsed = utils.splitSignature(sig)
    if (
      ![27, 28].includes(parseInt(sig.slice(-2), 16)) ||
      BigInt(parsed.s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
    )
      throw new Error('Noncanonical signature')
    if (!same(utils.recoverAddress(hash, sig), signer) || signatures[signer])
      throw new Error('Invalid or duplicate owner signature')
    signatures[signer] = sig
  }
  p.signatures = signatures
  // Execution status is local receipt data, never trusted from an imported file.
  delete p.executionTx
  return p
}
export interface SafeSession {
  key: string
  scope: string
  owner: string
  sessionOnly: boolean
  nestedClearSign: boolean
}
interface SafeStore {
  accounts: SafeAccount[]
  proposals: SafeProposal[]
}
interface SafeDeps {
  session: () => Promise<SafeSession>
  currentKey: () => string
  rpc: (method: string, params: any[]) => Promise<any>
  read: (scope: string) => string | null | undefined
  write: (scope: string, value: string) => void
  now?: () => number
  changed?: (session: SafeSession, accounts: SafeAccount[]) => void
  assertDestination?: (networkId: string, address: string, assetCaip: string) => void | Promise<void>
}
// SafeL2 v1.5.0 deployment: safe-global/safe-deployments@685f22be940739259cfc4148db3df7048f39a4e8.
// Proxy runtime independently matched to @safe-global/safe-smart-account@1.5.0.
export const SAFE_V150 = {
  singleton: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
  codeHash: '0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc',
  proxyHash: '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f',
} as const
export async function inspectBaseSafe(
  rpc: (method: string, params: any[]) => Promise<any>,
  input: string,
  name: string
): Promise<SafeAccount> {
  const a = address(input)
  name = label(name)
  if (Number(await rpc('eth_chainId', [])) !== SAFE_CHAIN_ID) throw new Error('RPC is not on Base')
  const block = await rpc('eth_blockNumber', [])
  if (typeof block !== 'string' || !/^0x[0-9a-f]+$/i.test(block)) throw new Error('Invalid Base block number')
  const proxyHash = utils.keccak256(await rpc('eth_getCode', [a, block]))
  if (![PROXY_HASH, SAFE_V150.proxyHash].includes(proxyHash))
    throw new Error('Unsupported Safe proxy bytecode on Base')
  const call = async (to: string, abi: utils.Interface, fn: string, args: any[] = []) =>
    abi.decodeFunctionResult(
      fn,
      await rpc('eth_call', [{ to, data: abi.encodeFunctionData(fn, args) }, block])
    )
  const [implementation] = await call(a, SAFE_ABI, 'masterCopy')
  const expected =
    same(implementation, SAFE_DEPLOYMENTS.singleton[0]) && proxyHash === PROXY_HASH
      ? { version: '1.4.1' as const, hash: SAFE_DEPLOYMENTS.singleton[1] }
      : same(implementation, SAFE_V150.singleton) && proxyHash === SAFE_V150.proxyHash
      ? { version: '1.5.0' as const, hash: SAFE_V150.codeHash }
      : undefined
  if (!expected) throw new Error('Unsupported Safe implementation (requires pinned SafeL2 v1.4.1 or v1.5.0)')
  if (utils.keccak256(await rpc('eth_getCode', [implementation, block])) !== expected.hash)
    throw new Error('Safe implementation bytecode verification failed')
  const [[version], [owners], [threshold], [nonce], eth, [usdc]] = await Promise.all([
    call(a, SAFE_ABI, 'VERSION'),
    call(a, SAFE_ABI, 'getOwners'),
    call(a, SAFE_ABI, 'getThreshold'),
    call(a, SAFE_ABI, 'nonce'),
    rpc('eth_getBalance', [a, block]),
    call(SAFE_USDC, TOKEN_ABI, 'balanceOf', [a]),
  ])
  if (
    version !== expected.version ||
    !owners.length ||
    owners.length > 20 ||
    threshold.lt(1) ||
    threshold.gt(owners.length)
  )
    throw new Error('Unsupported Safe configuration')
  const normalizedOwners = owners.map(address)
  if (new Set(normalizedOwners.map((v: string) => v.toLowerCase())).size !== owners.length)
    throw new Error('Invalid duplicate Safe owners')
  return {
    address: a,
    name,
    owners: normalizedOwners,
    threshold: threshold.toNumber(),
    nonce: nonce.toString(),
    deployed: true,
    safeVersion: expected.version,
    balanceEth: utils.formatEther(eth),
    balanceUsdc: utils.formatUnits(usdc, 6),
  }
}
export class SafeMultisigService {
  private state?: { session: SafeSession; store: SafeStore }
  private reviews = new Map<
    string,
    { session: string; review: SafeTxReview; busy?: boolean; txid?: string }
  >()
  private now: () => number
  constructor(private deps: SafeDeps) {
    this.now = deps.now || Date.now
  }
  clear() {
    this.state = undefined
    this.reviews.clear()
  }
  private assert(s: SafeSession) {
    if (this.deps.currentKey() !== s.key) throw new Error('Wallet changed. Reopen Multisig and review again.')
  }
  private async open() {
    const s = await this.deps.session()
    this.assert(s)
    if (this.state?.session.key !== s.key) {
      this.reviews.clear()
      let store: SafeStore = { accounts: [], proposals: [] }
      if (!s.sessionOnly) {
        const raw = this.deps.read(s.scope)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (!Array.isArray(parsed.accounts) || !Array.isArray(parsed.proposals))
            throw new Error('Invalid saved Safe data')
          store = { accounts: parsed.accounts, proposals: parsed.proposals }
        }
      }
      this.state = { session: s, store }
    }
    return { s, store: this.state!.store }
  }
  private save(s: SafeSession, store: SafeStore) {
    this.assert(s)
    if (!s.sessionOnly) this.deps.write(s.scope, JSON.stringify(store))
    this.deps.changed?.(s, clone(store.accounts))
  }
  private async rpc(s: SafeSession, method: string, params: any[]) {
    this.assert(s)
    const result = await this.deps.rpc(method, params)
    this.assert(s)
    return result
  }
  private async call(
    s: SafeSession,
    to: string,
    abi: utils.Interface,
    fn: string,
    args: any[] = [],
    block = 'latest'
  ) {
    const result = await this.rpc(s, 'eth_call', [{ to, data: abi.encodeFunctionData(fn, args) }, block])
    return abi.decodeFunctionResult(fn, result)
  }
  private async verifyDeployments(s: SafeSession, block = 'latest') {
    if (Number(await this.rpc(s, 'eth_chainId', [])) !== SAFE_CHAIN_ID) throw new Error('RPC is not on Base')
    await Promise.all(
      Object.values(SAFE_DEPLOYMENTS).map(async ([a, hash]) => {
        if (utils.keccak256(await this.rpc(s, 'eth_getCode', [a, block])) !== hash)
          throw new Error('Safe deployment bytecode verification failed')
      })
    )
  }
  private async inspect(s: SafeSession, a: string, name: string): Promise<SafeAccount> {
    return inspectBaseSafe((method, params) => this.rpc(s, method, params), a, name)
  }
  private upsert(store: SafeStore, a: SafeAccount) {
    const i = store.accounts.findIndex((v) => same(v.address, a.address))
    if (i >= 0) store.accounts[i] = a
    else {
      if (store.accounts.length >= 50) throw new Error('Maximum of 50 saved Safes')
      store.accounts.push(a)
    }
  }
  async list(): Promise<SafeContext> {
    const { s, store } = await this.open()
    return clone({
      owner: s.owner,
      session: s.key,
      sessionOnly: s.sessionOnly,
      nestedClearSign: s.nestedClearSign,
      ...store,
    })
  }
  async inspectAccount(params: { address: string; name: string }) {
    const { s } = await this.open()
    return this.inspect(s, params.address, label(params.name))
  }
  async verifyRecipient(params: { address: string; owners: string[]; threshold: number }) {
    const { s } = await this.open()
    const fresh = await this.inspect(s, params.address, 'Destination vault')
    this.assertConfiguration(fresh, params.owners, params.threshold)
  }
  private assertConfiguration(a: SafeAccount, owners: string[], threshold: number) {
    if (
      !Array.isArray(owners) ||
      owners.length !== a.owners.length ||
      threshold !== a.threshold ||
      [...owners]
        .map((v) => address(v).toLowerCase())
        .sort()
        .join() !==
        a.owners
          .map((v) => v.toLowerCase())
          .sort()
          .join()
    ) {
      throw new Error(
        'Vault owners or threshold changed. Review and confirm its configuration again before funding.'
      )
    }
  }
  async importAccount(params: {
    address: string
    name: string
    expectedOwners: string[]
    expectedThreshold: number
  }) {
    const { s, store } = await this.open()
    const account = await this.inspect(s, params.address, label(params.name))
    this.assertConfiguration(account, params.expectedOwners, params.expectedThreshold)
    const previous = store.accounts.find((a) => same(a.address, account.address))
    account.reviewedAt = Math.max(this.now(), (previous?.reviewedAt || 0) + 1)
    this.upsert(store, account)
    this.save(s, store)
    return clone(account)
  }
  async refresh(params: { address: string }) {
    const { s, store } = await this.open()
    const old = store.accounts.find((a) => same(a.address, params.address))
    if (!old) throw new Error('Safe is not saved in this wallet')
    if (!old.deployed && (await this.rpc(s, 'eth_getCode', [old.address, 'latest'])) === '0x')
      return clone(old)
    const fresh = await this.inspect(s, old.address, old.name)
    fresh.deploymentTx = old.deploymentTx
    fresh.reviewedAt = old.reviewedAt
    try {
      this.assertConfiguration(fresh, old.owners, old.threshold)
    } catch {
      fresh.configurationChanged = true
    }
    if (old.configurationChanged) fresh.configurationChanged = true
    this.upsert(store, fresh)
    this.save(s, store)
    return clone(fresh)
  }
  private async review(
    s: SafeSession,
    kind: 'create' | 'execute',
    safe: SafeAccount,
    to: string,
    data: string,
    extras: Partial<SafeTxReview> = {}
  ): Promise<SafeTxReview> {
    const tx = { from: s.owner, to, value: '0x0', data }
    const [estimate, price, nonce, balance] = await Promise.all([
      this.rpc(s, 'eth_estimateGas', [tx]),
      this.rpc(s, 'eth_gasPrice', []),
      this.rpc(s, 'eth_getTransactionCount', [s.owner, 'pending']),
      this.rpc(s, 'eth_getBalance', [s.owner, 'latest']),
    ])
    const gasLimit = BigNumber.from(estimate).mul(120).add(99).div(100)
    const gasPrice = BigNumber.from(price).mul(110).add(99).div(100)
    if (gasLimit.lte(0) || gasLimit.gt(10_000_000) || gasPrice.lte(0)) throw new Error('Invalid gas estimate')
    const review: SafeTxReview = {
      ...extras,
      id: randomUUID(),
      kind,
      safe: clone(safe),
      expiresAt: this.now() + 5 * 60_000,
      maximumExecutionFeeEth: utils.formatEther(gasLimit.mul(gasPrice)),
      ownerBalanceEth: utils.formatEther(balance),
      // Legacy gas avoids the existing EIP-1559 signing bug on chain IDs >= 256.
      transaction: {
        chainId: SAFE_CHAIN_ID,
        to,
        value: '0x0',
        data,
        nonce: BigNumber.from(nonce).toHexString(),
        gasLimit: gasLimit.toHexString(),
        gasPrice: gasPrice.toHexString(),
        addressNList: evmAddressPath(0),
      },
    }
    for (const [id, entry] of this.reviews)
      if (entry.review.expiresAt < this.now() && !entry.busy) this.reviews.delete(id)
    if (this.reviews.size >= 30) throw new Error('Too many pending reviews. Wait five minutes and retry.')
    this.reviews.set(review.id, { session: s.key, review: clone(review) })
    return review
  }
  async prepareCreate(params: SafeCreateParams) {
    const { s } = await this.open()
    const name = label(params.name)
    if (!Array.isArray(params.otherOwners) || params.otherOwners.length < 1 || params.otherOwners.length > 19)
      throw new Error('Add between 1 and 19 other owners')
    const owners = [address(s.owner), ...params.otherOwners.map(address)].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1
    )
    if (new Set(owners.map((a) => a.toLowerCase())).size !== owners.length)
      throw new Error('Every owner must be unique')
    if (!Number.isInteger(params.threshold) || params.threshold < 2 || params.threshold > owners.length)
      throw new Error('Choose a threshold between 2 and the owner count')
    const saltNonce = uint(params.saltNonce ?? BigInt('0x' + randomUUID().replace(/-/g, '')).toString())
    await this.verifyDeployments(s)
    const initializer = SAFE_ABI.encodeFunctionData('setup', [
      owners,
      params.threshold,
      ZERO,
      '0x',
      SAFE_DEPLOYMENTS.handler[0],
      ZERO,
      0,
      ZERO,
    ])
    const [code] = await this.call(s, SAFE_DEPLOYMENTS.factory[0], FACTORY_ABI, 'proxyCreationCode')
    const salt = utils.keccak256(
      utils.hexConcat([
        utils.keccak256(initializer),
        utils.hexZeroPad(BigNumber.from(saltNonce).toHexString(), 32),
      ])
    )
    const initCode = utils.hexConcat([
      code,
      utils.defaultAbiCoder.encode(['address'], [SAFE_DEPLOYMENTS.singleton[0]]),
    ])
    const predicted = utils.getCreate2Address(SAFE_DEPLOYMENTS.factory[0], salt, utils.keccak256(initCode))
    if ((await this.rpc(s, 'eth_getCode', [predicted, 'latest'])) !== '0x')
      throw new Error('This Safe is already deployed. Import its address instead.')
    const data = FACTORY_ABI.encodeFunctionData('createProxyWithNonce', [
      SAFE_DEPLOYMENTS.singleton[0],
      initializer,
      saltNonce,
    ])
    const result = await this.rpc(s, 'eth_call', [
      { from: s.owner, to: SAFE_DEPLOYMENTS.factory[0], data },
      'latest',
    ])
    if (!same(FACTORY_ABI.decodeFunctionResult('createProxyWithNonce', result)[0], predicted))
      throw new Error('Safe address simulation mismatch')
    return this.review(
      s,
      'create',
      {
        name,
        address: predicted,
        owners,
        threshold: params.threshold,
        nonce: '0',
        deployed: false,
        saltNonce,
      },
      SAFE_DEPLOYMENTS.factory[0],
      data,
      { saltNonce }
    )
  }
  async saveSetup(params: { reviewId: string }) {
    const { s, store } = await this.open()
    const entry = this.reviews.get(params.reviewId)
    if (!entry || entry.session !== s.key || entry.review.kind !== 'create' || entry.txid)
      throw new Error('Review the new Safe setup first')
    this.upsert(store, clone(entry.review.safe))
    this.save(s, store)
    return clone(entry.review.safe)
  }
  private account(store: SafeStore, a: string) {
    const safe = store.accounts.find((v) => same(v.address, address(a)))
    if (!safe?.deployed) throw new Error('Import or refresh the deployed Safe first')
    return safe
  }
  private async checkProposal(s: SafeSession, store: SafeStore, input: SafeProposal) {
    const existing = store.proposals.find((v) => v.hash === input.hash)
    const p = validateSafeProposal({ ...input, signatures: { ...existing?.signatures, ...input.signatures } })
    const destination = describeSafeTransfer(p.transaction)
    await this.deps.assertDestination?.(
      'eip155:8453',
      destination.recipient,
      destination.asset === 'ETH' ? 'eip155:8453/slip44:60' : `eip155:8453/erc20:${SAFE_USDC}`
    )
    const old = this.account(store, p.safe)
    const a = await this.inspect(s, p.safe, old.name)
    a.reviewedAt = old.reviewedAt
    try {
      this.assertConfiguration(a, old.owners, old.threshold)
      if (old.configurationChanged) throw new Error('Configuration needs review')
    } catch {
      a.configurationChanged = true
      this.upsert(store, a)
      this.save(s, store)
      throw new Error(
        'Vault owners or threshold changed. Review and confirm its configuration again before signing.'
      )
    }
    if (p.transaction.nonce !== a.nonce)
      throw new Error(`Safe nonce changed (current ${a.nonce}). Create a fresh proposal.`)
    for (const owner of Object.keys(p.signatures))
      if (!a.owners.some((v) => same(v, owner))) throw new Error('Signature is not from a current Safe owner')
    const [onchainHash] = await this.call(s, p.safe, SAFE_ABI, 'getTransactionHash', txArgs(p.transaction))
    if (onchainHash !== p.hash) throw new Error('Safe on-chain transaction hash mismatch')
    this.upsert(store, a)
    return { p, a }
  }
  private storeProposal(s: SafeSession, store: SafeStore, p: SafeProposal) {
    const old = store.proposals.find((v) => v.hash === p.hash)
    if (old) {
      p.signatures = { ...old.signatures, ...p.signatures }
      Object.assign(old, p)
    } else {
      if (store.proposals.length >= 100) throw new Error('Maximum of 100 local proposals')
      store.proposals.push(p)
    }
    this.save(s, store)
    return clone(p)
  }
  async propose(params: { safe: string } & SafeTransfer) {
    const { s, store } = await this.open()
    const old = this.account(store, params.safe)
    const a = await this.inspect(s, old.address, old.name)
    const recipient = address(params.recipient)
    await this.deps.assertDestination?.(
      'eip155:8453',
      recipient,
      params.asset === 'ETH' ? 'eip155:8453/slip44:60' : `eip155:8453/erc20:${SAFE_USDC}`
    )
    if (
      !['ETH', 'USDC'].includes(params.asset) ||
      typeof params.amount !== 'string' ||
      !/^\d+(?:\.\d+)?$/.test(params.amount) ||
      params.amount.length > 80
    )
      throw new Error('Enter a valid transfer amount')
    const amount = utils.parseUnits(params.amount, params.asset === 'ETH' ? 18 : 6)
    if (amount.lte(0)) throw new Error('Amount must be greater than zero')
    const transaction: SafeTransaction = {
      to: params.asset === 'ETH' ? recipient : utils.getAddress(SAFE_USDC),
      value: params.asset === 'ETH' ? amount.toString() : '0',
      data: params.asset === 'ETH' ? '0x' : TOKEN_ABI.encodeFunctionData('transfer', [recipient, amount]),
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: a.nonce,
    }
    const p: SafeProposal = {
      format: 'keepkey-safe-v1',
      chainId: SAFE_CHAIN_ID,
      safe: a.address,
      transaction,
      hash: utils._TypedDataEncoder.hash(
        { chainId: SAFE_CHAIN_ID, verifyingContract: a.address },
        SAFE_TYPES,
        transaction
      ),
      signatures: {},
    }
    await this.checkProposal(s, store, p)
    return this.storeProposal(s, store, p)
  }
  async importProposal(params: { json: string; expectedSafe?: string; expectedAsset?: 'ETH' | 'USDC' }) {
    if (typeof params.json !== 'string' || params.json.length > 40_000)
      throw new Error('Proposal file is too large')
    const { s, store } = await this.open()
    const input = validateSafeProposal(JSON.parse(params.json))
    if (params.expectedSafe && !same(input.safe, address(params.expectedSafe)))
      throw new Error('Proposal belongs to a different vault account')
    if (params.expectedAsset && describeSafeTransfer(input.transaction).asset !== params.expectedAsset)
      throw new Error('Proposal asset differs from the selected vault asset')
    const { p } = await this.checkProposal(s, store, input)
    return this.storeProposal(s, store, p)
  }
  async signingData(params: { hash: string }) {
    const { s, store } = await this.open()
    const old = store.proposals.find((p) => p.hash === params.hash)
    if (!old) throw new Error('Proposal not found')
    const { p, a } = await this.checkProposal(s, store, old)
    if (!a.owners.some((v) => same(v, s.owner))) throw new Error('Connected KeepKey is not a Safe owner')
    return { addressNList: evmAddressPath(0), typedData: safeTypedData(p) }
  }
  async addSignature(params: { hash: string; signature: string }) {
    const { s, store } = await this.open()
    const old = store.proposals.find((p) => p.hash === params.hash)
    if (!old) throw new Error('Proposal not found')
    const signer = utils.recoverAddress(old.hash, params.signature)
    if (!same(signer, s.owner)) throw new Error('Signature does not match the connected KeepKey owner')
    const { p } = await this.checkProposal(s, store, {
      ...old,
      signatures: { ...old.signatures, [signer]: params.signature },
    })
    return this.storeProposal(s, store, p)
  }
  async prepareExecute(params: { hash: string }) {
    const { s, store } = await this.open()
    const old = store.proposals.find((p) => p.hash === params.hash)
    if (!old) throw new Error('Proposal not found')
    const { p, a } = await this.checkProposal(s, store, old)
    const owners = Object.keys(p.signatures).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
    if (owners.length < a.threshold) throw new Error(`Need ${a.threshold} owner approvals`)
    const signatures = utils.hexConcat(owners.map((owner) => p.signatures[owner]))
    const data = SAFE_ABI.encodeFunctionData('execTransaction', [
      ...txArgs(p.transaction).slice(0, 9),
      signatures,
    ])
    const result = await this.rpc(s, 'eth_call', [{ from: s.owner, to: a.address, data }, 'latest'])
    if (SAFE_ABI.decodeFunctionResult('execTransaction', result)[0] !== true)
      throw new Error('Safe execution simulation failed')
    return this.review(s, 'execute', a, a.address, data, {
      proposal: p,
      transfer: describeSafeTransfer(p.transaction),
    })
  }
  async broadcast(params: { reviewId: string; signedTx: string }) {
    const { s, store } = await this.open()
    const entry = this.reviews.get(params.reviewId)
    if (!entry || entry.session !== s.key) throw new Error('Transaction review not found. Review again.')
    if (entry.txid) return { txid: entry.txid, safe: clone(entry.review.safe) }
    if (entry.busy) throw new Error('This transaction is already being submitted')
    if (entry.review.expiresAt < this.now())
      throw new Error('Transaction review expired. Refresh fees and review again.')
    const tx = utils.parseTransaction(params.signedTx)
    const expected = entry.review.transaction
    if (
      !tx.from ||
      !same(tx.from, s.owner) ||
      tx.chainId !== SAFE_CHAIN_ID ||
      (tx.type && tx.type !== 0) ||
      !tx.to ||
      !same(tx.to, expected.to) ||
      tx.data !== expected.data ||
      tx.value.toString() !== '0' ||
      tx.nonce !== Number(expected.nonce) ||
      !tx.gasLimit.eq(expected.gasLimit) ||
      !tx.gasPrice?.eq(expected.gasPrice)
    )
      throw new Error('Signed transaction differs from the reviewed transaction')
    entry.busy = true
    try {
      await this.verifyDeployments(s)
      if (entry.review.proposal) await this.checkProposal(s, store, entry.review.proposal)
      const simulated = await this.rpc(s, 'eth_call', [
        { from: s.owner, to: expected.to, data: expected.data, value: expected.value },
        'latest',
      ])
      if (
        entry.review.kind === 'execute' &&
        SAFE_ABI.decodeFunctionResult('execTransaction', simulated)[0] !== true
      )
        throw new Error('Safe execution simulation failed')
      if (
        entry.review.kind === 'create' &&
        !same(
          FACTORY_ABI.decodeFunctionResult('createProxyWithNonce', simulated)[0],
          entry.review.safe.address
        )
      )
        throw new Error('Safe address simulation mismatch')
      if (
        BigNumber.from(await this.rpc(s, 'eth_getTransactionCount', [s.owner, 'pending'])).toNumber() !==
        tx.nonce
      )
        throw new Error('Owner nonce changed. Review again.')
      const result = await this.rpc(s, 'eth_sendRawTransaction', [params.signedTx])
      if (typeof result !== 'string' || !same(result, utils.keccak256(params.signedTx)))
        throw new Error('RPC returned a different transaction hash. Check BaseScan before retrying.')
      entry.txid = result
      if (entry.review.kind === 'create') {
        const account = { ...entry.review.safe, deploymentTx: result }
        this.upsert(store, account)
      } else {
        const proposal = store.proposals.find((p) => p.hash === entry.review.proposal!.hash)
        if (proposal) proposal.executionTx = result
      }
      this.save(s, store)
      return { txid: result, safe: clone(entry.review.safe) }
    } finally {
      entry.busy = false
    }
  }
}
