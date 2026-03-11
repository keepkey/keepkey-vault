/**
 * UTXO tx builder — simplified from pioneer-sdk/txbuilder/createUnsignedUxtoTx.ts
 *
 * Uses coinselect for coin selection, Pioneer API for UTXOs + fees.
 * Returns an object ready for hdwallet's btcSignTx().
 */
import coinSelect from 'coinselect'
// @ts-ignore — coinselect/split has no types
import coinSelectSplit from 'coinselect/split'
// @ts-ignore — bech32 has no default export types for Bun
import * as bech32 from 'bech32'
// @ts-ignore
import bs58check from 'bs58check'
import type { ChainDef } from '../../shared/chains'

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
}

// SLIP-44 coin type by chain id
const COIN_TYPE: Record<string, number> = {
  bitcoin: 0, litecoin: 2, dogecoin: 3, dash: 5, bitcoincash: 145,
}

// Purpose by scriptType
const PURPOSE: Record<string, number> = {
  p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84,
}

// Reverse: purpose → scriptType (for deriving scriptType from UTXO paths)
const PURPOSE_TO_SCRIPT: Record<number, string> = {
  44: 'p2pkh', 49: 'p2sh-p2wpkh', 84: 'p2wpkh',
}

// Convert a Bitcoin address to its scriptPubKey hex (for matching UTXOs by script)
function addressToScriptPubKeyHex(address: string): string | undefined {
  try {
    if (address.startsWith('bc1') || address.startsWith('tb1') ||
        address.startsWith('ltc1') || address.startsWith('tltc1')) {
      // Bech32 (native segwit p2wpkh or p2wsh)
      const decoded = bech32.decode(address)
      const program = bech32.fromWords(decoded.words.slice(1))
      const hex = Buffer.from(Uint8Array.from(program)).toString('hex')
      if (program.length === 20) return `0014${hex}` // p2wpkh
      if (program.length === 32) return `0020${hex}` // p2wsh
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

export interface BuildUtxoParams {
  to: string
  amount: string   // human-readable (e.g. "0.001")
  memo?: string
  feeLevel?: number // 1=slow, 3=avg, 5=fast (default 5)
  isMax?: boolean
  xpub?: string    // xpub for UTXO lookup (derived by backend)
  scriptTypeOverride?: string // BTC multi-account: override chain default scriptType
  accountPath?: number[] // BTC multi-account: account-level path [purpose+H, coinType+H, account+H]
}

export async function buildUtxoTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildUtxoParams,
) {
  const { to, memo, feeLevel = 5, isMax = false, xpub, scriptTypeOverride, accountPath } = params

  if (!xpub) throw new Error(`${TAG} xpub required for UTXO chain ${chain.coin}`)

  // scriptType resolution: explicit override > xpub prefix > chain default > p2pkh
  const scriptType = scriptTypeOverride || getScriptTypeFromXpub(xpub) || chain.scriptType || 'p2pkh'
  console.log(`${TAG} scriptType=${scriptType} (override=${scriptTypeOverride}, xpub-prefix=${getScriptTypeFromXpub(xpub)}, chain-default=${chain.scriptType})`)
  const coinType = COIN_TYPE[chain.id] ?? 0
  const purpose = PURPOSE[scriptType] ?? 84

  // Account index: extract from accountPath if provided (for BTC multi-account)
  // accountPath is [purpose+H, coinType+H, account+H] — account index is element[2] minus hardened flag
  const accountIndex = accountPath ? (accountPath[2] - 0x80000000) : 0
  if (accountPath) {
    console.log(`${TAG} Using accountPath=[${accountPath.join(',')}] → accountIndex=${accountIndex}`)
  }

  // 1. Fetch UTXOs — Pioneer API 'network' param expects Chain enum (BTC, LTC, etc.), not CAIP-2 networkId
  console.log(`${TAG} Fetching UTXOs: network=${chain.chain}, xpub=${xpub?.slice(0, 20)}...`)
  const utxosResp = await pioneer.ListUnspent({ network: chain.chain, xpub })
  const utxos: any[] = utxosResp?.data || []
  if (!utxos.length) throw new Error(`No UTXOs found for ${chain.coin}`)

  for (const u of utxos) {
    u.value = Number(u.value)
    // Per-UTXO scriptType: prefer UTXO's own → derive from path → global default
    u.scriptType = u.scriptType || (u.path ? getScriptTypeFromPath(u.path) : undefined) || scriptType
  }

  // Diagnostic: dump raw UTXO[0] to see exactly what Pioneer returns
  if (utxos.length > 0) {
    console.log(`${TAG} UTXO[0] keys: ${Object.keys(utxos[0]).join(', ')}`)
    // Dump non-tx fields (tx is huge) to see what blockbook returns
    const { tx, hex, ...utxoMeta } = utxos[0]
    console.log(`${TAG} UTXO[0] meta: ${JSON.stringify(utxoMeta)}`)
  }
  console.log(`${TAG} Found ${utxos.length} UTXOs, total: ${utxos.reduce((s: number, u: any) => s + u.value, 0) / 1e8} ${chain.symbol}`)
  for (const u of utxos) {
    console.log(`${TAG}   UTXO ${u.txid?.slice(0, 12)}...:${u.vout} value=${u.value} scriptType=${u.scriptType} path=${u.path || 'NONE'} addr=${u.address || 'NONE'} hasHex=${!!u.hex || !!u.txHex}`)
  }

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

  // 4. Get pubkey info — used for both address→path lookup AND change address index
  let changeAddressIndex = 0
  const addressToPath = new Map<string, string>()
  try {
    const pubkeyInfo = (await pioneer.GetPubkeyInfo({ network: chain.chain, xpub }))?.data
    if (pubkeyInfo?.tokens) {
      let maxUsed = -1
      for (const token of pubkeyInfo.tokens) {
        // Build address→path lookup for UTXO path enrichment
        if (token.path && token.name) {
          addressToPath.set(token.name, token.path)
        }
        // Also index by 'address' field if present (some API versions use different field names)
        if (token.path && token.address && token.address !== token.name) {
          addressToPath.set(token.address, token.path)
        }
        // Change address index calculation (only change paths: .../1/N)
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
    console.log(`${TAG} Built address→path lookup: ${addressToPath.size} entries`)
  } catch {
    console.warn(`${TAG} GetPubkeyInfo failed, using change index 0 and no address→path lookup`)
  }

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
  // Fallback path when UTXO has no path: use scriptType-derived purpose with correct account index
  const fallbackBasePath = accountPath
    ? [...accountPath, 0, 0]
    : [purpose + 0x80000000, coinType + 0x80000000, 0x80000000, 0, 0]
  const preparedInputs = inputs.map((input: any) => {
    const inputScriptType = input.scriptType || scriptType
    let addressNList: number[]
    if (input.path) {
      const rawNList = bip32ToAddressNList(input.path)
      if (accountPath && rawNList.length === 5) {
        // Blockbook always returns account 0 in paths — replace first 3 segments
        // with the correct account-level path (which has the real account index)
        addressNList = [...accountPath, rawNList[3], rawNList[4]]
      } else {
        addressNList = rawNList
      }
    } else {
      // No path from API — use scriptType-derived base path
      console.warn(`${TAG} UTXO ${input.txid?.slice(0, 12)}...:${input.vout} missing path — using fallback`)
      addressNList = fallbackBasePath
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

  // OP_RETURN memo — hex-encode for hdwallet-keepkey protobuf layer
  const memoHex = memo && memo.trim()
    ? Buffer.from(memo.trim(), 'utf8').toString('hex')
    : undefined
  if (memoHex) {
    preparedOutputs.push({
      amount: '0',
      addressType: 'opreturn',
      opReturnData: memoHex,
    })
  }

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
    console.log(`${TAG}   OUTPUT type=${out.addressType} scriptType=${out.scriptType || 'n/a'} amount=${out.amount} addr=${out.address?.slice(0, 20) || 'change'}`)
  }

  return {
    coin: chain.coin,
    inputs: preparedInputs,
    outputs: preparedOutputs,
    version: 1,    // keepkey-desktop always passes these explicitly
    locktime: 0,
    fee: String(fee / 10 ** chain.decimals),
    memo,
    // opReturnData at top-level for v1 server contract (hex-encoded)
    ...(memoHex ? { opReturnData: memoHex } : {}),
  }
}
