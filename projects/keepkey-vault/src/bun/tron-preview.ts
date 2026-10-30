import { createHash } from 'node:crypto'
import protobuf from 'protobufjs/light'
import bs58 from 'bs58'
import type { SigningRequestInfo, TronCallPreview, TronTxPreview } from '../shared/types'
import { versionCompare } from '../shared/firmware-versions'

type Value = { wire: number; bytes?: Buffer; number?: bigint }
function fields(bytes: Buffer, allowed: Record<number, number>): Map<number, Value> {
  const reader = new protobuf.Reader(bytes)
  const out = new Map<number, Value>()
  while (reader.pos < reader.len) {
    const tag = reader.uint32(), field = tag >>> 3, wire = tag & 7
    if (allowed[field] !== wire || out.has(field)) throw Error('Unsupported or duplicate TRON field')
    out.set(field, wire === 2
      ? { wire, bytes: Buffer.from(reader.bytes()) }
      : { wire, number: BigInt(reader.uint64().toString()) })
  }
  return out
}
function bytes(f: Map<number, Value>, n: number): Buffer {
  const b = f.get(n)?.bytes
  if (!b) throw Error(`Missing TRON bytes field ${n}`)
  return b
}
function number(f: Map<number, Value>, n: number): bigint {
  const v = f.get(n)?.number
  if (v === undefined) throw Error(`Missing TRON number field ${n}`)
  return v
}
function address(raw: Buffer): string {
  if (raw.length !== 21 || raw[0] !== 0x41) throw Error('Invalid TRON address')
  const hash = (b: Buffer) => createHash('sha256').update(b).digest()
  return bs58.encode(Buffer.concat([raw, hash(hash(raw)).subarray(0, 4)]))
}
function human(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals)
  const fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${raw / scale}${fraction ? `.${fraction}` : ''}`
}

/** Canonical base58check TRON address, or null. Lowercasing base58 breaks the
 * checksum, so a case-damaged address can never pass. */
export function canonicalTronAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const decoded = Buffer.from(bs58.decode(value))
    if (decoded.length !== 25) return null
    const canonical = address(decoded.subarray(0, 21))
    return canonical === value ? canonical : null
  } catch { return null }
}

export interface TronTransfer {
  kind: 'TRX transfer' | 'TRC-20 transfer'
  owner: string
  to: string
  units: bigint
  tokenContract?: string
  memo?: Buffer
  feeLimit?: bigint
}

/** Decode a single plain TRX or TRC-20 transfer from the exact raw_data bytes
 * the device signs. Throws on anything else (fail closed like firmware
 * tron_parseRawTx). */
export function decodeTronTransfer(rawHex: string): TronTransfer {
  if (!/^(?:0x)?(?:[0-9a-fA-F]{2})+$/.test(rawHex)) throw Error('TRON raw_data is not hex')
  const raw = Buffer.from(rawHex.replace(/^0x/i, ''), 'hex')
  const top = fields(raw, { 1: 2, 3: 0, 4: 2, 8: 0, 10: 2, 11: 2, 14: 0, 18: 0 })
  const contract = fields(bytes(top, 11), { 1: 0, 2: 2 })
  const kind = Number(number(contract, 1))
  const any = fields(bytes(contract, 2), { 1: 2, 2: 2 })
  const url = bytes(any, 1).toString('utf8')
  const payload = bytes(any, 2)
  const memo = top.has(10) ? bytes(top, 10) : undefined
  const feeLimit = top.has(18) ? number(top, 18) : undefined
  if (kind === 1 && url.endsWith('/protocol.TransferContract')) {
    const transfer = fields(payload, { 1: 2, 2: 2, 3: 0 })
    return { kind: 'TRX transfer', owner: address(bytes(transfer, 1)), to: address(bytes(transfer, 2)),
      units: number(transfer, 3), memo, feeLimit }
  }
  if (kind === 31 && url.endsWith('/protocol.TriggerSmartContract')) {
    const trigger = fields(payload, { 1: 2, 2: 2, 3: 0, 4: 2 })
    if (trigger.has(3) && number(trigger, 3) !== 0n) throw Error('TRC-20 call carries TRX call_value')
    const call = bytes(trigger, 4)
    if (call.length !== 68 || call.subarray(0, 4).toString('hex') !== 'a9059cbb' ||
        call.subarray(4, 15).some(v => v !== 0) || ![0, 0x41].includes(call[15])) throw Error('Not a TRC-20 transfer(address,uint256) call')
    return { kind: 'TRC-20 transfer', owner: address(bytes(trigger, 1)), tokenContract: address(bytes(trigger, 2)),
      to: address(Buffer.concat([Buffer.from([0x41]), call.subarray(16, 36)])),
      units: BigInt(`0x${call.subarray(36).toString('hex')}`), memo, feeLimit }
  }
  throw Error(`Unsupported TRON contract type ${kind}`)
}

/** Firmware v7.16.0 scripts/tron_tokens.json, the table fsm_msgTronSignTx
 *  clear-signs TRC-20 transfers for. Deployed on mainnet (TronGrid
 *  wallet/getcontract, 2026-10-29). */
const TRON_FIRMWARE_TOKENS = new Set([
  'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT
  'TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz', // USDD 2.0
  'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', // WTRX
])
/** First firmware that parses TRON raw_data. 7.14.x blind-signs every TronSignTx. */
const TRON_PARSER_MIN_FW = '7.16.0'

/** The device shows this transaction from its own parse: a plain TRX transfer,
 *  or a TRC-20 transfer of a token in its table. Anything else (another
 *  contract, a TRC-20 outside the table, older firmware, an unknown version)
 *  is "TRON Blind Sign" behind AdvancedMode. */
export function tronShownNatively(rawTx: unknown, firmwareVersion: string | undefined): boolean {
  if (!firmwareVersion || versionCompare(firmwareVersion.replace(/^v/, ''), TRON_PARSER_MIN_FW) < 0) return false
  const hex = rawTx instanceof Uint8Array ? Buffer.from(rawTx).toString('hex') : rawTx
  if (typeof hex !== 'string') return false
  try {
    const { kind, tokenContract } = decodeTronTransfer(hex)
    return kind === 'TRX transfer' || TRON_FIRMWARE_TOKENS.has(tokenContract!)
  } catch { return false }
}

/** The REST /tron/sign-transaction approval card: what this computer reads
 *  from the signed raw_data bytes, and the AdvancedMode gate from what this
 *  firmware reads. A transfer decoded here is not one the device shows:
 *  7.14/7.15 blind-sign every TRON transaction, and 7.16 shows only TRX and
 *  the TRC-20 tokens in its own table. */
export function applyTronSigningPreview(info: SigningRequestInfo, rawTx: unknown, firmwareVersion: string | undefined): void {
  info.chain = 'tron'
  info.tronDecoded = tronPreview(rawTx) ?? undefined
  if (info.tronDecoded) {
    info.from = info.tronDecoded.owner
    info.to = info.tronDecoded.to
    info.value = info.tronDecoded.amount
  } else {
    // The device shows this as raw data; say what it does here.
    info.tronCall = tronCallPreview(rawTx) ?? undefined
    if (info.tronCall) info.from = info.tronCall.owner
  }
  const shown = tronShownNatively(rawTx, firmwareVersion)
  info.needsBlindSigning = !shown
  info.requiresAdvancedMode = !shown
}

/** Fail closed like firmware tron_parseRawTx. Only a single plain TRX or
 * TRC-20 transfer earns a human summary; all displayed values come from the
 * exact protobuf raw_data bytes signed by the device. */
export function tronPreview(rawHex: unknown): TronTxPreview | null {
  if (typeof rawHex !== 'string') return null
  try {
    const { kind, owner, to, units, tokenContract, memo: memoBytes, feeLimit } = decodeTronTransfer(rawHex)
    const amount = kind === 'TRX transfer' ? `${human(units, 6)} TRX`
      : tokenContract === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
        ? `${human(units, 6)} USDT` : `${units} base units (unverified token)`
    const memo = memoBytes ? new TextDecoder('utf-8', { fatal: true }).decode(memoBytes) : undefined
    if (memo?.includes('\0')) return null
    const preview: TronTxPreview = {
      kind, owner, to, amount, tokenContract, memo,
      feeLimit: feeLimit !== undefined ? `${human(feeLimit, 6)} TRX` : undefined,
      warning: 'Swap terms come from the signed memo. The destination and settlement outcome are not independently verified here.',
    }
    const parts = memo?.split(':')
    if (parts && (parts[0] === '=' || parts[0] === 'SWAP') && parts[1] && parts[2]) {
      preview.outputAsset = parts[1]
      preview.outputDestination = parts[2]
      const symbol = parts[1].split('.')[1]?.split('-')[0] || parts[1]
      preview.minimumOutput = parts[3] && /^\d+$/.test(parts[3])
        ? `${human(BigInt(parts[3]), 8)} ${symbol}` : 'NO MINIMUM IN SIGNED MEMO'
      if (parts[5] && /^\d+$/.test(parts[5])) preview.affiliateFee = `${(Number(parts[5]) / 100).toFixed(2)}%`
    }
    return preview
  } catch { return null }
}

// TRON contracts this computer names. Each: SUN.io's own announcement and a
// /wallet/getcontract on api.trongrid.io (2026-10-29) returning bytecode and
// the contract name shown here.
const TRON_CONTRACT_NAMES: Record<string, string> = {
  // https://sunio.zendesk.com/hc/en-us/articles/54899665032601 (Permit2 + Universal Router)
  TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9: 'SunSwap Permit2',
  TSJEtPuqHpvSaVnSwvCsngaeBxrGUzp95Q: 'SunSwap Universal Router',
  // https://sunio.zendesk.com/hc/en-us/articles/37839082907545 (SmartExchangeRouter)
  TJ4NNy8xZEqsowCBhLvZ45LCqPdGjkET5j: 'SunSwap Smart Router',
}
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const RESOURCES = ['bandwidth', 'energy', 'TRON Power']
/** uint96 max: at or above it an allowance is not a bound (as clearsign-risk). */
const BOUND_LIMIT = (1n << 96n) - 1n

/** A 32-byte ABI address word: 11 zero bytes, then 0x00 or 0x41 (tooling
 * puts the TRON prefix there; the TVM reads the low 160 bits), then 20 bytes. */
function addressWord(word: Buffer): string {
  if (word.length !== 32 || word.subarray(0, 11).some(v => v !== 0) || ![0, 0x41].includes(word[11])) throw Error('Not an address word')
  return address(Buffer.from(`41${word.subarray(12).toString('hex')}`, 'hex'))
}

/** A TRC-20 amount, named only for USDT; address(0) is TRX in a SunSwap path. */
function tronTokenAmount(units: bigint, token: string | null): string {
  if (token === null) return `${human(units, 6)} TRX`
  return token === USDT_TRC20 ? `${human(units, 6)} USDT` : `${units} base units of token ${token}`
}

/** SmartExchangeRouter swapExactInput(address[] path, string[] poolVersion,
 * uint256[] versionLen, uint24[] fees, SwapData data), selector cef95229, with
 * SwapData = (amountIn, amountOutMin, to, deadline) inline after the four
 * array offsets. Layout per SUN.io's router source,
 * https://github.com/sun-protocol/smart-exchange-router/blob/main/contracts/SmartExchangeRouter.sol
 * (path[0] is spent, the last path token goes to `to`; address(0) is TRX).
 * null for anything else or anything that does not read in full. */
function sunSwapExactInput(call: Buffer) {
  try {
    if (call.length < 4 + 8 * 32 || call.subarray(0, 4).toString('hex') !== 'cef95229') return null
    const uint = (at: number) => {
      if (at + 32 > call.length) throw Error('Call data too short')
      return BigInt(`0x${call.subarray(at, at + 32).toString('hex')}`)
    }
    const token = (at: number) => (uint(at) === 0n ? null : addressWord(call.subarray(at, at + 32)))
    const pathOffset = uint(4)
    if (pathOffset > BigInt(call.length)) return null
    const pathAt = 4 + Number(pathOffset)
    const n = uint(pathAt)
    if (n < 2n || n > 16n) return null
    const tokenIn = token(pathAt + 32), tokenOut = token(pathAt + 32 * Number(n))
    const amountIn = uint(4 + 4 * 32), amountOutMin = uint(4 + 5 * 32)
    return {
      amountIn: tronTokenAmount(amountIn, tokenIn), amountOutMin: tronTokenAmount(amountOutMin, tokenOut),
      noMinimum: amountOutMin === 0n, to: addressWord(call.subarray(4 + 6 * 32, 4 + 7 * 32)),
      trxIn: tokenIn === null ? amountIn : undefined,
    }
  } catch { return null }
}

/** What a TRON transaction the firmware shows only as raw data does, read
 * from the exact raw_data bytes. Advice for the approval card, never a gate:
 * null for anything it does not parse in full (one contract, no unknown
 * fields), and REST keeps the AdvancedMode requirement either way. */
export function tronCallPreview(rawHex: unknown): TronCallPreview | null {
  if (typeof rawHex !== 'string' || !/^(?:0x)?(?:[0-9a-fA-F]{2})+$/.test(rawHex)) return null
  try {
    const raw = Buffer.from(rawHex.replace(/^0x/i, ''), 'hex')
    const top = fields(raw, { 1: 2, 3: 0, 4: 2, 8: 0, 10: 2, 11: 2, 14: 0, 18: 0 })
    const contract = fields(bytes(top, 11), { 1: 0, 2: 2 })
    const kind = Number(number(contract, 1))
    const any = fields(bytes(contract, 2), { 1: 2, 2: 2 })
    const url = bytes(any, 1).toString('utf8')
    const payload = bytes(any, 2)
    const is = (name: string) => url === `type.googleapis.com/protocol.${name}`
    const trx = (sun: bigint) => `${human(sun, 6)} TRX`
    const resource = (f: Map<number, Value>) => RESOURCES[Number(f.get(2)?.number ?? 0n)] ?? 'an unknown resource'
    if (kind === 31 && is('TriggerSmartContract')) {
      const t = fields(payload, { 1: 2, 2: 2, 3: 0, 4: 2 })
      const owner = address(bytes(t, 1)), target = address(bytes(t, 2))
      const call = t.get(4)?.bytes ?? Buffer.alloc(0)
      const callValue = t.get(3)?.number ?? 0n
      if (callValue === 0n && call.length === 68 && call.subarray(0, 4).toString('hex') === '095ea7b3') {
        const spender = addressWord(call.subarray(4, 36))
        const units = BigInt(`0x${call.subarray(36).toString('hex')}`)
        const usdt = target === USDT_TRC20
        return {
          kind: 'TRC-20 approve', owner, token: target, tokenSymbol: usdt ? 'USDT' : undefined,
          spender, spenderName: TRON_CONTRACT_NAMES[spender],
          amount: usdt ? `${human(units, 6)} USDT` : `${units} base units of token ${target}`,
          unlimited: units >= BOUND_LIMIT, revoke: units === 0n,
        }
      }
      const swap = TRON_CONTRACT_NAMES[target] === 'SunSwap Smart Router' ? sunSwapExactInput(call) : null
      if (swap) {
        const { trxIn, ...rest } = swap
        // TRX in is paid as the call value; anything else sent along is extra.
        return { kind: 'SunSwap swap', owner, contract: target, contractName: TRON_CONTRACT_NAMES[target], ...rest,
          callValue: callValue > 0n && callValue !== trxIn ? trx(callValue) : undefined }
      }
      return { kind: 'Contract call', owner, contract: target, contractName: TRON_CONTRACT_NAMES[target],
        callValue: callValue > 0n ? trx(callValue) : undefined }
    }
    if (kind === 54 && is('FreezeBalanceV2Contract')) {
      const f = fields(payload, { 1: 2, 2: 0, 3: 0 })
      return { kind: 'Stake TRX', owner: address(bytes(f, 1)), amount: trx(number(f, 2)), resource: RESOURCES[Number(f.get(3)?.number ?? 0n)] ?? 'an unknown resource' }
    }
    if (kind === 55 && is('UnfreezeBalanceV2Contract')) {
      const f = fields(payload, { 1: 2, 2: 0, 3: 0 })
      return { kind: 'Unstake TRX', owner: address(bytes(f, 1)), amount: trx(number(f, 2)), resource: RESOURCES[Number(f.get(3)?.number ?? 0n)] ?? 'an unknown resource' }
    }
    if (kind === 56 && is('WithdrawExpireUnfreezeContract')) {
      return { kind: 'Withdraw unstaked TRX', owner: address(bytes(fields(payload, { 1: 2 }), 1)) }
    }
    if (kind === 13 && is('WithdrawBalanceContract')) {
      return { kind: 'Claim voting rewards', owner: address(bytes(fields(payload, { 1: 2 }), 1)) }
    }
    if (kind === 57 && is('DelegateResourceContract')) {
      const f = fields(payload, { 1: 2, 2: 0, 3: 0, 4: 2, 5: 0, 6: 0 })
      return { kind: 'Delegate resources', owner: address(bytes(f, 1)), resource: resource(f), amount: trx(number(f, 3)),
        receiver: address(bytes(f, 4)), locked: (f.get(5)?.number ?? 0n) !== 0n }
    }
    if (kind === 58 && is('UnDelegateResourceContract')) {
      const f = fields(payload, { 1: 2, 2: 0, 3: 0, 4: 2 })
      return { kind: 'Reclaim delegated resources', owner: address(bytes(f, 1)), resource: resource(f), amount: trx(number(f, 3)), receiver: address(bytes(f, 4)) }
    }
    if (kind === 4 && is('VoteWitnessContract')) {
      // votes is a repeated field, so it is read here rather than by fields().
      const reader = new protobuf.Reader(new Uint8Array(payload))
      let owner: string | undefined
      const votes: { witness: string; count: string }[] = []
      while (reader.pos < reader.len) {
        const tag = reader.uint32()
        if (tag === 10 && !owner) owner = address(Buffer.from(reader.bytes()))
        else if (tag === 18) {
          const v = fields(Buffer.from(reader.bytes()), { 1: 2, 2: 0 })
          votes.push({ witness: address(bytes(v, 1)), count: number(v, 2).toString() })
        } else throw Error('Unsupported VoteWitness field')
      }
      if (!owner || votes.length === 0) return null
      return { kind: 'Vote', owner, votes }
    }
    return null
  } catch { return null }
}
