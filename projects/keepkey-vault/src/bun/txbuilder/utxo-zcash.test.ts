import { describe, expect, it } from 'bun:test'
import { buildUtxoTx } from './utxo'

const ZCASH = {
	id: 'zcash',
	coin: 'Zcash',
	symbol: 'ZEC',
	networkId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
	decimals: 8,
	scriptType: 'p2pkh',
} as any

const PATH = "m/44'/133'/0'/0/0"
const FROM = 't1HsfFiokfuisz5AUW6y7WN9TTMM3VvwFWT'
const TO = 't1ZaeZwsrEQpzv2APWRs9EAdBwLUkymKM7q'

function pioneerWith(utxos: any[]) {
	return {
		ListUnspent: async () => ({ data: utxos }),
		GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 2, fast: 5 } }),
		GetPubkeyInfo: async () => ({ data: [] }),
	}
}

describe('transparent Zcash transaction policy', () => {
	it('uses the Ironwood branch ID and excludes sub-10-confirmation inputs', async () => {
		const tx = await buildUtxoTx(pioneerWith([
			{
				txid: 'c00b24b617db136acba4d831e31727319e6917123934f9f8b5253c7f0e89a5b6',
				vout: 0,
				value: '14727242',
				confirmations: 10,
				address: FROM,
				path: PATH,
				hex: '00',
			},
			{
				txid: 'ba30273f73690000000000000000000000000000000000000000000000000000',
				vout: 0,
				value: '10000',
				confirmations: 4,
				address: FROM,
				path: PATH,
				hex: '00',
			},
		]), ZCASH, {
			to: TO,
			amount: '0',
			isMax: true,
			xpub: 'xpub-test',
		})

		expect(tx.branchId).toBe(0x37a5165b)
		expect(tx.inputs).toHaveLength(1)
		expect(tx.inputs[0].amount).toBe('14727242')
		expect(tx.outputs[0].amount).toBe('14717242')
		expect(tx.fee).toBe('0.0001')
	})

	it('fails before signing when every ZEC output is still locked', async () => {
		await expect(buildUtxoTx(pioneerWith([{
			txid: 'ba30273f73690000000000000000000000000000000000000000000000000000',
			vout: 0,
			value: '14727242',
			confirmations: 4,
			address: FROM,
			path: PATH,
			hex: '00',
		}]), ZCASH, {
			to: TO,
			amount: '0',
			isMax: true,
			xpub: 'xpub-test',
		})).rejects.toThrow('4/10 blocks')
	})
})
