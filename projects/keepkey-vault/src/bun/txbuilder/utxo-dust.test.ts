import { describe, expect, it } from 'bun:test'
import { buildUtxoTx } from './utxo'
import { changeDustLimit, foldDustChange } from './utxo-dust'

// Audit v6 B4: coinselect adds change above 148 × rate (444 sat at 3 sat/vB),
// below the 546-sat limit nodes apply to P2PKH, so a 445–545 sat change made
// the whole transaction non-standard.

const BITCOIN = {
	id: 'bitcoin',
	coin: 'Bitcoin',
	symbol: 'BTC',
	networkId: 'bip122:000000000019d6689c085ae165831e93',
	decimals: 8,
	scriptType: 'p2wpkh',
} as any

const LEGACY_ACCOUNT_PATH = [0x80000000 + 44, 0x80000000, 0x80000000]
const LEGACY_XPUB = 'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj'
const TO = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'

function pioneerWith(utxos: any[]) {
	return {
		ListUnspent: async () => ({ data: utxos }),
		// Every level at 1 sat/vB, so the build uses the 3 sat/vB relay floor.
		GetFeeRateByNetwork: async () => ({ data: { slow: 1, average: 1, fast: 1 } }),
		GetPubkeyInfo: async () => ({ data: [] }),
	}
}

const legacyUtxo = (value: number) => ({
	txid: 'c00b24b617db136acba4d831e31727319e6917123934f9f8b5253c7f0e89a5b6',
	vout: 0,
	value: String(value),
	confirmations: 12,
	address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
	path: "m/44'/0'/0'/0/0",
	hex: '00',
})

// At 3 sat/vB a 1-in/2-out P2PKH tx is 226 vB = 678 sat; without change 192 vB.
const AMOUNT = 100_000
const FEE_WITH_CHANGE = 226 * 3

const build = (change: number) => buildUtxoTx(pioneerWith([legacyUtxo(AMOUNT + FEE_WITH_CHANGE + change)]), BITCOIN, {
	to: TO,
	amount: String(AMOUNT / 1e8),
	xpub: LEGACY_XPUB,
	accountPath: LEGACY_ACCOUNT_PATH,
	scriptTypeOverride: 'p2pkh',
})

describe('change below the dust limit', () => {
	it('adds a 502-sat P2PKH change to the fee instead of creating it', async () => {
		const tx = await build(502)
		expect(tx.outputs.some((o: any) => o.isChange)).toBe(false)
		expect(tx.outputs).toHaveLength(1)
		expect(tx.outputs[0].amount).toBe(String(AMOUNT))
		expect(tx.fee).toBe(String((FEE_WITH_CHANGE + 502) / 1e8))
	})

	it('keeps a P2PKH change at exactly the 546-sat limit', async () => {
		const tx = await build(546)
		const change = tx.outputs.find((o: any) => o.isChange)
		expect(change?.amount).toBe('546')
		expect(tx.fee).toBe(String(FEE_WITH_CHANGE / 1e8))
	})
})

const LITECOIN = {
	id: 'litecoin',
	coin: 'Litecoin',
	symbol: 'LTC',
	networkId: 'bip122:12a765e31ffd4059bada1e25190f6e98',
	decimals: 8,
	scriptType: 'p2wpkh',
} as any

const segwitUtxo = (value: number, coinType: number) => ({
	...legacyUtxo(value),
	address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
	path: `m/84'/${coinType}'/0'/0/0`,
})

// coinselect sizes every input and output as P2PKH, whatever the script.
const buildSegwit = (chain: any, coinType: number, change: number, satPerVByte?: number) => {
	const rate = satPerVByte ?? 3
	return buildUtxoTx(pioneerWith([segwitUtxo(AMOUNT + 226 * rate + change, coinType)]), chain, {
		to: TO,
		amount: String(AMOUNT / 1e8),
		xpub: LEGACY_XPUB,
		accountPath: [0x80000000 + 84, 0x80000000 + coinType, 0x80000000],
		scriptTypeOverride: 'p2wpkh',
		satPerVByte,
	})
}

describe('change below the dust limit on SegWit accounts', () => {
	// At a custom 1 sat/vB coinselect adds any change above 148 sat, under the 294-sat P2WPKH limit.
	it('adds a 200-sat P2WPKH change at 1 sat/vB to the fee', async () => {
		const tx = await buildSegwit(BITCOIN, 0, 200, 1)
		expect(tx.outputs.some((o: any) => o.isChange)).toBe(false)
		expect(tx.fee).toBe(String((226 + 200) / 1e8))
	})

	it('keeps a P2WPKH change at exactly the 294-sat limit', async () => {
		const tx = await buildSegwit(BITCOIN, 0, 294, 1)
		expect(tx.outputs.find((o: any) => o.isChange)?.amount).toBe('294')
	})

	it('uses the Litecoin limit (2940 litoshi for P2WPKH), not Bitcoin’s', async () => {
		const tx = await buildSegwit(LITECOIN, 2, 2000)
		expect(tx.outputs.some((o: any) => o.isChange)).toBe(false)
		expect(tx.fee).toBe(String((226 * 3 + 2000) / 1e8))
	})
})

describe('changeDustLimit', () => {
	it('matches Bitcoin Core for each script type', () => {
		expect(changeDustLimit('bitcoin', 'p2pkh')).toBe(546)
		expect(changeDustLimit('bitcoin', 'p2sh-p2wpkh')).toBe(540)
		expect(changeDustLimit('bitcoin', 'p2wpkh')).toBe(294)
		expect(changeDustLimit('bitcoin', 'p2tr')).toBe(330)
	})

	it('uses each chain’s own relay policy', () => {
		expect(changeDustLimit('bitcoincash', 'p2pkh')).toBe(546)
		expect(changeDustLimit('dash', 'p2pkh')).toBe(546)
		expect(changeDustLimit('litecoin', 'p2wpkh')).toBe(2940)
		expect(changeDustLimit('litecoin', 'p2pkh')).toBe(5460)
		expect(changeDustLimit('digibyte', 'p2pkh')).toBe(5460)
		expect(changeDustLimit('dogecoin', 'p2pkh')).toBe(1_000_000)
	})

	it('errs high for an unknown chain or script type', () => {
		expect(changeDustLimit('bitcoin', 'unknown')).toBe(546)
		expect(changeDustLimit('newcoin', 'p2pkh')).toBe(5460)
	})
})

describe('foldDustChange', () => {
	it('never removes a spend output, however small', () => {
		const result = foldDustChange([{ address: TO, value: 100 }, { value: 545 }], 678, 546)
		expect(result.outputs).toEqual([{ address: TO, value: 100 }])
		expect(result.fee).toBe(678 + 545)
		expect(result.folded).toBe(545)
	})

	it('leaves change at or above the limit alone', () => {
		const outputs = [{ address: TO, value: 1000 }, { value: 546 }]
		expect(foldDustChange(outputs, 678, 546)).toEqual({ outputs, fee: 678, folded: 0 })
	})
})
