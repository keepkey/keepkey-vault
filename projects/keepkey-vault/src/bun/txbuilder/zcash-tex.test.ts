import { describe, expect, it } from 'bun:test'
import {
	EPHEMERAL_GAP_LIMIT, decodeTexAddress, emptyTexState, encodeTransparentP2pkh, ephemeralPath,
	isTexAddress, p2pkhScript, parseTexState, pendingTexRecords, reserveEphemeral, texPayout,
	texStateKey, texStep2Fee, updateTexRecord,
} from './zcash-tex'

// ZIP-320 test vector: the TEX form of a mainnet P2PKH address.
const T1 = 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC'
const TEX = 'tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte'

describe('TEX decoding (ZIP-320)', () => {
	it('decodes the ZIP-320 vector to the same hash as its t1 address', () => {
		const hash = decodeTexAddress(TEX)
		expect(hash).toHaveLength(20)
		expect(encodeTransparentP2pkh(hash)).toBe(T1)
		expect(p2pkhScript(hash)).toMatch(/^76a914[0-9a-f]{40}88ac$/)
		expect(decodeTexAddress(TEX.toUpperCase())).toEqual(hash)
	})

	it('rejects a bad checksum, mixed case and testnet on mainnet', () => {
		expect(() => decodeTexAddress(TEX.slice(0, -1) + 'q')).toThrow('checksum')
		expect(() => decodeTexAddress('Tex1' + TEX.slice(4))).toThrow('case')
		expect(() => decodeTexAddress('textest1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte')).toThrow('Testnet')
		expect(() => decodeTexAddress(T1)).toThrow()
	})

	it('recognises TEX-shaped input', () => {
		expect(isTexAddress(` ${TEX} `)).toBe(true)
		expect(isTexAddress('textest1abc')).toBe(true)
		expect(isTexAddress(T1)).toBe(false)
		expect(isTexAddress('u1abc')).toBe(false)
	})
})

describe('two-transaction plan', () => {
	it('funds the one-time address with payment + step-2 fee', () => {
		expect(texStep2Fee(1)).toBe(10_000)
		expect(texStep2Fee(3)).toBe(15_000)
		const record = { funding: [{ txid: 'aa', vout: 0, value: 1_010_000 }] }
		expect(texPayout(record)).toEqual({ value: 1_000_000, fee: 10_000 })
		expect(() => texPayout({ funding: [{ txid: 'aa', vout: 0, value: 10_000 }] })).toThrow()
	})

	it('derives ephemeral paths on the ZIP-320 change index 2', () => {
		expect(ephemeralPath(0, 7)).toEqual([0x8000002c, 0x80000085, 0x80000000, 2, 7])
	})
})

describe('ephemeral index allocation', () => {
	const reserve = (s: ReturnType<typeof emptyTexState>) =>
		reserveEphemeral(s, { tex: TEX, amount: 1, account: 0, now: 0 })

	it('hands out increasing indexes and never reuses one', () => {
		let state = emptyTexState()
		const indexes: number[] = []
		for (let i = 0; i < 3; i++) {
			const r = reserve(state)
			state = updateTexRecord(r.state, r.record.index, { status: 'paid' })
			indexes.push(r.record.index)
		}
		expect(indexes).toEqual([0, 1, 2])
		// A finished payment does not free its index.
		expect(reserve(state).record.index).toBe(3)
	})

	it('stops at the gap limit of unfunded reservations', () => {
		let state = emptyTexState()
		for (let i = 0; i < EPHEMERAL_GAP_LIMIT; i++) state = reserve(state).state
		expect(() => reserve(state)).toThrow('reserved without being funded')
		// Funding the newest reservation reopens the window.
		state = updateTexRecord(state, EPHEMERAL_GAP_LIMIT - 1, { status: 'funded' })
		expect(reserve(state).record.index).toBe(EPHEMERAL_GAP_LIMIT)
	})

	it('round-trips through storage and refuses corrupt state', () => {
		const { state } = reserve(emptyTexState())
		expect(parseTexState(JSON.stringify(state))).toEqual(state)
		expect(parseTexState(null)).toEqual(emptyTexState())
		expect(() => parseTexState('{"records":[]}')).toThrow('corrupt')
		expect(texStateKey('u1abc')).toBe('zcash_tex_v1:u1abc')
	})
})

describe('retry state', () => {
	it('keeps a payment pending when step 2 fails after step 1 broadcast', () => {
		let { state, record } = reserveEphemeral(emptyTexState(), { tex: TEX, amount: 1_000_000, account: 0, now: 0 })
		expect(pendingTexRecords(state)).toHaveLength(0)
		state = updateTexRecord(state, record.index, {
			status: 'funded',
			funding: [{ txid: 'ab'.repeat(32), vout: 0, value: 1_010_000 }],
		})
		state = updateTexRecord(state, record.index, { error: 'All nodes rejected the transaction' })
		const pending = pendingTexRecords(state)
		expect(pending).toHaveLength(1)
		expect(pending[0].error).toContain('rejected')
		expect(texPayout(pending[0]).value).toBe(1_000_000)

		// Completing (or shielding back) clears it.
		expect(pendingTexRecords(updateTexRecord(state, record.index, { status: 'paid', error: undefined }))).toHaveLength(0)
		expect(pendingTexRecords(updateTexRecord(state, record.index, { status: 'returned' }))).toHaveLength(0)
	})
})
