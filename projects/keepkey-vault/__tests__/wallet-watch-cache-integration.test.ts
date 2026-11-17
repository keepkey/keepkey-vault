// Evaluate the actual index.ts cache/history callbacks with isolated dependencies.
// Do not import the application entrypoint: no app, wallet, IPC, device or network.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { CHAINS } from '../src/shared/chains'
import { createWalletHistoryRefreshPolicy } from '../src/shared/provider-refresh'
import { BALANCE_CACHE_QUIET_WINDOW_MS } from '../src/shared/balance-cache-policy'
import type { ChainBalance } from '../src/shared/types'

const file = new URL('../src/bun/index.ts', import.meta.url)
const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
let dependencyObject: ts.ObjectLiteralExpression | undefined
function findCallbacks(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'activeWalletWatches') {
    const findRefresh = (child: ts.Node) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'refreshWatchedChain') {
        const argument = child.arguments[1]
        if (argument && ts.isObjectLiteralExpression(argument)) dependencyObject = argument
      }
      ts.forEachChild(child, findRefresh)
    }
    ts.forEachChild(node, findRefresh)
  }
  ts.forEachChild(node, findCallbacks)
}
findCallbacks(source)
if (!dependencyObject) throw new Error('Actual wallet-watch refresh dependencies were not found')

