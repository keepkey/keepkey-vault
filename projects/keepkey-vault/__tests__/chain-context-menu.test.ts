import { describe, expect, test } from 'bun:test'
import { canHideNetwork, nextDisabledNetworks, setNetworkHidden } from '../src/mainview/lib/network-visibility'
import { isContextMenuKey } from '../src/mainview/components/ChainContextMenu'

describe('hiding a chain = turning its network off (one mechanism)', () => {
  test('hide appends once, show removes, order kept', () => {
    expect(nextDisabledNetworks(['solana'], 'ethereum', true)).toEqual(['solana', 'ethereum'])
    expect(nextDisabledNetworks(['solana', 'ethereum'], 'ethereum', true)).toEqual(['solana', 'ethereum'])
    expect(nextDisabledNetworks(['solana', 'ethereum', 'dash'], 'ethereum', false)).toEqual(['solana', 'dash'])
  })

  test('calls setDisabledNetworks, the setting Bun reads through networkOn() to skip fetches', async () => {
    const calls: any[] = []
    const s = await setNetworkHidden(['solana'], 'ripple', true, async (method, params) => { calls.push([method, params]); return { disabledNetworks: params.chainIds } as any })
    expect(calls).toEqual([['setDisabledNetworks', { chainIds: ['solana', 'ripple'] }]])
    expect(s.disabledNetworks).toEqual(['solana', 'ripple'])
  })

  test('bitcoin stays on (Bun drops it from the list too)', async () => {
    expect(canHideNetwork('bitcoin')).toBe(false)
    expect(nextDisabledNetworks([], 'bitcoin', true)).toEqual([])
    let called = false
    await expect(setNetworkHidden([], 'bitcoin', true, async () => { called = true; return {} as any })).rejects.toThrow()
    expect(called).toBe(false)
  })

  test('the menu opens from Shift+F10 and the Menu key', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
    expect(isContextMenuKey({ key: 'Enter', shiftKey: false })).toBe(false)
  })
})

test('chain context menu renders as an ARIA menu: keyboard, Esc, hide via the network setting, always-on bitcoin', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/chain-context-menu-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({ keyboard: true, hide: true, alwaysOn: true, pick: true })
}, 35000)
