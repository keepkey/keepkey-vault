import { describe, expect, it } from 'bun:test'
import { selectZcashCoins } from './zcash-coinselect'

const select = (values: number[], amount: number, max = false, memo?: string) =>
  selectZcashCoins(values.map(value => ({ value })), 'deposit', amount, 5, max, memo)

describe('Zcash swap fee reservation', () => {
  it('builds the exact MAX quote even when exact selection uses fewer inputs', () => {
    const values = [100000, 6000, 6000]
    const max = select(values, 0, true)
    const amount = max.outputs![0].value
    const exact = select(values, amount)
    expect(exact.inputs).toBeDefined()
    expect(exact.outputs![0].value).toBe(amount)
    expect(exact.fee).toBeGreaterThanOrEqual(5000 * Math.max(2, exact.inputs!.length))
  })
  it('selects another input when the byte fee fits but ZIP-317 does not', () => {
    const result = select([100000, 20000], 95000)
    expect(result.inputs).toHaveLength(2)
    expect(result.outputs![0].value).toBe(95000)
    expect(result.fee).toBe(10000)
  })
  it('reserves fees for MAX and round-trips the net amount', () => {
    for (const memo of [undefined, 'swap']) {
      for (const values of [[100000], [100000, 20000], [100000, 20000, 20000]]) {
        const max = select(values, 0, true, memo)
        const exact = select(values, max.outputs![0].value, false, memo)
        expect(exact.outputs![0].value).toBe(max.outputs![0].value)
        expect(exact.fee).toBeGreaterThanOrEqual(5000 * Math.max(2, exact.inputs!.length, exact.outputs!.length + (memo ? 1 : 0)))
      }
    }
  })
  it('does not silently reduce an unaffordable exact deposit', () => {
    expect(select([100000], 95000).inputs).toBeUndefined()
  })

  it('trims a stale fixed amount for a swap deposit', () => {
    const result = selectZcashCoins([{ value: 100000 }], 'deposit', 100000, 5, false, 'swap', true)
    expect(result.outputs![0].value).toBe(90000)
    expect(result.fee).toBe(10000)
  })
})
