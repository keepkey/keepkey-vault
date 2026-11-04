/**
 * SafeMessage on the approval card, from REAL Safe{Wallet} messages: the
 * typed data an owner's wallet receives and the Transaction Service record of
 * the same message (fixtures/safe/messages, each file names its URL).
 *
 * Safe{Wallet} sends SafeMessage { message: hashMessage(text) } or the EIP-712
 * hash of a typed document, never the original. Desktop reads the original
 * from the Transaction Service before approval and keeps it only when it
 * hashes to the signed value.
 */
import { describe, expect, test } from 'bun:test'
import { utils } from 'ethers'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import { decodeEIP712 } from '../src/bun/eip712-decoder'
import { attachSafeMessagePreimage } from '../src/bun/safe-message-preimage'
import type { SigningRequestInfo } from '../src/shared/types'
import siweOdos from './fixtures/safe/messages/siwe-odos.json'
import cowdaoHexHash from './fixtures/safe/messages/cowdao-hex-hash.json'
import permitReclamm from './fixtures/safe/messages/permit-reclamm.json'
import basePermit2Batch from './fixtures/safe/messages/base-permit2-batch.json'

type Fixture = typeof siweOdos | typeof cowdaoHexHash | typeof permitReclamm | typeof basePermit2Batch
const OWNER = '0x927CBc6A90080068cF839d27000E13355870c825'
// The shape of Safe's chain config (safe-config.safe.global), two of its 57 chains.
const CONFIG = { results: [
  { chainId: '1', transactionService: 'https://api.safe.global/tx-service/eth' },
  { chainId: '8453', transactionService: 'https://api.safe.global/tx-service/base' },
] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Safe's services as they answer, serving `records` by URL; every URL asked is kept. */
function service(records: Record<string, unknown>, asked: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url)
    asked.push(u)
    if (u.startsWith('https://safe-config.safe.global/')) return json(CONFIG)
    if (u in records) return json(records[u])
    return json({ detail: 'No SafeMessage matches the given query.' }, 404)
  }) as typeof fetch
}

/** The request as rest-api.ts / walletconnect.ts build it for eth_signTypedData_v4. */
function request(fx: Fixture, firmwareVersion = '7.16.0'): SigningRequestInfo {
  return {
    id: 't', method: '/eth/sign-typed-data', appName: 'Safe{Wallet}', chain: 'eth', from: OWNER,
    chainId: fx.typedData.domain.chainId, firmwareVersion, typedDataDecoded: decodeEIP712(fx.typedData, OWNER),
  }
}

async function card(fx: Fixture, records: Record<string, unknown>, firmwareVersion = '7.16.0') {
  const info = request(fx, firmwareVersion)
  await attachSafeMessagePreimage(info, service(records))
  return { info, risk: assessSigningRisk(info)! }
}
const served = (fx: Fixture) => ({ [fx._source[0]]: fx.record })
const text = (r: { reasons: { text: string }[] }) => r.reasons.map((x) => x.text).join('\n')

