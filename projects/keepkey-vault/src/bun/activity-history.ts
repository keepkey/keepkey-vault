import { withTimeout } from './engine-controller'
import { getPioneer } from './pioneer'
import { apiLogScanTxidExists, insertApiLog, updateApiLogTxMeta } from './db'
import { BTC_SCRIPT_TYPES, btcAccountPath, isChainSupported, type ChainDef } from '../shared/chains'
import type { ActivityType, RecentActivity } from '../shared/types'

const PIONEER_TIMEOUT_MS = 60_000

export type ActivityHistoryScope = {
  deviceId: string
  walletId: string
}

export type ActivityHistoryRebuildOptions = {
  chainId?: string
  chainIds?: string[]
  includeHidden?: boolean
  dryRun?: boolean
  accountIndex?: number
  /** Collect normalized RecentActivity rows into result.rows. Used with dryRun
   *  by hidden (passphrase) sessions: fetch live, return rows, write nothing. */
  collectRows?: boolean
}

type HistoryQuery = {
  caip: string
  pubkey: string
  label: string
  path?: string
  scriptType?: string
}

export type ActivityHistoryChainResult = {
  chainId: string
  symbol: string
  caip: string
  queries: Array<{
    label: string
    pubkeyPreview: string
    path?: string
    scriptType?: string
    txs: number
  }>
  txs: number
  inserted: number
  updated: number
  skippedNoTxid: number
  skippedDuplicate: number
  error?: string
}

export type ActivityHistoryRebuildResult = {
  scope: ActivityHistoryScope & { seedAddress?: string }
  dryRun: boolean
  scannedAt: number
  /** Present only when options.collectRows — normalized rows, never persisted here. */
  rows?: RecentActivity[]
  chains: ActivityHistoryChainResult[]
  totals: {
    chains: number
    queries: number
    txs: number
    inserted: number
    updated: number
    skippedNoTxid: number
    skippedDuplicate: number
    failedChains: number
  }
}

function previewKey(value: string): string {
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}...${value.slice(-6)}`
}

function addressNListToBIP32(addressNList: number[]): string {
  return 'm/' + addressNList.map(n => n >= 0x80000000 ? `${n - 0x80000000}'` : String(n)).join('/')
}

function responseAddress(result: any): string {
  return (typeof result === 'string' ? result : result?.address || '').trim()
}

function normalizeTimestamp(tx: any): number {
  const raw = tx.timestamp ?? tx.blockTime ?? tx.time
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n > 1_000_000_000_000 ? n : n * 1000
}

function normalizeActivityType(tx: any): ActivityType {
  const direction = String(tx.direction || '').toLowerCase()
  if (/(send|sent|out|outgoing|debit|withdraw)/.test(direction)) return 'send'
  if (/(receive|received|in|incoming|credit|deposit)/.test(direction)) return 'receive'
  const value = Number(tx.value)
  return Number.isFinite(value) && value < 0 ? 'send' : 'receive'
}

// Pioneer returns to/from as arrays of addresses (occasionally a string or
// {address} objects). Collapse to one display string: a single address, or
// "addr +N" when a tx fans out to several (common for UTXO change outputs).
function normalizeAddressField(field: any): string | undefined {
  if (!field) return undefined
  const arr = Array.isArray(field) ? field : [field]
  const addrs = arr
    .map(a => (typeof a === 'string' ? a : a?.address || a?.addr || ''))
    .map(s => String(s).trim())
    .filter(Boolean)
  if (addrs.length === 0) return undefined
  if (addrs.length === 1) return addrs[0]
  return `${addrs[0]} +${addrs.length - 1}`
}

function normalizeMeta(tx: any, activityType = normalizeActivityType(tx)) {
  return {
    // Absent ≠ zero: a tx returned by the HISTORY endpoint is already on-chain.
    // Defaulting a missing field to 0 falsely renders "Unconfirmed" (red) forever
    // for chains whose history Pioneer doesn't annotate (e.g. Solana). undefined
    // → the UI shows no confirmation badge rather than a wrong negative claim.
    // A real mempool tx still arrives as an explicit 0 and is preserved.
    confirmations: typeof tx.confirmations === 'number' ? tx.confirmations : undefined,
    blockHeight: tx.blockHeight || tx.block_height || tx.height || 0,
    value: tx.value != null ? String(tx.value) : undefined,
    fee: tx.fee != null ? String(tx.fee) : undefined,
    direction: activityType === 'send' ? 'sent' : 'received',
    // Counterparties Pioneer already provides per tx — previously discarded, so
    // historical/received txs showed no addresses in the detail panel.
    to: normalizeAddressField(tx.to),
    from: normalizeAddressField(tx.from),
  }
}

