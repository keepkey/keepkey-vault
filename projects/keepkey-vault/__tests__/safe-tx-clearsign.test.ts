/**
 * Safe transactions on the approval card, from REAL SafeTx documents:
 * Safe{Wallet} proposals fetched from Safe's transaction service (each file
 * names its URL, and its EIP-712 digest must equal the safeTxHash Safe
 * recorded) and the python-keepkey EIP-712 corpus Safe documents.
 *
 * Desktop decodes SafeTx.data here as advice. The KeepKey shows the data as
 * raw hex, and the card says so.
 */
import { describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'
import { assessSigningRisk } from '../src/shared/clearsign-risk'
import { decodeMultiSend, deviceWarnsSafeDelegatecall, safeContract } from '../src/shared/safe-tx'
import { decodeEIP712 } from '../src/bun/eip712-decoder'
import { attachSafeCallPreviews } from '../src/bun/evm-signing-preview'
import type { SigningRequestInfo } from '../src/shared/types'
import served from '../src/bun/erc7730-describe.fixtures.json'
import baseUsdcTransfer from './fixtures/safe/base-usdc-transfer.json'
import baseNativeSend from './fixtures/safe/base-native-send.json'
import baseRejection from './fixtures/safe/base-rejection.json'
import baseAddOwners from './fixtures/safe/base-multisend-add-owners.json'
import baseUsdcAave from './fixtures/safe/base-multisend-usdc-aave.json'
import baseMultiSend141 from './fixtures/safe/base-multisend-141-uniswap.json'
import basePermit2Swap from './fixtures/safe/base-multisend-permit2-swap.json'
import baseRelayDeposit from './fixtures/safe/base-relay-deposit.json'
import ethRejection from './fixtures/safe/eth-rejection.json'
import ethAddOwner from './fixtures/safe/eth-add-owner.json'
import ethSwapOwner from './fixtures/safe/eth-swap-owner.json'
import ethOwnerRotation from './fixtures/safe/eth-owner-rotation.json'
import ethSignMessageLib from './fixtures/safe/eth-sign-message-lib.json'
import ethFallbackHandler from './fixtures/safe/eth-multisend-fallback-handler.json'
import ethNativeSend from './fixtures/safe/eth-native-send.json'
import corpus from './fixtures/safe/pyk-eip712-corpus-safetx.json'

interface Fixture { safeTxHash: string; signer: string; typedData: any }
const REAL: Record<string, Fixture> = {
  baseUsdcTransfer, baseNativeSend, baseRejection, baseAddOwners, baseUsdcAave, baseMultiSend141, basePermit2Swap, baseRelayDeposit,
  ethRejection, ethAddOwner, ethSwapOwner, ethOwnerRotation, ethSignMessageLib, ethFallbackHandler, ethNativeSend,
}
const doc = (id: string) => corpus.documents.find((d) => d.id === id)!.typedData
/** The real Base depositV3 request of src/shared/acrossDeposit.test.ts. */
const ACROSS_DEPOSIT_V3 = '0x7b939232000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e000000000000000000000000909ef6b32dfdc12ca86aa710b54c991af3c5f82e0000000000000000000000004200000000000000000000000000000000000006000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000000000000000000000000000000000000000000000000189e6105b7a8de70000000000000000000000000000000000000000000000000189bfc0793fe6f50000000000000000000000000000000000000000000000000000000000000001000000000000000000000000394311a6aaa0d8e3411d8b62de4578d41322d1bd000000000000000000000000000000000000000000000000000000006ac2c7bb000000000000000000000000000000000000000000000000000000006ac2e3db000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000001dc0de00410000000c'

type Known = SigningRequestInfo['knownAddresses']
/** The KeepKey ClearSign service, replayed from its own captured responses
 *  (erc7730-describe.fixtures.json). Anything else gets the service's answer
 *  for a call it has no definition for. */
const SERVICE = (async (url: any) => {
  const q = new URL(String(url)).searchParams
  const hit = Object.values(served).find((d: any) => d?.chainId === Number(q.get('chainId'))
    && d.contractAddress === q.get('contract') && d.selectorOrTypeHash === q.get('selector'))
  return hit ? Response.json(hit) : Response.json({ classification: 'OPAQUE', code: 'NOT_IN_SIGNED_CATALOG' }, { status: 422 })
}) as unknown as typeof fetch
/** The approval card's request for a SafeTx, the way REST and WalletConnect build it. */
async function request(typedData: any, opts: { from?: string; known?: Known; firmwareVersion?: string; chainId?: number } = {}) {
  const info: SigningRequestInfo = {
    id: 't', method: '/eth/sign-typed-data', appName: 'Safe{Wallet}', chain: 'eth', chainId: opts.chainId ?? Number(typedData.domain.chainId),
    from: opts.from, firmwareVersion: opts.firmwareVersion ?? '7.16.0', typedDataDecoded: decodeEIP712(typedData), knownAddresses: opts.known,
  }
  await attachSafeCallPreviews(info, SERVICE)
  return info
}
const review = async (typedData: any, opts: Parameters<typeof request>[1] = {}) => assessSigningRisk(await request(typedData, opts))!
const real = (fx: Fixture, opts: { known?: Known; firmwareVersion?: string; chainId?: number } = {}) => review(fx.typedData, { from: fx.signer, ...opts })
const text = (r: { reasons: { text: string }[] }) => r.reasons.map((x) => x.text).join('\n')
const levelOf = (r: { reasons: { level: string; text: string }[] }, part: string) => r.reasons.find((x) => x.text.includes(part))?.level
/** The same document with message fields replaced (a mutant of a real request). */
const mutate = (fx: Fixture | any, message: Record<string, unknown>, domain: Record<string, unknown> = {}) => {
  const td = fx.typedData ?? fx
  return { ...td, domain: { ...td.domain, ...domain }, message: { ...td.message, ...message } }
}
/** Same first and last 4 hex characters, every middle one different: a ground look-alike. */
const twinOf = (a: string) => a.slice(0, 6) + [...a.slice(6, 38).toLowerCase()].map((c) => (c === 'f' ? 'e' : 'f')).join('') + a.slice(38)
const word = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

describe('Safe fixtures are the documents Safe signed', () => {
  test('each real fixture hashes to the safeTxHash Safe recorded', async () => {
    for (const [name, fx] of Object.entries(REAL)) {
      const { EIP712Domain: _d, ...types } = fx.typedData.types
      expect(`${name} ${ethersUtils._TypedDataEncoder.hash(fx.typedData.domain, types, fx.typedData.message)}`).toBe(`${name} ${fx.safeTxHash}`)
    }
  })
  test('each corpus document hashes to its independently computed digest', async () => {
    for (const d of corpus.documents) {
      const { EIP712Domain: _d, ...types } = d.typedData.types as any
      expect(ethersUtils._TypedDataEncoder.hash(d.typedData.domain, types, d.typedData.message)).toBe(d.digest)
    }
  })
})

describe('a call inside a SafeTx is decoded here (G10)', () => {
  test('a Base USDC transfer reads like a normal transfer, not red', async () => {
    const r = await real(baseUsdcTransfer)
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain('Sends 30,000 USDC to 0xab1d09e877ed3ba27e132f86acada264b60b1551.')
    expect(text(r)).toContain("Your KeepKey may show this Safe transaction's call data only as raw hex")
    expect(text(r)).not.toContain('cannot read')
  })
  test('the corpus Ethereum USDC transfer reads the same way', async () => {
    const r = await review(doc('safe-SafeTx'))
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain('Sends 1,500 USDC to 0x27213e28d7fda5c57fe9e5dd923818dbccf71c47.')
  })
  test('a transfer to a saved contact names it; to a look-alike of it is red', async () => {
    const recipient = '0xAB1d09E877eD3Ba27e132f86ACadA264B60B1551'
    const known = [{ address: recipient, name: 'Payroll', own: false }]
    expect(text(await real(baseUsdcTransfer, { known }))).toContain('0xab1d09e877ed3ba27e132f86acada264b60b1551 is your contact Payroll.')
    const data = baseUsdcTransfer.typedData.message.data.replace(recipient.slice(2).toLowerCase(), twinOf(recipient).slice(2).toLowerCase())
    const poisoned = await review(mutate(baseUsdcTransfer, { data }), { from: baseUsdcTransfer.signer, known })
    expect(poisoned.tier).toBe('red')
    expect(text(poisoned)).toContain(`looks like your contact Payroll (${recipient.toLowerCase()}) but is a different address`)
  })
  test('an unlimited approve to a spender KeepKey has not reviewed stays danger', async () => {
    const r = await review(doc('safe-SafeTx-approve-unlimited'))
    expect(r.level).toBe('critical')
    expect(text(r)).toContain('Lets 0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45 spend ALL of your USDC')
  })
  test('an approve the Safe gives canonical Permit2 names Permit2 (preview path)', async () => {
    const data = `0x095ea7b3${word('0x000000000022D473030F116dDEE9F6B43aC78BA3')}${'f'.repeat(64)}`
    const td = mutate(baseUsdcTransfer, { data })
    expect((await request(td)).safeCalls?.[0].recognizedSpender).toBe('Uniswap Permit2')
    expect(text(await review(td, { from: baseUsdcTransfer.signer }))).toContain('Standard Permit2 setup')
  })
  test('a call this computer cannot read keeps the red line', async () => {
    const r = await real(baseMultiSend141)
    expect(text(r)).toContain('Makes your Safe call 0x2626664c2603336e57b271c5c0b26f421741e481 with data this computer cannot read')
    expect(r.tier).toBe('red')
  })
})

describe('a call inside a SafeTx gets the preview an account call gets (G10)', () => {
  test('a Safe{Wallet} batch approving canonical Permit2 reads as the standard Permit2 setup, not danger', async () => {
    const r = await real(basePermit2Swap)
    expect(levelOf(r, 'Call 1 of 4: Standard Permit2 setup: gives canonical Permit2 persistent access to your USDC.')).toBe('medium')
    expect(text(r)).not.toContain('spend ALL of your USDC')
    expect(r.level).not.toBe('critical')
  })
  test('a Relay deposit straight from a Safe reads like one from an account', async () => {
    const r = await real(baseRelayDeposit)
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain('Relay deposit on Base: sends 30.074166 USDC to the Relay Depository, credited to your account.')
    expect(text(r)).not.toContain('cannot read')
    expect(text(r)).not.toContain('Advanced Mode')
  })
  test('an Across depositV3 from a Safe reads like one from an account', async () => {
    // The real Base depositV3 from src/shared/acrossDeposit.test.ts (SDK flow,
    // 2026-10-04), with its depositor and recipient set to this Safe, sent
    // from the real Base Safe of base-relay-deposit.json.
    const signer = '909ef6b32dfdc12ca86aa710b54c991af3c5f82e'
    const safe = baseRelayDeposit.typedData.domain.verifyingContract.toLowerCase().slice(2)
    const data = ACROSS_DEPOSIT_V3.replaceAll(signer, safe)
    const td = mutate(baseRelayDeposit, { to: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', value: BigInt('0x189e6105b7a8de7').toString(), data })
    const r = await review(td, { from: baseRelayDeposit.signer })
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain('Across bridge deposit to the Across SpokePool on Base, a contract KeepKey knows.')
    expect(text(r)).not.toContain('cannot read')
  })
  test('a saved contact with no label reads "a saved contact"', async () => {
    const recipient = '0xAB1d09E877eD3Ba27e132f86ACadA264B60B1551'
    const known = [{ address: recipient, name: '', own: false }]
    expect(text(await real(baseNativeSend, { known }))).toContain(`Sends 0.003 ETH from your Safe to a saved contact (${recipient.toLowerCase()}).`)
    const transfer = text(await real(baseUsdcTransfer, { known }))
    expect(transfer).toContain(`${recipient.toLowerCase()} is a saved contact.`)
    expect(transfer).not.toContain('your contact')
  })
  test('MultiSendCallOnly 1.4.1 on Robinhood is pinned like on Base', async () => {
    const r = await review(mutate(baseAddOwners, {}, { chainId: 4663 }), { from: baseAddOwners.signer })
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain("Runs 2 calls in one batch through Safe's standard MultiSendCallOnly 1.4.1 contract.")
  })
})

describe('a plain coin send from a Safe checks the recipient (G17)', () => {
  const recipient = '0xAB1d09E877eD3Ba27e132f86ACadA264B60B1551'
  test('to an address not in the address book: shown on the device, named here', async () => {
    const r = await real(baseNativeSend)
    expect(r.tier).toBe('green')
    expect(text(r)).toContain(`Sends 0.003 ETH from your Safe to ${recipient.toLowerCase()}, an address not in your address book.`)
  })
  test('to your own account or a saved contact: calm and named', async () => {
    const own = await real(baseNativeSend, { known: [{ address: recipient, name: 'ETH', own: true }] })
    expect(own.tier).toBe('green')
    expect(text(own)).toContain(`Sends 0.003 ETH from your Safe to your KeepKey account (${recipient.toLowerCase()}).`)
    const contact = await real(baseNativeSend, { known: [{ address: recipient, name: 'Payroll', own: false }] })
    expect(contact.tier).toBe('green')
    expect(text(contact)).toContain('to your contact Payroll')
  })
  test('to a look-alike of a known address: red', async () => {
    const r = await review(mutate(baseNativeSend, { to: twinOf(recipient) }), { from: baseNativeSend.signer, known: [{ address: recipient, name: 'Payroll', own: false }] })
    expect(r.tier).toBe('red')
    expect(text(r)).toContain('Address-poisoning scams use look-alikes like this')
    // The signing account and the Safe itself are known addresses too.
    const signer = await review(mutate(ethNativeSend, { to: twinOf(ethNativeSend.signer) }), { from: ethNativeSend.signer })
    expect(signer.tier).toBe('red')
    expect(text(signer)).toContain('looks like this KeepKey account')
  })
  test('40 ETH from the Ethereum Safe reads in ETH', async () => {
    expect(text(await real(ethNativeSend))).toContain('Sends 40 ETH from your Safe to 0xa5c629e04e563355c30885b62928fd6e03558548')
  })
})

describe('a rejection reads as one', () => {
  test('Base and Ethereum Safe{Wallet} rejections', async () => {
    const base = await real(baseRejection)
    expect(base.tier).toBe('green')
    expect(text(base)).toContain('Rejects pending transaction #127')
    expect(text(await real(ethRejection))).toContain('Rejects pending transaction #2723')
  })
})

describe('MultiSend batches through pinned Safe contracts (G11, G18)', () => {
  test('a Base batch adding two owners is described and not red', async () => {
    const r = await real(baseAddOwners)
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain("Runs 2 calls in one batch through Safe's standard MultiSendCallOnly 1.4.1 contract.")
    expect(text(r)).toContain('Call 1 of 2: Adds 0x661ce40abd415953a5667cbe4756838cd92b19c4 as an owner of your Safe, and the Safe then needs 1 owner signature.')
    expect(text(r)).not.toContain('Runs code from')
  })
  test('the same batch to an address that is not pinned keeps the delegatecall line', async () => {
    const notPinned = await review(mutate(baseAddOwners, { to: twinOf(baseAddOwners.typedData.message.to) }), { from: baseAddOwners.signer })
    expect(notPinned.tier).toBe('red')
    expect(text(notPinned)).toContain('inside your Safe (delegatecall)')
    // Pinned per chain: Sepolia is not a Desktop chain, so nothing is pinned there.
    expect(text(await review(mutate(baseAddOwners, {}, { chainId: 11155111 })))).toContain('inside your Safe (delegatecall)')
  })
  test('known-token transfers in a batch read like normal transfers; the rest stays honest', async () => {
    const r = await real(baseUsdcAave)
    expect(levelOf(r, 'Call 1 of 4: Sends 2.209273 USDC to 0xdceb0bb3311342e3ce9e49f57affce9deac40ba1.')).toBe('low')
    expect(text(r)).toContain('Call 2 of 4: Sends 0.045087 USDC to 0x22bb84bd6fe28376bb5d07559207c3a0e063c45d.')
    expect(levelOf(r, 'Call 4 of 4: Supply on Aave V3 (0xa238dd80c259a72e81d7e4664a9801593f98d1c5), as this computer reads it from a KeepKey ClearSign description.')).toBe('medium')
    expect(text(r)).not.toContain('Runs code from')
  })
  test('MultiSend 1.4.1 on Base and the corpus MultiSendCallOnly 1.3.0 batches are recognized', async () => {
    expect(text(await real(baseMultiSend141))).toContain("Safe's standard MultiSend 1.4.1 contract")
    const r = await review(doc('safe-SafeTx-multisend-approve-unlimited'))
    expect(text(r)).toContain("Runs 2 calls in one batch through Safe's standard MultiSendCallOnly 1.3.0 contract.")
    expect(text(r)).toContain('Call 1 of 2: Lets CoW Protocol Vault Relayer (0xc92e8bdf79f0507f65a392b0ab4667716bfe0110) spend ALL of your token at 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
    expect(text(await review(doc('safe-SafeTx-multisend-4900')))).toContain("through Safe's standard MultiSendCallOnly 1.3.0 contract")
  })
  test('an inner delegatecall is flagged', async () => {
    // Flip the first inner call of the real Base batch to operation 1.
    const data = baseAddOwners.typedData.message.data.replace(/^(0x8d80ff0a[0-9a-f]{128})00/i, '$101')
    expect(decodeMultiSend(data)?.[0].operation).toBe(1)
    const r = await review(mutate(baseAddOwners, { data }), { from: baseAddOwners.signer })
    expect(r.tier).toBe('red')
    expect(text(r)).toContain('Call 1 of 2: Runs code from 0x4aad245c2acae1c1893a3f8d4d96f276d0be0b18 inside your Safe (delegatecall)')
  })
  test('the decoder refuses trailing or missing bytes', async () => {
    const data = baseAddOwners.typedData.message.data
    expect(decodeMultiSend(data)?.length).toBe(2)
    expect(decodeMultiSend(data + '00')).toBeNull()
    expect(decodeMultiSend(data.slice(0, -64))).toBeNull()
  })
  test('on firmware 7.14.2 the device shows only a hash, so it stays red', async () => {
    const r = await real(baseAddOwners, { firmwareVersion: '7.14.2' })
    expect(r.tier).toBe('red')
    expect(text(r)).toContain('Your KeepKey can only show a code (hash)')
  })
})

describe('owner and threshold changes (G19)', () => {
  const safe = '0x849d52316331967b6ff1198e5e32a0eb168d039d'
  test('addOwnerWithThreshold and swapOwner name the owners and threshold', async () => {
    const add = await real(ethAddOwner)
    expect(add.tier).toBe('yellow')
    expect(text(add)).toContain('Adds 0xed5ddb58f3131274597ee59c98a073ce3c5d1cb9 as an owner of your Safe, and the Safe then needs 3 owner signatures.')
    expect(text(await real(ethSwapOwner))).toContain('Replaces owner 0x48a9d0953c8959aeb19ba55f5c04b0a54c84823c of your Safe with 0xbab04858c4ebbb226dd12b38639e59450820536f.')
  })
  test('an eight-call owner rotation is described call by call', async () => {
    const r = await real(ethOwnerRotation)
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain('Call 2 of 8: Removes owner 0x0da0c3e52c977ed3cbc641ff02dd271c3ed55afe from your Safe, and the Safe then needs 3 owner signatures.')
    expect(text(r)).toContain('Call 8 of 8: Adds this KeepKey account (0x964ae5ab627f1d536d5d5796734b7a44ad6531e3) as an owner')
  })
  test('a new owner that looks like a known address is red', async () => {
    const contact = '0xeD5Ddb58F3131274597EE59c98A073ce3C5d1cb9'
    const data = `0x0d582f13${word(twinOf(contact))}${word('0x3')}`
    const r = await review(mutate(ethAddOwner, { data }), { from: ethAddOwner.signer, known: [{ address: contact, name: 'Co-signer', own: false }] })
    expect(r.tier).toBe('red')
    expect(text(r)).toContain('looks like your contact Co-signer')
  })
  test('changeThreshold and removeOwner', async () => {
    expect(text(await review(mutate(ethAddOwner, { data: `0x694e80c3${word('0x2')}` })))).toContain('Changes your Safe to need 2 owner signatures for every transaction.')
    const removed = '0xeD5Ddb58F3131274597EE59c98A073ce3C5d1cb9'
    expect(text(await review(mutate(ethAddOwner, { data: `0xf8dc5dd9${word(ethAddOwner.signer)}${word(removed)}${word('0x2')}` }))))
      .toContain(`Removes owner ${removed.toLowerCase()} from your Safe, and the Safe then needs 2 owner signatures.`)
  })
  test('control: the same call to a different contract is not read as the Safe changing itself', async () => {
    const r = await review(mutate(ethAddOwner, { to: '0x27d8bb2e33Bc38A9CE93fdD90C80677b8436aFfb' }), { from: ethAddOwner.signer })
    expect(r.tier).toBe('red')
    expect(text(r)).not.toContain('as an owner')
    expect(text(r)).toContain('with data this computer cannot read')
    expect(safe).toBe(ethAddOwner.typedData.domain.verifyingContract.toLowerCase())
  })
})

describe('modules, guards and handlers are described calmly (G20)', () => {
  // Real addresses from the Ethereum Safe's own history: a Zodiac module it
  // enabled (nonce 2594) and the handler it set (nonce 2835).
  const MODULE = '0xE39434eBba1b636202E3A00C1804Fb607D766D35'
  const self = (data: string) => review(mutate(ethAddOwner, { data }), { from: ethAddOwner.signer })
  test('the real batch that sets a fallback handler and a domain verifier', async () => {
    const r = await real(ethFallbackHandler)
    expect(levelOf(r, "Call 1 of 4: Sets 0x2f55e8b20d0b9fefa187aa7d00b6cbe563605bf5 as your Safe's fallback handler.")).toBe('medium')
    expect(levelOf(r, 'Call 2 of 4: Lets 0xfdafc9d1902f4e0b84f65f49f244b32b31013b74 answer signature checks for your Safe for one app domain (0xc078f884a2676e1345748b1feace7b0abee5d00ecadb6e574dcdd109a63e8943).')).toBe('medium')
  })
  test('one line per setting, none of them danger', async () => {
    const cases: Array<[string, string]> = [
      [`0x610b5925${word(MODULE)}`, `Enables ${MODULE.toLowerCase()} as a module of your Safe. A module can move funds`],
      [`0xe009cfde${word('0x1')}${word(MODULE)}`, `Disables module ${MODULE.toLowerCase()} on your Safe.`],
      [`0xe19a9dd9${word(MODULE)}`, `Sets ${MODULE.toLowerCase()} as your Safe's transaction guard.`],
      [`0xe19a9dd9${word('0x0')}`, "Removes your Safe's transaction guard."],
      [`0xe068df37${word(MODULE)}`, `Sets ${MODULE.toLowerCase()} as your Safe's module guard.`],
      [`0xf08a0323${word('0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99')}`, "Sets your Safe's fallback handler to Safe's standard CompatibilityFallbackHandler 1.4.1"],
      [`0x7de7edef${word('0x3E5c63644E683549055b9Be8653de26E0B4CD36E')}`, 'Upgrades your Safe to the standard SafeL2 1.3.0 contract'],
    ]
    for (const [data, line] of cases) {
      const r = await self(data)
      expect(`${data.slice(0, 10)} ${text(r)}`).toContain(line)
      expect(`${data.slice(0, 10)} ${r.tier}`).toBe(`${data.slice(0, 10)} yellow`)
    }
  })
  test('the code the Safe runs switched to a non-standard contract is danger', async () => {
    const r = await self(`0x7de7edef${word('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')}`)
    expect(r.level).toBe('critical')
    expect(text(r)).toContain('which is not a standard Safe contract')
  })
  test('control: an unknown call to the Safe itself does not use the settings wording', async () => {
    const r = await self(`0x12345678${word(MODULE)}`)
    expect(r.tier).toBe('red')
    expect(text(r)).toContain('Makes your Safe call itself with data this computer cannot read')
    expect(text(r)).not.toContain('module')
  })
})

describe("delegatecalls to Safe's own helper contracts", () => {
  test('SignMessageLib with a 32-byte hash reads like an opaque SafeMessage, not "runs code"', async () => {
    const r = await real(ethSignMessageLib)
    expect(r.tier).toBe('red')
    expect(text(r)).toContain("Signs a message on-chain for your Safe through Safe's standard SignMessageLib 1.3.0.")
    expect(text(r)).toContain('Approves a message for your whole Safe')
    expect(text(r)).not.toContain('Runs code from')
  })
  test('SignMessageLib with readable text quotes it', async () => {
    const msg = Buffer.from('Sign in to app.example.org with your Safe').toString('hex')
    const len = msg.length / 2
    const data = `0x85a5affe${word('0x20')}${word(`0x${len.toString(16)}`)}${msg.padEnd(Math.ceil(len / 32) * 64, '0')}`
    const r = await review(mutate(ethSignMessageLib, { data }), { from: ethSignMessageLib.signer })
    expect(r.tier).toBe('yellow')
    expect(text(r)).toContain('Sign in to app.example.org with your Safe')
  })
  test('SafeMigration and SafeToL2Migration to pinned singletons are described, not red', async () => {
    const migrate = await review(mutate(baseUsdcTransfer, { to: '0x526643F69b81B008F46d95CD5ced5eC0edFFDaC6', data: '0x68cb3d94', operation: 1 }))
    expect(migrate.tier).toBe('yellow')
    expect(text(migrate)).toContain("Upgrades your Safe to the standard SafeL2, with its standard fallback handler 1.4.1, through Safe's own SafeMigration contract.")
    const toL2 = await review(mutate(baseUsdcTransfer, { to: '0xfF83F6335d8930cBad1c0D439A841f01888D9f69', data: `0xef2624ae${word('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762')}`, operation: 1 }))
    expect(toL2.tier).toBe('yellow')
    expect(text(toL2)).toContain('Switches your Safe to the standard SafeL2 1.4.1 contract')
    const rogue = await review(mutate(baseUsdcTransfer, { to: '0xfF83F6335d8930cBad1c0D439A841f01888D9f69', data: `0xef2624ae${word('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')}`, operation: 1 }))
    expect(rogue.level).toBe('critical')
  })
  test('control: a delegatecall to anything not pinned keeps the red line (G23)', async () => {
    const r = await review(mutate(baseUsdcTransfer, { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x68cb3d94', operation: 1 }))
    expect(r.tier).toBe('red')
    expect(text(r)).toContain('Runs code from 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 inside your Safe (delegatecall)')
  })
})

describe('pinned Safe contracts', () => {
  test('pinned per chain from safe-deployments, Robinhood included', async () => {
    for (const chain of [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114]) {
      expect(safeContract(chain, '0x9641d764fc13c8B624c04430C7356C1C7C8102e2')?.name).toBe('MultiSendCallOnly')
    }
    expect(safeContract(11155111, '0x9641d764fc13c8B624c04430C7356C1C7C8102e2')).toBeUndefined()
    expect(safeContract(8453, '0x8D29bE29923b68abfDD21e541b9374737B49cdAD')).toBeUndefined()
  })
})

/** The device's own words, from the 7.16.0 emulator legs of 2026-10-30
 *  (safe/results/7.16.0/<leg>.json, the "Delegatecall" screen of each). */
const DEVICE_SAID: [string, Fixture, string][] = [
  ['base-multisend-add-owners', baseAddOwners, "SafeTx gives 0x9641d764fc13c8B624c04430C7356C1C7C8102e2 your Safe's full authority. Not checked."],
  ['base-multisend-usdc-aave', baseUsdcAave, "SafeTx gives 0x9641d764fc13c8B624c04430C7356C1C7C8102e2 your Safe's full authority. Not checked."],
  ['base-multisend-141-uniswap', baseMultiSend141, "SafeTx gives 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526 your Safe's full authority. Not checked."],
  ['base-multisend-permit2-swap', basePermit2Swap, "SafeTx gives 0x9641d764fc13c8B624c04430C7356C1C7C8102e2 your Safe's full authority. Not checked."],
  ['eth-sign-message-lib', ethSignMessageLib, "SafeTx gives 0xA65387F16B013cf2Af4605Ad8aA5ec25a2cbA3a2 your Safe's full authority. Not checked."],
]
const deviceLine = (r: { reasons: { level: string; text: string }[] }) => r.reasons.find((x) => x.text.startsWith('Your KeepKey will show "Delegatecall'))

describe("the device's Delegatecall screen for Safe's own contracts is on the card", () => {
  test('7.16.0: each real request the emulator warned about names the screen, calmly', async () => {
    for (const [leg, fx, said] of DEVICE_SAID) {
      const r = await real(fx)
      const line = deviceLine(r)
      expect(`${leg} ${line?.level}`).toBe(`${leg} low`)
      expect(line!.text).toContain(`"Delegatecall: ${said}"`)
      expect(line!.text).toContain("That is expected here")
      expect(line!.text).toMatch(/Safe's own (MultiSend|MultiSendCallOnly|SignMessageLib) 1\.[345]\.[01] contract at its standard address/)
    }
  })
  test('the add-owners batch stays calm yellow with the line', async () => {
    const r = await real(baseAddOwners)
    expect(r.tier).toBe('yellow')
    expect(r.level).toBe('medium')
  })
  test('7.16.0 on Ethereum: a clean MultiSend batch gets no screen, so no line (the emulator showed none)', async () => {
    for (const id of ['safe-SafeTx-multisend-4900', 'safe-SafeTx-multisend-approve-unlimited']) {
      expect(deviceLine(await review(doc(id)))).toBeUndefined()
    }
    expect(deviceLine(await real(ethFallbackHandler))).toBeUndefined()
  })
  test('7.14.2 signs a hash and shows no such screen', async () => {
    for (const [, fx] of DEVICE_SAID) expect(deviceLine(await real(fx, { firmwareVersion: '7.14.2' }))).toBeUndefined()
  })
  test('7.17: Base batches no longer get the screen; SignMessageLib still does', async () => {
    for (const fx of [baseAddOwners, baseUsdcAave, baseMultiSend141, basePermit2Swap]) {
      expect(deviceLine(await real(fx, { firmwareVersion: '7.17.0' }))).toBeUndefined()
    }
    expect(deviceLine(await real(ethSignMessageLib, { firmwareVersion: '7.17.0' }))?.level).toBe('low')
  })
  test('an inner delegatecall in an Ethereum batch makes 7.16 warn about the SafeTx too', async () => {
    const data = baseAddOwners.typedData.message.data.replace(/^(0x8d80ff0a[0-9a-f]{128})00/i, '$101')
    const to = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'
    expect(deviceWarnsSafeDelegatecall('7.16.0', 1, to, baseAddOwners.typedData.message.data)).toBe(false)
    expect(deviceWarnsSafeDelegatecall('7.16.0', 1, to, data)).toBe(true)
    expect(deviceWarnsSafeDelegatecall('7.17.0', 8453, to, data)).toBe(true)
  })
  test('7.17 upgrades: calm screen only with a pinned SafeL2 argument', async () => {
    const toL2 = '0xfF83F6335d8930cBad1c0D439A841f01888D9f69'
    expect(deviceWarnsSafeDelegatecall('7.17.0', 8453, '0x526643F69b81B008F46d95CD5ced5eC0edFFDaC6', '0x68cb3d94')).toBe(false)
    expect(deviceWarnsSafeDelegatecall('7.16.0', 8453, '0x526643F69b81B008F46d95CD5ced5eC0edFFDaC6', '0x68cb3d94')).toBe(true)
    expect(deviceWarnsSafeDelegatecall('7.17.0', 8453, toL2, `0xef2624ae${word('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762')}`)).toBe(false)
    expect(deviceWarnsSafeDelegatecall('7.17.0', 8453, toL2, `0xef2624ae${word('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')}`)).toBe(true)
  })
  test('control: a delegatecall to anything not pinned gets no calm line, and stays red', async () => {
    const r = await review(mutate(baseAddOwners, { to: twinOf(baseAddOwners.typedData.message.to) }), { from: baseAddOwners.signer })
    expect(deviceLine(r)).toBeUndefined()
    expect(r.tier).toBe('red')
    expect(levelOf(r, 'inside your Safe (delegatecall)')).toBe('high')
  })
})

/** Requests that keep one of Safe's own contracts in `to` but are not how
 *  Safe{Wallet} uses it, or that the device reads differently (PR #583 review).
 *  Mutants of real requests, each also run on the 7.16.0 and 7.14.2 emulators
 *  (emulator-legs-20261030/fixes/safe-card-review). */
describe("the device's Delegatecall screen when the request is not Safe's standard use", () => {
  const TO_L2_MIGRATION = '0xfF83F6335d8930cBad1c0D439A841f01888D9f69'
  const SAFE_L2_141 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'
  const CFH_141 = '0xfd0732dc9E303f09fCEf3a7388Ad10A83459Ec99'
  const ROGUE = '0x1111111111111111111111111111111111111111'
  const toL2 = (data: string) => mutate(baseAddOwners, { to: TO_L2_MIGRATION, operation: 1, data })
  const run = (td: any, firmwareVersion: string) => review(td, { from: baseAddOwners.signer, firmwareVersion })
  const said = `"Delegatecall: SafeTx gives ${TO_L2_MIGRATION} your Safe's full authority. Not checked."`

  test('migrateToL2 to a contract that is not SafeL2: the warning is real, never "expected"', async () => {
    for (const fw of ['7.16.0', '7.17.0']) {
      const r = await run(toL2(`0xef2624ae${word(ROGUE)}`), fw)
      expect(r.tier).toBe('red')
      expect(levelOf(r, 'which is not a standard SafeL2 contract')).toBe('critical')
      expect(`${fw} ${deviceLine(r)?.level}`).toBe(`${fw} high`)
      expect(deviceLine(r)!.text).toContain(said)
      expect(deviceLine(r)!.text).toContain('Take it seriously here')
      expect(text(r)).not.toContain('That is expected here')
    }
  })
  test('migrateFromV111 with a fallback handler that is not pinned: red, the warning is real', async () => {
    for (const fw of ['7.16.0', '7.17.0']) {
      const r = await run(toL2(`0xd9a20812${word(SAFE_L2_141)}${word(ROGUE)}`), fw)
      expect(`${fw} ${r.tier}`).toBe(`${fw} red`)
      expect(levelOf(r, `Also sets ${ROGUE} as your Safe's fallback handler`)).toBe('medium')
      expect(`${fw} ${deviceLine(r)?.level}`).toBe(`${fw} high`)
      expect(text(r)).not.toContain('That is expected here')
    }
  })
  test('the same two calls with pinned arguments stay calm: 7.16 warns ("expected"), 7.17 shows its own upgrade screen', async () => {
    for (const data of [`0xef2624ae${word(SAFE_L2_141)}`, `0xd9a20812${word(SAFE_L2_141)}${word(CFH_141)}`]) {
      const r16 = await run(toL2(data), '7.16.0')
      expect(r16.tier).toBe('yellow')
      expect(deviceLine(r16)?.level).toBe('low')
      expect(deviceLine(r16)!.text).toContain(`${said} That is expected here`)
      expect(deviceLine(await run(toL2(data), '7.17.0'))).toBeUndefined()
    }
  })
  test('an inner delegatecall in a batch: the warning is real, never "expected"', async () => {
    const data = baseAddOwners.typedData.message.data.replace(/^(0x8d80ff0a[0-9a-f]{128})00/i, '$101')
    const r = await run(mutate(baseAddOwners, { data }), '7.16.0')
    expect(levelOf(r, 'Call 1 of 2: Runs code from')).toBe('high')
    expect(deviceLine(r)?.level).toBe('high')
    expect(text(r)).not.toContain('That is expected here')
  })
  test('a Safe before 1.3.0 (no chainId in its domain): the device pins nothing and warns about a clean MultiSend batch', async () => {
    const MULTISEND_111 = '0x8D29bE29923b68abfDD21e541b9374737B49cdAD'
    const td = mutate(ethFallbackHandler, { to: MULTISEND_111 })
    const old = { ...td, types: { ...td.types, EIP712Domain: [{ name: 'verifyingContract', type: 'address' }] }, domain: { verifyingContract: td.domain.verifyingContract } }
    for (const fw of ['7.16.0', '7.17.0']) {
      const line = deviceLine(await review(old, { from: ethFallbackHandler.signer, firmwareVersion: fw, chainId: 1 }))
      expect(`${fw} ${line?.level}`).toBe(`${fw} low`)
      expect(line!.text).toContain(`"Delegatecall: SafeTx gives ${MULTISEND_111} your Safe's full authority. Not checked."`)
    }
    // control: the same batch with chainId 1 in its domain gets no screen on 7.16 (the emulator showed none)
    expect(deviceLine(await review(td, { from: ethFallbackHandler.signer, firmwareVersion: '7.16.0' }))).toBeUndefined()
    expect(deviceWarnsSafeDelegatecall('7.16.0', 0, MULTISEND_111, td.message.data)).toBe(true)
    expect(deviceWarnsSafeDelegatecall('7.16.0', 1, MULTISEND_111, td.message.data)).toBe(false)
  })
})
