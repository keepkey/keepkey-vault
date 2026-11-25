import { describe, expect, it } from 'bun:test'
import { addressToScriptPubKeyHex, buildUtxoTx, witnessScriptPubKeyHex } from './utxo'
import { changeDustLimit, foldDustChange, outputDustLimit } from './utxo-dust'
import { describeDustError, dustErrorMessage, formatBaseUnits } from '../../shared/utxo-dust-errors'

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

// KEEPKEY-158: a spend output under the limit cannot be folded away; the node
// refuses the signed tx at broadcast. The builder must refuse before signing.
const LEGACY_TO = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'

const send = (to: string, amount: number, utxoValue = 1_000_000) =>
	buildUtxoTx(pioneerWith([legacyUtxo(utxoValue)]), BITCOIN, {
		to,
		amount: String(amount / 1e8),
		xpub: LEGACY_XPUB,
		accountPath: LEGACY_ACCOUNT_PATH,
		scriptTypeOverride: 'p2pkh',
	})

describe('spend output below the dust limit', () => {
	it('refuses 500 sat to a legacy address, naming the 546-sat minimum', async () => {
		await expect(send(LEGACY_TO, 500)).rejects.toThrow('Amount is below the network dust limit (minimum 0.00000546 BTC)')
	})

	it('accepts exactly 546 sat to a legacy address', async () => {
		const tx = await send(LEGACY_TO, 546)
		expect(tx.outputs.find((o: any) => o.address === LEGACY_TO)?.amount).toBe('546')
	})

	it('uses the recipient’s script: 300 sat to P2WPKH is fine, 293 is not', async () => {
		const tx = await send(TO, 300)
		expect(tx.outputs.find((o: any) => o.address === TO)?.amount).toBe('300')
		await expect(send(TO, 293)).rejects.toThrow('(minimum 0.00000294 BTC)')
	})

	it('reads an upper-case bech32 address (as QR codes carry it) as P2WPKH, not P2PKH', async () => {
		const upper = TO.toUpperCase()
		const tx = await send(upper, 300)
		expect(tx.outputs.find((o: any) => o.address === upper)?.amount).toBe('300')
	})

	it('uses the P2SH limit (540) for a 3… address', async () => {
		const P2SH_TO = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'
		await expect(send(P2SH_TO, 539)).rejects.toThrow('(minimum 0.0000054 BTC)')
		const tx = await send(P2SH_TO, 540)
		expect(tx.outputs.find((o: any) => o.address === P2SH_TO)?.amount).toBe('540')
	})

	it('refuses a MAX send whose amount after fees is dust', async () => {
		// 1 in / 1 out P2PKH at 3 sat/vB = 192 vB = 576 sat; split keeps anything above 444.
		const build = buildUtxoTx(pioneerWith([legacyUtxo(576 + 502)]), BITCOIN, {
			to: LEGACY_TO,
			amount: '0',
			isMax: true,
			xpub: LEGACY_XPUB,
			accountPath: LEGACY_ACCOUNT_PATH,
			scriptTypeOverride: 'p2pkh',
		})
		await expect(build).rejects.toThrow('After fees, the amount to send is below the network dust limit (minimum 0.00000546 BTC)')
	})

	it('refuses a DOGE send under 0.01 DOGE', async () => {
		const DOGE = { id: 'dogecoin', coin: 'Dogecoin', symbol: 'DOGE', networkId: 'bip122:00000000001a91e3dace36e2be3bf030', decimals: 8, scriptType: 'p2pkh' } as any
		const build = buildUtxoTx(pioneerWith([{ ...legacyUtxo(500_000_000), path: "m/44'/3'/0'/0/0" }]), DOGE, {
			to: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L',
			amount: '0.005',
			xpub: LEGACY_XPUB,
			accountPath: [0x80000000 + 44, 0x80000000 + 3, 0x80000000],
			scriptTypeOverride: 'p2pkh',
		})
		await expect(build).rejects.toThrow('(minimum 0.01 DOGE)')
	})
})

