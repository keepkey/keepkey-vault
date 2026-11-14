import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SwapHistoryRecord } from '../src/shared/types'

// V16: swaps saved before the fix stored Base native ETH as "BASE".
const dir = mkdtempSync(join(tmpdir(), 'vault-swap-native-symbol-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('../src/bun/db')
beforeAll(() => db.initDb())
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

test('a saved swap labelled BASE / ARB for a native coin reads back as ETH', () => {
  const record: SwapHistoryRecord = { id: 'old-base-swap', walletId: 'fixture-wallet', txid: '0xold',
    fromAsset: 'BASE.BASE', toAsset: 'ARB.ARB', fromSymbol: 'BASE', toSymbol: 'ARB', fromChainId: 'base', toChainId: 'arbitrum',
    fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:42161/slip44:60',
    fromAmount: '0.01', quotedOutput: '0.0099', minimumOutput: '0.0098', slippageBps: 100, feeBps: 0, feeOutbound: '0',
    integration: 'relay', memo: '', inboundAddress: '', status: 'completed', createdAt: 1, updatedAt: 1, estimatedTimeSeconds: 60 }
  db.insertSwapHistory(record)
  const stored = db.getSwapHistoryByTxid('0xold', undefined, 'fixture-wallet')!
  expect(stored.fromSymbol).toBe('ETH')
  expect(stored.toSymbol).toBe('ETH')
  // A token row keeps its own symbol.
  db.insertSwapHistory({ ...record, id: 'arb-token', txid: '0xtoken', toCaip: 'eip155:42161/erc20:0x912ce59144191c1204e64559fe8253a0e49e6548', toSymbol: 'ARB' })
  expect(db.getSwapHistoryByTxid('0xtoken', undefined, 'fixture-wallet')!.toSymbol).toBe('ARB')
})
