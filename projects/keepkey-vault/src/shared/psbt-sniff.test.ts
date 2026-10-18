import { describe, expect, it } from 'bun:test'
import { looksLikePsbt } from './psbt-sniff'

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
