/** Real hook, isolated RPC promises and DOM; no wallet, profile or network. */
import { mock } from 'bun:test'
import { JSDOM } from 'jsdom'
import { pathToFileURL } from 'node:url'
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) (globalThis as any)[key] = (dom.window as any)[key]
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
type Read = { resolve: (value: any) => void; reject: (error: Error) => void }
const reads: Read[] = []
const mutations: Array<Read & { method: string }> = []
const errors: string[] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  if (String(args[0]).startsWith('[useEvmAddresses]')) errors.push(args.join(' '))
  else originalConsoleError(...args)
}
const listeners = new Map<string, Set<(value: any) => void>>()
mock.module('../../src/mainview/lib/rpc', () => ({
  rpcRequest: (method: string) => {
    if (method === 'getEvmAddresses') return new Promise((resolve, reject) => reads.push({ resolve, reject }))
    if (['addEvmAddressIndex', 'removeEvmAddressIndex', 'setEvmSelectedIndex'].includes(method)) {
      return new Promise((resolve, reject) => mutations.push({ method, resolve, reject }))
    }
    throw new Error(`Unexpected RPC: ${method}`)
  },
  onRpcMessage: (name: string, listener: (value: any) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(listener)
    return () => listeners.get(name)!.delete(listener)
  },
}))
const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const moduleUrl = process.env.EVM_LOADING_HOOK_SOURCE
  ? pathToFileURL(process.env.EVM_LOADING_HOOK_SOURCE).href
  : new URL('../../src/mainview/hooks/useEvmAddresses.ts', import.meta.url).href
