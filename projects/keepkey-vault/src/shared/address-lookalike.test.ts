import { describe, expect, test } from 'bun:test'
import { looksAlike, lookalikeOf } from './address-lookalike'

const REAL = '0x1a6aaE5495962C8F04f4A069a4cf59006416c541'
// Same first/last hex as REAL, different middle: what a poisoner grinds.
const swap = (prefix: number, suffix: number) =>
  '0x' + REAL.slice(2, 2 + prefix) + 'f'.repeat(40 - prefix - suffix).replace(/^./, c => (REAL[2 + prefix] === 'f' ? 'e' : c)) + REAL.slice(42 - suffix)

describe('looksAlike', () => {
  test('ground look-alikes are caught: 4+4, 3+5, 2+6', () => {
    expect(looksAlike(swap(4, 4), REAL)).toBe(true)
    expect(looksAlike(swap(3, 5), REAL)).toBe(true)
    expect(looksAlike(swap(2, 6), REAL)).toBe(true)
  })
  test('the same address in another case is not a look-alike', () => {
    expect(looksAlike(REAL.toLowerCase(), REAL)).toBe(false)
  })
  test('matching only one end, or too little in total, is not flagged', () => {
    expect(looksAlike(swap(6, 0), REAL)).toBe(false)
    expect(looksAlike(swap(0, 6), REAL)).toBe(false)
    expect(looksAlike(swap(2, 3), REAL)).toBe(false)
  })
  test('unrelated real addresses are not flagged', () => {
    expect(looksAlike('0x9768236c72F2EddE1A46aff6c1D85f5E252E6183', REAL)).toBe(false)
  })
  test('lookalikeOf returns the known entry it resembles', () => {
    const known = [{ address: '0x9768236c72F2EddE1A46aff6c1D85f5E252E6183', name: 'Guilliman' }, { address: REAL, name: 'Aurelian' }]
    expect(lookalikeOf(swap(4, 4), known)?.name).toBe('Aurelian')
    expect(lookalikeOf(REAL, known)).toBeUndefined()
  })
})
