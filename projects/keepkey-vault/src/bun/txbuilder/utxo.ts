/**
 * UTXO tx builder — simplified from pioneer-sdk/txbuilder/createUnsignedUxtoTx.ts
 *
 * Uses coinselect for coin selection, Pioneer API for UTXOs + fees.
 * Returns an object ready for hdwallet's btcSignTx().
 */
import coinSelect from 'coinselect'
// @ts-ignore — coinselect/split has no types
import coinSelectSplit from 'coinselect/split'
import type { ChainDef } from '../../shared/chains'

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
}

// SLIP-44 coin type by chain id
const COIN_TYPE: Record<string, number> = {
  bitcoin: 0, litecoin: 2, dogecoin: 3, dash: 5, bitcoincash: 145,
}

// Purpose by scriptType
const PURPOSE: Record<string, number> = {
  p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84,
}

export interface BuildUtxoParams {
  to: string
  amount: string   // human-readable (e.g. "0.001")
  memo?: string
  feeLevel?: number // 1=slow, 3=avg, 5=fast (default 5)
  isMax?: boolean
  xpub?: string    // xpub for UTXO lookup (derived by backend)
}

export async function buildUtxoTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildUtxoParams,
) {
  const { to, memo, feeLevel = 5, isMax = false, xpub } = params
  const amount = parseFloat(params.amount)

  if (!xpub) throw new Error(`${TAG} xpub required for UTXO chain ${chain.coin}`)

  const scriptType = chain.scriptType || 'p2pkh'
  const coinType = COIN_TYPE[chain.id] ?? 0
  const purpose = PURPOSE[scriptType] ?? 84

  // 1. Fetch UTXOs — Swagger param name is 'network', value is chain symbol
  console.log(`${TAG} Fetching UTXOs for ${chain.coin}...`)
  const utxosResp = await pioneer.ListUnspent({ network: chain.networkId, xpub })
  const utxos: any[] = utxosResp?.data || []
  if (!utxos.length) throw new Error(`No UTXOs found for ${chain.coin}`)

  for (const u of utxos) {
    u.value = Number(u.value)
    u.scriptType = u.scriptType || scriptType
  }

  console.log(`${TAG} Found ${utxos.length} UTXOs, total: ${utxos.reduce((s: number, u: any) => s + u.value, 0) / 1e8} ${chain.symbol}`)

  // 2. Get fee rate
  let feeRates: { slow: number; average: number; fast: number }

  if (HARDCODED_FEES[chain.networkId]) {
    feeRates = HARDCODED_FEES[chain.networkId]
  } else {
    try {
      const feeResp = pioneer.GetFeeRateByNetwork
        ? await pioneer.GetFeeRateByNetwork({ networkId: chain.networkId })
        : await pioneer.GetFeeRate({ networkId: chain.networkId })
      const data = feeResp?.data || {}

      // Detect sat/kB → convert to sat/byte
      const vals = [data.slow, data.average, data.fast, data.fastest].filter(Boolean)
      const needsConversion = vals.some((v: number) => v > 500)

      feeRates = {
        slow: (data.slow || data.average || 5) / (needsConversion ? 1000 : 1),
        average: (data.average || data.fast || 10) / (needsConversion ? 1000 : 1),
        fast: (data.fastest || data.fast || data.average || 15) / (needsConversion ? 1000 : 1),
      }
    } catch {
      feeRates = DEFAULT_FEES[chain.networkId] || { slow: 3, average: 5, fast: 15 }
      console.warn(`${TAG} Fee API failed, using defaults for ${chain.coin}`)
    }
  }

  const effectiveFeeRate = Math.max(
    3, // min relay fee
    Math.ceil(feeLevel <= 2 ? feeRates.slow : feeLevel <= 4 ? feeRates.average : feeRates.fast),
  )
  console.log(`${TAG} Fee rate: ${effectiveFeeRate} sat/vB (level=${feeLevel})`)

  // 3. Coin selection
  const satoshis = Math.round(amount * 10 ** chain.decimals)
  const result = isMax
    ? coinSelectSplit(utxos, [{ address: to }], effectiveFeeRate)
    : coinSelect(utxos, [{ address: to, value: satoshis }], effectiveFeeRate)

  if (!result?.inputs) {
    const total = utxos.reduce((s: number, u: any) => s + u.value, 0)
    if (total < satoshis) throw new Error(`Insufficient funds: have ${total / 1e8}, need ${satoshis / 1e8} ${chain.symbol}`)
    throw new Error('Coin selection failed (possibly high fees)')
  }

  let { inputs, outputs, fee } = result

  // DOGE: enforce minimum 1 DOGE fee
  if (chain.id === 'dogecoin' && fee < 100000000) {
    const increase = 100000000 - fee
    const changeIdx = outputs.findIndex((o: any) => !o.address)
    if (changeIdx >= 0 && outputs[changeIdx].value >= increase) {
      outputs[changeIdx].value -= increase
      if (outputs[changeIdx].value < 1000000) {
        fee = 100000000 + outputs[changeIdx].value
        outputs.splice(changeIdx, 1)
      } else {
        fee = 100000000
      }
    }
  }

  // 4. Get change address index
  let changeAddressIndex = 0
  try {
    const pubkeyInfo = (await pioneer.GetPubkeyInfo({ network: chain.networkId, xpub }))?.data
    if (pubkeyInfo?.tokens) {
      let maxUsed = -1
      for (const token of pubkeyInfo.tokens) {
        if (token.path && token.transfers > 0) {
          const parts = token.path.split('/')
          if (parts.length === 6 && parts[4] === '1') {
            const idx = parseInt(parts[5], 10)
            if (!isNaN(idx) && idx > maxUsed) maxUsed = idx
          }
        }
      }
      changeAddressIndex = maxUsed + 1
    }
  } catch {
    console.warn(`${TAG} GetPubkeyInfo failed, using change index 0`)
  }

  // Collision detection
  const inputPaths = new Set(inputs.map((i: any) => i.path).filter(Boolean))
  for (let attempt = 0; attempt < 20; attempt++) {
    const changePath = `m/${purpose}'/${coinType}'/0'/1/${changeAddressIndex}`
    if (!inputPaths.has(changePath)) break
    changeAddressIndex++
  }

  const changePath = `m/${purpose}'/${coinType}'/0'/1/${changeAddressIndex}`
  const changeAddressNList = bip32ToAddressNList(changePath)

  // 5. Prepare inputs/outputs for hdwallet
  const preparedInputs = inputs.map((input: any) => ({
    addressNList: input.path ? bip32ToAddressNList(input.path) : chain.defaultPath,
    scriptType: input.scriptType || scriptType,
    amount: String(input.value),
    vout: input.vout,
    txid: input.txid,
    hex: input.txHex || input.hex || '',
  }))

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

  // OP_RETURN memo
  if (memo && memo.trim()) {
    preparedOutputs.push({
      amount: '0',
      addressType: 'opreturn',
      opReturnData: memo,
    })
  }

  return {
    coin: chain.coin,
    inputs: preparedInputs,
    outputs: preparedOutputs,
    fee: String(fee),
    memo,
    // opReturnData at top-level for v1 server contract
    ...(memo && memo.trim() ? { opReturnData: memo } : {}),
  }
}
