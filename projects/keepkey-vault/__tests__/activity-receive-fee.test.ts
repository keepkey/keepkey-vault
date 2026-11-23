import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAINS } from '../src/shared/chains'

// Audit v6 R5: Base activity showed "Received 0.0002988 ETH … fee: 0.00000378 ETH"
// as if the user paid it, and a "Received 0 ETH … fee" row. The sender pays the fee.
const dir = mkdtempSync(join(tmpdir(), 'vault-receive-fee-'))
mock.module('electrobun/main/utils', () => ({ paths: { userData: dir } }))
mock.module('../src/bun/engine-controller', () => ({ withTimeout: async (promise: Promise<any>) => promise }))
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => { throw new Error('No network in this suite') } }))
const { classifyHistoryTx, historyOwnAddress, normalizeMeta } = await import('../src/bun/activity-history')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const base = CHAINS.find(c => c.id === 'base')!
const bitcoin = CHAINS.find(c => c.id === 'bitcoin')!
const own = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
// ownAddress null = a UTXO chain, queried by xpub (no own address to compare).
const row = (tx: any, ownAddress: string | null = own, chain = base) => {
	const { type, walletPaidFee } = classifyHistoryTx(tx, ownAddress ?? undefined, chain.caip)
	return { type, fee: normalizeMeta(tx, type, chain, walletPaidFee).fee }
}

test('a receive someone else sent carries no fee', () => {
	expect(row({ direction: 'received', value: '298800000000000', fee: '3780000000000', from: [other], to: [own], caip: base.caip }))
		.toEqual({ type: 'receive', fee: undefined })
})

test('a tx we sent back to ourselves is a send with its fee, even when the provider calls it received', () => {
	// The audit's Base MAX self-send; the checksum case differs.
	const ownChecksum = own.toUpperCase().replace('0X', '0x')
	expect(row({ direction: 'received', value: '298800000000000', fee: '3780000000000', from: [ownChecksum], to: [own] }))
		.toEqual({ type: 'send', fee: '3780000000000' })
	expect(row({ direction: 'self', value: '1', fee: '21000' })).toEqual({ type: 'send', fee: '21000' })
})

test('a 0-value tx we sent is our contract call: a send, with its fee', () => {
	// Stays "Sent" so the Sent filter and the blind-signing prior-use count see it.
	expect(row({ direction: 'received', value: '0', fee: '17250000000000', from: [own], to: [other], caip: base.caip }))
		.toEqual({ type: 'send', fee: '17250000000000' })
})

test('a 0-value tx someone else sent is a contract call with no fee of ours', () => {
	expect(row({ direction: 'received', value: '0', fee: '17250000000000', from: [other], to: [own], caip: base.caip }))
		.toEqual({ type: 'contract', fee: undefined })
})

test('address poisoning: an attacker-sent tx the provider calls "sent" shows no fee of ours', () => {
	// transferFrom(victim -> lookalike) sent and paid by the attacker.
	expect(row({ direction: 'sent', value: '0', fee: '9000000000000', from: [other], to: [other], caip: base.caip }))
		.toEqual({ type: 'contract', fee: undefined })
	expect(row({ direction: 'sent', value: '0', fee: '9000000000000', from: [other], caip: `${base.networkId}/erc20:0xabc` }))
		.toEqual({ type: 'send', fee: undefined })
})

test('a receive from a tx we sent (e.g. unwrapping WETH) stays a receive, and the fee is ours', () => {
	expect(row({ direction: 'received', value: '1000000000000000', fee: '50000000000000', from: [own], to: [other], caip: base.caip }))
		.toEqual({ type: 'receive', fee: '50000000000000' })
})

test('cosmos/solana keep the provider type: a reward withdrawal stays a receive, a declared send keeps its fee', () => {
	const cosmos = CHAINS.find(c => c.id === 'cosmos')!, solana = CHAINS.find(c => c.id === 'solana')!
	const us = 'cosmos1ours', sol = 'SoLOurWallet111'
	// MsgWithdrawDelegatorReward: signed by us, paid to us.
	expect(row({ direction: 'received', value: '500000', fee: '5000', from: [us], to: [us], caip: cosmos.caip }, us, cosmos))
		.toEqual({ type: 'receive', fee: '5000' })
	// Someone else's transfer to us: no fee of ours.
	expect(row({ direction: 'received', value: '500000', fee: '5000', from: ['cosmos1other'], to: [us], caip: cosmos.caip }, us, cosmos))
		.toEqual({ type: 'receive', fee: undefined })
	// An SPL send whose from is our token account, not the wallet address.
	expect(row({ direction: 'sent', value: '1000000', fee: '5000', from: ['OurTokenAccount'], caip: `${solana.networkId}/token:mint` }, sol, solana))
		.toEqual({ type: 'send', fee: '5000' })
})

