// The real HiveAccountPanel onboarding wizard driven to a 409 from the sponsor.
// No device, network or Pioneer: rpcRequest is mocked per scenario.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const element = (tag: string) => (props: any) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'placeholder', 'role', 'type'].includes(key)))
  const as = typeof props.as === 'string' ? props.as : tag
  return React.createElement(as, attrs, props.children)
}
mock.module('@chakra-ui/react', () => ({
  Box: element('div'), Flex: element('div'), Text: element('span'), Button: element('button'),
  IconButton: element('button'), Input: element('input'), Spinner: () => null,
}))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => (text: string, values?: Record<string, unknown>) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(values?.[k] ?? '')) }))
mock.module('../../src/mainview/components/AssetIcon', () => ({ AssetIcon: () => null }))
mock.module('../../src/mainview/components/v3/SpinningDevice', () => ({ SpinningDevice: () => null }))

let createResponse: any = null
let accountExists = false
const opened: string[] = []
const PAYERS: Record<string, any> = {
  skatehive: { name: 'skatehive', balance: '10.000 HIVE', pending_claimed_accounts: 0 },
  tokenrich: { name: 'tokenrich', balance: '0.000 HIVE', pending_claimed_accounts: 3 },
}
// Path B: an existing account whose keys live in a browser wallet; weights arrive as strings.
const EXISTING = { name: 'sopadev', balance: '1.000 HIVE', pending_claimed_accounts: 0, memo_key: 'STM8old', json_metadata: '{"profile":{"name":"Sopa"}}',
  owner: { weight_threshold: 1, account_auths: [], key_auths: [['STM5old', 1]] },
  active: { weight_threshold: '1', account_auths: [], key_auths: [['STM6old', '1']] },
  posting: { weight_threshold: 1, account_auths: [['peakd.app', '1'], ['ecency.app', 1]], key_auths: [['STM7old', 1]] } }

const authority = (k: string) => ({ weight_threshold: 1, account_auths: [], key_auths: [[k, 1]] })
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  if (method === 'hiveGetAccount') return accountExists ? { account: { name: 'sopatest', hive: '0.000', hbd: '0.000' } } : { noAccount: true }
  if (method === 'hiveAccountCreationFee') return { fee: '3.000 HIVE' }
  if (method === 'openUrl') { opened.push(params.url); return }
  if (method === 'hiveLookupAccount') {
    if (params.name === 'sopadev') return { found: true, account: (await import('../../src/shared/hive-onboarding')).parseAccountAuthorities(EXISTING) }
    const p = PAYERS[params.name]
    return p ? { found: true, account: { ...p, owner: authority('STMo'), active: authority('STMa'), posting: authority('STMp'), memo_key: 'STMm', json_metadata: '' } } : { found: false }
  }
  if (method === 'hiveGetRoleKeys') return { owner: 'STM1', active: 'STM2', posting: 'STM3', memo: 'STM4' }
  if (method === 'hiveUsernameAvailable') return { success: true, available: true }
  if (method === 'hiveCreateAccount') return createResponse
  throw new Error(`Unexpected RPC: ${method}`)
} }))
globalThis.fetch = (() => { throw new Error('Network forbidden in HiveAccountPanel fixture') }) as typeof fetch

const { act } = React
const { createRoot } = await import('react-dom/client')
const { HiveAccountPanel } = await import('../../src/mainview/components/HiveAccountPanel')
const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

async function run(response: any) {
  createResponse = response
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<HiveAccountPanel activeKey="STM2" color="#E31337" />))
  await settle()
  const input = container.querySelector('input') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, 'sopatest'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle(450) // past the availability debounce
  await click([...container.querySelectorAll('button')].find(b => b.textContent === 'Create account')!)
  await settle()
  const box = container.querySelector('[data-hive-conflict]')
  const useExisting = container.querySelector('[data-hive-use-existing]')
  const result: Record<string, any> = {
    conflict: box?.getAttribute('data-hive-conflict') ?? null,
    message: box?.querySelector('span')?.textContent ?? null,
    nameTaken: (container.textContent || '').includes('That name was just taken'),
    blamesDevice: /this device/i.test(container.textContent || ''),
    offersExisting: !!useExisting,
    opensBring: false,
    choiceShown: !!container.querySelector('[data-hive-selfserve="choose"]'),
  }
  if (useExisting) { await click(useExisting); result.opensBring = !!container.querySelector('[data-hive-selfserve="bring"]') }
  await act(async () => root.unmount())
  container.remove()
  return result
}

