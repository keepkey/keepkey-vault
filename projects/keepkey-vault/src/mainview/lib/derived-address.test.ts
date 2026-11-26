import { expect, test } from 'bun:test'
import { addressFromDeriveResult } from './derived-address'

test('strings pass through', () => {
	expect(addressFromDeriveResult('0xabc')).toBe('0xabc')
	expect(addressFromDeriveResult('  bc1q  ')).toBe('bc1q')
})

test('{ address } objects', () => {
	expect(addressFromDeriveResult({ address: 'cosmos1x' })).toBe('cosmos1x')
})

test('Hive answers { publicKey } and must not become [object Object]', () => {
	const stm = 'STM6FtXCJQNZi2evfx3Zt6CcP8KRb46Y5CmFSQnw3jYYFR4tFaicN'
	expect(addressFromDeriveResult({ publicKey: stm })).toBe(stm)
})

test('anything else is rejected', () => {
	for (const bad of [null, undefined, '', '   ', 42, {}, { address: 1 }, { publicKey: {} }, []]) {
		expect(addressFromDeriveResult(bad)).toBeNull()
	}
})