// KEEPKEY-162: the limit read segwit only from lower-case bc1/tb1/ltc1/tltc1, so a
// DigiByte dgb1… (any case) got the P2PKH limit (5460) and valid sends were refused.
describe('spend output below the dust limit on other segwit prefixes', () => {
	const DIGIBYTE = { id: 'digibyte', coin: 'DigiByte', symbol: 'DGB', networkId: 'bip122:4da631f2ac1bed857bd968c67c913978', decimals: 8, scriptType: 'p2pkh' } as any
	const DGB_P2WPKH = 'dgb1qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc57rkd6l'
	const DGB_P2TR = 'dgb1pquyqjzstpsxsurcszyfpx9q4zct3sxg6rvwp68slyqsjygeyy5nq3v2qtd'
	const sendDgb = (to: string, amount: number) =>
		buildUtxoTx(pioneerWith([{ ...legacyUtxo(100_000_000), path: "m/44'/20'/0'/0/0" }]), DIGIBYTE, {
			to,
			amount: String(amount / 1e8),
			xpub: LEGACY_XPUB,
			accountPath: [0x80000000 + 44, 0x80000000 + 20, 0x80000000],
			scriptTypeOverride: 'p2pkh',
		})
	const sent = async (to: string, amount: number) =>
		(await sendDgb(to, amount)).outputs.find((o: any) => o.address === to)?.amount

	it('uses the P2WPKH limit (2940) for dgb1q…, in lower and upper case', async () => {
		expect(await sent(DGB_P2WPKH, 2940)).toBe('2940')
		expect(await sent(DGB_P2WPKH.toUpperCase(), 2940)).toBe('2940')
		await expect(sendDgb(DGB_P2WPKH.toUpperCase(), 2939)).rejects.toThrow('(minimum 0.0000294 DGB)')
	})

	it('uses the P2TR limit (3300) for an upper-case dgb1p…', async () => {
		expect(await sent(DGB_P2TR.toUpperCase(), 3300)).toBe('3300')
		await expect(sendDgb(DGB_P2TR.toUpperCase(), 3299)).rejects.toThrow('(minimum 0.000033 DGB)')
	})

	it('keeps the P2PKH limit for a mixed-case address, which is not valid bech32', async () => {
		const mixed = 'DGB1' + DGB_P2WPKH.slice(4)
		await expect(sendDgb(mixed, 5459)).rejects.toThrow('(minimum 0.0000546 DGB)')
	})
})

describe('witnessScriptPubKeyHex', () => {
	it('reads a segwit address of any prefix and case, and nothing else', () => {
		const p2wpkh = '0014' + '0102030405060708090a0b0c0d0e0f1011121314'
		expect(witnessScriptPubKeyHex('dgb1qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc57rkd6l')).toBe(p2wpkh)
		expect(witnessScriptPubKeyHex('DGB1QQYPQXPQ9QCRSSZG2PVXQ6RS0ZQG3YYC57RKD6L')).toBe(p2wpkh)
		expect(witnessScriptPubKeyHex(TO.toUpperCase())).toBe(addressToScriptPubKeyHex(TO))
		expect(witnessScriptPubKeyHex('DGB1qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc57rkd6l')).toBeUndefined()
		expect(witnessScriptPubKeyHex(LEGACY_TO)).toBeUndefined()
	})
})

describe('outputDustLimit', () => {
	it('follows the node formula for each script', () => {
		expect(outputDustLimit('bitcoin', '76a914' + '00'.repeat(20) + '88ac')).toBe(546) // P2PKH
		expect(outputDustLimit('bitcoin', 'a914' + '00'.repeat(20) + '87')).toBe(540) // P2SH
		expect(outputDustLimit('bitcoin', '0014' + '00'.repeat(20))).toBe(294) // P2WPKH
		expect(outputDustLimit('bitcoin', '0020' + '00'.repeat(32))).toBe(330) // P2WSH
		expect(outputDustLimit('bitcoin', '5120' + '00'.repeat(32))).toBe(330) // P2TR
		expect(outputDustLimit('litecoin', '0014' + '00'.repeat(20))).toBe(2940)
	})

	it('takes the P2PKH size for an unreadable script, and 0.01 DOGE on Dogecoin', () => {
		expect(outputDustLimit('bitcoincash', undefined)).toBe(546)
		expect(outputDustLimit('bitcoin', 'zz')).toBe(546)
		expect(outputDustLimit('dogecoin', '0014' + '00'.repeat(20))).toBe(1_000_000)
	})
})

describe('describeDustError', () => {
	const t = (key: string, options: any) => `${key}|${options.minimum}|${options.symbol}`

	it('translates the builder message with a localized, unrounded minimum', () => {
		expect(describeDustError(dustErrorMessage('amount', '0.00000546', 'BTC'), t, 'pt-BR')).toBe('amountBelowDust|0,00000546|BTC')
		expect(describeDustError(dustErrorMessage('maxAfterFees', '0.01', 'DOGE'), t, 'en-US')).toBe('maxBelowDust|0.01|DOGE')
	})

	it('leaves any other error to the caller', () => {
		expect(describeDustError('Insufficient funds: have 0.1, need 1 BTC', t)).toBeNull()
		expect(describeDustError('Amount is below the network dust limit', t)).toBeNull()
	})

	it('prints the minimum without exponent notation', () => {
		expect(formatBaseUnits(294, 8)).toBe('0.00000294')
		expect(formatBaseUnits(1_000_000, 8)).toBe('0.01')
		expect(formatBaseUnits(100_000_000, 8)).toBe('1')
	})
})