async function selfServe(payer: string) {
  createResponse = { status: 409, success: false, error: 'This ETH address or client has already claimed a sponsored Hive account' }
  accountExists = false; opened.length = 0
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<HiveAccountPanel activeKey="STM2" color="#E31337" />))
  await settle()
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  const type = async (el: HTMLInputElement, v: string) => { await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }); await settle(450) }
  await type(container.querySelector('input') as HTMLInputElement, 'sopatest')
  await click([...container.querySelectorAll('button')].find(b => b.textContent === 'Create account')!)
  await settle()
  const choiceShown = !!container.querySelector('[data-hive-selfserve="choose"]')
  await click(container.querySelector('[data-hive-path="pay"]')!)
  const panelShown = choiceShown && !!container.querySelector('[data-hive-selfserve="pay"]')
  const nameField = container.querySelector('[data-hive-field="name"]') as HTMLInputElement
  await type(container.querySelector('[data-hive-field="payer"]') as HTMLInputElement, '@' + payer)
  await settle(450) // name availability + payer lookup debounces
  const sign = container.querySelector('[data-hive-sign]')
  const qr = !!container.querySelector('[data-hive-qr] svg')
  const hivesigner = container.querySelector('[data-hive-open-hivesigner]')
  if (hivesigner) await click(hivesigner)
  const waiting = !!container.querySelector('[data-hive-waiting]')
  accountExists = true
  await settle(3300) // first watcher tick at 3s
  const resolved = (container.textContent || '').includes('@sopatest') && (container.textContent || '').includes('HBD')
  await act(async () => root.unmount())
  container.remove()
  return { panelShown, prefilledName: nameField?.value ?? null, op: sign?.getAttribute('data-hive-sign') ?? null, qr, opened: [...opened], waiting, resolved }
}

async function bring(keepApps: boolean) {
  createResponse = { status: 409, success: false, error: 'This client has already claimed a sponsored Hive account' }
  accountExists = false; opened.length = 0
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<HiveAccountPanel activeKey="STM2" color="#E31337" />))
  await settle()
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
  const type = async (el: HTMLInputElement, v: string) => { await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }); await settle(450) }
  await type(container.querySelector('input') as HTMLInputElement, 'sopatest')
  await click([...container.querySelectorAll('button')].find(b => b.textContent === 'Create account')!)
  await settle()
  await click(container.querySelector('[data-hive-use-existing]')!)
  const bringShown = !!container.querySelector('[data-hive-selfserve="bring"]')
  await type(container.querySelector('[data-hive-field="account"]') as HTMLInputElement, '@SopaDev')
  await settle(50)
  const rows = [...container.querySelectorAll('[data-preflight]')].map(li => li.querySelector('b')?.textContent)
  const text = container.textContent || ''
  if (!keepApps) {
    const appsBox = [...container.querySelectorAll('input[type="checkbox"]')].find(i => i.closest('li')?.textContent?.includes('Apps with posting access')) as HTMLInputElement
    await click(appsBox)
  }
  const sign = container.querySelector('[data-hive-sign]')
  const ownerOffered = !!container.querySelector('details summary')
  await click(container.querySelector('[data-hive-open-hivesigner]')!)
  accountExists = true
  await settle(3300)
  const resolved = (container.textContent || '').includes('HBD')
  await act(async () => root.unmount())
  container.remove()
  return { bringShown, rows, appsListed: text.includes('Keep ecency.app, peakd.app'), op: sign?.getAttribute('data-hive-sign') ?? null, ownerOffered, opened: [...opened], resolved }
}

const out = {
  name: await run({ status: 409, success: false, error: 'Username already registered' }),
  eth: await run({ status: 409, success: false, error: 'This ETH address already has a sponsored Hive account' }),
  client: await run({ status: 409, success: false, error: 'This client has already claimed a sponsored Hive account' }),
  production: await run({ status: 409, success: false, error: 'This ETH address or client has already claimed a sponsored Hive account' }),
  payWithHive: await selfServe('skatehive'),
  payWithToken: await selfServe('tokenrich'),
  bringKeepApps: await bring(true),
  bringDropApps: await bring(false),
}
console.log(JSON.stringify(out))
process.exit(0)
