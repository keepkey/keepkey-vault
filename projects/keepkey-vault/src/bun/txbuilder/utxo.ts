/**
 * UTXO tx builder — simplified from pioneer-sdk/txbuilder/createUnsignedUxtoTx.ts
 *
 * Uses coinselect for coin selection, Pioneer API for UTXOs + fees.
 * Returns an object ready for hdwallet's btcSignTx().
 */
import coinSelect from 'coinselect'
// @ts-ignore — coinselect/split has no types
import coinSelectSplit from 'coinselect/split'
import { bech32, bech32m } from '@scure/base'
// @ts-ignore
import bs58check from 'bs58check'
import type { ChainDef } from '../../shared/chains'
import { getBtcBackend } from '../btc-backend'
import { utxoDiscoveryKey } from '../btc-backend/types'

/** BTC mainnet — the ONLY UTXO chain that routes to a self-host node; every other
 *  coin (LTC/DOGE/BCH/Dash/Zcash) stays on Pioneer. */
const BTC_NETWORK_ID = 'bip122:000000000019d6689c085ae165831e93'
const btcSelfHostActive = (networkId: string) =>
  networkId === BTC_NETWORK_ID && getBtcBackend().kind !== 'pioneer'

// @ts-ignore — CJS module, no types
const cashaddrLib = require('@shapeshiftoss/bitcoinjs-lib/src/cashaddr')

/** Convert a legacy BCH P2PKH/P2SH address (1... or 3...) to cashaddr format.
 *  No-op for addresses already in cashaddr format or that aren't BCH legacy addresses. */
export function normalizeBchAddress(address: string): string {
  if (!address) return address
  const lower = address.toLowerCase()
  // Already cashaddr (with or without 'bitcoincash:' prefix, or q/p bare)
  if (lower.startsWith('bitcoincash:') || lower.startsWith('q') || lower.startsWith('p')) return address
  // Attempt Base58Check decode (legacy BCH P2PKH/P2SH)
  let payload: Buffer
  try { payload = bs58check.decode(address) } catch { return address }
  if (payload.length !== 21) return address
  const version = payload[0]
  const hash = new Uint8Array(payload.slice(1))
  let type: string
  if (version === 0x00) type = 'P2PKH'
  else if (version === 0x05) type = 'P2SH'
  else return address
  try { return cashaddrLib.encode('bitcoincash', type, hash) } catch { return address }
}

/** String-based decimal→integer to avoid floating-point precision loss */
function parseDecimalToInt(amount: string, decimals: number): number {
  const [whole = '0', frac = ''] = amount.split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return Number(whole + padded)
}

const TAG = '[txbuilder:utxo]'

// BIP32 path segment to addressNList
function bip32ToAddressNList(path: string): number[] {
  return path
    .replace('m/', '')
    .split('/')
    .map((seg) => {
      const hardened = seg.endsWith("'")
      const index = parseInt(seg.replace("'", ''), 10)
      return hardened ? index + 0x80000000 : index
    })
}

// Hardcoded fee overrides for chains where API is unreliable
const HARDCODED_FEES: Record<string, { slow: number; average: number; fast: number }> = {
  'bip122:00000000001a91e3dace36e2be3bf030': { slow: 10, average: 10, fast: 10 }, // DOGE
  'bip122:4da631f2ac1bed857bd968c67c913978': { slow: 100, average: 120, fast: 150 }, // DGB
}

// Default fallback fees
const DEFAULT_FEES: Record<string, { slow: number; average: number; fast: number }> = {
  'bip122:000000000019d6689c085ae165831e93': { slow: 3, average: 5, fast: 15 }, // BTC
  'bip122:12a765e31ffd4059bada1e25190f6e98': { slow: 2, average: 3, fast: 10 }, // LTC
  'bip122:00000000001a91e3dace36e2be3bf030': { slow: 10, average: 10, fast: 10 }, // DOGE
  'bip122:000000000000000000651ef99cb9fcbe': { slow: 1, average: 1, fast: 3 }, // BCH
  'bip122:000007d91d1254d60e2dd1ae58038307': { slow: 1, average: 1, fast: 3 }, // DASH
  'bip122:00040fe8ec8471911baa1db1266ea15d': { slow: 1, average: 2, fast: 5 }, // ZEC
}

// SLIP-44 coin type by chain id
const COIN_TYPE: Record<string, number> = {
  bitcoin: 0, litecoin: 2, dogecoin: 3, dash: 5, bitcoincash: 145, zcash: 133,
}

// Purpose by scriptType
const PURPOSE: Record<string, number> = {
  p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84, p2tr: 86,
}

