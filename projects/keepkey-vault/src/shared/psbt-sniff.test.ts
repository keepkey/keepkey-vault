import { describe, expect, it } from 'bun:test'
import { looksLikePsbt, looksLikeRawTxHex, looksLikeWatchOnlyImport } from './psbt-sniff'

const enc = (s: string) => new TextEncoder().encode(s)

describe('looksLikePsbt', () => {
	it('recognises binary, base64 and hex PSBTs', () => {
		expect(looksLikePsbt(new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x01, 0x00]))).toBe(true)
		expect(looksLikePsbt(enc('cHNidP8BAHUCAAAAASaBcTce3/KF6Tet'))).toBe(true)
		expect(looksLikePsbt(enc('﻿\n  cHNidP8BAHUC'))).toBe(true)
		expect(looksLikePsbt(enc('70736274ff01007502'))).toBe(true)
		expect(looksLikePsbt(enc('70736274FF0100'))).toBe(true)
	})

	it('rejects everything else', () => {
		expect(looksLikePsbt(new Uint8Array([0x70, 0x73, 0x62, 0x74]))).toBe(false)
		expect(looksLikePsbt(new Uint8Array([0x4b, 0x50, 0x4b, 0x59, 0x00]))).toBe(false) // firmware "KPKY"
		expect(looksLikePsbt(enc('0200000001268171371edff285e937'))).toBe(false) // raw tx hex
		expect(looksLikePsbt(enc('{"wallet_type": "standard"}'))).toBe(false)
		expect(looksLikePsbt(new Uint8Array(0))).toBe(false)
	})
})

describe('looksLikeRawTxHex', () => {
	it('recognises version 1 and 2 transactions as hex text, segwit included', () => {
		expect(looksLikeRawTxHex(enc('0200000001268171371edff285e937'))).toBe(true)
		expect(looksLikeRawTxHex(enc('\n01000000000101aa'))).toBe(true)
	})

	it('rejects PSBTs, binary and other text', () => {
		expect(looksLikeRawTxHex(enc('70736274ff01007502'))).toBe(false)
		expect(looksLikeRawTxHex(new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x01]))).toBe(false)
		expect(looksLikeRawTxHex(enc('02000000 is not a tx'))).toBe(false)
		expect(looksLikeRawTxHex(enc('03000000aabbccdd'))).toBe(false)
	})
})

describe('looksLikeWatchOnlyImport', () => {
	it('recognises Electrum wallet files and extended keys', () => {
		expect(looksLikeWatchOnlyImport(enc('{\n    "addr_history": {'))).toBe(true)
		expect(looksLikeWatchOnlyImport(enc('{"wallet_type": "standard"}'))).toBe(true)
		expect(looksLikeWatchOnlyImport(enc('QklFMQPe3n'))).toBe(true)
		expect(looksLikeWatchOnlyImport(enc('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9x'))).toBe(true)
		expect(looksLikeWatchOnlyImport(enc('\n xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2'))).toBe(true)
	})

	it('leaves PSBTs, raw transactions and old Electrum .txn JSON alone', () => {
		expect(looksLikeWatchOnlyImport(enc('cHNidP8BAHUCAAAAASaBcTce3/KF6Tet'))).toBe(false)
		expect(looksLikeWatchOnlyImport(enc('0200000001268171371edff285e937'))).toBe(false)
		expect(looksLikeWatchOnlyImport(enc('{"complete": true, "final": false, "hex": "0200'))).toBe(false)
		expect(looksLikeWatchOnlyImport(enc('xpub'))).toBe(false)
	})
})
