// KEEPKEY-179 (Audit v7 S13): the real PasskeysView with the Portuguese catalogs, scripted
// RPC replies and errors thrown with the English text the bun side sends. No device.
import { JSDOM } from 'jsdom'
import { mock } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { messageKey } from '../../src/shared/message-key'
import { DEVICE_BUSY, passkeyErrorMessage } from '../../src/shared/passkey-errors'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const locales = join(import.meta.dir, '../../src/mainview/i18n/locales')
const catalog = (ns: string) => JSON.parse(readFileSync(join(locales, 'pt', `${ns}.json`), 'utf8'))
const ui = catalog('ui'), device = catalog('device')
const fill = (text: string, values: Record<string, unknown> = {}) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(values[k]))
// Same lookup as i18next with the English fallback: a missing pt text shows in English.
const uiText = (text: string, values?: Record<string, unknown>) => fill(ui[messageKey(text)] ?? text, values)
const t = (key: string, options: Record<string, unknown> = {}) => {
  const value = key.split('.').reduce((o: any, k) => o?.[k], options.ns === 'device' ? device : {})
  return typeof value === 'string' ? fill(value, options) : key
}

const element = (tag: string) => (props: any) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'placeholder', 'role', 'type'].includes(key)))
  return React.createElement(tag, attrs, props.children)
}
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span'), Button: element('button'), Input: element('input') }))
mock.module('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt' } }) }))
mock.module('../../src/mainview/i18n/ui', () => ({ useUiTranslation: () => uiText }))

type Reply = (params: any) => unknown
const replies: Record<string, Reply> = {}
const fail = (message: string): Reply => () => { throw new Error(message) }
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params?: any) => {
  const reply = replies[method]
  if (!reply) throw new Error(`Unexpected RPC: ${method}`)
  return reply(params)
} }))

const { act } = React
const { createRoot } = await import('react-dom/client')
const { PasskeysView } = await import('../../src/mainview/components/PasskeysView')

let container: HTMLDivElement, root: ReturnType<typeof createRoot>
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const text = () => container.textContent || ''
const alert = () => container.querySelector('[role="alert"]')?.textContent ?? ''
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)
const press = async (label: string) => {
  const node = button(label); if (!node) throw new Error(`No button "${label}" in: ${text()}`)
  await act(async () => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }); await settle()
}
const type = async (value: string) => {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  }); await settle()
}
const mount = async () => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root.render(<PasskeysView />)); await settle()
}
const unmount = async () => { await act(async () => root.unmount()); container.remove() }

const status = { available: true, deviceVersion: '7.17.0', ctapVersions: ['FIDO_2_0'], aaguid: '', discoverable: true, credMgmt: true, pinSet: true, pinRetries: 8 }
const slot = { rpHash: 'ab'.repeat(32), userName: 'eu@exemplo.com', credentialId: 'cd'.repeat(64), label: '', labelSource: 'unknown' }
const out: Record<string, unknown> = {}

// No FIDO interface: the status call fails with the bun side's English text.
replies.passkeysStatus = fail(passkeyErrorMessage('noDevice'))
await mount()
out.noDevice = alert()
await unmount()

// PIN set: a wrong PIN, then the list.
replies.passkeysStatus = () => status
await mount()
out.pinStatus = text().includes('PIN da chave de segurança: definido (8 tentativas restantes)')
replies.passkeysList = fail(passkeyErrorMessage('pinInvalid'))
await type('1234'); await press('Mostrar chaves de acesso')
out.pinInvalid = alert()
replies.passkeysList = () => ({ used: 1, remaining: 3, slots: [slot] })
await type('1234'); await press('Mostrar chaves de acesso')
out.list = ['1 de 4 espaços usados', 'Site desconhecido', 'Renomear', 'Vazio'].every(s => text().includes(s))

// Deleting while Desktop is talking to the KeepKey, then an unexpected status byte.
replies.passkeysDelete = fail(DEVICE_BUSY)
await press('Excluir'); await press('Excluir')
out.busy = alert()
replies.passkeysDelete = fail(passkeyErrorMessage('status', { code: '0x2b' }))
await press('Excluir'); await press('Excluir')
out.unexpectedCode = alert()

// Erase all: the confirmation, then the KeepKey declines it.
await press('Apagar todas as chaves de acesso…')
out.eraseConfirm = text().includes('Apagar todas as chaves de acesso deste KeepKey?')
replies.passkeysReset = fail(passkeyErrorMessage('resetDeclined'))
await press('Apagar chaves de acesso')
out.resetDeclined = alert()

// Anything that is not a passkey error is shown as it came.
replies.passkeysList = fail('socket hang up')
await press('Atualizar')
out.other = alert()
await unmount()

console.log(JSON.stringify(out))
