/**
 * Report money-flow on a real 10-tx wallet history (values exact; addresses and
 * txids anonymized). tx0 is an exchange payout: 0.00807204 BTC to the wallet,
 * 1.57696599 BTC back to the exchange as change. Old reports showed 1.58503803.
 */
import { describe, expect, test } from 'bun:test'
import { buildFlowTx, withRunningBalance, flowTotals, parseSwapMemo, describeOwnPath, buildAddressFlow } from './report-btc-flow'
import fixture from './report-btc-flow.fixtures.json'

const own = new Map<string, string>()
for (const tx of fixture) for (const r of [...tx.vin, ...tx.vout]) {
	const m = r.addresses[0].match(/^own_(\d+)_(\d+)_(\d+)$/)
	if (m) own.set(r.addresses[0], `m/44'/0'/${m[1]}'/${m[2]}/${m[3]}`)
}
const flows = withRunningBalance(fixture.map(tx => buildFlowTx(tx, own)))
const byId = Object.fromEntries(flows.map(f => [f.txid, f]))

describe('report BTC flow', () => {
	test("a payment counts only the wallet's output, not the sender's change", () => {
		const f = byId.tx0
		expect(f.dir).toBe('received')
		expect(f.amount).toBe(807204)
		expect(f.to).toEqual(['own_0_0_0'])
		expect(f.rows.find(r => r.address === 'ext1')!.whose).toStartWith('NOT YOURS')
	})

	test('send with change: change is marked yours, amount is what left the wallet', () => {
		const f = byId.tx4
		expect(f.dir).toBe('sent')
		expect(f.amount).toBe(1430941)
		expect(f.net).toBe(-(1430941 + 102150))
		expect(f.rows.find(r => r.address === 'own_1_1_0')!.whose).toBe('YOURS - change back to you (account 1, change #0)')
	})

	test('swap out and refund are labeled from the memo', () => {
		expect(byId.tx7.label).toBe('Swap BTC -> ETH.ETH (to 0xDEST)')
		expect(byId.tx7.amount).toBe(109128)
		expect(byId.tx8.label).toBe('Swap refund (for tx tx7)')
		expect(byId.tx8.dir).toBe('received')
		expect(byId.tx8.amount).toBe(107522) // not the vault's 17.6 BTC
		expect(byId.tx8.rows.filter(r => r.side === 'IN').every(r => r.whose === 'Swap vault (payer)')).toBe(true)
	})

	test('running balance never exceeds what was actually held, ends at zero', () => {
		const t = flowTotals(flows)
		expect(flows.map(f => f.balanceAfter)).toEqual([807204, 711864, 1000, 1584841, 51750, 1501076, 113520, 0, 107522, 0])
		expect(t.peak.sats).toBe(1584841)
		expect(t.computedBalance).toBe(0)
		expect(t.received - t.sent - t.fees).toBe(0)
		expect(t.received).toBe(3947893)
	})

	describe('others contributed inputs (payjoin / coinjoin)', () => {
		const io = (a: string, v: number) => ({ addresses: [a], value: String(v) })
		const txOf = (txid: string, fees: number, vin: any[], vout: any[]) => ({ txid, blockHeight: 900000, blockTime: 1700000000, fees: String(fees), vin, vout })
		const pj = new Map([['own_a', "m/84'/0'/0'/0/0"], ['own_b', "m/84'/0'/0'/1/0"]])

		// Wallet pays 300000 to the receiver, who adds a 200000 input. 600000 + 200000 in, 1000 fee.
		const payjoinSend = txOf('pj-send', 1000, [io('own_a', 600000), io('recv_in', 200000)],
			[io('recv_out', 500000), io('own_b', 299000)])

		test('sender: only the payment counts, not the receiver\'s own input coming back', () => {
			const f = buildFlowTx(payjoinSend, pj)
			expect(f.dir).toBe('sent')
			expect(f.shared).toBe(true)
			expect(f.net).toBe(-301000)
			expect(f.fee).toBe(1000) // the payjoin sender pays the whole fee
			expect(f.amount).toBe(300000)
			expect(f.label).toBe('Sent - shared transaction (payjoin/coinjoin), only your part counted')
			expect(f.rows.find(r => r.address === 'recv_in')!.whose).toBe("NOT YOURS - another participant's input")
			expect(f.rows.find(r => r.address === 'recv_out')!.whose).toBe("Paid out - may include another participant's own funds")
			const t = flowTotals(withRunningBalance([f]))
			expect(t.sent).toBe(300000)
			expect(t.fees).toBe(1000)
		})

		test('receiver: the wallet input is not a send; amount is the net gain', () => {
			const recv = new Map([['recv_in', "m/84'/0'/0'/0/1"], ['recv_out', "m/84'/0'/0'/0/2"]])
			const f = buildFlowTx(payjoinSend, recv)
			expect(f.dir).toBe('received')
			expect(f.amount).toBe(300000)
			expect(f.rows.find(r => r.address === 'own_a')!.whose).toBe("NOT YOURS - another participant's input")
		})

		test('coinjoin: equal outputs to others are not counted as sent', () => {
			// Three 100000 inputs, three 99000 outputs, 3000 fee shared equally.
			const f = buildFlowTx(txOf('cj', 3000,
				[io('own_a', 100000), io('p2_in', 100000), io('p3_in', 100000)],
				[io('own_b', 99000), io('p2_out', 99000), io('p3_out', 99000)]), pj)
			expect(f.dir).toBe('sent')
			expect(f.fee).toBe(1000)
			expect(f.amount).toBe(0)
		})

		test('fee never exceeds what the wallet lost', () => {
			// Wallet loses 500 of a 1000 fee; the other input covers the rest.
			const f = buildFlowTx(txOf('half', 1000, [io('own_a', 100000), io('other', 500)], [io('own_b', 99500)]), pj)
			expect(f.dir).toBe('sent')
			expect(f.fee).toBe(500)
			expect(f.amount).toBe(0)
		})

		test('an input with no address does not make a consolidation look shared', () => {
			const f = buildFlowTx(txOf('consol', 1000, [io('own_a', 100000), { addresses: [], value: '50000' }], [io('own_b', 149000)]), pj)
			expect(f.dir).toBe('internal')
			expect(f.shared).toBe(false)
		})

		test('ordinary sends are not shared and keep their labels', () => {
			expect(flows.every(f => f.shared === false)).toBe(true)
			expect(flows.some(f => f.label.includes('shared'))).toBe(false)
		})

		test('all outputs are the wallet\'s but someone else added an input: received, not an internal move', () => {
			const f = buildFlowTx(txOf('in-only', 1000, [io('own_a', 100000), io('other', 50000)], [io('own_b', 149000)]), pj)
			expect(f.dir).toBe('received')
			expect(f.amount).toBe(49000)
		})

		test('address flow lists only what the wallet paid, not other participants\' outputs', () => {
			const coinjoin = buildFlowTx(txOf('cj2', 3000,
				[io('own_a', 100000), io('p2_in', 100000), io('p3_in', 100000)],
				[io('own_b', 99000), io('p2_out', 99000), io('p3_out', 99000)]), pj)
			const [summary, sentTo] = buildAddressFlow([buildFlowTx(payjoinSend, pj), coinjoin])
			expect((summary.data as string[])[0]).toStartWith('BTC Sent to: 0.00300000 BTC (1 unique addresses)')
			expect((sentTo.data as any).rows).toEqual([['1', 'recv_out', '0.00300000', '1']])
		})

		test('address flow of ordinary sends is unchanged', () => {
			const rows = (buildAddressFlow(flows)[1].data as any).rows
			const paid = flows.filter(f => f.dir === 'sent').reduce((s, f) => s + f.amount, 0)
			expect(rows.reduce((s: number, r: string[]) => s + Math.round(Number(r[2]) * 1e8), 0)).toBe(paid)
		})

		test('received - sent - fees still equals the balance across a mixed history', () => {
			const flows2 = withRunningBalance([
				buildFlowTx(txOf('fund', 0, [io('ext', 700000)], [io('own_a', 600000)]), pj),
				buildFlowTx({ ...payjoinSend, blockHeight: 900001 }, pj),
			])
			const t = flowTotals(flows2)
			expect(t.received - t.sent - t.fees).toBe(t.computedBalance)
			expect(t.computedBalance).toBe(299000)
		})
	})

	test('memo + path helpers', () => {
		expect(parseSwapMemo('SWAP:BTC.BTC:bc1q')).toEqual({ kind: 'swap', asset: 'BTC.BTC', dest: 'bc1q' })
		expect(parseSwapMemo('OUT:ABC')).toEqual({ kind: 'payout', txid: 'abc' })
		expect(parseSwapMemo('hello')).toBeNull()
		expect(describeOwnPath("m/84'/0'/0'/0/5")).toBe('account 0, receive #5')
	})
})
