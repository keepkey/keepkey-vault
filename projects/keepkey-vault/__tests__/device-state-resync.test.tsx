// useDeviceState re-reads the device state when a launch-time push is lost
// (audit v4 H8: a KeepKey plugged in locked sat on "searching"). Real hook, fake RPC.
import { JSDOM } from 'jsdom'
import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) (globalThis as any)[key] = (dom.window as any)[key]
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let replies: string[] = []
const listeners = new Map<string, (payload: any) => void>()
mock.module('../src/mainview/lib/rpc', () => ({
  rpcRequest: async (method: string) => {
    if (method !== 'getDeviceState') throw new Error(`Unexpected RPC: ${method}`)
    return { state: replies.length > 1 ? replies.shift()! : replies[0] }
  },
  onRpcMessage: (name: string, listener: (payload: any) => void) => { listeners.set(name, listener); return () => listeners.delete(name) },
}))
const { act } = React
const { createRoot } = await import('react-dom/client')
const { useDeviceState } = await import('../src/mainview/hooks/useDeviceState')

function Probe() { return <span>{useDeviceState().state}</span> }
const settle = async (ms = 0) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
async function mount(sequence: string[]) {
  replies = sequence; listeners.clear()
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<Probe />)); await settle()
  return { state: () => container.textContent, push: async (name: string, payload: any) => { await act(async () => listeners.get(name)!(payload)) },
    unmount: async () => { await act(async () => root.unmount()); container.remove() } }
}

describe('device state resync', () => {
  test('a lost needs_pin push is read on the next poll', async () => {
    const view = await mount(['disconnected', 'needs_pin'])
    expect(view.state()).toBe('disconnected')
    await settle(2100)
    expect(view.state()).toBe('needs_pin')
    await view.unmount()
  }, 5000)

  test('a wallet-data-purged push does not end the resync', async () => {
    const view = await mount(['disconnected', 'needs_pin'])
    await view.push('wallet-data-purged', {})
    await settle(2100)
    expect(view.state()).toBe('needs_pin')
    await view.unmount()
  }, 5000)

  test('after a device-state push, a late poll reply cannot undo it', async () => {
    const view = await mount(['disconnected'])
    await view.push('device-state', { state: 'needs_pin' })
    await settle(2100)
    expect(view.state()).toBe('needs_pin')
    await view.unmount()
  }, 5000)
})
