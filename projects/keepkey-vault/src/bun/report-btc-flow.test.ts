/**
 * Report money-flow on a real 10-tx wallet history (values exact; addresses and
 * txids anonymized). tx0 is an exchange payout: 0.00807204 BTC to the wallet,
 * 1.57696599 BTC back to the exchange as change. Old reports showed 1.58503803.
 */
import { describe, expect, test } from 'bun:test'
import { buildFlowTx, withRunningBalance, flowTotals, parseSwapMemo, describeOwnPath } from './report-btc-flow'
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

	test('memo + path helpers', () => {
		expect(parseSwapMemo('SWAP:BTC.BTC:bc1q')).toEqual({ kind: 'swap', asset: 'BTC.BTC', dest: 'bc1q' })
		expect(parseSwapMemo('OUT:ABC')).toEqual({ kind: 'payout', txid: 'abc' })
		expect(parseSwapMemo('hello')).toBeNull()
		expect(describeOwnPath("m/84'/0'/0'/0/5")).toBe('account 0, receive #5')
	})
})