// Reverse: purpose → scriptType (for deriving scriptType from UTXO paths)
const PURPOSE_TO_SCRIPT: Record<number, string> = {
  44: 'p2pkh', 49: 'p2sh-p2wpkh', 84: 'p2wpkh', 86: 'p2tr',
}

// Convert a Bitcoin address to its scriptPubKey hex (for matching UTXOs by script)
export function addressToScriptPubKeyHex(address: string): string | undefined {
  try {
    if (address.startsWith('bc1') || address.startsWith('tb1') ||
        address.startsWith('ltc1') || address.startsWith('tltc1')) {
      // BIP173 v0 uses Bech32; BIP350 v1+ (including P2TR) uses Bech32m.
      // Decode with both, then enforce the checksum variant required by the
      // witness version so a v1 address with an old Bech32 checksum is rejected.
      let decoded: { prefix: string; words: number[] }
      let isBech32m = false
      try {
        decoded = bech32.decode(address)
      } catch {
        decoded = bech32m.decode(address)
        isBech32m = true
      }
      const version = decoded.words[0]
      if (version == null || version < 0 || version > 16) return undefined
      if ((version === 0 && isBech32m) || (version > 0 && !isBech32m)) return undefined
      const program = (isBech32m ? bech32m : bech32).fromWords(decoded.words.slice(1))
      if (program.length < 2 || program.length > 40) return undefined
      if (version === 0 && program.length !== 20 && program.length !== 32) return undefined
      const hex = Buffer.from(Uint8Array.from(program)).toString('hex')
      const versionOpcode = version === 0 ? '00' : (0x50 + version).toString(16).padStart(2, '0')
      return `${versionOpcode}${program.length.toString(16).padStart(2, '0')}${hex}`
    }
    // Zcash t1... (P2PKH) and t3... (P2SH) — 2-byte version prefix
    if (address.startsWith('t1') || address.startsWith('t3')) {
      const payload = bs58check.decode(address)
      if (payload.length < 22) return undefined
      const hash = Buffer.from(payload.slice(2)).toString('hex')
      if (address.startsWith('t1')) return `76a914${hash}88ac`
      if (address.startsWith('t3')) return `a914${hash}87`
      return undefined
    }
    // Base58Check addresses (1..., 3..., L..., D..., X..., etc.)
    const payload = bs58check.decode(address)
    const version = payload[0]
    const hash = Buffer.from(payload.slice(1)).toString('hex')
    if (version === 0x00 || version === 0x1e || version === 0x30 || version === 0x4c) {
      // p2pkh: BTC(0x00), DOGE(0x1e), LTC(0x30), DASH(0x4c)
      return `76a914${hash}88ac`
    }
    if (version === 0x05 || version === 0x16 || version === 0x32) {
      // p2sh: BTC(0x05), DOGE(0x16), LTC(0x32)
      return `a914${hash}87`
    }
    return undefined
  } catch {
    return undefined
  }
}

// Extract scriptPubKey hex from a UTXO's embedded tx data
function getUtxoScriptPubKeyHex(utxo: any): string | undefined {
  return utxo.tx?.vout?.[utxo.vout]?.scriptPubKey?.hex
}

// Derive scriptType from xpub prefix (Pioneer SDK pattern)
function getScriptTypeFromXpub(xpub: string): string | undefined {
  // BTC
  if (xpub.startsWith('zpub')) return 'p2wpkh'
  if (xpub.startsWith('ypub')) return 'p2sh-p2wpkh'
  if (xpub.startsWith('xpub')) return 'p2pkh'
  // DOGE (dgub), BCH, DASH (drkp) — all legacy p2pkh
  if (xpub.startsWith('dgub') || xpub.startsWith('drkp')) return 'p2pkh'
  // LTC
  if (xpub.startsWith('Mtub')) return 'p2wpkh'
  if (xpub.startsWith('Ltub')) return 'p2sh-p2wpkh'
  return undefined // unknown prefix — let caller fall back
}

