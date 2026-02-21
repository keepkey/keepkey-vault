/**
 * TX builder dispatcher — routes to chain-family builder, signs, broadcasts.
 */
import type { ChainDef } from '../../shared/chains'
import type { BuildTxParams } from '../../shared/types'
import { buildUtxoTx, type BuildUtxoParams } from './utxo'
import { buildEvmTx, type BuildEvmParams } from './evm'
import { buildCosmosTx, type BuildCosmosParams } from './cosmos'
import { buildXrpTx, type BuildXrpParams } from './xrp'

export type { BuildTxParams }

/**
 * Build an unsigned transaction for any supported chain.
 * Requires the from address + xpub (for UTXO chains) to be pre-resolved by the caller.
 */
export async function buildTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildTxParams & { fromAddress?: string; xpub?: string },
): Promise<{ unsignedTx: any; fee: string }> {
  switch (chain.chainFamily) {
    case 'utxo': {
      const unsignedTx = await buildUtxoTx(pioneer, chain, {
        to: params.to,
        amount: params.amount,
        memo: params.memo,
        feeLevel: params.feeLevel,
        isMax: params.isMax,
        xpub: params.xpub,
      })
      return { unsignedTx, fee: unsignedTx.fee }
    }

    case 'evm': {
      if (!params.fromAddress) throw new Error('fromAddress required for EVM chains')
      const unsignedTx = await buildEvmTx(pioneer, chain, {
        to: params.to,
        amount: params.amount,
        memo: params.memo,
        feeLevel: params.feeLevel,
        isMax: params.isMax,
        fromAddress: params.fromAddress,
      })
      return { unsignedTx, fee: unsignedTx.fee }
    }

    case 'cosmos': {
      if (!params.fromAddress) throw new Error('fromAddress required for Cosmos chains')
      const unsignedTx = await buildCosmosTx(pioneer, chain, {
        to: params.to,
        amount: params.amount,
        memo: params.memo,
        isMax: params.isMax,
        fromAddress: params.fromAddress,
      })
      return { unsignedTx, fee: unsignedTx.fee }
    }

    case 'xrp': {
      if (!params.fromAddress) throw new Error('fromAddress required for XRP')
      const unsignedTx = await buildXrpTx(pioneer, chain, {
        to: params.to,
        amount: params.amount,
        memo: params.memo,
        isMax: params.isMax,
        fromAddress: params.fromAddress,
      })
      return { unsignedTx, fee: unsignedTx.fee }
    }

    case 'binance': {
      // Binance chain — simple transfer, no Pioneer API needed for tx building
      const amountNum = parseFloat(params.amount)
      const unsignedTx = {
        addressNList: chain.defaultPath,
        chain_id: 'Binance-Chain-Tigris',
        account_number: '0',
        sequence: '0',
        tx: {
          msg: [{
            inputs: [{
              address: params.fromAddress || '',
              coins: [{ denom: 'BNB', amount: String(Math.round(amountNum * 1e8)) }],
            }],
            outputs: [{
              address: params.to,
              coins: [{ denom: 'BNB', amount: String(Math.round(amountNum * 1e8)) }],
            }],
          }],
          signatures: [],
          memo: params.memo || '',
        },
      }
      return { unsignedTx, fee: '0.000375' }
    }

    default:
      throw new Error(`Unsupported chain family: ${chain.chainFamily}`)
  }
}

/**
 * Sign a transaction using hdwallet.
 */
export async function signTx(
  wallet: any,
  chain: ChainDef,
  unsignedTx: any,
): Promise<any> {
  switch (chain.chainFamily) {
    case 'utxo':
      return wallet.btcSignTx(unsignedTx)
    case 'evm':
      return wallet.ethSignTx(unsignedTx)
    case 'cosmos': {
      // hdwallet method names: cosmosSignTx, thorchainSignTx, mayachainSignTx, osmosisSignTx
      if (!wallet[chain.signMethod]) throw new Error(`Wallet missing method: ${chain.signMethod}`)
      return wallet[chain.signMethod](unsignedTx)
    }
    case 'binance':
      return wallet.binanceSignTx(unsignedTx)
    case 'xrp':
      return wallet.rippleSignTx(unsignedTx)
    default:
      throw new Error(`Cannot sign for chain family: ${chain.chainFamily}`)
  }
}

/**
 * Broadcast a signed transaction via Pioneer API.
 */
export async function broadcastTx(
  pioneer: any,
  chain: ChainDef,
  signedTx: any,
): Promise<{ txid: string }> {
  console.log(`[broadcast] Broadcasting ${chain.coin} tx...`)

  // Extract serialized hex from signed result
  let serializedTx: string
  if (typeof signedTx === 'string') {
    serializedTx = signedTx
  } else if (signedTx?.serializedTx) {
    serializedTx = signedTx.serializedTx
  } else if (signedTx?.serialized) {
    serializedTx = signedTx.serialized
  } else {
    serializedTx = JSON.stringify(signedTx)
  }

  const result = await pioneer.Broadcast({ caip: chain.caip, serializedTx, txHex: serializedTx })
  const data = result?.data

  if (data?.txid) return { txid: data.txid }
  if (data?.tx_hash) return { txid: data.tx_hash }
  if (data?.hash) return { txid: data.hash }
  if (typeof data === 'string') return { txid: data }

  return { txid: JSON.stringify(data) }
}
