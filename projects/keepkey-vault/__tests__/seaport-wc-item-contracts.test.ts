/**
 * WalletConnect eth_signTypedData_v4 with a Seaport order on 7.17: the card
 * asks each item's token contract what it is even when the ClearSign service's
 * definition is attached (review r2 on firmware PR #1035). Before, a
 * definition built the report in walletconnect.ts and index.ts skipped the
 * contract reads, so an ERC-721 item naming an ERC-20 with an ID under 2^64
 * (which the device cannot flag) got no red line.
 *
 * Real pieces: the OpenSea listing (seaport-opensea-listing-mainnet.json), the
 * 6-D Seaport leaf signed by the batch-6 rehearsal TEST root (trusted here
 * only), the WalletConnect manager, and an eth_call RPC on 127.0.0.1 set as
 * the user's own RPC, answering as the chain does (USDe: no
 * supportsInterface, decimals 18; the listed NFT: ERC-721, no decimals).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SigningRequestInfo } from '../src/shared/types'
import seaport from './fixtures/typed-data/seaport-opensea-listing-mainnet.json'
import leaf from './fixtures/typed-data/seaport-6d-test-envelope.json'
import { trustTestRoot } from './support/clearsign-test-root'

mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-seaport-wc-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
const { WalletConnectManager } = await import('../src/bun/walletconnect')
const { forgetRefusedErc7730Definitions } = await import('../src/bun/erc7730-resolver')
const { assessSigningRisk } = await import('../src/shared/clearsign-risk')
const { CAPABILITY_ERC7730_RUNTIME_REVIEW } = await import('../src/shared/erc7730-support')

const { address, typedData } = seaport.body
const NFT = typedData.message.offer[0].token.toLowerCase()
const USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3'
const SUPPORTS_721 = '0x01ffc9a780ac58cd00000000000000000000000000000000000000000000000000000000'
const SUPPORTS_1155 = '0x01ffc9a7d9b67a2600000000000000000000000000000000000000000000000000000000'
const DECIMALS = '0x313ce567'
const word = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const REVERT = 'execution reverted'
const contracts: Record<string, Record<string, string>> = {
  [NFT]: { [SUPPORTS_721]: word(1), [SUPPORTS_1155]: word(0), [DECIMALS]: REVERT },
  [USDE.toLowerCase()]: { [SUPPORTS_721]: REVERT, [SUPPORTS_1155]: REVERT, [DECIMALS]: word(18) },
}

let rpcUp = true
let lookups = 0
const rpc = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(req) {
    if (!rpcUp) return new Response('down', { status: 503 })
    const { id, method, params } = await req.json() as any
    const answer = method === 'eth_call' ? contracts[String(params[0].to).toLowerCase()]?.[params[0].data] : undefined
    // Anything else (royaltyInfo, an unknown contract) reverts, as it would there.
    if (answer === undefined || answer === REVERT) return Response.json({ jsonrpc: '2.0', id, error: { code: 3, message: REVERT } })
    return Response.json({ jsonrpc: '2.0', id, result: answer })
  },
})
const originalFetch = globalThis.fetch
let untrust = () => {}

beforeAll(() => {
  db.initDb()
  db.setSetting('evm_simulation_rpc_urls', JSON.stringify({ 1: `http://127.0.0.1:${rpc.port}/` }))
})
afterAll(() => { rpc.stop(true); db.closeDb(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  forgetRefusedErc7730Definitions()
  rpcUp = true
  lookups = 0
  untrust = trustTestRoot(leaf.testRootPubkey)
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url)
    if (u.startsWith('http://127.0.0.1:')) return originalFetch(url, init)
    if (u.includes('/v1/erc7730/definition')) { lookups++; return Response.json(leaf.definition) }
    throw new Error('offline')
  }) as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch; untrust() })

async function wcCard(td: any): Promise<SigningRequestInfo> {
  let card: SigningRequestInfo | undefined
  const manager: any = new WalletConnectManager({
    getEvmAddressInfo: () => ({ address, addressIndex: 0 }),
    getFirmwareVersion: () => '7.17.0',
    getDeviceCapabilities: () => [CAPABILITY_ERC7730_RUNTIME_REVIEW, 30],
    recordClearSignObservation: () => undefined,
    finalizeClearSignObservation: () => {},
    requestSigningApproval: async (info: SigningRequestInfo) => { card = structuredClone(info); return false },
    dismissSigning: () => {},
    log: () => {},
  } as any)
  await expect(manager.signTypedData(td, [0x8000002c, 0x8000003c, 0x80000000, 0, 0], 'OpenSea', 1))
    .rejects.toThrow('User rejected signing')
  return card!
}
const texts = (card: SigningRequestInfo) => assessSigningRisk(card)!.reasons.map((r) => r.text).join('\n')
const withOffer = (item: any) => {
  const td = JSON.parse(JSON.stringify(typedData))
  td.message.offer = [{ ...td.message.offer[0], ...item }]
  return td
}

describe('WalletConnect Seaport order with a ClearSign definition attached', () => {
  test('an ERC-721 item naming USDe with ID 10^19 (under 2^64) is red on the card', async () => {
    const card = await wcCard(withOffer({ token: USDE, identifierOrCriteria: '10000000000000000000' }))
    // The definition is attached and the report built before approval.
    expect(lookups).toBe(1)
    expect(card.erc7730?.definitions[0].definitionId).toBe(leaf.definition.definitionId)
    expect(card.clearSignReport).toBeDefined()
    // ...and the contract was asked anyway.
    expect(card.typedDataDecoded?.seaportItems?.[0]).toMatchObject({ side: 'offer', itemType: 2, erc721: false, erc1155: false, decimals: 18 })
    expect(assessSigningRisk(card)!.tier).toBe('red')
    expect(texts(card)).toContain(`Offer 1 is an ERC-721 NFT item, but ${USDE} answers like an ERC-20 token (decimals 18): Seaport would move the NFT ID as that many token units.`)
  })

  test('CONTROL: the real listing, its NFT says ERC-721: no contract line', async () => {
    const card = await wcCard(typedData)
    expect(card.erc7730).toBeDefined()
    expect(card.typedDataDecoded?.seaportItems?.[0]).toMatchObject({ erc721: true, erc1155: false })
    expect(texts(card)).not.toContain('answers like an ERC-20')
    expect(texts(card)).not.toContain('could not ask the contracts')
  })

  test('the RPC does not answer: the card says the contracts could not be checked', async () => {
    rpcUp = false
    const card = await wcCard(withOffer({ token: USDE, identifierOrCriteria: '10000000000000000000' }))
    expect(card.erc7730).toBeDefined()
    expect(card.typedDataDecoded?.seaportItems?.[0].unchecked).toBe(true)
    expect(texts(card)).toContain('This computer could not ask the contracts in this order whether they are NFTs or tokens, so it could not check them.')
    expect(texts(card)).not.toContain('answers like an ERC-20')
  })
})