const { useEvmAddresses } = await import(moduleUrl)
let latest: ReturnType<typeof useEvmAddresses>
function Fixture({ enabled }: { enabled: boolean }) {
  latest = useEvmAddresses(enabled)
  return <div>{latest.initialLoaded ? 'settled' : 'pending'}:{latest.evmAddresses.addresses[0]?.address || 'empty'}</div>
}
const root = createRoot(document.getElementById('root')!)
const render = async (enabled: boolean) => { await act(async () => root.render(<Fixture enabled={enabled} />)) }
const snapshot = (address: string) => ({ addresses: [{ addressIndex: 0, address, balanceUsd: 1 }], selectedIndex: 0, totalBalanceUsd: 1 })
const current = () => ({ loaded: latest.initialLoaded, address: latest.evmAddresses.addresses[0]?.address || null })
const push = (name: string, value?: unknown) => { for (const listener of listeners.get(name) || []) listener(value) }
const result: Record<string, unknown> = {}
try {
  await render(false)
  result.disabled = { reads: reads.length, ...current() }
  await act(async () => {
    const attempts = [latest.addIndex(), latest.removeIndex(1), latest.selectIndex(1)]
    for (const request of mutations) request.resolve(snapshot('disabled-mutation'))
    await Promise.all(attempts)
  })
  result.disabledMutationCalls = mutations.length
  mutations.length = 0
  await render(true)
  result.initialPending = { reads: reads.length, ...current() }
  await act(async () => { reads[0].resolve(snapshot('owner-a')) })
  result.initialSettled = current()

  let first!: Promise<void>, duplicate!: Promise<void>
  await act(async () => { first = latest.refresh(); duplicate = latest.refresh() })
  result.coalesced = reads.length
  await act(async () => {
    push('evm-addresses-update', snapshot('owner-newer-push'))
    reads[1].resolve(snapshot('owner-old-read'))
    await Promise.all([first, duplicate])
  })
  result.pushWins = current()

  let retired!: Promise<void>
  await act(async () => { retired = latest.refresh() })
  await render(false)
  result.disabledAgain = current()
  await render(true)
  await act(async () => { reads[3].resolve(snapshot('owner-reenabled')) })
  await act(async () => { reads[2].resolve(snapshot('owner-retired')); await retired })
  result.generationWins = current()

  let purged!: Promise<void>
  await act(async () => { purged = latest.refresh() })
  await act(async () => { push('wallet-data-purged'); reads[4].resolve(snapshot('owner-before-purge')); await purged })
  result.purged = current()
  await act(async () => { push('evm-addresses-update', snapshot('owner-current')) })
  let failed!: Promise<unknown>
  await act(async () => { failed = latest.refresh().catch((error: Error) => error.message) })
  await act(async () => { reads[5].reject(new Error('Synthetic device busy')); await failed })
  result.failureKeepsSnapshot = { ...current(), failure: await failed }

  // Responses from both mutation methods must not resurrect the purged wallet.
  let purgedAdd!: Promise<void>, purgedRemove!: Promise<void>
  await act(async () => { purgedAdd = latest.addIndex(1); purgedRemove = latest.removeIndex(1) })
  result.addPending = latest.loading
  await act(async () => { push('wallet-data-purged') })
  result.purgedMutationPending = { ...current(), loading: latest.loading }
  await act(async () => {
    mutations[0].resolve(snapshot('owner-purged-add'))
    mutations[1].resolve(snapshot('owner-purged-remove'))
    await Promise.all([purgedAdd, purgedRemove])
  })
  result.purgedMutations = { ...current(), loading: latest.loading }

  // A newer pushed snapshot also wins without a wallet/generation transition.
  let pushedAdd!: Promise<void>, pushedRemove!: Promise<void>
  await act(async () => { pushedAdd = latest.addIndex(2); pushedRemove = latest.removeIndex(2) })
  await act(async () => {
    push('evm-addresses-update', snapshot('owner-newer-mutation-push'))
    mutations[2].resolve(snapshot('owner-old-add'))
    mutations[3].resolve(snapshot('owner-old-remove'))
    await Promise.all([pushedAdd, pushedRemove])
  })
  result.pushBeatsMutations = { ...current(), loading: latest.loading }

  let disabledAdd!: Promise<void>, disabledRemove!: Promise<void>, disabledSelect!: Promise<void>
  await act(async () => { disabledAdd = latest.addIndex(3); disabledRemove = latest.removeIndex(3); disabledSelect = latest.selectIndex(3) })
  await render(false)
  result.disabledMutationPending = { ...current(), loading: latest.loading }
  await act(async () => {
    const selection = latest.selectIndex(4)
    // Drain even a faulty implementation so the assertions report the extra RPC.
    if (mutations[7]) mutations[7].resolve(undefined)
    await selection
  })
  result.disabledSelectionCalls = mutations.filter(request => request.method === 'setEvmSelectedIndex').length
  mutations.splice(7)
  await render(true)
  await act(async () => { reads[6].resolve(snapshot('owner-after-mutation-reenable')) })
  let currentAdd!: Promise<void>
  await act(async () => { currentAdd = latest.addIndex(5) })
  await act(async () => {
    mutations[4].resolve(snapshot('owner-disabled-add'))
    mutations[5].resolve(snapshot('owner-disabled-remove'))
    mutations[6].reject(new Error('Retired selection failure'))
    await Promise.all([disabledAdd, disabledRemove, disabledSelect])
  })
  result.reenabledMutations = { ...current(), loading: latest.loading, errors: [...errors] }
  await act(async () => { mutations[7].resolve(snapshot('owner-current-add')); await currentAdd })
  result.currentMutation = { ...current(), loading: latest.loading }

  let retiredErrorAdd!: Promise<void>, retiredErrorRemove!: Promise<void>
  await act(async () => { retiredErrorAdd = latest.addIndex(6); retiredErrorRemove = latest.removeIndex(6) })
  await act(async () => {
    push('wallet-data-purged')
    mutations[8].reject(new Error('Retired add failure'))
    mutations[9].reject(new Error('Retired remove failure'))
    await Promise.all([retiredErrorAdd, retiredErrorRemove])
  })
  result.retiredErrors = { ...current(), loading: latest.loading, errors: [...errors] }

  let currentErrorAdd!: Promise<void>
  await act(async () => { currentErrorAdd = latest.addIndex(7) })
  await act(async () => { mutations[10].reject(new Error('Current add failure')); await currentErrorAdd })
  result.currentError = { loading: latest.loading, errors: [...errors] }

  let unmounted!: Promise<void>
  let unmountedAdd!: Promise<void>, unmountedRemove!: Promise<void>
  await act(async () => { unmounted = latest.refresh(); unmountedAdd = latest.addIndex(8); unmountedRemove = latest.removeIndex(8) })
  await act(async () => root.unmount())
  await act(async () => {
    reads[7].resolve(snapshot('owner-after-unmount'))
    mutations[11].resolve(snapshot('owner-unmounted-add'))
    mutations[12].reject(new Error('Unmounted remove failure'))
    await Promise.all([unmounted, unmountedAdd, unmountedRemove])
  })
  result.unmounted = true
  result.unmountedErrors = [...errors]
} finally {
  console.error = originalConsoleError
  dom.window.close()
}
console.log(JSON.stringify(result))
