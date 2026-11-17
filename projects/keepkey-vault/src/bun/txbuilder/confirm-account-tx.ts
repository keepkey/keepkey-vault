import type { ChainDef } from '../../shared/chains'
import { COSMOS_REST } from './cosmos-spendable'

/** Broadcast acceptance is not execution success. Read the included result
 * before returning a completed send. Never broadcast again while checking. */
export async function confirmAccountTx(
  chain: Pick<ChainDef, 'id' | 'chainFamily'>,
  txid: string,
  options: { attempts?: number; delayMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  if (chain.chainFamily !== 'cosmos' && chain.chainFamily !== 'xrp') return
  if (!/^[a-fA-F0-9]{64}$/.test(txid)) throw new Error('Broadcast returned an invalid transaction hash')
  const deadline = Date.now() + (options.timeoutMs ?? 20000)
  for (let attempt = 0; attempt < (options.attempts ?? 12); attempt++) {
    const endpoints = chain.chainFamily === 'cosmos' ? COSMOS_REST[chain.id] ?? []
      : ['https://s1.ripple.com:51234', 'https://s2.ripple.com:51234']
    for (const endpoint of endpoints) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      let body: any
      try {
        const response = await fetch(chain.chainFamily === 'cosmos'
          ? `${endpoint}/cosmos/tx/v1beta1/txs/${txid}` : endpoint, {
          ...(chain.chainFamily === 'xrp' ? { method: 'POST', body: JSON.stringify({ method: 'tx', params: [{ transaction: txid, binary: false }] }) } : {}),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          cache: 'no-store', signal: AbortSignal.timeout(Math.min(4000, remaining)),
        })
        if (!response.ok) continue
        body = await response.json()
      } catch { continue }
      if (chain.chainFamily === 'cosmos') {
        const tx = body?.tx_response
        if (typeof tx?.txhash !== 'string' || tx.txhash.toLowerCase() !== txid.toLowerCase() || !/^[1-9]\d*$/.test(String(tx.height))) continue
        if (!/^\d+$/.test(String(tx.code))) continue
        if (Number(tx.code) !== 0) throw new Error(`Transaction ${txid} failed on chain (code ${tx.code}): ${tx.raw_log || tx.codespace || 'execution rejected'}. The fee may have been charged.`)
        return
      }
      const tx = body?.result
      if (tx?.validated !== true || typeof tx.hash !== 'string' || tx.hash.toLowerCase() !== txid.toLowerCase()) continue
      const result = tx.meta?.TransactionResult
      if (typeof result !== 'string') continue
      if (result !== 'tesSUCCESS') throw new Error(`Transaction ${txid} failed on chain: ${result}. The fee may have been charged.`)
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    if (attempt + 1 < (options.attempts ?? 12)) await new Promise(resolve => setTimeout(resolve, Math.min(options.delayMs ?? 1500, remaining)))
  }
  throw new Error(`Transaction ${txid} was submitted; confirmation is unknown. Check the explorer before sending again.`)
}