function unwrapHistoryTransactions(resp: any): any[] {
  const data = resp?.data || resp
  const histories = data?.histories || data?.data?.histories || []
  return histories.flatMap((h: any) => Array.isArray(h?.transactions) ? h.transactions : [])
}

async function deriveHistoryQueries(wallet: any, chain: ChainDef, accountIndex: number): Promise<HistoryQuery[]> {
  if (chain.chainFamily === 'utxo') {
    const paths = chain.id === 'bitcoin'
      ? BTC_SCRIPT_TYPES.map(st => ({
        addressNList: btcAccountPath(st.purpose, accountIndex),
        scriptType: st.scriptType,
        label: `account-${accountIndex}-${st.scriptType}`,
      }))
      : [{
        addressNList: chain.defaultPath.slice(0, 3),
        scriptType: chain.scriptType || 'p2pkh',
        label: `account-${accountIndex}-${chain.scriptType || 'p2pkh'}`,
      }]

    const results = await wallet.getPublicKeys(paths.map(p => ({
      addressNList: p.addressNList,
      curve: 'secp256k1',
      coin: chain.coin,
      scriptType: p.scriptType,
      showDisplay: false,
    })))

    return paths
      .map((p, i) => ({
        caip: chain.caip,
        pubkey: String(results?.[i]?.xpub || ''),
        label: p.label,
        path: addressNListToBIP32(p.addressNList),
        scriptType: p.scriptType,
      }))
      .filter(q => q.pubkey)
  }

  if (chain.chainFamily === 'evm') {
    const result = await wallet.ethGetAddress({
      addressNList: chain.defaultPath,
      showDisplay: false,
      coin: 'Ethereum',
    })
    const pubkey = responseAddress(result)
    return pubkey ? [{
      caip: chain.caip,
      pubkey,
      label: 'default',
      path: addressNListToBIP32(chain.defaultPath),
    }] : []
  }

  const method = chain.id === 'ripple' ? 'rippleGetAddress' : chain.rpcMethod
  if (typeof wallet[method] !== 'function') {
    throw new Error(`Wallet method unavailable: ${method}`)
  }

  const params: any = { addressNList: chain.defaultPath, showDisplay: false, coin: chain.coin }
  if (chain.scriptType) params.scriptType = chain.scriptType
  if (chain.chainFamily === 'ton') params.bounceable = false

  const result = await wallet[method](params)
  const pubkey = responseAddress(result)
  return pubkey ? [{
    caip: chain.caip,
    pubkey,
    label: 'default',
    path: addressNListToBIP32(chain.defaultPath),
    scriptType: chain.scriptType,
  }] : []
}

function selectChains(
  chains: ChainDef[],
  firmwareVersion: string | undefined,
  options: ActivityHistoryRebuildOptions,
): ChainDef[] {
  const requested = new Set([...(options.chainIds || []), ...(options.chainId ? [options.chainId] : [])])
  return chains
    .filter(chain => requested.size === 0 || requested.has(chain.id) || requested.has(chain.symbol))
    .filter(chain => options.includeHidden || !chain.hidden)
    .filter(chain => chain.chainFamily !== 'zcash-shielded')
    .filter(chain => isChainSupported(chain, firmwareVersion))
}

