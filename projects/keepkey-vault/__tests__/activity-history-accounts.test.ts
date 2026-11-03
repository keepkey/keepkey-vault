import { expect, mock, test } from 'bun:test'
import { CHAINS } from '../src/shared/chains'
import { createTxWatch } from '../src/bun/tx-watch'

// Isolated suite with an in-memory provider. No USB, renderer, DB or network.
const requests: Array<{ body: any; options: any }> = []
mock.module('../src/bun/db', () => ({ apiLogScanTxidExists: () => false, insertApiLog: () => { throw new Error('No DB writes in dry run') }, updateApiLogTxMeta: () => { throw new Error('No DB writes in dry run') } }))
mock.module('../src/bun/engine-controller', () => ({ withTimeout: async (promise: Promise<any>) => promise }))
mock.module('../src/bun/pioneer', () => ({ getPioneer: async () => ({ GetTransactionHistory: async (body: any, options: any) => {
  requests.push({ body, options })
  return { data: { histories: [{ transactions: body.queries[0].pubkey === 'p2sh-p2wpkh:49:0' ? [{ txid: 'wrapped-send', confirmations: 1, direction: 'outgoing', value: '0.1', timestamp: 1700000000 }] : [] }] } }
} }) }))
const { deriveHistoryQueries, rebuildActivityHistory, clearHistoryQueryCache } = await import('../src/bun/activity-history')
const ltc = CHAINS.find(chain => chain.id === 'litecoin')!
const bitcoin = CHAINS.find(chain => chain.id === 'bitcoin')!
const wallet = { getPublicKeys: async (paths: any[]) => paths.map(path => ({ xpub: `${path.scriptType}:${path.addressNList[0] - 0x80000000}:${path.addressNList[2] - 0x80000000}` })) }

test('Litecoin history scans standard account scripts and historical native SegWit on the selected account', async () => {
  const queries = await deriveHistoryQueries(wallet, ltc, 3)
  expect(queries.map(query => [query.scriptType, query.path])).toEqual([
    ['p2pkh', "m/44'/2'/3'"], ['p2sh-p2wpkh', "m/49'/2'/3'"], ['p2wpkh', "m/84'/2'/3'"], ['p2wpkh', "m/44'/2'/3'"],
  ])
  expect(new Set(queries.map(query => query.pubkey)).size).toBe(4)
})

test('a wrapped Litecoin send reaches confirmation tracking through four forced history queries', async () => {
  clearHistoryQueryCache(); requests.length = 0
  let tick!: () => void
  const confirmations: string[] = []
  const watcher = createTxWatch({ scanChain: async () => (await rebuildActivityHistory({ wallet, chains: [ltc], scope: { deviceId: 'fixture', walletId: 'fixture:wallet' },
    options: { chainId: 'litecoin', forceRefresh: true, dryRun: true, collectRows: true } })).rows || [],
    onConfirmed: chain => confirmations.push(chain), requiredConfs: () => 1,
    setTimer: run => { tick = run; return 1 }, clearTimer: () => {},
  })
  watcher.watch('litecoin', 'wrapped-send'); tick()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(requests).toHaveLength(4)
  expect(requests.every(request => request.options?.forceRefresh === true)).toBe(true)
  expect(confirmations).toEqual(['litecoin'])
  expect(watcher.size()).toBe(0)
})

test('Bitcoin Taproot history remains gated by actual device support', async () => {
  expect(await deriveHistoryQueries(wallet, bitcoin, 0)).toHaveLength(3)
  const supported = await deriveHistoryQueries({ ...wallet, btcSupportsScriptType: async () => true }, bitcoin, 0)
  expect(supported).toHaveLength(4)
  expect(supported[3]).toMatchObject({ scriptType: 'p2tr', path: "m/86'/0'/0'", pubkey: 'tr(p2tr:86:0)' })
  expect(await deriveHistoryQueries({ ...wallet, btcSupportsScriptType: async () => { throw new Error('Unsupported') } }, bitcoin, 0)).toHaveLength(3)
})
