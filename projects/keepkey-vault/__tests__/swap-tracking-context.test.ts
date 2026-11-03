import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SwapHistoryRecord } from '../src/shared/types'

const dir = mkdtempSync(join(tmpdir(), 'vault-swap-context-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

test('retains the actual sender, custom recipient, base units and solver mode across resume', () => {
  const record: SwapHistoryRecord = { id: 'swap-context', walletId: 'fixture-wallet', txid: '0xfixture',
    fromAsset: 'ETH.ETH', toAsset: 'ETH.USDT', fromSymbol: 'ETH', toSymbol: 'USDT', fromChainId: 'ethereum', toChainId: 'ethereum',
    fromAmount: '0.01', quotedOutput: '25', minimumOutput: '24', slippageBps: 100, feeBps: 30, feeOutbound: '0',
    integration: 'relay', memo: '', inboundAddress: '0xdeposit', status: 'pending', createdAt: 1, updatedAt: 1, estimatedTimeSeconds: 4,
    trackingContext: { fromAddress: '0xsender', toAddress: '0xcustom-recipient', fromAmountBaseUnits: '10000000000000000', relaySolverDeposit: true },
  }
  db.insertSwapHistory(record)
  expect(db.getSwapHistoryByTxid(record.txid, undefined, record.walletId)?.trackingContext).toEqual(record.trackingContext)
  db.closeDb(); db.initDb()
  expect(db.getSwapHistoryByTxid(record.txid, undefined, record.walletId)?.trackingContext).toEqual(record.trackingContext)
  db.insertSwapHistory({ ...record, id: 'legacy', txid: '0xlegacy', trackingContext: undefined })
  expect(db.getSwapHistoryByTxid('0xlegacy', undefined, record.walletId)?.trackingContext).toBeUndefined()
})
