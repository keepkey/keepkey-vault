import { afterEach, describe, expect, test } from 'bun:test'
import { expectedHiveSignTxTransferBytes, serializeHiveOpsTx } from '../src/bun/txbuilder/hive-ops'
import { signAndBroadcastDeposit, signAndBroadcastOps, type MagiRuntimeContext } from '../src/bun/swap/magi-runtime'
import { hiveTxId } from '../src/bun/txbuilder/hive-broadcast'
import { hiveRolePath } from '../src/shared/chains'

const header = { refBlockNum: 4660, refBlockPrefix: 0x01020304, expirationUnix: 1_790_000_000, chainId: 'beeab0de' + '0'.repeat(56) }
const deposit: [string, any] = ['transfer', { from: 'vladtest', to: 'vsc.gateway', amount: '1.500 HBD', memo: 'to=vladtest' }]
const sig = new Uint8Array(65).fill(7)

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** Pioneer tx-params + Hive node broadcast, recording what was sent. */
function fakeNetwork() {
	const broadcasts: any[] = []
	globalThis.fetch = (async (url: string, init?: any) => {
		if (String(url).endsWith('/api/v1/hive/tx-params')) return new Response(JSON.stringify({ success: true, ...header }))
		const body = JSON.parse(init.body)
		broadcasts.push(body)
		return new Response(JSON.stringify({ result: {} }))
	}) as any
	return broadcasts
}

function ctx(wallet: any): MagiRuntimeContext {
	return { wallet, deviceState: { state: 'ready' }, pioneerBase: 'https://pioneer.test', signOp: (fn) => fn(), store: null }
}

describe('HiveSignTx transfer bytes (verification only)', () => {
	test('serializes HBD with the SBD wire symbol, HIVE as STEEM', () => {
		const hbd = expectedHiveSignTxTransferBytes({ ...header, from: 'a', to: 'b', amount: '1.500 HBD', memo: '' })
		expect(hbd.includes(Buffer.from('SBD\0'))).toBe(true)
		const hive = expectedHiveSignTxTransferBytes({ ...header, from: 'a', to: 'b', amount: '1.500 HIVE', memo: '' })
		expect(hive.includes(Buffer.from('STEEM'))).toBe(true)
		// op id 2 right after the one-op count
		expect(hbd[10]).toBe(1)
		expect(hbd[11]).toBe(2)
	})
	test('HiveSignOperations still refuses a transfer (op 2 invariant)', () => {
		expect(() => serializeHiveOpsTx({ ...header, operations: [deposit as any] })).toThrow()
	})
})

describe('deposit: HiveSignTx, byte-checked, direct broadcast', () => {
	test('matching bytes: broadcasts the transfer with the signed header, txid from the signed bytes', async () => {
		const broadcasts = fakeNetwork()
		const bytes = expectedHiveSignTxTransferBytes({ ...header, ...deposit[1] })
		let signedMsg: any
		const wallet = { hiveSignTx: async (m: any) => { signedMsg = m; return { signature: sig, serializedTx: new Uint8Array(bytes) } } }
		const { txid } = await signAndBroadcastDeposit(ctx(wallet), deposit as any)
		expect(signedMsg).toMatchObject({ amount: 1500, decimals: 3, assetSymbol: 'HBD', from: 'vladtest', to: 'vsc.gateway', memo: 'to=vladtest', expiration: header.expirationUnix })
		expect(signedMsg.addressNList).toEqual(hiveRolePath('active', 0))
		expect(txid).toBe(hiveTxId(bytes))
		expect(broadcasts).toHaveLength(1)
		expect(broadcasts[0].method).toBe('condenser_api.broadcast_transaction')
		expect(broadcasts[0].params[0]).toMatchObject({ ref_block_num: 4660, operations: [deposit], signatures: [Buffer.from(sig).toString('hex')] })
	})
	test('different bytes from the device: nothing is broadcast', async () => {
		const broadcasts = fakeNetwork()
		const other = expectedHiveSignTxTransferBytes({ ...header, ...deposit[1], amount: '1.501 HBD' })
		const wallet = { hiveSignTx: async () => ({ signature: sig, serializedTx: new Uint8Array(other) }) }
		await expect(signAndBroadcastDeposit(ctx(wallet), deposit as any)).rejects.toThrow(/different bytes/)
		expect(broadcasts).toHaveLength(0)
	})
	test('only a transfer may take the HiveSignTx path', async () => {
		fakeNetwork()
		await expect(signAndBroadcastDeposit(ctx({}), ['custom_json', {}] as any)).rejects.toThrow(/Only a transfer/)
	})
})

describe('swap step: HiveSignOperations with the active key', () => {
	test('signs the serialized ops and broadcasts them', async () => {
		const broadcasts = fakeNetwork()
		const op: any = ['custom_json', { required_auths: ['vladtest'], required_posting_auths: [], id: 'vsc.call', json: '{"a":1}' }]
		let msg: any
		const wallet = { hiveSignOperations: async (m: any) => { msg = m; return { signature: sig } } }
		const { txid } = await signAndBroadcastOps(ctx(wallet), [op])
		const serialized = serializeHiveOpsTx({ ...header, operations: [op] })
		expect(Buffer.from(msg.serializedTx).equals(serialized.serializedTx)).toBe(true)
		expect(msg.addressNList[2]).toBe(0x80000001) // active role
		expect(txid).toBe(hiveTxId(serialized.serializedTx))
		expect(broadcasts[0].params[0].operations).toEqual([op])
	})
	test('refuses posting-tier ops', async () => {
		fakeNetwork()
		const op: any = ['custom_json', { required_auths: [], required_posting_auths: ['vladtest'], id: 'x', json: '{}' }]
		await expect(signAndBroadcastOps(ctx({ hiveSignOperations: async () => ({ signature: sig }) }), [op])).rejects.toThrow(/active key/)
	})
})
