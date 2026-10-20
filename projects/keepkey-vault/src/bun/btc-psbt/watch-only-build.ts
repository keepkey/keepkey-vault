/**
 * Watch-only "Create PSBT": coin selection on backend data in strict mode (no
 * guessed fee rate, change index, path or previous tx), then an Electrum-compatible
 * unsigned PSBT. No device. The backend is passed in: index.ts gives getBtcBackend(),
 * so the user's own node answers when it is active.
 */
import { buildUtxoTx } from '../txbuilder/utxo'
import type { BtcBackend } from '../btc-backend/types'
import type { ChainDef } from '../../shared/chains'
import { assertMainnetAddress, buildPsbt, type BtcPsbtAccount } from './psbt'
import { toSlip132 } from './codec'

export interface WatchOnlyBuildRequest {
  to: string
  /** BTC, decimal string; ignored when isMax */
  amount: string
  isMax: boolean
  /** 1-2 slow, 3-4 average, 5 fast (buildUtxoTx levels) */
  feeLevel: number
}

export async function buildWatchOnlyPsbt(backend: BtcBackend, chain: ChainDef, account: BtcPsbtAccount & { xpub: string }, req: WatchOnlyBuildRequest) {
  const to = req.to.trim()
  assertMainnetAddress(to)
  if (!req.isMax && !/^\d+(\.\d{1,8})?$/.test(req.amount.trim())) throw new Error('Amount must be in BTC with at most 8 decimals')
  if (!req.isMax && !/[1-9]/.test(req.amount)) throw new Error('Amount must be more than zero')
  const tx = await buildUtxoTx(null, chain, {
    to,
    amount: req.isMax ? '0' : req.amount.trim(),
    isMax: req.isMax,
    feeLevel: req.feeLevel,
    xpub: toSlip132(account.xpub, account.scriptType),
    scriptTypeOverride: account.scriptType,
    accountPath: account.path,
    strictBackend: backend,
  })
  const spends = tx.outputs.filter((o: any) => o.addressType === 'spend')
  const change = tx.outputs.find((o: any) => o.addressType === 'change')
  // buildPsbt hash-checks every previous tx, takes each input's value from it (refusing a
  // listing that disagrees) and re-derives every input and change script from the xpub.
  const built = buildPsbt({
    account,
    utxos: tx.inputs.map((i: any) => ({ txid: i.txid, vout: i.vout, value: i.amount, path: i.addressNList, scriptType: i.scriptType })),
    prevTxs: Object.fromEntries(tx.inputs.map((i: any) => [i.txid, i.hex])),
    outputs: spends.map((o: any) => ({ address: o.address, value: o.amount })),
    change: change ? { path: change.addressNList, value: change.amount } : undefined,
  })
  const listedFee = tx.inputs.reduce((s: bigint, i: any) => s + BigInt(i.amount), 0n) - tx.outputs.reduce((s: bigint, o: any) => s + BigInt(o.amount), 0n)
  if (built.analysis.fee !== listedFee) throw new Error('Fee from the previous transactions differs from coin selection, refusing')
  return built
}
