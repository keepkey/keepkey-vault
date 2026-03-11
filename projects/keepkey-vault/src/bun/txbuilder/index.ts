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
  params: BuildTxParams & { fromAddress?: string; xpub?: string; rpcUrl?: string; accountPath?: number[]; evmAddressIndex?: number },
): Promise<{ unsignedTx: any; fee: string }> {
  switch (chain.chainFamily) {
    case 'utxo': {
      const utxoResult = await buildUtxoTx(pioneer, chain, {
        to: params.to,
        amount: params.amount,
        memo: params.memo,
        feeLevel: params.feeLevel,
        isMax: params.isMax,
        xpub: params.xpub,
        scriptTypeOverride: params.scriptTypeOverride,
        accountPath: params.accountPath,
      })
      const { fee: utxoFee, ...utxoTx } = utxoResult
      return { unsignedTx: utxoTx, fee: utxoFee }
    }

    case 'evm': {
      if (!params.fromAddress) throw new Error('fromAddress required for EVM chains')
      const evmResult = await buildEvmTx(pioneer, chain, {
        to: params.to,
        amount: params.amount,
        memo: params.memo,
        feeLevel: params.feeLevel,
        isMax: params.isMax,
        fromAddress: params.fromAddress,
        caip: params.caip,
        tokenBalance: params.tokenBalance,
        tokenDecimals: params.tokenDecimals,
        rpcUrl: params.rpcUrl,
        addressIndex: params.evmAddressIndex,
      })
      // Strip non-tx metadata so only hdwallet-compatible fields reach ethSignTx
      const { fee, ...unsignedTx } = evmResult
      return { unsignedTx, fee }
    }

    case 'cosmos': {
      if (!params.fromAddress) throw new Error('fromAddress required for Cosmos chains')
      const cosmosResult = await buildCosmosTx(pioneer, chain, {
        to: params.to,
        amount: params.amount,
        memo: params.memo,
        isMax: params.isMax,
        isSwapDeposit: params.isSwapDeposit,
        fromAddress: params.fromAddress,
      })
      const { fee: cosmosFee, ...cosmosTx } = cosmosResult
      return { unsignedTx: cosmosTx, fee: cosmosFee }
    }

    case 'xrp': {
      if (!params.fromAddress) throw new Error('fromAddress required for XRP')
      const xrpResult = await buildXrpTx(pioneer, chain, {
        to: params.to,
        amount: params.amount,
        memo: params.memo,
        isMax: params.isMax,
        fromAddress: params.fromAddress,
      })
      const { fee: xrpFee, ...xrpTx } = xrpResult
      return { unsignedTx: xrpTx, fee: xrpFee }
    }

    case 'solana': {
      // Solana — Pioneer builds the raw tx (with dummy signature header), device signs
      if (!params.fromAddress) throw new Error('fromAddress required for Solana')

      // Convert SOL amount to lamports (9 decimals)
      const solAmountLamports = (() => {
        const parts = params.amount.split('.')
        const whole = parts[0] || '0'
        const frac = (parts[1] || '').slice(0, 9).padEnd(9, '0')
        return String(BigInt(whole) * 1000000000n + BigInt(frac))
      })()

      let rawTx: string
      try {
        // Pioneer SDK: BuildTransfer1 = POST /solana/build-transfer
        // Returns { serialized: "base64..." } with 65-byte header (sig_count + dummy_sig + message)
        const resp = await pioneer.BuildTransfer1({
          from: params.fromAddress,
          to: params.to,
          amount: solAmountLamports,
          memo: params.memo || undefined,
        })
        const data = resp?.data
        rawTx = data?.serialized
        if (!rawTx) throw new Error('Pioneer did not return serialized tx for Solana')
      } catch (e: any) {
        throw new Error(`Solana tx build failed: ${e.message}`)
      }

      const unsignedTx = {
        addressNList: chain.defaultPath,
        rawTx,
      }
      // Solana fees are per-signature (5000 lamports = 0.000005 SOL)
      return { unsignedTx, fee: '0.000005' }
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
    case 'xrp':
      return wallet.rippleSignTx(unsignedTx)
    case 'solana':
      return wallet.solanaSignTx(unsignedTx)
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
  console.log(`[broadcast] Broadcasting ${chain.coin} tx (networkId=${chain.networkId})...`)

  // Extract serialized tx from signed result
  // XRP: hdwallet returns { value: { signatures: [{ serializedTx: "base64" }] } }
  // EVM/UTXO: hdwallet returns { serializedTx: "hex" }
  // Cosmos: proto-tx-builder returns { serialized: "base64" } — must convert to hex for Pioneer
  // Solana: hdwallet returns { signature: Uint8Array } — pass signature to Pioneer for assembly
  let serializedTx: string
  if (chain.chainFamily === 'solana') {
    // Solana: solanaSignTx RPC handler assembles full signed tx (base64)
    if (signedTx?.serializedTx) {
      serializedTx = signedTx.serializedTx
    } else if (signedTx?.signature) {
      // Fallback: just the signature — Pioneer may handle assembly
      const sig = signedTx.signature
      serializedTx = sig instanceof Uint8Array ? Buffer.from(sig).toString('base64')
        : typeof sig === 'string' ? sig : String(sig)
    } else {
      throw new Error('Solana signing did not return a signature or serializedTx')
    }
  } else if (typeof signedTx === 'string') {
    serializedTx = signedTx
  } else if (signedTx?.value?.signatures?.[0]?.serializedTx) {
    // XRP signed response — serializedTx is already base64 (what Pioneer expects)
    serializedTx = signedTx.value.signatures[0].serializedTx
  } else if (signedTx?.serializedTx) {
    serializedTx = signedTx.serializedTx
  } else if (signedTx?.serialized) {
    // hdwallet-keepkey returns { serialized: "0xf86c..." } for EVM (hex with 0x prefix)
    // proto-tx-builder returns { serialized: "CpQB..." } for Cosmos (base64)
    // Detect which format: strip optional 0x prefix, then test if remaining chars are hex
    const raw = signedTx.serialized
    const stripped = raw.startsWith('0x') ? raw.slice(2) : raw
    if (stripped && /^[0-9a-fA-F]*$/.test(stripped)) {
      serializedTx = raw
    } else {
      serializedTx = Buffer.from(raw, 'base64').toString('hex')
    }
  } else {
    throw new Error(`Cannot extract serialized tx from signed result: ${JSON.stringify(signedTx).slice(0, 200)}`)
  }

  // EVM chains: Pioneer's broadcast calls ethers arrayify() which requires 0x prefix.
  // hdwallet's ethSignTx returns raw hex without 0x — add it here.
  if (chain.chainFamily === 'evm' && serializedTx && !serializedTx.startsWith('0x')) {
    serializedTx = '0x' + serializedTx
  }

  const result = await pioneer.Broadcast({ networkId: chain.networkId, serialized: serializedTx })
  const data = result?.data

  // Tendermint: detect on-chain broadcast failure even if txid is present
  const txResponse = data?.results?.raw?.tx_response
  if (txResponse && typeof txResponse.code === 'number' && txResponse.code !== 0) {
    const rawLog = txResponse.raw_log || 'Broadcast failed'
    throw new Error(`Broadcast rejected: ${rawLog}`)
  }

  // Detect broadcast failure — Pioneer wraps errors in { success: false, error: ... }
  if (data && typeof data === 'object' && data.success === false) {
    const errMsg = typeof data.error === 'string' ? data.error
      : typeof data.error?.error === 'string' ? data.error.error
      : JSON.stringify(data.error || data)
    throw new Error(`Broadcast rejected: ${errMsg}`)
  }

  if (data?.txid) return { txid: data.txid }
  if (data?.tx_hash) return { txid: data.tx_hash }
  if (data?.hash) return { txid: data.hash }
  if (typeof data === 'string' && data.length >= 32) return { txid: data }

  // If we get here, the response is unexpected — don't pretend it's a txid
  console.error(`[broadcast] Unexpected response:`, JSON.stringify(data).slice(0, 500))
  throw new Error(`Broadcast failed: unexpected response — ${JSON.stringify(data).slice(0, 200)}`)
}