describe('SafeMessage original from the Transaction Service', () => {
  test('the request carries only a hash, so without the original the card cannot read it', () => {
    // What Safe{Wallet} really sends: 32 bytes, not the sign-in text.
    expect(siweOdos.typedData.message.message).toMatch(/^0x[0-9a-f]{64}$/)
    const r = assessSigningRisk(request(siweOdos))!
    expect(r.tier).toBe('red')
    expect(text(r)).toContain('this computer cannot read what it approves')
  })

  test('a verified sign-in text is described and not red (7.16)', async () => {
    const asked: string[] = []
    const info = request(siweOdos)
    await attachSafeMessagePreimage(info, service(served(siweOdos), asked))
    // Looked up under the SafeMessage's own hash, on its chain's service.
    expect(asked.at(-1)).toBe(siweOdos._source[0])
    expect(info.safeMessageOriginal).toEqual({ status: 'text', text: siweOdos.record.message })
    const r = assessSigningRisk(info)!
    expect(r.tier).toBe('yellow')
    expect(r.level).toBe('medium')
    expect(text(r)).toContain('signs this text as its own')
    expect(text(r)).toContain('"app.odos.xyz wants you to sign in with your Ethereum account:')
    // In full: the URI, chain and nonce come after the first 200 characters.
    expect(text(r)).toContain('Request ID: b809b180-fb07-4082-ae6b-d8b3aeb472d7"')
    expect(text(r)).toContain("checked that it matches what your KeepKey signs")
    expect(text(r)).toContain('Your KeepKey shows this message only as its hash')
    expect(text(r)).not.toContain('cannot read what it approves')
  })

  test('a verified sign-in text on 7.14.2 is known, not blind', async () => {
    const { risk } = await card(siweOdos, served(siweOdos), '7.14.2')
    expect(risk.tier).toBe('yellow')
    expect(text(risk)).toContain('cannot show this Safe Message on the device yet')
    expect(text(risk)).not.toContain('You would be signing blind')
  })

  test('first signer: no copy on the service yet, red, and the card says why', async () => {
    const { info, risk } = await card(siweOdos, {})
    expect(info.safeMessageOriginal).toEqual({ status: 'not-found' })
    expect(risk.tier).toBe('red')
    expect(text(risk)).toContain('this computer cannot read what it approves')
    expect(text(risk)).toContain('If you are the first owner to sign')
  })

  test('an original that does not hash to the signed value is ignored', async () => {
    const tampered = { ...siweOdos.record, message: siweOdos.record.message.replace('app.odos.xyz', 'app.0dos.xyz') }
    const { info, risk } = await card(siweOdos, { [siweOdos._source[0]]: tampered })
    expect(info.safeMessageOriginal).toEqual({ status: 'mismatch' })
    expect(risk.tier).toBe('red')
    expect(text(risk)).not.toContain('app.0dos.xyz')
    expect(text(risk)).toContain('does not match what you are signing')

    const permit = permitReclamm.record.message as any
    const bigger = { ...permitReclamm.record, message: { ...permit, message: { ...permit.message, value: '1' + permit.message.value } } }
    const typed = await card(permitReclamm, { [permitReclamm._source[0]]: bigger })
    expect(typed.info.safeMessageOriginal).toEqual({ status: 'mismatch' })
    expect(typed.risk.tier).toBe('red')
  })

  test('a service that fails or hangs never blocks the card', async () => {
    const down = request(siweOdos)
    await attachSafeMessagePreimage(down, (async (url: string | URL) => {
      if (String(url).includes('/messages/')) throw new TypeError('fetch failed')
      return json(CONFIG)
    }) as typeof fetch)
    expect(down.safeMessageOriginal).toEqual({ status: 'failed' })
    expect(assessSigningRisk(down)!.tier).toBe('red')

    const hung = request(siweOdos)
    const started = Date.now()
    await attachSafeMessagePreimage(hung, ((_url: string | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    })) as typeof fetch, 100)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(hung.safeMessageOriginal).toEqual({ status: 'failed' })
    expect(text(assessSigningRisk(hung)!)).toContain("could not reach Safe's Transaction Service")
  })

  test('an original that is itself a 32-byte code stays unreadable', async () => {
    const { info, risk } = await card(cowdaoHexHash, served(cowdaoHexHash))
    expect(info.safeMessageOriginal).toEqual({ status: 'text', text: cowdaoHexHash.record.message })
    expect(risk.tier).toBe('red')
    expect(text(risk)).toContain('this computer cannot read what it approves')
    expect(text(risk)).toContain(`is not readable text: "${cowdaoHexHash.record.message}"`)
  })

  test('a verified typed original is described by the typed-data describers, as signed by the Safe', async () => {
    const { info, risk } = await card(permitReclamm, served(permitReclamm))
    expect(info.safeMessageOriginal?.status).toBe('typed')
    const t = text(risk)
    expect(t).toContain('signs this ERC-2612 Permit as its own')
    // The spend line the Permit describer writes, naming the real spender.
    expect(t).toContain('Lets 0xae563e3f8219521950555f5962419c8919758ea2 spend')
    expect(t).not.toContain('cannot read what it approves')
    expect(risk.tier).toBe('red')

    const batch = await card(basePermit2Batch, served(basePermit2Batch))
    expect(batch.info.safeMessageOriginal?.status).toBe('typed')
    expect(text(batch.risk)).toContain('Lets 0x3f170631ed9821ca51a59d996ab095162438dc10 spend')
    expect(text(batch.risk)).not.toContain('cannot read what it approves')
  })

  test('only a SafeMessage holding a hash on a chain Safe serves is looked up', async () => {
    const asked: string[] = []
    const other = { ...siweOdos.typedData, domain: { ...siweOdos.typedData.domain, chainId: 2 } }
    const info = { ...request(siweOdos), chainId: 2, typedDataDecoded: decodeEIP712(other, OWNER) }
    await attachSafeMessagePreimage(info, service({}, asked))
    expect(info.safeMessageOriginal).toBeUndefined()
    expect(asked.some((u) => u.includes('/messages/'))).toBe(false)
  })

  // Nested Safes: Safe A owns Safe B, so B's SafeTx is approved by A signing
  // its EIP-712 hash as a SafeMessage. The doc is what the Transaction Service
  // stores for that message; the request is what Safe{Wallet} sends A's owner.
  const SAFE_A = siweOdos.typedData.domain.verifyingContract
  const SAFE_B = '0xb0b0000000000000000000000000000000000b0b'
  const SAFE_TX_TYPES = { SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ] }
  const ZERO = '0x0000000000000000000000000000000000000000'
  const safeTxOfB = (o: Record<string, string>) => ({
    domain: { chainId: 1, verifyingContract: SAFE_B }, types: SAFE_TX_TYPES, primaryType: 'SafeTx',
    message: { to: SAFE_B, value: '0', data: '0x', operation: '0', safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: '5', ...o },
  })
  /** SafeMessage { message: hash(doc) } for SAFE_A, and its service record. */
  function wrapped(doc: { domain: any; types: Record<string, any>; primaryType: string; message: any }): Fixture {
    const hash = utils._TypedDataEncoder.hash(doc.domain, doc.types, doc.message)
    const typedData = { ...siweOdos.typedData, message: { message: hash } }
    const h = decodeEIP712(typedData, OWNER).hashes!
    const id = utils.keccak256(utils.concat(['0x1901', h.domainHash, h.messageHash!]))
    return { _source: [`https://api.safe.global/tx-service/eth/api/v1/messages/${id}/`], typedData, record: { message: doc } } as unknown as Fixture
  }

  test("a Safe's SafeTx wrapped in a SafeMessage still flags a gas refund payout", async () => {
    const refund = wrapped(safeTxOfB({ baseGas: '500000', gasPrice: '1000000000000', refundReceiver: '0x2222222222222222222222222222222222222222' }))
    const { info, risk } = await card(refund, served(refund))
    expect(info.safeMessageOriginal?.status).toBe('typed')
    // The same refund line, with its amount, that an outer SafeTx gets (G24).
    expect(text(risk)).toContain('Pays a gas refund out of your Safe when it is executed: up to 0.5 ETH'
      + " (gas price 1000000000000 × (safeTxGas 0 + baseGas 500000), plus Safe's own call overhead, at no more than the executor's own gas price),"
      + ' to 0x2222222222222222222222222222222222222222. Normal Safe transactions leave the refund at zero.')
    expect(risk.tier).toBe('red')

    // Control: the same rejection with no refund is normal.
    const plain = wrapped(safeTxOfB({}))
    const ok = await card(plain, served(plain))
    expect(text(ok.risk)).toContain('Rejects pending transaction #5')
    expect(text(ok.risk)).not.toContain('gas refund')
    expect(ok.risk.tier).toBe('yellow')
  })

  test("the outer Safe is named as the Safe that signs, not as this KeepKey account", async () => {
    const pay = wrapped(safeTxOfB({ to: SAFE_A, value: '1000000000000000000' }))
    const { risk } = await card(pay, served(pay))
    const t = text(risk)
    expect(t).not.toContain('this KeepKey account')
    expect(t).toContain('your Safe that signs this message')
  })

  test('a stored document whose primaryType is not the type it hashes is ignored', async () => {
    // Permit2: the hash infers PermitSingle as the root, whatever primaryType says.
    const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    const SPENDER = '0x2222222222222222222222222222222222222222'
    const types = {
      PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
    }
    const message = {
      details: { token: USDC, amount: (2n ** 160n - 1n).toString(), expiration: '1900000000', nonce: '0' },
      spender: SPENDER, sigDeadline: '1900000000',
      // Not hashed: no field of PermitSingle has these names.
      token: USDC, amount: '1000000',
    }
    const domain = { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' }
    const mislabelled = wrapped({ domain, types, primaryType: 'PermitDetails', message })
    const { info, risk } = await card(mislabelled, served(mislabelled))
    expect(info.safeMessageOriginal).toEqual({ status: 'mismatch' })
    expect(text(risk)).not.toContain('1000000')
    expect(risk.tier).toBe('red')

    // Control: the same record with the type it hashes is read as signed.
    const labelled = wrapped({ domain, types, primaryType: 'PermitSingle', message })
    const ok = await card(labelled, served(labelled))
    expect(ok.info.safeMessageOriginal?.status).toBe('typed')
    expect(text(ok.risk)).toContain(`Lets ${SPENDER} spend ALL of your USDC`)
  })
})