function actualCallback(name: string, dependencies: Record<string, unknown>): (...args: any[]) => any {
  const property = dependencyObject!.properties.find((node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && node.name.getText(source) === name)
  if (!property) throw new Error(`Actual wallet-watch callback ${name} was not found`)
  const javascript = ts.transpileModule(`const callback = ${property.initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(...Object.keys(dependencies), `${javascript}; return callback`)(...Object.values(dependencies))
}

const now = 2 * BALANCE_CACHE_QUIET_WINDOW_MS
const row = (patch: Partial<ChainBalance> = {}): ChainBalance => ({ chainId: 'ethereum', symbol: 'ETH',
  address: '', balance: '1', balanceUsd: 100, updatedAt: now - 1000, ...patch })
function harness(rows: ChainBalance[] = []) {
  let hidden = false
  let scope: { deviceId: string; walletId: string } | undefined = { deviceId: 'fixture-device-A', walletId: 'fixture-wallet-A' }
  const dbReads: string[] = [], scans: any[][] = [], discoveryScopes: string[] = []
  const historyPolicy = createWalletHistoryRefreshPolicy()
  const dependencies = {
    engine: { get isPassphraseWallet() { return hidden } },
    getWalletDbScope: () => scope,
    getCachedBalances: (deviceId: string) => { dbReads.push(deviceId); return { balances: rows } },
    getAllChains: () => CHAINS,
    activitySessionEpoch: 7,
    walletHistoryRefreshReason: (walletScope: string, networkId: string) => {
      discoveryScopes.push(walletScope); return historyPolicy(walletScope, networkId)
    },
    scanOneChain: async (...args: any[]) => { scans.push(args); return { rows: [], added: 0, updated: 0 } },
  }
  return { read: actualCallback('readCachedBalance', dependencies), history: actualCallback('scanHistory', dependencies),
    dbReads, scans, discoveryScopes, hide: () => { hidden = true }, setScope: (value: typeof scope) => { scope = value } }
}

describe('actual wallet-watch cache wiring', () => {
  test('only the current standard-wallet scope supplies its requested cached chain', () => {
    const eth = row(), btc = row({ chainId: 'bitcoin' })
    const h = harness([eth, btc])
    expect(h.read('ethereum')).toBe(eth)
    h.setScope({ deviceId: 'fixture-device-B', walletId: 'fixture-wallet-B' })
    expect(h.read('bitcoin')).toBe(btc)
    expect(h.dbReads).toEqual(['fixture-device-A', 'fixture-device-B'])
    expect(h.read('missing-chain')).toBeUndefined()
    h.setScope(undefined)
    expect(h.read('ethereum')).toBeUndefined()
    expect(h.dbReads).toHaveLength(3)
  })

  test('hidden wallets never read standard-wallet disk balances or use them for history policy', async () => {
    const h = harness([row()]); h.hide()
    expect(h.read('ethereum')).toBeUndefined()
    const current = () => true
    await h.history('ethereum', current)
    expect(h.dbReads).toEqual([])
    expect(h.scans).toEqual([['ethereum', true, current, 'wallet-open']])
  })

  test('existing snapshots keep history cache-only even when expired or transaction-invalidated', async () => {
    for (const snapshot of [row(), row({ updatedAt: now - BALANCE_CACHE_QUIET_WINDOW_MS }),
      row({ txPending: true, syncState: 'stale' }), row({ syncState: 'degraded', updatedAt: 0 })]) {
      const h = harness([snapshot]), current = () => true
      await h.history('ethereum', current)
      expect(h.scans).toEqual([['ethereum', true, current, 'automatic']])
      expect(h.discoveryScopes).toEqual([])
    }
  })

  test('a genuinely missing chain uses the once-per-wallet first-discovery policy', async () => {
    const h = harness([row({ chainId: 'bitcoin' })]), current = () => true
    await h.history('ethereum', current)
    await h.history('base', current)
    expect(h.scans.map(call => call[3])).toEqual(['wallet-open', 'automatic'])
    expect(h.discoveryScopes).toEqual(['7:fixture-wallet-A', '7:fixture-wallet-A'])
    h.setScope({ deviceId: 'fixture-device-B', walletId: 'fixture-wallet-B' })
    await h.history('ethereum', current)
    expect(h.scans.at(-1)).toEqual(['ethereum', true, current, 'wallet-open'])
  })
})

function watchOnlyNoticeHarness() {
  let setView: ts.PropertyAssignment | undefined, refresh: ts.PropertyAssignment | undefined
  const findHandlers = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      if (node.name.getText(source) === 'watchOnlySetView') setView = node
      if (node.name.getText(source) === 'refreshWatchOnlyBalances') refresh = node
    }
    ts.forEachChild(node, findHandlers)
  }
  findHandlers(source)
  if (!setView || !refresh) throw new Error('Actual watch-only handlers were not found')
  let capture: ts.VariableStatement | undefined, notice: ts.IfStatement | undefined
  const findNotice = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'viewRevision')) capture = node
    if (ts.isIfStatement(node)) {
      const identifiers = new Set<string>()
      const collect = (part: ts.Node) => { if (ts.isIdentifier(part)) identifiers.add(part.text); ts.forEachChild(part, collect) }
      collect(node.expression)
      if (['viewRevision', 'watchOnlyViewRevision', 'watchOnlyViewDeviceId', 'deviceId'].every(name => identifiers.has(name))) notice = node
    }
    ts.forEachChild(node, findNotice)
  }
  findNotice(refresh.initializer)
  if (!capture || !notice) throw new Error('Actual watch-only refresh revision capture and notice guard were not found')
  const scopeVariables = ['watchOnlyViewRevision', 'watchOnlyViewDeviceId', 'watchOnlyViewBtcOnly']
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => scopeVariables.includes(declaration.name.getText(source)))
  if (declarations.length !== scopeVariables.length) throw new Error('Actual watch-only scope declarations were not found')
  const pushes: any[] = []
  const snapshots = new Map(['A', 'B'].map(deviceId => [deviceId, { deviceId, featuresJson: '{}' }]))
  const dependencies = {
    getDeviceSnapshotById: (id: string) => snapshots.get(id), getLatestDeviceSnapshot: () => snapshots.get('A'),
    bitcoinOnlyWatchOnlyScope: () => false, setBtcNodeWatchOnlyEligible: () => {},
    sendPortfolioFault: (payload: unknown) => { pushes.push(payload) }, getPioneerApiBase: () => 'https://fixture.invalid',
    allChains: CHAINS, failedChainIds: new Set(['ethereum']), errorChainIds: new Set(['ethereum']), pubkeys: [{ chainId: 'ethereum' }],
  }
  // Execute the production view handler and final notice guard around a deferred
  // result. Deliberately exclude the network/storage refresh body itself.
  const javascript = ts.transpileModule(`
    ${declarations.map(declaration => `let ${declaration.getText(source)};`).join('\n')}
    const setView = ${setView.initializer.getText(source)};
    const finishRefresh = async (deviceId: string, pending: Promise<void>) => {
      ${capture.getText(source)}
      await pending;
      ${notice.getText(source)}
    };
    const fixture = { setView, finishRefresh };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const actual = new Function(...Object.keys(dependencies), `${javascript}; return fixture`)(...Object.values(dependencies))
  let resolve!: () => void
  const pending = new Promise<void>(yes => { resolve = yes })
  return { ...actual, pushes, pending, resolve }
}

describe('actual watch-only refresh notices stay in their view scope', () => {
  test('a deferred A refresh cannot publish its full snapshot after switching to B', async () => {
    const h = watchOnlyNoticeHarness()
    await h.setView({ active: true, deviceId: 'A' })
    const refresh = h.finishRefresh('A', h.pending)
    await h.setView({ active: true, deviceId: 'B' })
    h.resolve(); await refresh
    expect(h.pushes).toEqual([])
  })

  test('a refresh completing in the same active A view publishes the actual notice', async () => {
    const h = watchOnlyNoticeHarness()
    await h.setView({ active: true, deviceId: 'A' })
    const refresh = h.finishRefresh('A', h.pending)
    h.resolve(); await refresh
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0]).toMatchObject({ fullSnapshot: true, severity: 'warning', checkedChainIds: ['ethereum'], degradedChainIds: ['ethereum'] })
  })

  test('leaving and reopening A does not revive an old A refresh revision', async () => {
    const h = watchOnlyNoticeHarness()
    await h.setView({ active: true, deviceId: 'A' })
    const refresh = h.finishRefresh('A', h.pending)
    await h.setView({ active: false })
    await h.setView({ active: true, deviceId: 'A' })
    h.resolve(); await refresh
    expect(h.pushes).toEqual([])
  })

  test('an inactive watch-only view cannot publish a refresh notice', async () => {
    const h = watchOnlyNoticeHarness()
    const refresh = h.finishRefresh('A', h.pending)
    h.resolve(); await refresh
    expect(h.pushes).toEqual([])
  })
})
