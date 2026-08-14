import { describe, expect, it } from 'bun:test'
import { buildUtxoTx } from './utxo'

const BITCOIN = {
	id: 'bitcoin',
	coin: 'Bitcoin',
	symbol: 'BTC',
	networkId: 'bip122:000000000019d6689c085ae165831e93',
	decimals: 8,
	scriptType: 'p2wpkh',
} as any

// BIP86 account 0. The xpub carries ordinary BIP32 version bytes, so the path
// is the only thing that says "Taproot".
const TAPROOT_ACCOUNT_PATH = [0x80000000 + 86, 0x80000000, 0x80000000]
const TAPROOT_XPUB = 'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj'
const TO = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'

function pioneerWith(utxos: any[]) {
	return {
		ListUnspent: async () => ({ data: utxos }),
		GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 2, fast: 5 } }),
		GetPubkeyInfo: async () => ({ data: [] }),
	}
}

// A factory, not a constant: the builder tags UTXOs with scriptType and
// _sourceAccountPath in place, so a shared object leaks state between tests.
const taprootUtxo = () => ({
	txid: 'c00b24b617db136acba4d831e31727319e6917123934f9f8b5253c7f0e89a5b6',
	vout: 0,
	value: '500000',
	confirmations: 12,
	address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
	path: "m/86'/0'/0'/0/0",
	hex: '00',
})

describe('Taproot transaction building', () => {
	it('spends P2TR inputs and returns change to the BIP86 account', async () => {
		const tx = await buildUtxoTx(pioneerWith([taprootUtxo()]), BITCOIN, {
			to: TO,
			amount: '0.001',
			xpub: TAPROOT_XPUB,
			accountPath: TAPROOT_ACCOUNT_PATH,
			scriptTypeOverride: 'p2tr',
		})

		expect(tx.inputs).toHaveLength(1)
		expect(tx.inputs[0].scriptType).toBe('p2tr')
		expect(tx.inputs[0].addressNList).toEqual([...TAPROOT_ACCOUNT_PATH, 0, 0])

		// Change must stay on m/86'. Firmware only treats an output as change when
		// its path matches the inputs up to the account (signing.c
		// check_change_bip32_path), and it excludes purpose 86 from the
		// cross-account mixed-mode allowance — so a p2pkh change path here would
		// be shown to the user as an ordinary recipient instead of suppressed.
		const change = tx.outputs.find((o: any) => o.isChange)
		expect(change).toBeDefined()
		expect(change.scriptType).toBe('p2tr')
		expect(change.addressNList.slice(0, 3)).toEqual(TAPROOT_ACCOUNT_PATH)
		expect(change.addressNList[3]).toBe(1)
	})

	it('derives Taproot from the account path when no override is passed', async () => {
		// The regression guard: BIP86 reuses `xpub` version bytes, so resolving
		// scriptType from the prefix alone yields p2pkh and builds m/44' change.
		const tx = await buildUtxoTx(pioneerWith([taprootUtxo()]), BITCOIN, {
			to: TO,
			amount: '0.001',
			xpub: TAPROOT_XPUB,
			accountPath: TAPROOT_ACCOUNT_PATH,
		})

		const change = tx.outputs.find((o: any) => o.isChange)
		expect(change.scriptType).toBe('p2tr')
		expect(change.addressNList[0]).toBe(0x80000000 + 86)
	})

	it('leaves non-Taproot accounts on their own purpose', async () => {
		const tx = await buildUtxoTx(pioneerWith([{
			...taprootUtxo(),
			address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
			path: "m/84'/0'/0'/0/0",
		}]), BITCOIN, {
			to: TO,
			amount: '0.001',
			xpub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
			accountPath: [0x80000000 + 84, 0x80000000, 0x80000000],
		})

		expect(tx.inputs[0].scriptType).toBe('p2wpkh')
		const change = tx.outputs.find((o: any) => o.isChange)
		expect(change.scriptType).toBe('p2wpkh')
		expect(change.addressNList[0]).toBe(0x80000000 + 84)
	})
})
