import { afterEach, expect, mock, test } from 'bun:test'
import { getNumberLocale, setNumberLocale } from '../src/mainview/lib/number-locale'

// The panel's RPC transport needs a WebView; this test only calls a pure helper.
mock.module('../src/mainview/lib/rpc', () => ({ rpcRequest: async () => { throw new Error('no RPC in this test') }, onRpcMessage: () => () => {} }))
const { formatNativeValue } = await import('../src/mainview/components/ActivityPanel')

const initial = getNumberLocale()
afterEach(() => setNumberLocale(initial))
const eth = { decimals: 18, symbol: 'ETH' }

// H16: a fee stored as "1.26e-7" is shown as a plain decimal, and its USD value
// comes from the number itself, never from the comma-localized display text.
test.each(['en-US', 'pt-BR', 'de-DE'])('fee 1.26e-7 ETH at $3000 is under a cent in %s', (locale) => {
  setNumberLocale(locale)
  const value = formatNativeValue('1.26e-7', eth, 'app', 3000)!
  expect(value.amount).not.toMatch(/e/i)
  expect(value.usd).toBe('<$0.01')
})

test('a plain decimal fee keeps its USD value', () => {
  setNumberLocale('pt-BR')
  expect(formatNativeValue('0.5', eth, 'app', 3000)?.usd).toBe('$1,500.00')
})

test('scan values in base units still price from the decoded amount', () => {
  expect(formatNativeValue('1500000000000000000', eth, 'scan', 2)).toEqual({ amount: '1.5', usd: '$3.00' })
})