test('without a comparable address the provider direction decides, and a declared send keeps its fee', () => {
	const ton = CHAINS.find(c => c.id === 'ton')!, hive = CHAINS.find(c => c.id === 'hive')!
	expect(historyOwnAddress(ton, 'UQ-ours')).toBeUndefined()
	expect(historyOwnAddress(hive, 'STM-public-key')).toBeUndefined()
	expect(historyOwnAddress(base, own)).toBe(own)
	expect(row({ direction: 'sent', value: '5', fee: '100', from: ['EQ-other-encoding-of-us'] }, null, ton))
		.toEqual({ type: 'send', fee: '100' })
	expect(row({ direction: 'received', value: '0', fee: '100', from: ['someone'] }, null, hive))
		.toEqual({ type: 'receive', fee: undefined })
	// A record without a sender: the direction decides.
	expect(row({ direction: 'sent', value: '5', fee: '100' })).toEqual({ type: 'send', fee: '100' })
})

test('token rows and UTXO chains keep the provider direction', () => {
	// A token row with a 0 amount is not a native 0-value call.
	expect(row({ direction: 'received', value: '0', from: [other], caip: `${base.networkId}/erc20:0xabc` }).type).toBe('receive')
	// UTXO: no own address to compare; the ownership-based direction decides.
	expect(row({ direction: 'received', value: '10000', fee: '200' }, null, bitcoin)).toEqual({ type: 'receive', fee: undefined })
	expect(row({ direction: 'sent', value: '10000', fee: '200' }, null, bitcoin)).toEqual({ type: 'send', fee: '200' })
	expect(row({ direction: 'received', value: '0', fee: '200' }, null, bitcoin).type).toBe('receive')
})

test('stored receive rows read no fee, and contract rows read as contract calls', async () => {
	const db = await import('../src/bun/db')
	db.initDb()
	try {
		const wallet = { deviceId: 'fixture-device', walletId: 'fixture-wallet' }
		const scan = (txid: string, activityType: string, meta: Record<string, unknown>) => db.insertApiLog({
			...wallet, method: 'SCAN', route: `history/${meta.chainId}`, timestamp: Date.now(), durationMs: 0, status: 200,
			appName: 'vault', txid, chain: String(meta.chainSymbol), activityType, responseBody: meta,
		} as any)
		// Stored before this fix, outside the window a rescan rewrites.
		scan('BASE-OLD-RECEIVE', 'receive', { chainId: 'base', chainSymbol: 'ETH', value: '298800000000000', fee: '3780000000000' })
		scan('BASE-SEND', 'send', { chainId: 'base', chainSymbol: 'ETH', value: '1', fee: '3780000000000' })
		scan('BASE-CONTRACT', 'contract', { chainId: 'base', chainSymbol: 'ETH', value: '0', fee: '17250000000000' })
		// Our own 0-value contract call, classified as the scan would: it still counts as prior use.
		const venice = '0x3333333333333333333333333333333333333333'
		const call = { direction: 'received', value: '0', fee: '1', from: [own], to: [venice], caip: base.caip }
		const own0 = classifyHistoryTx(call, own, base.caip)
		scan('BASE-OWN-CALL', own0.type, { ...normalizeMeta(call, own0.type, base, own0.walletPaidFee), chainId: 'base', chainSymbol: 'ETH', networkId: base.networkId })
		const rows = db.getRecentActivityFromLog(undefined, undefined, wallet.deviceId, wallet.walletId)
		const get = (txid: string) => rows.find(r => r.txid === txid)
		expect(get('BASE-OLD-RECEIVE')?.fee).toBeUndefined()
		expect(get('BASE-SEND')?.fee).toBe('3780000000000')
		expect(get('BASE-CONTRACT')?.type).toBe('contract')
		expect(get('BASE-CONTRACT')?.fee).toBe('17250000000000')
		expect(get('BASE-OWN-CALL')?.type).toBe('send')
		expect(db.getPriorEvmCalls(own, venice, 8453)?.count).toBe(1)
	} finally {
		db.closeDb()
	}
})
