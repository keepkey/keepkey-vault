import { expect, test } from 'bun:test'
import { SafeTransactionService } from './safe-transaction-service'
import type { SafeProposal } from '../shared/safe-multisig'

const base = 'https://api.safe.global/tx-service/base'
const safe = '0x1111111111111111111111111111111111111111'
const sender = '0x2222222222222222222222222222222222222222'
const hash = '0x' + 'ab'.repeat(32)
const signature = '0x' + '12'.repeat(65)
const proposal: SafeProposal = { format: 'keepkey-safe-v1', chainId: 8453, safe, hash, transaction: { nonce: '0', to: sender, data: '0x', value: '1', operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: '0x' + '0'.repeat(40), refundReceiver: '0x' + '0'.repeat(40) }, signatures: { [sender]: signature } }
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status })
function client(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const request = (async (input: any, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init })
    if (url.startsWith('https://safe-config.safe.global/'))
      return json({ results: [{ chainId: '8453', transactionService: base }], next: null })
    return handler(url, init)
  }) as typeof fetch
  return { service: new SafeTransactionService(request, 'test-api-key'), calls }
}
test('all pages are read inside the configured Base service, with optional bearer authentication', async () => {
  const c = client(url => url.includes('page=2') ? json({ results: [{ nonce: 1 }], next: null })
    : json({ results: [{ nonce: 0 }], next: `${base}/api/v2/queue/?page=2` }))
  expect(await c.service.pending(8453, safe, '0')).toEqual([{ nonce: 0 }, { nonce: 1 }])
  expect(c.calls[1]!.url).toContain(`/api/v2/safes/${safe}/multisig-transactions/?executed=false&nonce__gte=0`)
  expect(c.calls[1]!.init?.headers).toMatchObject({ Authorization: 'Bearer test-api-key' })
  expect(c.calls[0]!.init?.headers).toBeUndefined()
  expect(c.calls.slice(1).every(c => c.init?.redirect === 'error')).toBe(true)
})
test('owner discovery uses the v2 owner endpoint, canonicalizes addresses and deduplicates results', async () => {
  const c = client(() => json({ results: [{ address: safe }, { address: safe.toLowerCase() }], next: null }))
  expect(await c.service.ownedSafes(8453, sender)).toEqual([safe])
  expect(c.calls[1]!.url).toBe(`${base}/api/v2/owners/${sender}/safes/`)
})
test('cross-service pagination is rejected before credentials or data leave the service', async () => {
  for (const next of ['https://attacker.invalid/api/steal', `${base}/../other/api/steal`, `${base}/api/../../other/api/steal`, 'https://api.safe.global/tx-service/ethereum/api/steal']) {
    const c = client(() => json({ results: [], next }))
    await expect(c.service.pending(8453, safe, '0')).rejects.toThrow('outside its service')
    expect(c.calls).toHaveLength(2)
  }
})
test('cycles, malformed pages and partial pagination fail visibly', async () => {
  const cycle = client(url => json({ results: [], next: url }))
  await expect(cycle.service.pending(8453, safe, '0')).rejects.toThrow('repeated a page')
  const malformed = client(() => json({ count: 0 }))
  await expect(malformed.service.pending(8453, safe, '0')).rejects.toThrow('Invalid')
  let page = 0
  const cap = client(() => json({ results: [], next: `${base}/api/queue/?page=${++page}` }))
  await expect(cap.service.pending(8453, safe, '0')).rejects.toThrow('pagination limit')
})
test('new signed proposals use the documented v2 create payload; existing ones use the confirmations endpoint', async () => {
  for (const exists of [false, true]) {
    const c = client((_url, init) => init?.method === 'POST' ? new Response(null, { status: 201 }) : json({}, exists ? 200 : 404))
    await c.service.publish(proposal, sender)
    const sent = c.calls.at(-1)!
    const body = JSON.parse(String(sent.init?.body))
    if (exists) {
      expect(sent.url).toBe(`${base}/api/v1/multisig-transactions/${hash}/confirmations/`)
      expect(body).toEqual({ signature })
    } else {
      expect(sent.url).toBe(`${base}/api/v2/safes/${safe}/multisig-transactions/`)
      expect(body).toEqual({ ...proposal.transaction, contractTransactionHash: hash, sender, signature, origin: 'KeepKey Vault' })
    }
  }
})
test('missing approval and service failures do not cause a write or an alternate-route retry', async () => {
  const c = client(() => json({}, 429))
  await expect(c.service.publish({ ...proposal, signatures: {} }, sender)).rejects.toThrow('Approve')
  expect(c.calls).toHaveLength(0)
  await expect(c.service.publish(proposal, sender)).rejects.toThrow('429')
  expect(c.calls.some(c => c.init?.method === 'POST')).toBe(false)
})
