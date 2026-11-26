// Real SigningApproval (device-confirm phase) with layout-only mocks: the
// left column must show the KeepKey's own screen for real Hive requests.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const translate = (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback
  : fallback && typeof fallback === 'object' ? key.replace(/\{\{(\w+)\}\}/g, (_, k) => String((fallback as any)[k] ?? '')) : key
const element = (tag: string) => React.forwardRef<any, any>((props, ref) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'checked', 'title', 'role', 'type', 'tabIndex'].includes(key)))
  return React.createElement(typeof props.as === 'string' ? props.as : tag, { ...attrs, ref }, props.children)
})
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), VStack: element('div'),
  HStack: element('div'), Button: element('button'), Badge: element('span'), Link: element('a'), Image: element('img') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => translate }))
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string) => { throw new Error(`Unexpected RPC: ${method}`) } }))
globalThis.fetch = (() => { throw new Error('Network forbidden in signing fixture') }) as typeof fetch
const { createRoot } = await import('react-dom/client')
const { SigningApproval } = await import('../../src/mainview/components/device/SigningApproval')
const container = document.createElement('div'); document.body.appendChild(container)
const root = createRoot(container)
const settle = async () => { await React.act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const noop = () => {}
let n = 0
const render = async (request: any, devicePrompts: number) => {
  await React.act(async () => root.render(<SigningApproval key={++n} request={request} phase="device-confirm" devicePrompts={devicePrompts} onApprove={noop} onReject={noop} onCancel={noop} />))
  await settle()
}
const mirror = () => container.querySelector('[data-device-mirror]') as HTMLElement | null
const screen = () => [...container.querySelectorAll('[data-oled-screen]')].map(el => [...el.children].map(c => c.textContent).join('|'))
const left = () => container.querySelector('.kk-pf-left') as HTMLElement
const result: Record<string, boolean> = {}

// 1. KeepKey Client login (sign-message text): the device's own second screen,
//    in the LEFT column, exact; the message is readable in the details.
await render({ id: 'm1', method: '/hive/sign-message', appName: 'KeepKey Client', rawRequestBody: { message: 'Login to peakd.com 1732600000' } }, 2)
expect(left().querySelector('[data-device-mirror="exact"]')).not.toBeNull()
expect(screen()).toEqual(['Hive Message|Login to peakd.com 1732600000'])
expect(container.textContent).toContain('Screen 2 of 2, as your KeepKey shows it now.')
expect(container.textContent).not.toContain('A sketch, not a readback')
expect(container.textContent).not.toContain('Readable message text is unavailable')
expect(container.querySelector('[data-signing-review-depth]')!.textContent).toContain('Login to peakd.com 1732600000') // details column keeps the field
expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Cancel')).toBe(true)
result.message = true

// 2. Vote: the first ButtonRequest shows the vote screen; the step pills list all three.
await render({ id: 'v1', method: '/hive/sign-operations', appName: 'PeakD', rawRequestBody: { operations: [['vote', { voter: 'vladtest', author: 'skatehive', permlink: 'week-47', weight: 10000 }]] } }, 1)
expect(screen()).toEqual(['Vote|@vladtest -> @skatehive at 100.00%'])
const pills = [...mirror()!.querySelectorAll('button')]
expect(pills.map(p => p.textContent)).toEqual(['1', '2', '3'])
expect(pills[0]!.getAttribute('aria-current')).toBe('step')
// Peeking at a later screen does not move the device's position marker.
await React.act(async () => pills[2]!.click()); await settle()
expect(screen()).toEqual(['Sign Transaction|Sign 1 Hive operation with the posting key?'])
expect(container.textContent).toContain('exactly as your KeepKey firmware draws it')
result.vote = true

// 3. custom_json at its third ButtonRequest: the JSON page itself.
const json = '["follow",{"follower":"vladtest","following":"skatehive","what":["blog"]}]'
await render({ id: 'c1', method: '/hive/sign-operations', appName: 'Ecency', rawRequestBody: { operations: [['custom_json', { required_auths: [], required_posting_auths: ['vladtest'], id: 'follow', json }]] } }, 3)
expect(screen()).toEqual(['Custom JSON|["follow",{"follower":"vladtest","following":"sk|atehive","what":["blog"]}]'])
result.customJson = true

// 4. Not Hive (an Ethereum contract call, 3 confirmations so far): no mirror,
//    but the KeepKey is still the large one in the LEFT column, with one mark
//    per ButtonRequest and a discreet sketch caveat; none on the right.
const contract = { id: 'e1', method: '/eth/sign-transaction', appName: 'swaps.pro', chainId: 1, from: '0x0000000000000000000000000000000000000001',
  to: '0xb2c4000000000000000000000000000000000001', value: '0x0', data: '0x12345678' + '0'.repeat(64) }
await render(contract, 3)
expect(mirror()).toBeNull()
const sketch = container.querySelectorAll('[data-device-sketch]')
expect(sketch).toHaveLength(1)
expect(sketch[0]!.closest('.kk-pf-left')).not.toBeNull()
expect([...sketch[0]!.querySelectorAll('[role="listitem"]')].map(m => [m.textContent, m.getAttribute('aria-current')])).toEqual([['1', null], ['2', null], ['3', 'step']])
expect(sketch[0]!.textContent).toContain('Confirmation 3 on your KeepKey.')
expect(sketch[0]!.textContent).toContain('A sketch, not a readback')
expect(container.querySelector('[data-signing-review-depth]')!.textContent).not.toContain('A sketch, not a readback')
expect(container.textContent).not.toContain('Device confirmation requests')
// Approve phase: the same device on the left, before any confirmation.
await React.act(async () => root.render(<SigningApproval key="approve-eth" request={contract} phase="approve" onApprove={noop} onReject={noop} onCancel={noop} />)); await settle()
expect(container.querySelectorAll('[data-device-sketch]')).toHaveLength(1)
expect(container.querySelector('.kk-pf-left [data-device-sketch]')).not.toBeNull()
result.fallback = true

// 4b. The same contract call as the KeepKey Client sends it (gas and fee
//     fields, AdvancedMode on): the firmware's own three screens, exact, on
//     the third ButtonRequest the calldata's Keccak-256.
await render({ ...contract, id: 'e2', advancedModeEnabled: true, rawRequestBody: { from: contract.from, to: contract.to, value: '0x0', data: contract.data, chainId: 1, gas: '0x30d40', maxFeePerGas: '0x77359400' } }, 3)
expect(container.querySelectorAll('[data-device-sketch]')).toHaveLength(0)
expect(left().querySelector('[data-device-mirror="exact"]')).not.toBeNull()
expect([...mirror()!.querySelectorAll('button')].map(p => p.title)).toEqual(['Send', 'Transaction', 'Ethereum Data Hash'])
expect(screen()[0]!.startsWith('Ethereum Data Hash|')).toBe(true)
expect(container.textContent).toContain('Screen 3 of 3, as your KeepKey shows it now.')
result.ethExact = true

// 5. skatehive.app profile edit, replayed ButtonRequest by ButtonRequest while
//    the dialog is still in its "sending payload" minimum time: the mirror
//    follows every request, and a peek is dropped when the device moves on.
const profile = { id: 'p1', method: '/hive/sign-operations', appName: 'skatehive.app', rawRequestBody: { operations: [['account_update2', {
  account: 'sopadevs', json_metadata: '{"profile":{},"extensions":{"settings":{"voteSettings":{"default_voting_weight":5100,"enable_slider":true}}}}',
  posting_json_metadata: '{"profile":{"name":"sopadevs","profile_image":"https://ipfs.skatehive.app/ipfs/bafkreib3vjph33zmrsw5xpdnvhd7yc26h3i6vykhi6snmfkzr5vjszjohy?filename=skatehive.png","version":2}}', extensions: [] }]] } }
const same = async (phase: 'sending-payload' | 'device-confirm', devicePrompts: number) => {
  await React.act(async () => root.render(<SigningApproval key="profile" request={profile} phase={phase} devicePrompts={devicePrompts} onApprove={noop} onReject={noop} onCancel={noop} />))
  await settle()
}
const title = () => container.querySelector('[data-oled-screen]')!.children[0]!.textContent
const current = () => [...mirror()!.querySelectorAll('button')].filter(b => b.getAttribute('aria-current') === 'step').map(b => b.textContent)
await same('sending-payload', 0)
expect(container.textContent).toContain('Sending payload to device')
const profileTitles = [...mirror()!.querySelectorAll('button')].map(b => b.title)
expect(profileTitles.length).toBeGreaterThan(2)
for (let n = 1; n <= profileTitles.length; n++) {
  await same(n < 4 ? 'sending-payload' : 'device-confirm', n)
  expect(title()).toBe(profileTitles[n - 1]!)
  expect(current()).toEqual([String(n)])
  expect(container.textContent).toContain(`Screen ${n} of ${profileTitles.length}, as your KeepKey shows it now.`)
  expect(container.textContent).toContain('Confirm on your KeepKey')
  if (n === 2) { // peek at the last screen, then the device moves on
    await React.act(async () => [...mirror()!.querySelectorAll('button')].at(-1)!.click()); await settle()
    expect(title()).toBe('Sign Transaction')
  }
}
result.follows = true

// 6. A transfer that may first show a certified-contact screen: a range, not a guess.
const transfer = { id: 't1', method: '/hive/sign-transfer', appName: 'PeakD', rawRequestBody: { from: 'vladtest', to: 'skatehive', amount: 1500, asset_symbol: 'HBD', memo: 'hi' } }
await React.act(async () => root.render(<SigningApproval key="transfer" request={transfer} phase="device-confirm" devicePrompts={2} onApprove={noop} onReject={noop} onCancel={noop} />)); await settle()
expect(container.textContent).toContain('Screen 1–2 of 3: your KeepKey is on one of these now.')
expect(current()).toEqual(['1', '2'])
await React.act(async () => root.render(<SigningApproval key="transfer" request={transfer} phase="device-confirm" devicePrompts={5} onApprove={noop} onReject={noop} onCancel={noop} />)); await settle()
expect(container.textContent).toContain('Your KeepKey asked for more confirmations than these 3 screens. Trust its own screen.')
result.range = true

await React.act(async () => root.unmount())
console.log(JSON.stringify(result))
process.exit(0)
