// Real ChainContextMenu in jsdom with layout-only Chakra mocks; the hide item
// goes through the real network-visibility helper with a recording RPC.
import { JSDOM } from 'jsdom'
import { expect, mock } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  ;(globalThis as any)[key] = key === 'window' ? dom.window : (dom.window as any)[key]
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const element = (tag: string) => React.forwardRef<any, any>((props, ref) => {
  const attrs = Object.fromEntries(Object.entries(props).filter(([key]) => /^(on[A-Z]|aria-|data-)/.test(key)
    || ['value', 'disabled', 'checked', 'title', 'role', 'type', 'tabIndex', 'style'].includes(key)))
  return React.createElement(typeof props.as === 'string' ? props.as : tag, { ...attrs, ref }, props.children)
})
mock.module('@chakra-ui/react', () => ({ Box: element('div'), Flex: element('div'), Text: element('span') }))
const rpcCalls: Array<{ method: string; params: any }> = []
mock.module('../../src/mainview/lib/rpc', () => ({ rpcRequest: async (method: string, params: any) => {
  rpcCalls.push({ method, params })
  if (method === 'setDisabledNetworks') return { disabledNetworks: params.chainIds }
  throw new Error(`Unexpected RPC: ${method}`)
} }))

const { createRoot } = await import('react-dom/client')
const { ChainContextMenu } = await import('../../src/mainview/components/ChainContextMenu')
const { canHideNetwork, setNetworkHidden } = await import('../../src/mainview/lib/network-visibility')

const container = document.createElement('div'); document.body.appendChild(container)
const row = document.createElement('button'); row.textContent = 'Ethereum'; document.body.appendChild(row)
const root = createRoot(container)
const settle = async () => { await React.act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const items = () => [...container.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
const key = async (k: string, init: KeyboardEventInit = {}) => {
  await React.act(async () => { (document.activeElement as HTMLElement).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, ...init })) })
  await settle()
}
const result: Record<string, boolean> = {}

let disabled = ['solana']
const refreshed: string[] = []
let mounts = 0
function Host({ chainId }: { chainId: string }) {
  const [open, setOpen] = React.useState(true)
  if (!open) return <div />
  const hideable = canHideNetwork(chainId)
  return (
    <ChainContextMenu x={40} y={60} label={chainId} returnFocusTo={row} onClose={() => setOpen(false)}
      items={[
        { key: 'refresh', label: 'Refresh balance', onSelect: () => { refreshed.push(chainId) } },
        { key: 'copy', label: 'Copy address', onSelect: () => {} },
        hideable
          ? { key: 'hide', label: 'Hide chain', onSelect: () => { setNetworkHidden(disabled, chainId, true).then(s => { disabled = s.disabledNetworks }) } }
          : { key: 'hide', label: 'Hide chain', onSelect: () => { throw new Error('must not run') }, disabled: true, hint: 'Always on' },
      ]} />
  )
}
const renderMenu = async (chainId: string) => {
  await React.act(async () => root.render(<Host key={++mounts} chainId={chainId} />))
  await settle()
}

// 1. Opens as an ARIA menu with focus on the first item; arrows wrap; Esc closes and returns focus to the row.
await renderMenu('ethereum')
expect(container.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('ethereum')
expect(document.activeElement?.textContent).toBe('Refresh balance')
await key('ArrowUp'); expect(document.activeElement?.textContent).toBe('Hide chain')
await key('ArrowDown'); expect(document.activeElement?.textContent).toBe('Refresh balance')
await key('End'); expect(document.activeElement?.textContent).toBe('Hide chain')
await key('Escape')
expect(container.querySelector('[role="menu"]')).toBeNull()
expect(document.activeElement).toBe(row)
result.keyboard = true

// 2. Hide goes through setDisabledNetworks with the chain added to the existing list (no UI-only state).
rpcCalls.length = 0
await renderMenu('ethereum')
await React.act(async () => items().find(i => i.textContent === 'Hide chain')!.click()); await settle()
expect(rpcCalls).toEqual([{ method: 'setDisabledNetworks', params: { chainIds: ['solana', 'ethereum'] } }])
expect(disabled).toEqual(['solana', 'ethereum'])
expect(container.querySelector('[role="menu"]')).toBeNull()
result.hide = true

// 3. Bitcoin can't be turned off: the item is disabled, skipped by the arrows, and a click does nothing.
rpcCalls.length = 0
await renderMenu('bitcoin')
const hide = items().find(i => i.textContent?.startsWith('Hide chain'))!
expect(hide.getAttribute('aria-disabled')).toBe('true')
expect(hide.textContent).toContain('Always on')
await key('ArrowDown'); await key('ArrowDown')
expect(document.activeElement?.textContent).toBe('Refresh balance') // wrapped past the disabled item
await React.act(async () => hide.click()); await settle()
expect(rpcCalls).toHaveLength(0)
expect(container.querySelector('[role="menu"]')).not.toBeNull()
result.alwaysOn = true

// 4. Enter on a focused item picks it; an outside press closes without picking.
await key('Enter')
expect(refreshed).toEqual(['bitcoin'])
await renderMenu('dash')
await React.act(async () => { document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })) }); await settle()
expect(container.querySelector('[role="menu"]')).toBeNull()
expect(refreshed).toEqual(['bitcoin'])
result.pick = true

await React.act(async () => root.unmount())
console.log(JSON.stringify(result))
process.exit(0)
