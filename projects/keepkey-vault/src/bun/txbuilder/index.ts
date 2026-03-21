/**
 * TX builder dispatcher — routes to chain-family builder, signs, broadcasts.
 */
import type { ChainDef } from '../../shared/chains'
import type { BuildTxParams } from '../../shared/types'
import { buildUtxoTx, type BuildUtxoParams } from './utxo'
import { buildEvmTx, type BuildEvmParams } from './evm'
import { buildCosmosTx, type BuildCosmosParams } from './cosmos'
import { buildXrpTx, type BuildXrpParams } from './xrp'
import { sendShielded, type ShieldedSendParams } from './zcash-shielded'
import { buildTonTransfer, assembleTonSignedBoc, getTonSeqno, getTonWalletState, broadcastTonBoc, type TonBuildResult } from './ton'
// Pioneer SDK instance is passed as parameter to buildTx()

export type { BuildTxParams }

/**
 * Build an unsigned transaction for any supported chain.
 * Requires the from address + xpub (for UTXO chains) to be pre-resolved by the caller.
 */
export async function buildTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildTxParams & { fromAddress?: string; xpub?: string; rpcUrl?: string; accountPath?: number[]; evmAddressIndex?: number; publicKeyHex?: string },
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

      // Detect SPL token send from CAIP: "solana:.../token:MintAddress" or "solana:.../spl:MintAddress"
      const splMintMatch = params.caip?.match(/\/(token|spl):([A-Za-z0-9]+)/)
      const isSplToken = !!splMintMatch
      const splMintAddress = splMintMatch?.[2]

      console.debug(`[buildTx:solana] isSPL=${isSplToken} isMax=${params.isMax}${splMintAddress ? ` mint=${splMintAddress}` : ''}`)

      let rawTx: string

      if (isSplToken && splMintAddress) {
        // SPL token transfer — Pioneer builds the ATA-aware transfer instruction
        if (params.tokenDecimals == null) throw new Error('tokenDecimals required for SPL token transfers')
        const tokenDecimals = params.tokenDecimals
        // For MAX send, use frontend-provided tokenBalance (same pattern as EVM)
        const sendAmount = params.isMax && params.tokenBalance && parseFloat(params.tokenBalance) > 0
          ? params.tokenBalance
          : params.amount
        if (params.isMax && (!sendAmount || parseFloat(sendAmount) <= 0)) {
          throw new Error('Token balance is zero — cannot send max')
        }
        const tokenAmountBase = (() => {
          const parts = sendAmount.split('.')
          const whole = parts[0] || '0'
          const frac = (parts[1] || '').slice(0, tokenDecimals).padEnd(tokenDecimals, '0')
          return String(BigInt(whole) * BigInt(10 ** tokenDecimals) + BigInt(frac))
        })()

        console.debug(`[buildTx:solana] SPL token: decimals=${tokenDecimals}`)
        try {
          const resp = await pioneer.BuildSolanaTransferToken({
            from: params.fromAddress,
            to: params.to,
            amount: tokenAmountBase,
            token: splMintAddress,
            decimals: tokenDecimals,
            memo: params.memo || undefined,
          })
          const data = resp?.data as any
          if (data?.success === false) {
            throw new Error(data?.error || data?.message || 'Build failed')
          }
          rawTx = data?.serialized
          if (!rawTx) throw new Error('Pioneer did not return serialized tx for SPL token transfer')
          console.debug(`[buildTx:solana] SPL tx built OK, rawTx length=${rawTx.length}`)
        } catch (e: any) {
          throw new Error(`SPL token tx build failed: ${e.message}`)
        }
      } else {
        // Native SOL transfer — convert to lamports (9 decimals)
        const solAmountLamports = (() => {
          const parts = params.amount.split('.')
          const whole = parts[0] || '0'
          const frac = (parts[1] || '').slice(0, 9).padEnd(9, '0')
          return String(BigInt(whole) * 1000000000n + BigInt(frac))
        })()

        console.debug(`[buildTx:solana] Native SOL transfer`)
        try {
          const resp = await pioneer.BuildSolanaTransfer({
            from: params.fromAddress,
            to: params.to,
            amount: solAmountLamports,
            memo: params.memo || undefined,
          })
          const data = resp?.data as any
          console.debug(`[buildTx:solana] Pioneer response: success=${data?.success !== false}`)
          if (data?.success === false) {
            throw new Error(data?.error || data?.message || 'Build failed')
          }
          rawTx = data?.serialized
          if (!rawTx) throw new Error('Pioneer did not return serialized tx for Solana')
          console.debug(`[buildTx:solana] Native tx built OK, rawTx length=${rawTx.length}`)
        } catch (e: any) {
          throw new Error(`Solana tx build failed: ${e.message}`)
        }
      }

      const unsignedTx = {
        addressNList: chain.defaultPath,
        rawTx,
      }
      console.debug(`[buildTx:solana] unsignedTx ready, rawTx length=${rawTx.length}`)
      // Solana fees are per-signature (5000 lamports = 0.000005 SOL)
      return { unsignedTx, fee: '0.000005' }
    }

    case 'tron': {
      // Tron — TronGrid builds the raw protobuf tx (raw_data_hex), device signs
      if (!params.fromAddress) throw new Error('fromAddress required for Tron')

      // Convert TRX amount to sun (6 decimals)
      const sunAmount = (() => {
        const parts = params.amount.split('.')
        const whole = parts[0] || '0'
        const frac = (parts[1] || '').slice(0, 6).padEnd(6, '0')
        // Keep as Number — TronGrid expects integer, and TRX max supply (99B) fits safely in Number
        const sun = BigInt(whole) * 1000000n + BigInt(frac)
        if (sun > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('TRX amount too large')
        return Number(sun)
      })()

      let tronGridTx: any
      try {
        // Use TronGrid's createtransaction — it returns raw_data_hex (serialized protobuf)
        // which is exactly what the KeepKey firmware needs to sign.
        console.debug(`[buildTx] TRON createtransaction: amount=${sunAmount} SUN`)
        const resp = await fetch('https://api.trongrid.io/wallet/createtransaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner_address: params.fromAddress,
            to_address: params.to,
            amount: sunAmount,
            visible: true,
          }),
        })
        tronGridTx = await resp.json() as any
        if (tronGridTx?.Error) {
          if (tronGridTx.Error.includes('no OwnerAccount')) {
            throw new Error(`Account ${params.fromAddress} is not activated on the Tron network. Send TRX to this address first to activate it.`)
          }
          throw new Error(tronGridTx.Error)
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        if (!tronGridTx?.raw_data_hex) throw new Error('TronGrid did not return raw_data_hex')
      } catch (e: any) {
        throw new Error(`Tron tx build failed: ${e.message}`)
      }

      const tronUnsignedTx = {
        addressNList: chain.defaultPath,
        rawTx: tronGridTx.raw_data_hex,
        // Display metadata for clear-sign on device
        toAddress: params.to,
        amount: String(sunAmount),
        // Store full TronGrid response — broadcasttransaction needs raw_data JSON
        tronGridTx,
      }
      // Tron: bandwidth is typically free for TRX transfers
      return { unsignedTx: tronUnsignedTx, fee: '0' }
    }

    case 'ton': {
      // TON — build v4r2 wallet transfer, device signs cell hash
      if (!params.fromAddress) throw new Error('fromAddress required for TON')

      // Convert TON amount to nanoTON (9 decimals)
      const nanoTon = (() => {
        const parts = params.amount.split('.')
        const whole = parts[0] || '0'
        const frac = (parts[1] || '').slice(0, 9).padEnd(9, '0')
        return String(BigInt(whole) * 1000000000n + BigInt(frac))
      })()

      // Check wallet state — uninitialized wallets need StateInit in first tx
      let walletState: { initialized: boolean; balance: string }
      let seqno: number
      try {
        ;[seqno, walletState] = await Promise.all([
          getTonSeqno(params.fromAddress),
          getTonWalletState(params.fromAddress),
        ])
      } catch (e: any) {
        throw new Error(`TON network error — cannot determine wallet state: ${e.message}`)
      }

      const needsDeploy = !walletState.initialized
      console.debug(`[buildTx] TON wallet state: initialized=${walletState.initialized}, seqno=${seqno}, needsDeploy=${needsDeploy}`)
      if (needsDeploy && !params.publicKeyHex) {
        throw new Error('TON wallet not initialized — public key required for deployment')
      }

      const expireAt = Math.floor(Date.now() / 1000) + 300 // 5 minutes — hardware wallet confirm needs time

      const tonBuild = buildTonTransfer({
        fromAddress: params.fromAddress,
        to: params.to,
        amountNano: nanoTon,
        memo: params.memo,
        seqno,
        expireAt,
        needsDeploy,
        publicKeyHex: params.publicKeyHex,
      })

      const tonUnsignedTx = {
        addressNList: chain.defaultPath,
        rawTx: tonBuild.rawTx, // cell hash (32 bytes hex) — firmware signs this
        seqno: tonBuild.seqno,
        expireAt: tonBuild.expireAt,
        toAddress: tonBuild.toAddress,
        amount: tonBuild.amountNano,
        workchain: 0,
        // Clear-sign fields — sent to firmware for future body reconstruction + verification
        bounce: tonBuild._internal.bounce,
        memo: tonBuild._internal.memo,
        isDeploy: tonBuild.needsDeploy,
        // Store build result for BOC assembly after signing
        tonBuildResult: tonBuild,
      }
      // TON fees: ~0.005 TON for simple transfers, ~0.01 for deploy+transfer
      return { unsignedTx: tonUnsignedTx, fee: needsDeploy ? '0.01' : '0.005' }
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
    case 'solana': {
      console.debug(`[signTx:solana] signing tx`)
      const solResult = await wallet.solanaSignTx(unsignedTx)
      console.debug(`[signTx:solana] result: hasSig=${!!solResult?.signature} hasSerializedTx=${!!solResult?.serializedTx}`)
      return solResult
    }
    case 'tron':
      return wallet.tronSignTx(unsignedTx)
    case 'ton':
      return wallet.tonSignTx(unsignedTx)
    case 'zcash-shielded':
      // Shielded signing is handled by the zcash-shielded module (sidecar + device)
      // The full flow is orchestrated by sendShielded() — this should not be called directly
      throw new Error('Zcash shielded transactions use sendShielded() — not the standard sign flow')
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
  console.debug(`[broadcast] Broadcasting ${chain.coin} tx (networkId=${chain.networkId})`)

  // Extract serialized tx from signed result
  // XRP: hdwallet returns { value: { signatures: [{ serializedTx: "base64" }] } }
  // EVM/UTXO: hdwallet returns { serializedTx: "hex" }
  // Cosmos: proto-tx-builder returns { serialized: "base64" } — must convert to hex for Pioneer
  // Solana: hdwallet returns { signature: Uint8Array } — pass signature to Pioneer for assembly
  // TON: assemble signed BOC and broadcast via TON Center
  if (chain.chainFamily === 'ton') {
    const tonBuildResult = signedTx?.tonBuildResult as TonBuildResult | undefined
    const sigHex = signedTx?.signature
    if (!tonBuildResult || !sigHex) throw new Error('TON broadcast requires tonBuildResult and signature')

    const sigBuf = Buffer.from(typeof sigHex === 'string' ? sigHex : Buffer.from(sigHex).toString('hex'), 'hex')
    if (sigBuf.length !== 64) throw new Error(`TON signature must be 64 bytes, got ${sigBuf.length}`)
    const { boc: bocBase64, extMsgHash } = assembleTonSignedBoc(tonBuildResult, sigBuf)

    console.debug(`[broadcast] TON BOC assembled: needsDeploy=${tonBuildResult.needsDeploy}, seqno=${tonBuildResult.seqno}`)

    // Broadcast directly to TON Center (Pioneer's TON relay has issues)
    try {
      await broadcastTonBoc(bocBase64)
    } catch (e: any) {
      // Include diagnostic info in error
      throw new Error(`TON broadcast failed (needsDeploy=${tonBuildResult.needsDeploy}, seqno=${tonBuildResult.seqno}): ${e.message}`)
    }
    return { txid: extMsgHash }
  }

  // Tron: broadcast via TronGrid's broadcasttransaction (JSON format, needs raw_data + signature)
  if (chain.chainFamily === 'tron') {
    const tronGridTx = signedTx?.tronGridTx
    const sigHex = signedTx?.signature
    if (!tronGridTx || !sigHex) throw new Error('Tron broadcast requires tronGridTx and signature')

    const broadcastBody = { ...tronGridTx, signature: [sigHex] }
    const resp = await fetch('https://api.trongrid.io/wallet/broadcasttransaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(broadcastBody),
    })
    const data = await resp.json() as any
    if (data?.result === true && data?.txid) return { txid: data.txid }
    // TronGrid returns error messages as hex-encoded strings
    let errMsg = data?.code || 'Unknown error'
    if (data?.message) {
      try { errMsg = Buffer.from(data.message, 'hex').toString('utf8') } catch { errMsg = data.message }
    }
    throw new Error(`Tron broadcast failed: ${errMsg}`)
  }

  let serializedTx: string
  if (chain.chainFamily === 'solana') {
    // Solana: solanaSignTx RPC handler assembles full signed tx (base64)
    if (signedTx?.serializedTx) {
      serializedTx = signedTx.serializedTx
      console.debug(`[broadcast:solana] Using assembled serializedTx (len=${serializedTx.length})`)
    } else if (signedTx?.signature) {
      // Fallback: just the signature — Pioneer may handle assembly
      const sig = signedTx.signature
      serializedTx = sig instanceof Uint8Array ? Buffer.from(sig).toString('base64')
        : typeof sig === 'string' ? sig : String(sig)
      console.debug(`[broadcast:solana] Fallback: using raw signature as serializedTx`)
    } else {
      throw new Error('Solana signing did not return a signature or serializedTx')
    }
    console.debug(`[broadcast:solana] Sending to Pioneer.Broadcast(networkId=${chain.networkId})`)
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
    // Cosmos/Tendermint: Pioneer expects base64 — do NOT convert to hex
    // EVM: already hex, pass through
    const raw = signedTx.serialized
    if (chain.chainFamily === 'cosmos') {
      // proto-tx-builder output is base64 — Pioneer passes it to Tendermint RPC as-is
      serializedTx = raw
    } else {
      const stripped = raw.startsWith('0x') ? raw.slice(2) : raw
      if (stripped && /^[0-9a-fA-F]*$/.test(stripped)) {
        serializedTx = raw
      } else {
        serializedTx = Buffer.from(raw, 'base64').toString('hex')
      }
    }
  } else {
    throw new Error(`Cannot extract serialized tx from signed result: ${JSON.stringify(signedTx).slice(0, 200)}`)
  }

  // EVM chains: Pioneer's broadcast calls ethers arrayify() which requires 0x prefix.
  // hdwallet's ethSignTx returns raw hex without 0x — add it here.
  if (chain.chainFamily === 'evm' && serializedTx && !serializedTx.startsWith('0x')) {
    serializedTx = '0x' + serializedTx
  }

  console.log(`[broadcast] Sending to Pioneer: networkId=${chain.networkId}, format=${chain.chainFamily === 'cosmos' ? 'base64' : 'hex'}, len=${serializedTx.length}`)
  const result = await pioneer.Broadcast({ networkId: chain.networkId, serialized: serializedTx })
  const data = result?.data
  console.log(`[broadcast] Pioneer response: ${JSON.stringify(data).slice(0, 500)}`)

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