// Derive scriptType from a BIP44/49/84 path string like "m/84'/0'/0'/0/1"
function getScriptTypeFromPath(path: string): string | undefined {
  const match = path.match(/^m\/(\d+)'\//)
  if (!match) return undefined
  return PURPOSE_TO_SCRIPT[parseInt(match[1], 10)]
}

export interface XpubInfo {
  xpub: string
  scriptType: string
  accountPath: number[]
}

export interface BuildUtxoParams {
  to: string
  amount: string   // human-readable (e.g. "0.001")
  memo?: string
  feeLevel?: number // 1-2=slow, 3-4=avg, 5+=fast (default 5)
  isMax?: boolean
  xpub?: string    // primary xpub for UTXO lookup (single-xpub chains or change address)
  allXpubs?: XpubInfo[]  // BTC multi-xpub: aggregate UTXOs from all funded xpubs
  scriptTypeOverride?: string // BTC multi-account: override chain default scriptType
  accountPath?: number[] // BTC multi-account: account-level path [purpose+H, coinType+H, account+H]
  satPerVByte?: number   // custom (free-form) fee rate — overrides feeLevel preset
}

/** Unwrap Pioneer ListUnspent response (handles Swagger/Axios double-wrapping) */
function unwrapUtxoResponse(resp: any): any[] {
  return Array.isArray(resp) ? resp
    : Array.isArray(resp?.data) ? resp.data
    : Array.isArray(resp?.data?.data) ? resp.data.data
    : Array.isArray(resp?.utxos) ? resp.utxos
    : []
}

/** Resolve fee rates (sat/vByte). BTC self-host reads the node; everything else
 *  uses Pioneer's fee API (sat/kB → sat/vB conversion), falling back to defaults. */
async function resolveFeeRates(
  pioneer: any, chain: ChainDef,
): Promise<{ slow: number; average: number; fast: number }> {
  if (HARDCODED_FEES[chain.networkId]) return HARDCODED_FEES[chain.networkId]
  if (btcSelfHostActive(chain.networkId)) {
    try { return await getBtcBackend().feeRate(chain.networkId) }
    catch { return DEFAULT_FEES[chain.networkId] || { slow: 3, average: 5, fast: 15 } }
  }
  try {
    const feeResp = pioneer.GetFeeRateByNetwork
      ? await pioneer.GetFeeRateByNetwork({ networkId: chain.networkId })
      : await pioneer.GetFeeRate({ networkId: chain.networkId })
    const data = feeResp?.data || {}
    const vals = [data.slow, data.average, data.fast, data.fastest].filter(Boolean)
    const needsConversion = vals.some((v: number) => v > 500) // sat/kB → sat/vB
    return {
      slow: (data.slow || data.average || 5) / (needsConversion ? 1000 : 1),
      average: (data.average || data.fast || 10) / (needsConversion ? 1000 : 1),
      fast: (data.fastest || data.fast || data.average || 15) / (needsConversion ? 1000 : 1),
    }
  } catch {
    return DEFAULT_FEES[chain.networkId] || { slow: 3, average: 5, fast: 15 }
  }
}

/** Fetch UTXOs for a single xpub, tag each with its scriptType and source accountPath */
async function fetchUtxosForXpub(
  pioneer: any, network: string, xpub: string, defaultScriptType: string,
  sourceAccountPath?: number[],
): Promise<any[]> {
  console.log(`${TAG} Fetching UTXOs: network=${network}, xpub=${xpub.slice(0, 20)}...`)
  if (btcSelfHostActive(network)) {
    const backend = getBtcBackend()
    const raw = await backend.listUnspent({ network, xpub, scriptType: defaultScriptType })
    const utxos = raw.map((u) => ({
      txid: u.txid, vout: u.vout, value: Number(u.value),
      path: u.path, address: u.address, hex: u.hex,
      scriptType: u.scriptType || (u.path ? getScriptTypeFromPath(u.path) : undefined) || defaultScriptType,
      ...(sourceAccountPath ? { _sourceAccountPath: sourceAccountPath } : {}),
    }))
    console.log(`${TAG} ${xpub.slice(0, 8)}...: ${utxos.length} UTXOs via self-host ${backend.kind}, ${utxos.reduce((s, u) => s + u.value, 0) / 1e8}`)
    return utxos
  }
  const discoveryKey = utxoDiscoveryKey(xpub, defaultScriptType)
  const resp = await pioneer.ListUnspent({ network, xpub: discoveryKey })
  console.log(`${TAG} ListUnspent raw: ${JSON.stringify(resp)?.slice(0, 300)}`)
  const utxos = unwrapUtxoResponse(resp)
  for (const u of utxos) {
    u.value = Number(u.value)
    u.scriptType = u.scriptType || (u.path ? getScriptTypeFromPath(u.path) : undefined) || defaultScriptType
    // Tag with source xpub's account path so input preparation can rewrite correctly
    if (sourceAccountPath) u._sourceAccountPath = sourceAccountPath
  }
  console.log(`${TAG} ${xpub.slice(0, 8)}...: ${utxos.length} UTXOs, ${utxos.reduce((s: number, u: any) => s + u.value, 0) / 1e8}`)
  return utxos
}

/** Estimate the miner fee for a UTXO send without building the full tx.
 *  Runs steps 1-3 of buildUtxoTx (fetch UTXOs + fee rate + coin selection) and
 *  returns the fee in satoshis and the net spendable amount. Returns null on any
 *  error so callers can safely degrade to no-estimate. */
export async function estimateUtxoFee(
  pioneer: any,
  chain: ChainDef,
  params: Pick<BuildUtxoParams, 'to' | 'amount' | 'feeLevel' | 'isMax' | 'xpub' | 'allXpubs' | 'scriptTypeOverride' | 'accountPath' | 'satPerVByte' | 'memo'>,
): Promise<{ feeSat: number; netSat: number } | null> {
  try {
    const { to, feeLevel = 5, isMax = false, xpub, allXpubs, scriptTypeOverride, accountPath, satPerVByte, memo } = params
    const primaryXpub = xpub || allXpubs?.[0]?.xpub
    if (!primaryXpub) return null
    const scriptType = scriptTypeOverride || getScriptTypeFromXpub(primaryXpub) || chain.scriptType || 'p2pkh'

    let utxos: any[]
    if (allXpubs && allXpubs.length > 0) {
      const settled = await Promise.allSettled(
        allXpubs.map(x => fetchUtxosForXpub(pioneer, chain.networkId, x.xpub, x.scriptType, x.accountPath))
      )
      utxos = settled.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    } else {
      utxos = await fetchUtxosForXpub(pioneer, chain.networkId, primaryXpub, scriptType, accountPath)
    }
    if (!utxos.length) return null

    const feeRates = await resolveFeeRates(pioneer, chain)
    const effectiveFeeRate = satPerVByte && satPerVByte > 0
      ? Math.max(1, Math.ceil(satPerVByte))
      : Math.max(3, Math.ceil(feeLevel <= 2 ? feeRates.slow : feeLevel <= 4 ? feeRates.average : feeRates.fast))

    const satoshis = parseDecimalToInt(params.amount, chain.decimals)
    const result = isMax
      ? coinSelectSplit(utxos, [{ address: to }], effectiveFeeRate)
      : coinSelect(utxos, [{ address: to, value: satoshis }], effectiveFeeRate)

    if (!result?.inputs || result.fee == null) return null
    const totalIn = result.inputs.reduce((s: number, i: any) => s + i.value, 0)
    let feeSat: number = result.fee
    // ZIP-317: coinSelectSplit uses sat/byte which produces fees far below the
    // ZIP-317 floor. Apply the same enforcement here so netSat matches what
    // buildUtxoTx will actually produce — otherwise the re-quote under-estimates
    // the fee and the deposit address is quoted for more than we can deliver.
    if (chain.id === 'zcash') {
      // Same memo-output accounting as buildUtxoTx — OP_RETURN adds a vout.
      const memoOut = memo && memo.trim() ? 1 : 0
      const logicalActions = Math.max(result.inputs.length, (result.outputs?.length ?? 1) + memoOut)
      const zip317Fee = 5000 * Math.max(2, logicalActions)
      if (feeSat < zip317Fee) feeSat = zip317Fee
    }
    return { feeSat, netSat: totalIn - feeSat }
  } catch {
    return null
  }
}

export async function buildUtxoTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildUtxoParams,
) {
  const { memo, feeLevel = 5, isMax = false, xpub, allXpubs, scriptTypeOverride, accountPath, satPerVByte } = params
  // BCH: NEAR Intents (and some other providers) return legacy P2PKH/P2SH addresses
  // (starting with '1'/'3'). The KeepKey firmware requires cashaddr format — convert.
  const to = chain.id === 'bitcoincash' ? normalizeBchAddress(params.to) : params.to
  if (to !== params.to) console.log(`${TAG} BCH address normalized: ${params.to} → ${to}`)

  if (!xpub && (!allXpubs || !allXpubs.length)) throw new Error(`${TAG} xpub required for UTXO chain ${chain.coin}`)

  // scriptType resolution: explicit override > xpub prefix > chain default > p2pkh
  const primaryXpub = xpub || allXpubs![0].xpub
  const scriptType = scriptTypeOverride || getScriptTypeFromXpub(primaryXpub) || chain.scriptType || 'p2pkh'
  console.log(`${TAG} scriptType=${scriptType} (override=${scriptTypeOverride}, xpub-prefix=${getScriptTypeFromXpub(primaryXpub)}, chain-default=${chain.scriptType})`)
  const coinType = COIN_TYPE[chain.id] ?? 0
  const purpose = PURPOSE[scriptType] ?? 84

  // Account index: extract from accountPath if provided (for BTC multi-account)
  const accountIndex = accountPath ? (accountPath[2] - 0x80000000) : 0
  if (accountPath) {
    console.log(`${TAG} Using accountPath=[${accountPath.join(',')}] → accountIndex=${accountIndex}`)
  }

  // 1. Fetch UTXOs — aggregate from all xpubs if provided, otherwise single xpub
  let utxos: any[]
  if (allXpubs && allXpubs.length > 0) {
    console.log(`${TAG} Multi-xpub aggregation: ${allXpubs.length} xpubs`)
    // Finding 5: tolerate individual xpub failures — use allSettled
    const settled = await Promise.allSettled(
      allXpubs.map(x => fetchUtxosForXpub(pioneer, chain.networkId, x.xpub, x.scriptType, x.accountPath))
    )
    utxos = []
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'fulfilled') {
        utxos.push(...(settled[i] as PromiseFulfilledResult<any[]>).value)
      } else {
        console.warn(`${TAG} ListUnspent failed for ${allXpubs[i].xpub.slice(0, 12)}...: ${(settled[i] as PromiseRejectedResult).reason?.message}`)
      }
    }
  } else {
    utxos = await fetchUtxosForXpub(pioneer, chain.networkId, primaryXpub, scriptType, accountPath || undefined)
  }
  if (!utxos.length) throw new Error(`No confirmed UTXOs found for ${chain.coin}. If you recently sent or received ${chain.symbol}, the transaction may still be confirming — please wait and try again.`)

  // Diagnostic: dump raw UTXO[0]
  if (utxos.length > 0) {
    const { tx, hex, ...utxoMeta } = utxos[0]
    console.log(`${TAG} UTXO[0] meta: ${JSON.stringify(utxoMeta)}`)
  }
  console.log(`${TAG} Found ${utxos.length} UTXOs total, ${utxos.reduce((s: number, u: any) => s + u.value, 0) / 1e8} ${chain.symbol}`)
  for (const u of utxos) {
    console.log(`${TAG}   UTXO ${u.txid?.slice(0, 12)}...:${u.vout} value=${u.value} scriptType=${u.scriptType} path=${u.path || 'NONE'} addr=${u.address || 'NONE'} hasHex=${!!u.hex || !!u.txHex}`)
  }

  // 2. Get fee rate
  const feeRates = await resolveFeeRates(pioneer, chain)

  const effectiveFeeRate = satPerVByte && satPerVByte > 0
    ? Math.max(1, Math.ceil(satPerVByte)) // custom rate — user's explicit choice (consensus floors still apply below)
    : Math.max(
        3, // min relay fee
        Math.ceil(feeLevel <= 2 ? feeRates.slow : feeLevel <= 4 ? feeRates.average : feeRates.fast),
      )
  console.log(`${TAG} Fee rate: ${effectiveFeeRate} sat/vB (level=${feeLevel}${satPerVByte ? ', custom' : ''})`)

  // 3. Coin selection (string-based to avoid float precision loss)
  const satoshis = parseDecimalToInt(params.amount, chain.decimals)
  const result = isMax
    ? coinSelectSplit(utxos, [{ address: to }], effectiveFeeRate)
    : coinSelect(utxos, [{ address: to, value: satoshis }], effectiveFeeRate)

  if (!result?.inputs) {
    const total = utxos.reduce((s: number, u: any) => s + u.value, 0)
    if (total < satoshis) throw new Error(`Insufficient funds: have ${total / 1e8}, need ${satoshis / 1e8} ${chain.symbol}`)
    throw new Error('Coin selection failed (possibly high fees)')
  }

  let { inputs, outputs, fee } = result

  // DOGE: enforce minimum 1 DOGE fee (network consensus rule)
  // Pioneer SDK: DOGE_MIN_FEE = 100000000 (1 DOGE), dust = 1000000 (0.01 DOGE)
  if (chain.id === 'dogecoin' && fee < 100000000) {
    const increase = 100000000 - fee
    const changeIdx = outputs.findIndex((o: any) => !o.address)
    if (changeIdx >= 0 && outputs[changeIdx].value >= increase) {
      // Absorb fee deficit from change output
      outputs[changeIdx].value -= increase
      if (outputs[changeIdx].value < 1000000) {
        // Change is dust — consolidate into fee
        fee = 100000000 + outputs[changeIdx].value
        outputs.splice(changeIdx, 1)
      } else {
        fee = 100000000
      }
    } else {
      // No change output (or change too small) — reduce spend output to cover fee.
      // For swaps this is fine: THORChain swaps whatever it receives.
      const spendIdx = outputs.findIndex((o: any) => o.address)
      if (spendIdx >= 0 && outputs[spendIdx].value > increase + 1000000) {
        console.log(`${TAG} DOGE: no change output — reducing spend by ${increase} sats to enforce 1 DOGE min fee`)
        outputs[spendIdx].value -= increase
        fee = 100000000
      } else {
        throw new Error(`Insufficient DOGE to cover minimum 1 DOGE network fee`)
      }
    }
    console.log(`${TAG} DOGE: enforced minimum fee = ${fee} sats (${fee / 1e8} DOGE)`)
  }

  // ZEC: enforce ZIP-317 minimum fee (NU5+ consensus rule)
  // fee = 5000 × max(grace_actions, logical_actions) where grace_actions = 2
  // logical_actions = max(transparent_inputs, transparent_outputs)
  // coinselect uses sat/byte which produces fees far below the ZIP-317 floor.
  if (chain.id === 'zcash') {
    // +1 output when a memo is present: the OP_RETURN vout is appended at
    // broadcast time (opReturnData below), AFTER coin selection — and ZIP-317
    // counts every transparent output. Missing it left memo txs exactly one
    // action unpaid → node rejects with "tx unpaid action limit exceeded".
    const memoOut = memo && memo.trim() ? 1 : 0
    const logicalActions = Math.max(inputs.length, outputs.length + memoOut)
    const zip317Fee = 5000 * Math.max(2, logicalActions)
    if (fee < zip317Fee) {
      const increase = zip317Fee - fee
      const changeIdx = outputs.findIndex((o: any) => !o.address)
      if (changeIdx >= 0 && outputs[changeIdx].value >= increase) {
        outputs[changeIdx].value -= increase
        if (outputs[changeIdx].value < 5000) {
          // Change is dust — consolidate into fee
          fee = zip317Fee + outputs[changeIdx].value
          outputs.splice(changeIdx, 1)
        } else {
          fee = zip317Fee
        }
      } else if (isMax || memo) {
        // Only reduce the spend output for sendMax or swap deposits (memo present).
        // For exact-amount user sends, fail instead of silently reducing the amount.
        const spendIdx = outputs.findIndex((o: any) => o.address)
        if (spendIdx >= 0 && outputs[spendIdx].value > increase + 5000) {
          outputs[spendIdx].value -= increase
          fee = zip317Fee
        } else {
          throw new Error(`Insufficient ZEC to cover ZIP-317 minimum fee (${zip317Fee} zats for ${logicalActions} actions)`)
        }
      } else {
        throw new Error(`Insufficient ZEC to cover ZIP-317 minimum fee (${zip317Fee} zats for ${logicalActions} actions). Try sending a slightly smaller amount.`)
      }
      console.log(`${TAG} ZEC: enforced ZIP-317 fee = ${fee} zats (${logicalActions} actions, min ${zip317Fee})`)
    }
  }

  // 4. Get pubkey info — used for both address→path lookup AND change address index
  //    Aggregate across all xpubs when multi-xpub mode
  let changeAddressIndex = 0
  const addressToPath = new Map<string, string>()
  // BTC self-host: no Pioneer metadata. UTXOs already carry `path` (Blockbook/Core
  // provide it), so the address→path enrichment below is a no-op; we only need the
  // next change index. Derive it from unspent change UTXOs (path .../1/N).
  // ponytail: under-counts only if a change addr was used then fully spent → address
  // reuse (privacy), never fund loss; the collision loop below still prevents reusing
  // a live input path. Upgrade path: query the node's used-address set if reuse bites.
  const btcSelfHost = btcSelfHostActive(chain.networkId)
  // Always query primaryXpub for change-address discovery, plus all funded xpubs for path enrichment
  const queryCandidates = allXpubs?.length
    ? [{ xpub: primaryXpub, scriptType }, ...allXpubs.map(x => ({ xpub: x.xpub, scriptType: x.scriptType }))]
    : [{ xpub: primaryXpub, scriptType }]
  const xpubsToQuery = btcSelfHost ? [] : [...new Map(
    queryCandidates.map(q => [utxoDiscoveryKey(q.xpub, q.scriptType), q]),
  ).values()]
  if (btcSelfHost) {
    let maxUsed = -1
    for (const u of utxos) {
      const parts = (u.path || '').split('/')
      if (parts.length === 6 && parts[4] === '1') {
        const idx = parseInt(parts[5], 10)
        if (!isNaN(idx) && idx > maxUsed) maxUsed = idx
      }
    }
    changeAddressIndex = maxUsed + 1
    console.log(`${TAG} Self-host change index from UTXOs: ${changeAddressIndex}`)
  }
  for (const query of xpubsToQuery) {
    const qXpub = query.xpub
    const discoveryKey = utxoDiscoveryKey(qXpub, query.scriptType)
    try {
      const pubkeyInfo = (await pioneer.GetPubkeyInfo({ network: chain.networkId, xpub: discoveryKey }))?.data
      if (pubkeyInfo?.tokens) {
        let maxUsed = -1
        for (const token of pubkeyInfo.tokens) {
          if (token.path && token.name) addressToPath.set(token.name, token.path)
          if (token.path && token.address && token.address !== token.name) {
            addressToPath.set(token.address, token.path)
          }
          // Change address index — only from primary xpub's change paths
          if (qXpub === primaryXpub && token.path && token.transfers > 0) {
            const parts = token.path.split('/')
            if (parts.length === 6 && parts[4] === '1') {
              const idx = parseInt(parts[5], 10)
              if (!isNaN(idx) && idx > maxUsed) maxUsed = idx
            }
          }
        }
        if (qXpub === primaryXpub) changeAddressIndex = maxUsed + 1
      }
    } catch {
      console.warn(`${TAG} GetPubkeyInfo failed for ${qXpub.slice(0, 12)}...`)
    }
  }
  console.log(`${TAG} Built address→path lookup: ${addressToPath.size} entries (from ${xpubsToQuery.length} xpubs)`)

  // Enrich UTXOs that lack path by matching against GetPubkeyInfo
  // Strategy 1: direct address match
  // Strategy 2: scriptPubKey hex match (robust — works even when address field missing)
  //
  // Build scriptPubKeyHex → path lookup from GetPubkeyInfo tokens
  const scriptToPath = new Map<string, string>()
  for (const [addr, path] of addressToPath) {
    const spkHex = addressToScriptPubKeyHex(addr)
    if (spkHex) scriptToPath.set(spkHex, path)
  }
  console.log(`${TAG} Built scriptPubKey→path lookup: ${scriptToPath.size} entries`)

  let enriched = 0
  for (const u of utxos) {
    if (u.path) continue // already has path

    // Strategy 1: direct address field match
    if (u.address && addressToPath.has(u.address)) {
      u.path = addressToPath.get(u.address)!
      u.scriptType = getScriptTypeFromPath(u.path) || u.scriptType
      enriched++
      continue
    }

    // Strategy 2: match by scriptPubKey hex from tx.vout
    const spkHex = getUtxoScriptPubKeyHex(u)
    if (spkHex && scriptToPath.has(spkHex)) {
      u.path = scriptToPath.get(spkHex)!
      u.scriptType = getScriptTypeFromPath(u.path) || u.scriptType
      enriched++
      console.log(`${TAG} Matched UTXO ${u.txid?.slice(0, 12)}...:${u.vout} by scriptPubKey → path=${u.path}`)
      continue
    }

    // Log what we have for debugging
    console.warn(`${TAG} Could not resolve path for UTXO ${u.txid?.slice(0, 12)}...:${u.vout} addr=${u.address || 'NONE'} spk=${spkHex?.slice(0, 20) || 'NONE'}`)
  }
  if (enriched > 0) {
    console.log(`${TAG} Enriched ${enriched}/${utxos.length} UTXOs with paths from GetPubkeyInfo`)
  }
  const stillMissing = utxos.filter((u: any) => !u.path)
  if (stillMissing.length > 0) {
    console.warn(`${TAG} WARNING: ${stillMissing.length} UTXOs still missing path — will use fallback index 0`)
  }

  // Collision detection — avoid change address reusing an input path
  const MAX_GAP_LIMIT = 20
  const inputPaths = new Set(inputs.map((i: any) => i.path).filter(Boolean))
  let collisionAttempts = 0
  while (collisionAttempts < MAX_GAP_LIMIT) {
    const candidate = `m/${purpose}'/${coinType}'/${accountIndex}'/1/${changeAddressIndex}`
    if (!inputPaths.has(candidate)) break
    changeAddressIndex++
    collisionAttempts++
  }
  if (collisionAttempts >= MAX_GAP_LIMIT) {
    throw new Error(`Failed to find unused change address after ${MAX_GAP_LIMIT} attempts — gap limit exceeded`)
  }

  // Change address path — use correct account index (from accountPath or default 0)
  const changeAddressNList = accountPath
    ? [...accountPath, 1, changeAddressIndex]
    : bip32ToAddressNList(`m/${purpose}'/${coinType}'/0'/1/${changeAddressIndex}`)

  // 5. Prepare inputs/outputs for hdwallet
  const preparedInputs = inputs.map((input: any) => {
    const inputScriptType = input.scriptType || scriptType
    // Per-input accountPath: from source xpub tag (multi-xpub) or global accountPath (single-xpub)
    const inputAccountPath: number[] | undefined = input._sourceAccountPath || accountPath
    let addressNList: number[]
    if (input.path) {
      const rawNList = bip32ToAddressNList(input.path)
      if (inputAccountPath && rawNList.length === 5) {
        // Blockbook returns account-0 paths — rewrite first 3 segments to the
        // UTXO's own source account path (correct for both single- and multi-xpub)
        addressNList = [...inputAccountPath, rawNList[3], rawNList[4]]
      } else {
        addressNList = rawNList
      }
    } else {
      // No path from API — derive from this input's scriptType + account path
      const inputPurpose = PURPOSE[inputScriptType] ?? purpose
      const fb = inputAccountPath || [inputPurpose + 0x80000000, coinType + 0x80000000, 0x80000000]
      addressNList = [...fb, 0, 0]
      console.warn(`${TAG} UTXO ${input.txid?.slice(0, 12)}...:${input.vout} missing path — using fallback from scriptType=${inputScriptType}`)
    }
    return {
      addressNList,
      scriptType: inputScriptType,
      amount: String(input.value),
      vout: input.vout,
      txid: input.txid,
      hex: input.txHex || input.hex || '',
    }
  })

  const preparedOutputs: any[] = outputs
    .map((output: any) => {
      if (!output.value) return null
      if (output.address) {
        return { address: output.address, amount: String(output.value), addressType: 'spend' }
      }
      if (!isMax) {
        return {
          addressNList: changeAddressNList,
          scriptType,
          isChange: true,
          amount: String(output.value),
          addressType: 'change',
        }
      }
      return null
    })
    .filter(Boolean)

  // OP_RETURN memo — pass raw UTF-8 string as top-level opReturnData ONLY.
  // hdwallet-keepkey btcSignTx() does its own base64 encoding (line 296):
  //   Buffer.from(msg.opReturnData).toString("base64")
  // Do NOT add to preparedOutputs — hdwallet creates the output internally.
  // Do NOT pre-encode (hex/base64) — causes double-encoding → garbled on-chain.
  const memoRaw = memo && memo.trim() ? memo.trim() : undefined

  // Safety validation — prevent fee burn or empty transactions
  if (!preparedInputs.length) throw new Error('No inputs selected — cannot build transaction')
  if (!preparedOutputs.length) throw new Error('No outputs produced — funds would be burned as fee')

  const totalIn = inputs.reduce((s: number, i: any) => s + i.value, 0)
  const totalOut = outputs.filter((o: any) => o.value).reduce((s: number, o: any) => s + o.value, 0)
  if (totalIn - totalOut !== fee) {
    throw new Error(`Input/output mismatch: ${totalIn} in - ${totalOut} out ≠ ${fee} fee`)
  }

  // Log final signing payload summary
  console.log(`${TAG} Signing payload: coin=${chain.coin}, inputs=${preparedInputs.length}, outputs=${preparedOutputs.length}, fee=${fee}`)
  for (const inp of preparedInputs) {
    console.log(`${TAG}   INPUT txid=${inp.txid?.slice(0, 12)}... vout=${inp.vout} scriptType=${inp.scriptType} path=[${inp.addressNList.join(',')}] amount=${inp.amount} hasHex=${!!inp.hex}`)
  }
  for (const out of preparedOutputs) {
    console.log(`${TAG}   OUTPUT type=${out.addressType} scriptType=${out.scriptType || 'n/a'} amount=${out.amount} addr=${out.address || 'change'}`)
  }

  return {
    coin: chain.coin,
    inputs: preparedInputs,
    outputs: preparedOutputs,
    version: chain.coin === 'Zcash' ? 4 : 1,
    locktime: 0,
    ...(chain.coin === 'Zcash' ? {
      overwintered: true,
      versionGroupId: 0x892F2085,
      // Consensus branch id baked into the ZIP-243 transparent sighash. A
      // stale value makes every node reject the tx as ScriptInvalid (the
      // signature commits to the wrong branch), so this MUST track Zcash
      // network upgrades. The shielded paths get it live from the sidecar;
      // this transparent path has no sidecar dependency, hence a constant.
      // ponytail: rots at every NU activation — if ZEC sends suddenly fail
      // ScriptInvalid on all nodes, update this first (the sidecar's
      // ZcashSignPCZT log line prints the current live value).
      branchId: 0x5437f330,   // NU6.2 (current Zcash mainnet, 2026)
      expiry: 0,
    } : {}),
    fee: String(fee / 10 ** chain.decimals),
    memo,
    // opReturnData at top-level — raw UTF-8 string (hdwallet base64-encodes internally)
    ...(memoRaw ? { opReturnData: memoRaw } : {}),
  }
}