export async function rebuildActivityHistory(params: {
  wallet: any
  scope: ActivityHistoryScope
  chains: ChainDef[]
  firmwareVersion?: string
  options?: ActivityHistoryRebuildOptions
}): Promise<ActivityHistoryRebuildResult> {
  const options = params.options || {}
  const dryRun = !!options.dryRun
  const collected: RecentActivity[] | undefined = options.collectRows ? [] : undefined
  const accountIndex = Math.max(0, Number.isInteger(options.accountIndex) ? options.accountIndex! : 0)
  const selectedChains = selectChains(params.chains, params.firmwareVersion, options)
  const pioneer = await getPioneer()
  const result: ActivityHistoryRebuildResult = {
    scope: {
      ...params.scope,
      seedAddress: params.scope.walletId.includes(':') ? params.scope.walletId.split(':').pop() : undefined,
    },
    dryRun,
    scannedAt: Date.now(),
    chains: [],
    totals: {
      chains: selectedChains.length,
      queries: 0,
      txs: 0,
      inserted: 0,
      updated: 0,
      skippedNoTxid: 0,
      skippedDuplicate: 0,
      failedChains: 0,
    },
  }

  for (const chain of selectedChains) {
    const chainResult: ActivityHistoryChainResult = {
      chainId: chain.id,
      symbol: chain.symbol,
      caip: chain.caip,
      queries: [],
      txs: 0,
      inserted: 0,
      updated: 0,
      skippedNoTxid: 0,
      skippedDuplicate: 0,
    }
    const seenTxids = new Set<string>()

    try {
      const queries = await deriveHistoryQueries(params.wallet, chain, accountIndex)
      result.totals.queries += queries.length

      for (const query of queries) {
        const resp = await withTimeout(
          pioneer.GetTransactionHistory({ queries: [{ pubkey: query.pubkey, caip: query.caip }] }),
          PIONEER_TIMEOUT_MS,
          `GetTransactionHistory(${chain.symbol}:${query.label})`,
        )
        const txs = unwrapHistoryTransactions(resp)
        chainResult.queries.push({
          label: query.label,
          pubkeyPreview: previewKey(query.pubkey),
          path: query.path,
          scriptType: query.scriptType,
          txs: txs.length,
        })
        chainResult.txs += txs.length

        for (const tx of txs) {
          const txid = String(tx.txid || tx.hash || tx.txHash || '').trim()
          if (!txid) {
            chainResult.skippedNoTxid++
            continue
          }
          if (seenTxids.has(txid)) {
            chainResult.skippedDuplicate++
            continue
          }
          seenTxids.add(txid)

          const activityType = normalizeActivityType(tx)
          const timestamp = normalizeTimestamp(tx)
          const route = `history/${chain.id}`
          const meta = {
            ...normalizeMeta(tx, activityType),
            chainId: chain.id,
            chainSymbol: chain.symbol,
            networkId: chain.networkId,
          }
          const exists = apiLogScanTxidExists(txid, params.scope.deviceId, params.scope.walletId)
          if (collected) {
            // Same shape getRecentActivityFromLog produces for SCAN rows, so
            // the frontend renders session rows identically to persisted ones.
            collected.push({
              id: `live-${chain.id}-${txid}`,
              deviceId: params.scope.deviceId,
              walletId: params.scope.walletId,
              txid,
              chain: chain.symbol,
              chainId: chain.id,
              type: activityType,
              source: 'scan',
              status: 'broadcast',
              createdAt: timestamp,
              confirmations: meta.confirmations,
              blockHeight: meta.blockHeight,
              amount: meta.value,
              fee: meta.fee,
              to: meta.to,
              from: meta.from,
            })
          }
          if (!dryRun) {
            if (exists) {
              updateApiLogTxMeta(txid, meta, params.scope.deviceId, params.scope.walletId, {
                activityType,
                chain: chain.symbol,
                route,
                timestamp,
              })
            } else {
              insertApiLog({
                ...params.scope,
                method: 'SCAN',
                route,
                timestamp,
                durationMs: 0,
                status: 200,
                appName: 'vault',
                txid,
                chain: chain.symbol,
                activityType,
                responseBody: meta,
              })
            }
          }
          if (exists) chainResult.updated++
          else chainResult.inserted++
        }
      }
    } catch (err: any) {
      chainResult.error = err?.message || String(err)
      result.totals.failedChains++
    }

    result.totals.txs += chainResult.txs
    result.totals.inserted += chainResult.inserted
    result.totals.updated += chainResult.updated
    result.totals.skippedNoTxid += chainResult.skippedNoTxid
    result.totals.skippedDuplicate += chainResult.skippedDuplicate
    result.chains.push(chainResult)
  }

  if (collected) result.rows = collected
  return result
}
