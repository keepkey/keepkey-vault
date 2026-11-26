// Real MagiSwapDialog with layout-only mocks; no device, wallet or network.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const translate = (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key
const element = (tag: string) => React.forwardRef<any, any>((props, ref) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'checked', 'title', 'role', 'type', 'tabIndex'].includes(key)))
  return React.createElement(typeof props.as === 'string' ? props.as : tag, { ...attrs, ref }, props.children)
})
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), VStack: element('div'),
  HStack: element('div'), Button: element('button'), Badge: element('span'), Link: element('a'), Image: element('img') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))

// Scripted Bun side.
let capability = 'supported'
let records: any[] = []
let balance = { username: 'vladtest', hive: '0.000', hbd: '0.000' }
const calls: Array<{ method: string; params: any }> = []
const quote = { quoteId: 'q1', provider: 'Magi', route: { from: 'HIVE', to: 'HBD', kind: 'hive-ops' }, username: 'vladtest',
  amountIn: '10.000', expectedOut: '2.400', minOut: '2.388', referralBps: 0, hops: 1, recipient: 'hive:vladtest', simDeferred: true }
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  calls.push({ method, params })
  switch (method) {
    case 'magiCapability': return { capability }
    case 'magiBalance': return balance
    case 'magiRecords': return records
    case 'magiQuote': return quote
    case 'magiExecute': {
      const r = { id: 'r1', username: 'vladtest', from: 'HIVE', to: 'HBD', amountIn: '10.000', minOut: '2.388', recipient: 'hive:vladtest', stage: 'swap-sent', updatedAt: Date.now() }
      records = [r]; balance = { ...balance, hbd: '2.400' }
      return r
    }
    case 'magiBtcDepositAddress': return { address: 'bc1qmagideposit0000000000000000000000000000', username: 'vladtest', assetOut: params.assetOut }
    case 'magiRetry': return { ...records[0], stage: 'swap-sent' }
    case 'btcGetAddress': return { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }
  }
  throw new Error(`Unexpected RPC: ${method}`)
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in Magi fixture') }) as typeof fetch

const { createRoot } = await import('react-dom/client')
const { MagiSwapDialog } = await import('../../src/mainview/components/MagiSwapDialog')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const settle = async (ms = 0) => { await React.act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const render = async (node: React.ReactNode) => { await React.act(async () => root.render(node)); await settle() }
const button = (label: string | RegExp) => [...container.querySelectorAll('button')].find(node => typeof label === 'string' ? node.textContent === label : label.test(node.textContent || ''))
const click = async (label: string | RegExp) => {
  const b = button(label); expect(b).toBeDefined(); expect(b!.disabled).toBe(false)
  await React.act(async () => b!.click()); await settle()
}
const type = async (value: string) => {
  const input = container.querySelector('input')!
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  await React.act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
  await settle(700) // quote debounce
}
const methods = () => calls.map(c => c.method)
const result: Record<string, boolean> = {}

// 1. Firmware without HiveSignOperations: quote shows, swap stays blocked, nothing executes.
capability = 'unsupported'
await render(<MagiSwapDialog key="blocked" open onClose={() => {}} initialFrom="HIVE" />)
await type('10')
expect(container.textContent).toContain('Firmware can\'t sign the swap step')
expect(button("Can't swap yet")!.disabled).toBe(true)
expect(methods()).not.toContain('magiExecute')
result.blocked = true

// 2. Supported: the webview sends only the quote id; the HBD output then shows in the Magi balance with a withdrawal.
capability = 'supported'; calls.length = 0
await render(<MagiSwapDialog key="ok" open onClose={() => {}} initialFrom="HIVE" />)
await type('10')
expect(container.textContent).toContain('2.388')
await click('Swap on KeepKey')
const exec = calls.find(c => c.method === 'magiExecute')!
expect(exec.params).toEqual({ quoteId: 'q1' })
expect(container.textContent).toContain('Swap sent')
expect(button(/^Withdraw .* HBD to your Hive account$/)).toBeDefined()
result.execute = true

// 3. BTC in: the deposit address (a Magi mapping) is requested only on Continue, then handed to the BTC send form.
calls.length = 0; balance = { username: 'vladtest', hive: '0.000', hbd: '0.000' }; records = []
let sentTo = ''
await render(<MagiSwapDialog key="btc" open onClose={() => {}} initialFrom="BTC" onSendBtc={a => { sentTo = a }} />)
expect(methods()).not.toContain('magiBtcDepositAddress')
expect(container.textContent).toContain('Send a small amount first')
await click('Continue')
expect(calls.find(c => c.method === 'magiBtcDepositAddress')!.params).toEqual({ assetOut: 'HIVE' })
await click('Send BTC from this KeepKey')
expect(sentTo).toBe('bc1qmagideposit0000000000000000000000000000')
result.btcIn = true

// 4. A swap left in the Magi balance offers retry and withdrawal on open.
records = [{ id: 'r2', username: 'vladtest', from: 'HBD', to: 'HIVE', amountIn: '1.000', minOut: '4.000', recipient: 'hive:vladtest', stage: 'needs-attention', attention: 'Your HBD is in your Magi balance.', updatedAt: 1 }]
balance = { username: 'vladtest', hive: '0.000', hbd: '1.000' }; calls.length = 0
await render(<MagiSwapDialog key="attn" open onClose={() => {}} initialFrom="HIVE" />)
expect(container.textContent).toContain('Your HBD is in your Magi balance.')
await click('Try the swap again')
expect(calls.find(c => c.method === 'magiRetry')!.params).toEqual({ id: 'r2' })
result.attention = true

// 5. BTC out: this KeepKey's own address is read without a device display and prefilled.
records = []; calls.length = 0; capability = 'supported'
await render(<MagiSwapDialog key="btcout" open onClose={() => {}} initialFrom="HIVE" />)
const toBtc = [...container.querySelectorAll('button[role="radio"]')].filter(b => b.textContent === 'BTC')[1] as HTMLButtonElement
await React.act(async () => toBtc.click()); await settle()
const read = calls.find(c => c.method === 'btcGetAddress')!
expect(read.params.showDisplay).toBe(false)
expect(read.params.scriptType).toBe('p2wpkh')
expect((container.querySelectorAll('input')[1] as HTMLInputElement).value).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
result.btcOut = true

await React.act(async () => root.unmount())
console.log(JSON.stringify(result))
process.exit(0)
