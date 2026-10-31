/**
 * EIP-712 typed data decoder — extracts human-readable fields for signing approval UI.
 *
 * Two tiers:
 * 1. Known descriptors (Permit2, ERC-2612 Permit, DAI Permit) matched by contract + primaryType
 * 2. Generic fallback — reads types[primaryType] and auto-detects format from Solidity type names
 */
import type { EIP712DecodedField, EIP712DecodedInfo } from '../shared/types'
import { utils as ethersUtils } from 'ethers'
import { evmChainLabel } from '../shared/chains'
import { evmTokenIdentity } from '../shared/evm-contract-identity'
import { amountWithDecimals } from '../shared/erc20Preview'
import { OPENSEA_CONDUIT_KEY, OPENSEA_FEE_RECIPIENT, SEAPORT_1_6, SEAPORT_1_6_CHAINS } from '../shared/nft-marketplaces'

// ── Helpers ──────────────────────────────────────────────────────────────

function humanizeFieldName(name: string): string {
  // camelCase → Title Case: "maxFeePerGas" → "Max Fee Per Gas"
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
}

function autoDetectFormat(solidityType: string, fieldName: string): EIP712DecodedField['format'] {
  const lowerName = fieldName.toLowerCase()
  if (solidityType === 'address') return 'address'
  if (solidityType.startsWith('bytes')) return 'hex'
  if (solidityType.startsWith('uint') || solidityType.startsWith('int')) {
    if (lowerName.includes('expir') || lowerName.includes('deadline') || lowerName.includes('validto') || lowerName.includes('validuntil')) {
      return 'datetime'
    }
    if (lowerName.includes('amount') || lowerName.includes('value') || lowerName.includes('nonce')) {
      return 'amount'
    }
    return 'raw'
  }
  return 'raw'
}

function formatValue(val: any, format: EIP712DecodedField['format']): string {
  if (val === undefined || val === null) return ''
  const str = String(val)

  switch (format) {
    case 'address':
      return str.length === 42 ? str : str
    case 'datetime': {
      const n = Number(str)
      if (!n || n > 1e15) return str // already ms or invalid
      try {
        return new Date(n * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
      } catch {
        return str
      }
    }
    case 'amount':
      return str
    case 'hex':
      return str.length > 66 ? str.slice(0, 66) + '...' : str
    default:
      return str.length > 200 ? str.slice(0, 200) + '...' : str
  }
}

// ── Known type descriptors ───────────────────────────────────────────────

const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3'

interface KnownDescriptor {
  match: (typedData: any) => boolean
  operationName: string
  extract: (message: any, typedData: any, signer?: string) => EIP712DecodedField[]
  protocolIdentity?: (typedData: any, message: any) => boolean
  seaportListing?: (typedData: any) => EIP712DecodedInfo['seaportListing']
  seaportItems?: (typedData: any) => EIP712DecodedInfo['seaportItems']
}

function exactFields(typedData: any, typeName: string, expected: Array<[string, string]>): boolean {
  const fields = typedData.types?.[typeName]
  return Array.isArray(fields) && fields.length === expected.length &&
    expected.every(([name, type], index) => fields[index]?.name === name && fields[index]?.type === type)
}

const isPermit2 = (typedData: any) =>
  typedData.domain?.verifyingContract?.toLowerCase() === PERMIT2_ADDRESS

const UNISWAPX_REACTORS: Record<string, Record<number, string[]>> = {
  V3DutchOrder: {
    1: ['0x0000000015757c461808ea25eb309638b62681cf'], 10: ['0x000000000923439a92dae8930613568824108631'],
    56: ['0x00000000a55e50c71b70db3c8b58749cd1e18eb2'], 130: ['0x000000005af66799d1a6317714d66800f9ca1406'],
    137: ['0x00000000bab6e234db8ad638b6a6395b7c499bc4'], 143: ['0x000000000ac008f7e07210cfb6648e40249232c2'],
    196: ['0x000000005af66799d1a6317714d66800f9ca1406'], 480: ['0x00000000d714ea34028930b762e96bfbe50f42c2'],
    1868: ['0x000000005af66799d1a6317714d66800f9ca1406'], 4217: ['0x00000000fc1e66c9f582566ead00108e55f1c0c6'],
    4663: ['0x000000007a1c8e570011eedf86a2a35593013cba'], 5042: ['0x0000000015134054ea82ae0bb9fda66b36402c36'],
    8453: ['0x000000008a8330b5d1f43a62bf4c673a49f27ba0'], 42161: ['0xb274d5f4b833b61b340b654d600a864fb604a87c'],
    42220: ['0x00000000b8077fdf2281a80be96f6c282b5d943a'], 43114: ['0x00000000862ccf095823fc7576fa6c7e6b7385ef'],
    81457: ['0x0000000086f50c5e1a2500602183d4390a7ffc98'], 7777777: ['0x000000002c9a3812e15cf233190992e9a57edb56'],
  },
  ExclusiveDutchOrder: { 1: ['0x6000da47483062a0d734ba3dc7576ce6a0b645c4'], 137: ['0x6000da47483062a0d734ba3dc7576ce6a0b645c4'] },
  V2DutchOrder: { 1: ['0x00000011f84b9aa48e5f8aa8b9897600006289be'], 42161: ['0x1bd1aadc9e230626c44a139d7e70d842749351eb'] },
  PriorityOrder: { 130: ['0x00000006021a6bce796be7ba509bbba71e956e37'], 8453: ['0x000000001ec5656dcdb24d90dfa42742738de729'] },
  HybridOrder: { 1301: ['0x000000000c75276d956cc35218ca8f132d877957'] },
}

function verifiedUniswapXReactor(type: string, td: any, message: any): boolean {
  const chainId = Number(td.domain?.chainId)
  const reactor = String(message.witness?.info?.reactor || '').toLowerCase()
  const spender = String(message.spender || '').toLowerCase()
  return reactor === spender && Boolean(UNISWAPX_REACTORS[type]?.[chainId]?.includes(reactor))
}

function tokenPermissionFields(message: any, batch: boolean): EIP712DecodedField[] {
  const permitted = batch
    ? (Array.isArray(message.permitted) ? message.permitted : [])
    : message.permitted ? [message.permitted] : []
  const fields: EIP712DecodedField[] = []
  permitted.forEach((item: any, index: number) => {
    const prefix = permitted.length > 1 ? `[${index + 1}] ` : ''
    fields.push(
      { label: `${prefix}Token`, value: formatValue(item.token, 'address'), format: 'address', raw: item.token },
      { label: `${prefix}Maximum Amount`, value: formatValue(item.amount, 'amount'), format: 'amount', raw: item.amount },
    )
  })
  fields.push(
    { label: 'Spender', value: formatValue(message.spender, 'address'), format: 'address', raw: message.spender },
    { label: 'Nonce', value: formatValue(message.nonce, 'raw'), format: 'raw', raw: message.nonce },
    { label: 'Deadline', value: formatValue(message.deadline, 'datetime'), format: 'datetime', raw: message.deadline },
  )
  return fields
}

const ORDER_INFO_FIELDS: Array<[string, string]> = [
  ['reactor', 'address'], ['swapper', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256'],
  ['additionalValidationContract', 'address'], ['additionalValidationData', 'bytes'],
]

function exactPermitWitnessEnvelope(td: any, witnessType: string): boolean {
  if (!isPermit2(td) || td.primaryType !== 'PermitWitnessTransferFrom' ||
    !exactFields(td, 'TokenPermissions', [['token', 'address'], ['amount', 'uint256']])) return false
  return exactFields(td, 'PermitWitnessTransferFrom', [
    ['permitted', 'TokenPermissions'], ['spender', 'address'], ['nonce', 'uint256'],
    ['deadline', 'uint256'], ['witness', witnessType],
  ])
}

function exactWitnessEnvelope(td: any, witnessType: string): boolean {
  return exactPermitWitnessEnvelope(td, witnessType) && exactFields(td, 'OrderInfo', ORDER_INFO_FIELDS)
}

function orderInfoFields(witness: any): EIP712DecodedField[] {
  const info = witness?.info || {}
  return [
    { label: 'Reactor / Spender', value: formatValue(info.reactor, 'address'), format: 'address', raw: info.reactor },
    { label: 'Swapper', value: formatValue(info.swapper, 'address'), format: 'address', raw: info.swapper },
    { label: 'Order Deadline', value: formatValue(info.deadline, 'datetime'), format: 'datetime', raw: info.deadline },
    { label: 'Order Nonce', value: formatValue(info.nonce, 'raw'), format: 'raw', raw: info.nonce },
    { label: 'Extra Validation Contract', value: formatValue(info.additionalValidationContract, 'address'), format: 'address', raw: info.additionalValidationContract },
  ]
}

function outputFields(outputs: any[], amountKeys: string[]): EIP712DecodedField[] {
  const fields: EIP712DecodedField[] = []
  ;(Array.isArray(outputs) ? outputs : []).forEach((output: any, index: number) => {
    const prefix = `Output ${index + 1}`
    fields.push(
      { label: `${prefix} Token`, value: formatValue(output.token, 'address'), format: 'address', raw: output.token },
      ...amountKeys.map(key => ({
        label: `${prefix} ${humanizeFieldName(key)}`,
        value: formatValue(output[key], 'amount'), format: 'amount' as const, raw: output[key],
      })),
      { label: `${prefix} Recipient`, value: formatValue(output.recipient, 'address'), format: 'address', raw: output.recipient },
    )
  })
  return fields
}

function uniswapXBaseFields(message: any, inputToken: any, inputAmounts: Array<[string, any]>, outputs: any[], outputAmounts: string[]): EIP712DecodedField[] {
  const witness = message.witness || {}
  return [
    ...tokenPermissionFields(message, false),
    ...orderInfoFields(witness),
    { label: 'Input Token', value: formatValue(inputToken, 'address'), format: 'address', raw: inputToken },
    ...inputAmounts.map(([label, value]) => ({ label, value: formatValue(value, 'amount'), format: 'amount' as const, raw: value })),
    ...outputFields(outputs, outputAmounts),
  ]
}

function toBig(raw: unknown): bigint | undefined {
  const s = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  return /^\d+$/.test(s) ? BigInt(s) : /^0x[0-9a-fA-F]+$/.test(s) ? BigInt(s) : undefined
}

/** An amount in whole units with its symbol: the chain's coin when `native`,
 *  else a catalogued token. Base units and the address when neither is known. */
function tokenUnits(chainId: number, token: unknown, raw: unknown, native = false): string {
  const amount = toBig(raw)
  if (amount === undefined) return String(raw ?? '')
  const coin = native ? evmChainLabel(chainId)?.symbol : undefined
  if (coin) return `${amountWithDecimals(amount, 18)} ${coin}`
  const t = !native && typeof token === 'string' && /^0x[0-9a-fA-F]{40}$/.test(token) ? evmTokenIdentity(chainId, token) : undefined
  return t ? `${amountWithDecimals(amount, t.decimals)} ${t.symbol}` : `${amount} base units of ${native ? 'the native coin' : `token ${String(token)}`}`
}

const lower = (v: unknown) => String(v ?? '').toLowerCase()

// CoW Protocol GPv2Settlement, one CREATE2 address on every chain CoW runs:
// https://github.com/cowprotocol/contracts/blob/main/networks.json (GPv2Settlement).
// Checked 2026-10-29 on each chain below: eth_getCode, and domainSeparator()
// equals the ("Gnosis Protocol", "v2", chainId, this address) domain.
const COW_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41'
const COW_CHAINS = new Set([1, 10, 56, 100, 137, 8453, 42161, 43114])
/** GPv2's marker for the chain's own coin as the token bought. */
const COW_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

const isCowOrder = (td: any) => td.domain?.name === 'Gnosis Protocol' && td.domain?.version === 'v2'
  && lower(td.domain?.verifyingContract) === COW_SETTLEMENT && COW_CHAINS.has(Number(td.domain?.chainId))
  && td.primaryType === 'Order' && exactFields(td, 'Order', [
    ['sellToken', 'address'], ['buyToken', 'address'], ['receiver', 'address'], ['sellAmount', 'uint256'],
    ['buyAmount', 'uint256'], ['validTo', 'uint32'], ['appData', 'bytes32'], ['feeAmount', 'uint256'],
    ['kind', 'string'], ['partiallyFillable', 'bool'], ['sellTokenBalance', 'string'], ['buyTokenBalance', 'string'],
  ])
  // The only values GPv2Settlement accepts; anything else is not a valid order.
  && ['sell', 'buy'].includes(td.message?.kind)
  && ['erc20', 'external', 'internal'].includes(td.message?.sellTokenBalance)
  && ['erc20', 'internal'].includes(td.message?.buyTokenBalance)

function cowOrderFields(msg: any, td: any, signer?: string): EIP712DecodedField[] {
  const chainId = Number(td.domain.chainId)
  const sell = msg.kind === 'sell'
  const nativeBuy = lower(msg.buyToken) === COW_NATIVE
  const receiver = String(msg.receiver ?? '')
  // A zero receiver means the order's owner: the account that signs it.
  const own = /^0x0{40}$/.test(receiver) || (!!signer && lower(receiver) === lower(signer))
  const coin = evmChainLabel(chainId)?.symbol
  return [
    { label: sell ? 'Sell' : 'Sell at most', value: tokenUnits(chainId, msg.sellToken, msg.sellAmount), format: 'amount', raw: String(msg.sellAmount) },
    { label: sell ? 'Receive at least' : 'Receive', value: tokenUnits(chainId, msg.buyToken, msg.buyAmount, nativeBuy), format: 'amount', raw: String(msg.buyAmount) },
    { label: 'Sell Token', value: formatValue(msg.sellToken, 'address'), format: 'address', raw: msg.sellToken },
    { label: 'Buy Token', value: nativeBuy && coin ? `${coin} (native coin)` : formatValue(msg.buyToken, 'address'), format: 'address', raw: msg.buyToken },
    { label: 'Receiver', value: own ? 'This wallet' : receiver, format: 'address', raw: receiver },
    { label: 'Valid Until', value: formatValue(msg.validTo, 'datetime'), format: 'datetime', raw: String(msg.validTo) },
    { label: 'Fee', value: tokenUnits(chainId, msg.sellToken, msg.feeAmount), format: 'amount', raw: String(msg.feeAmount) },
    { label: 'Order Kind', value: String(msg.kind), format: 'raw', raw: String(msg.kind) },
    { label: 'Partially Fillable', value: String(msg.partiallyFillable), format: 'raw', raw: String(msg.partiallyFillable) },
    { label: 'App Data', value: formatValue(msg.appData, 'hex'), format: 'hex', raw: msg.appData },
    { label: 'Sell Token Balance', value: String(msg.sellTokenBalance), format: 'raw', raw: String(msg.sellTokenBalance) },
    { label: 'Buy Token Balance', value: String(msg.buyTokenBalance), format: 'raw', raw: String(msg.buyTokenBalance) },
  ]
}

const isSeaportOrder = (td: any) => td.domain?.name === 'Seaport' && td.domain?.version === '1.6'
  && lower(td.domain?.verifyingContract) === SEAPORT_1_6 && SEAPORT_1_6_CHAINS.has(Number(td.domain?.chainId))
  && td.primaryType === 'OrderComponents' && exactFields(td, 'OrderComponents', [
    ['offerer', 'address'], ['zone', 'address'], ['offer', 'OfferItem[]'], ['consideration', 'ConsiderationItem[]'],
    ['orderType', 'uint8'], ['startTime', 'uint256'], ['endTime', 'uint256'], ['zoneHash', 'bytes32'],
    ['salt', 'uint256'], ['conduitKey', 'bytes32'], ['counter', 'uint256'],
  ]) && exactFields(td, 'OfferItem', [
    ['itemType', 'uint8'], ['token', 'address'], ['identifierOrCriteria', 'uint256'], ['startAmount', 'uint256'], ['endAmount', 'uint256'],
  ]) && exactFields(td, 'ConsiderationItem', [
    ['itemType', 'uint8'], ['token', 'address'], ['identifierOrCriteria', 'uint256'], ['startAmount', 'uint256'],
    ['endAmount', 'uint256'], ['recipient', 'address'],
  ])

/** One Seaport item in words. A start/end pair that differ is a price that moves over time. */
function seaportItem(chainId: number, item: any): string {
  const type = Number(item?.itemType)
  const amount = (raw: unknown) => type === 0 ? tokenUnits(chainId, item.token, raw, true)
    : type === 1 ? tokenUnits(chainId, item.token, raw) : String(raw)
  const start = amount(item?.startAmount), end = amount(item?.endAmount)
  const howMany = start === end ? start : `${start}, moving to ${end}`
  switch (type) {
    case 0: case 1: return howMany
    case 2: return `ERC-721 #${item.identifierOrCriteria} of collection ${item.token}`
    case 3: return `${howMany} × ERC-1155 #${item.identifierOrCriteria} of collection ${item.token}`
    case 4: case 5: return `${howMany} × any ${type === 4 ? 'ERC-721' : 'ERC-1155'} of collection ${item.token} matching criteria ${item.identifierOrCriteria}`
    default: return `unknown item type ${item?.itemType} (${JSON.stringify(item)})`
  }
}

const SEAPORT_ORDER_TYPES = ['Full, open', 'Partial, open', 'Full, restricted by zone', 'Partial, restricted by zone', 'Contract order']

function seaportOrderFields(msg: any, td: any): EIP712DecodedField[] {
  const chainId = Number(td.domain.chainId)
  const offerer = lower(msg.offerer)
  const role = (r: string) => lower(r) === offerer ? ' (the offerer)' : lower(r) === OPENSEA_FEE_RECIPIENT ? ' (OpenSea fee)' : ''
  const offer: any[] = Array.isArray(msg.offer) ? msg.offer : []
  const consideration: any[] = Array.isArray(msg.consideration) ? msg.consideration : []
  return [
    { label: 'Offerer', value: formatValue(msg.offerer, 'address'), format: 'address', raw: msg.offerer },
    ...offer.map((item, i): EIP712DecodedField => ({ label: `Offer ${i + 1}`, value: seaportItem(chainId, item), format: 'raw' })),
    ...consideration.map((item, i): EIP712DecodedField => ({
      label: `Payment ${i + 1}`, value: `${seaportItem(chainId, item)} to ${item.recipient}${role(item.recipient)}`, format: 'raw',
    })),
    { label: 'Order Type', value: SEAPORT_ORDER_TYPES[Number(msg.orderType)] ?? String(msg.orderType), format: 'raw' },
    { label: 'Zone', value: formatValue(msg.zone, 'address'), format: 'address', raw: msg.zone },
    { label: 'Starts', value: formatValue(msg.startTime, 'datetime'), format: 'datetime', raw: String(msg.startTime) },
    { label: 'Ends', value: formatValue(msg.endTime, 'datetime'), format: 'datetime', raw: String(msg.endTime) },
    { label: 'Conduit', value: lower(msg.conduitKey) === OPENSEA_CONDUIT_KEY ? `OpenSea conduit (${msg.conduitKey})` : String(msg.conduitKey), format: 'raw' },
    { label: 'Salt', value: formatValue(msg.salt, 'raw'), format: 'raw', raw: String(msg.salt) },
    { label: 'Counter', value: formatValue(msg.counter, 'raw'), format: 'raw', raw: String(msg.counter) },
  ]
}

/** Every item of the order, for seaport-item-contracts.ts to ask its token
 *  contract what it is. */
function seaportItems(td: any): EIP712DecodedInfo['seaportItems'] {
  const msg = td.message || {}
  const side = (name: 'offer' | 'consideration') => (Array.isArray(msg[name]) ? msg[name] : [])
    .map((item: any, index: number) => ({ side: name, index, itemType: Number(item?.itemType), token: String(item?.token ?? '') }))
  return [...side('offer'), ...side('consideration')]
}

/** The order as a listing: only specific NFTs offered, and every payment in
 *  one currency at a fixed price. Any other shape is left undefined. */
function seaportListing(td: any): EIP712DecodedInfo['seaportListing'] {
  const msg = td.message || {}
  const chainId = Number(td.domain.chainId)
  const offer: any[] = Array.isArray(msg.offer) ? msg.offer : []
  const pay: any[] = Array.isArray(msg.consideration) ? msg.consideration : []
  const fixed = (i: any) => toBig(i?.startAmount) !== undefined && toBig(i.startAmount) === toBig(i.endAmount)
  if (offer.length === 0 || !offer.every((i) => (Number(i?.itemType) === 2 || Number(i?.itemType) === 3) && fixed(i))) return undefined
  const type = Number(pay[0]?.itemType), token = lower(pay[0]?.token)
  if (pay.length === 0 || (type !== 0 && type !== 1)
    || !pay.every((i) => Number(i?.itemType) === type && lower(i?.token) === token && fixed(i) && /^0x[0-9a-fA-F]{40}$/.test(String(i?.recipient)))) return undefined
  if (type === 0 && !/^0x0{40}$/.test(token)) return undefined
  const offerer = lower(msg.offerer)
  const units = (raw: bigint) => tokenUnits(chainId, pay[0].token, raw.toString(), type === 0)
  const total = pay.reduce((sum, i) => sum + toBig(i.startAmount)!, 0n)
  const nftId = offer.length === 1 ? toBig(offer[0].identifierOrCriteria) : undefined
  // The same test tokenUnits uses to name the currency.
  const decimals = type === 0 ? (evmChainLabel(chainId)?.symbol ? 18 : undefined)
    : /^0x[0-9a-fA-F]{40}$/.test(String(pay[0].token)) ? evmTokenIdentity(chainId, pay[0].token)?.decimals : undefined
  return {
    offerer: String(msg.offerer),
    items: offer.map((i) => seaportItem(chainId, i)),
    total: units(total),
    totalRaw: total.toString(),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(nftId !== undefined && /^0x[0-9a-fA-F]{40}$/.test(String(offer[0].token))
      ? { nft: { token: String(offer[0].token), id: nftId.toString() } } : {}),
    payments: pay.map((i) => ({
      recipient: String(i.recipient),
      amount: units(toBig(i.startAmount)!),
      raw: toBig(i.startAmount)!.toString(),
      role: lower(i.recipient) === offerer ? 'offerer' as const : lower(i.recipient) === OPENSEA_FEE_RECIPIENT ? 'opensea-fee' as const : 'other' as const,
    })),
    endTime: formatValue(msg.endTime, 'datetime'),
  }
}

const KNOWN_DESCRIPTORS: KnownDescriptor[] = [
  // x402 EVM exact — EIP-3009 TransferWithAuthorization. The facilitator pays
  // gas, while these signed fields bind the payer, merchant, amount and window.
  {
    match: (td) => {
      if (td.primaryType !== 'TransferWithAuthorization') return false
      const fields = td.types?.TransferWithAuthorization
      const expected = [
        ['from', 'address'],
        ['to', 'address'],
        ['value', 'uint256'],
        ['validAfter', 'uint256'],
        ['validBefore', 'uint256'],
        ['nonce', 'bytes32'],
      ]
      return Array.isArray(fields) && fields.length === expected.length &&
        expected.every(([name, type], i) => fields[i]?.name === name && fields[i]?.type === type)
    },
    operationName: 'x402 EIP-3009 Payment',
    extract: (msg) => [
      { label: 'From', value: formatValue(msg.from, 'address'), format: 'address', raw: msg.from },
      { label: 'Pay To', value: formatValue(msg.to, 'address'), format: 'address', raw: msg.to },
      { label: 'Value', value: formatValue(msg.value, 'amount'), format: 'amount', raw: msg.value },
      { label: 'Valid After', value: formatValue(msg.validAfter, 'datetime'), format: 'datetime', raw: msg.validAfter },
      { label: 'Valid Before', value: formatValue(msg.validBefore, 'datetime'), format: 'datetime', raw: msg.validBefore },
      { label: 'Nonce', value: formatValue(msg.nonce, 'hex'), format: 'hex', raw: msg.nonce },
    ],
  },
  // Uniswap Permit2 — PermitSingle
  {
    match: (td) => isPermit2(td) && td.primaryType === 'PermitSingle' &&
      exactFields(td, 'PermitSingle', [['details', 'PermitDetails'], ['spender', 'address'], ['sigDeadline', 'uint256']]) &&
      exactFields(td, 'PermitDetails', [['token', 'address'], ['amount', 'uint160'], ['expiration', 'uint48'], ['nonce', 'uint48']]),
    operationName: 'Permit2 (Single)',
    extract: (msg) => {
      const details = msg.details || {}
      return [
        { label: 'Token', value: formatValue(details.token, 'address'), format: 'address', raw: details.token },
        { label: 'Amount', value: formatValue(details.amount, 'amount'), format: 'amount', raw: details.amount },
        { label: 'Expiration', value: formatValue(details.expiration, 'datetime'), format: 'datetime', raw: details.expiration },
        { label: 'Nonce', value: formatValue(details.nonce, 'raw'), format: 'raw' },
        { label: 'Spender', value: formatValue(msg.spender, 'address'), format: 'address', raw: msg.spender },
        { label: 'Sig Deadline', value: formatValue(msg.sigDeadline, 'datetime'), format: 'datetime', raw: msg.sigDeadline },
      ]
    },
  },
  // Uniswap Permit2 — PermitBatch
  {
    match: (td) => isPermit2(td) && td.primaryType === 'PermitBatch' &&
      exactFields(td, 'PermitBatch', [['details', 'PermitDetails[]'], ['spender', 'address'], ['sigDeadline', 'uint256']]) &&
      exactFields(td, 'PermitDetails', [['token', 'address'], ['amount', 'uint160'], ['expiration', 'uint48'], ['nonce', 'uint48']]),
    operationName: 'Permit2 (Batch)',
    extract: (msg) => {
      const details = Array.isArray(msg.details) ? msg.details : []
      const fields: EIP712DecodedField[] = []
      details.forEach((d: any, i: number) => {
        const prefix = details.length > 1 ? `[${i + 1}] ` : ''
        fields.push(
          { label: `${prefix}Token`, value: formatValue(d.token, 'address'), format: 'address', raw: d.token },
          { label: `${prefix}Amount`, value: formatValue(d.amount, 'amount'), format: 'amount', raw: d.amount },
          { label: `${prefix}Expiration`, value: formatValue(d.expiration, 'datetime'), format: 'datetime', raw: d.expiration },
        )
      })
      fields.push(
        { label: 'Spender', value: formatValue(msg.spender, 'address'), format: 'address', raw: msg.spender },
        { label: 'Sig Deadline', value: formatValue(msg.sigDeadline, 'datetime'), format: 'datetime', raw: msg.sigDeadline },
      )
      return fields
    },
  },
  // Permit2 one-time signature transfers. Unlike allowance permits, the
  // signed amount is a maximum and the calling spender chooses the actual
  // recipient/amount in the subsequent contract call.
  {
    match: (td) => isPermit2(td) && td.primaryType === 'PermitTransferFrom' &&
      exactFields(td, 'PermitTransferFrom', [['permitted', 'TokenPermissions'], ['spender', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256']]) &&
      exactFields(td, 'TokenPermissions', [['token', 'address'], ['amount', 'uint256']]),
    operationName: 'Permit2 Signature Transfer',
    extract: (msg) => tokenPermissionFields(msg, false),
  },
  {
    match: (td) => isPermit2(td) && td.primaryType === 'PermitBatchTransferFrom' &&
      exactFields(td, 'PermitBatchTransferFrom', [['permitted', 'TokenPermissions[]'], ['spender', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256']]) &&
      exactFields(td, 'TokenPermissions', [['token', 'address'], ['amount', 'uint256']]),
    operationName: 'Permit2 Batch Signature Transfer',
    extract: (msg) => tokenPermissionFields(msg, true),
  },
  // UniswapX V3 Dutch orders. Match every signed struct exactly: a familiar
  // type name is not sufficient evidence for these auction semantics.
  {
    match: (td) => exactWitnessEnvelope(td, 'V3DutchOrder') &&
      exactFields(td, 'V3DutchOrder', [['info', 'OrderInfo'], ['cosigner', 'address'], ['startingBaseFee', 'uint256'], ['baseInput', 'V3DutchInput'], ['baseOutputs', 'V3DutchOutput[]']]) &&
      exactFields(td, 'V3DutchInput', [['token', 'address'], ['startAmount', 'uint256'], ['curve', 'NonlinearDutchDecay'], ['maxAmount', 'uint256'], ['adjustmentPerGweiBaseFee', 'uint256']]) &&
      exactFields(td, 'V3DutchOutput', [['token', 'address'], ['startAmount', 'uint256'], ['curve', 'NonlinearDutchDecay'], ['recipient', 'address'], ['minAmount', 'uint256'], ['adjustmentPerGweiBaseFee', 'uint256']]) &&
      exactFields(td, 'NonlinearDutchDecay', [['relativeBlocks', 'uint256'], ['relativeAmounts', 'int256[]']]),
    operationName: 'UniswapX V3 Dutch Order',
    protocolIdentity: (td, msg) => verifiedUniswapXReactor('V3DutchOrder', td, msg),
    extract: (msg) => {
      const order = msg.witness || {}
      return [
        ...uniswapXBaseFields(msg, order.baseInput?.token, [
          ['Input Start Amount', order.baseInput?.startAmount],
          ['Maximum Input', order.baseInput?.maxAmount],
          ['Input Base-Fee Adjustment', order.baseInput?.adjustmentPerGweiBaseFee],
        ], order.baseOutputs, ['startAmount', 'minAmount', 'adjustmentPerGweiBaseFee']),
        { label: 'Cosigner', value: formatValue(order.cosigner, 'address'), format: 'address', raw: order.cosigner },
        { label: 'Starting Base Fee', value: formatValue(order.startingBaseFee, 'amount'), format: 'amount', raw: order.startingBaseFee },
      ]
    },
  },
  // UniswapX Priority orders expose the priority-fee-dependent input/output
  // slopes so the user can see that the signed result is not a fixed quote.
  {
    match: (td) => exactWitnessEnvelope(td, 'PriorityOrder') &&
      exactFields(td, 'PriorityOrder', [['info', 'OrderInfo'], ['cosigner', 'address'], ['auctionStartBlock', 'uint256'], ['baselinePriorityFeeWei', 'uint256'], ['input', 'PriorityInput'], ['outputs', 'PriorityOutput[]']]) &&
      exactFields(td, 'PriorityInput', [['token', 'address'], ['amount', 'uint256'], ['mpsPerPriorityFeeWei', 'uint256']]) &&
      exactFields(td, 'PriorityOutput', [['token', 'address'], ['amount', 'uint256'], ['mpsPerPriorityFeeWei', 'uint256'], ['recipient', 'address']]),
    operationName: 'UniswapX Priority Order',
    protocolIdentity: (td, msg) => verifiedUniswapXReactor('PriorityOrder', td, msg),
    extract: (msg) => {
      const order = msg.witness || {}
      return [
        ...uniswapXBaseFields(msg, order.input?.token, [
          ['Input Amount', order.input?.amount],
          ['Input Priority-Fee Slope', order.input?.mpsPerPriorityFeeWei],
        ], order.outputs, ['amount', 'mpsPerPriorityFeeWei']),
        { label: 'Auction Start Block', value: formatValue(order.auctionStartBlock, 'raw'), format: 'raw', raw: order.auctionStartBlock },
        { label: 'Baseline Priority Fee', value: formatValue(order.baselinePriorityFeeWei, 'amount'), format: 'amount', raw: order.baselinePriorityFeeWei },
        { label: 'Cosigner', value: formatValue(order.cosigner, 'address'), format: 'address', raw: order.cosigner },
      ]
    },
  },
  {
    match: (td) => exactWitnessEnvelope(td, 'ExclusiveDutchOrder') &&
      exactFields(td, 'ExclusiveDutchOrder', [
        ['info', 'OrderInfo'], ['decayStartTime', 'uint256'], ['decayEndTime', 'uint256'],
        ['exclusiveFiller', 'address'], ['exclusivityOverrideBps', 'uint256'], ['inputToken', 'address'],
        ['inputStartAmount', 'uint256'], ['inputEndAmount', 'uint256'], ['outputs', 'DutchOutput[]'],
      ]) && exactFields(td, 'DutchOutput', [['token', 'address'], ['startAmount', 'uint256'], ['endAmount', 'uint256'], ['recipient', 'address']]),
    operationName: 'UniswapX Exclusive Dutch Order',
    protocolIdentity: (td, msg) => verifiedUniswapXReactor('ExclusiveDutchOrder', td, msg),
    extract: (msg) => {
      const order = msg.witness || {}
      return [
        ...uniswapXBaseFields(msg, order.inputToken, [['Input Start Amount', order.inputStartAmount], ['Maximum Input End Amount', order.inputEndAmount]], order.outputs, ['startAmount', 'endAmount']),
        { label: 'Decay Starts', value: formatValue(order.decayStartTime, 'datetime'), format: 'datetime', raw: order.decayStartTime },
        { label: 'Decay Ends', value: formatValue(order.decayEndTime, 'datetime'), format: 'datetime', raw: order.decayEndTime },
        { label: 'Exclusive Filler', value: formatValue(order.exclusiveFiller, 'address'), format: 'address', raw: order.exclusiveFiller },
        { label: 'Exclusivity Override Bps', value: formatValue(order.exclusivityOverrideBps, 'raw'), format: 'raw', raw: order.exclusivityOverrideBps },
      ]
    },
  },
  {
    match: (td) => exactWitnessEnvelope(td, 'V2DutchOrder') &&
      exactFields(td, 'V2DutchOrder', [
        ['info', 'OrderInfo'], ['cosigner', 'address'], ['baseInputToken', 'address'],
        ['baseInputStartAmount', 'uint256'], ['baseInputEndAmount', 'uint256'], ['baseOutputs', 'DutchOutput[]'],
      ]) && exactFields(td, 'DutchOutput', [['token', 'address'], ['startAmount', 'uint256'], ['endAmount', 'uint256'], ['recipient', 'address']]),
    operationName: 'UniswapX V2 Dutch Order',
    protocolIdentity: (td, msg) => verifiedUniswapXReactor('V2DutchOrder', td, msg),
    extract: (msg) => {
      const order = msg.witness || {}
      return [
        ...uniswapXBaseFields(msg, order.baseInputToken, [['Input Start Amount', order.baseInputStartAmount], ['Maximum Input End Amount', order.baseInputEndAmount]], order.baseOutputs, ['startAmount', 'endAmount']),
        { label: 'Cosigner', value: formatValue(order.cosigner, 'address'), format: 'address', raw: order.cosigner },
      ]
    },
  },
  {
    match: (td) => exactPermitWitnessEnvelope(td, 'HybridOrder') &&
      exactFields(td, 'OrderInfo', [
        ['reactor', 'address'], ['swapper', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256'],
        ['preExecutionHook', 'address'], ['preExecutionHookData', 'bytes'], ['postExecutionHook', 'address'],
        ['postExecutionHookData', 'bytes'], ['auctionResolver', 'address'],
      ]) && exactFields(td, 'HybridOrder', [
        ['info', 'OrderInfo'], ['cosigner', 'address'], ['input', 'HybridInput'], ['outputs', 'HybridOutput[]'],
        ['auctionStartBlock', 'uint256'], ['baselinePriorityFee', 'uint256'], ['scalingFactor', 'uint256'], ['priceCurve', 'uint256[]'],
      ]) && exactFields(td, 'HybridInput', [['token', 'address'], ['maxAmount', 'uint256']]) &&
      exactFields(td, 'HybridOutput', [['token', 'address'], ['minAmount', 'uint256'], ['recipient', 'address']]),
    operationName: 'UniswapX Hybrid Order',
    protocolIdentity: (td, msg) => verifiedUniswapXReactor('HybridOrder', td, msg),
    extract: (msg) => {
      const order = msg.witness || {}
      return [
        ...uniswapXBaseFields(msg, order.input?.token, [['Maximum Input', order.input?.maxAmount]], order.outputs, ['minAmount']),
        { label: 'Auction Start Block', value: formatValue(order.auctionStartBlock, 'raw'), format: 'raw', raw: order.auctionStartBlock },
        { label: 'Baseline Priority Fee', value: formatValue(order.baselinePriorityFee, 'amount'), format: 'amount', raw: order.baselinePriorityFee },
        { label: 'Scaling Factor', value: formatValue(order.scalingFactor, 'raw'), format: 'raw', raw: order.scalingFactor },
        { label: 'Price Curve', value: formatValue(JSON.stringify(order.priceCurve || []), 'raw'), format: 'raw', raw: JSON.stringify(order.priceCurve || []) },
        { label: 'Pre-execution Hook', value: formatValue(order.info?.preExecutionHook, 'address'), format: 'address', raw: order.info?.preExecutionHook },
        { label: 'Post-execution Hook', value: formatValue(order.info?.postExecutionHook, 'address'), format: 'address', raw: order.info?.postExecutionHook },
        { label: 'Auction Resolver', value: formatValue(order.info?.auctionResolver, 'address'), format: 'address', raw: order.info?.auctionResolver },
      ]
    },
  },
  // UniswapX orders use Permit2 witness transfer. The witness type is
  // application-defined; retain its complete value while proving the fixed
  // Permit2 envelope rather than pretending every witness is the same order.
  {
    match: (td) => {
      if (!isPermit2(td) || !/^Permit(?:Batch)?WitnessTransferFrom$/.test(td.primaryType) ||
        !exactFields(td, 'TokenPermissions', [['token', 'address'], ['amount', 'uint256']])) return false
      const fields = td.types?.[td.primaryType]
      const batch = td.primaryType === 'PermitBatchWitnessTransferFrom'
      return Array.isArray(fields) && fields.length === 5 &&
        fields[0]?.name === 'permitted' && fields[0]?.type === `TokenPermissions${batch ? '[]' : ''}` &&
        fields[1]?.name === 'spender' && fields[1]?.type === 'address' &&
        fields[2]?.name === 'nonce' && fields[2]?.type === 'uint256' &&
        fields[3]?.name === 'deadline' && fields[3]?.type === 'uint256' &&
        fields[4]?.name === 'witness' && typeof fields[4]?.type === 'string' &&
        Array.isArray(td.types?.[fields[4].type])
    },
    operationName: 'Permit2 Witness Transfer (UniswapX-compatible)',
    protocolIdentity: () => false,
    extract: (msg) => [
      ...tokenPermissionFields(msg, Array.isArray(msg.permitted)),
      { label: 'Witness / Order', value: formatValue(JSON.stringify(msg.witness ?? msg), 'raw'), format: 'raw' },
    ],
  },
  // ERC-2612 Permit (owner/spender/value/deadline)
  {
    match: (td) =>
      td.primaryType === 'Permit' &&
      td.types?.Permit?.some((f: any) => f.name === 'owner') &&
      td.types?.Permit?.some((f: any) => f.name === 'spender') &&
      td.types?.Permit?.some((f: any) => f.name === 'value') &&
      td.types?.Permit?.some((f: any) => f.name === 'deadline'),
    operationName: 'ERC-2612 Permit',
    extract: (msg) => [
      { label: 'Owner', value: formatValue(msg.owner, 'address'), format: 'address', raw: msg.owner },
      { label: 'Spender', value: formatValue(msg.spender, 'address'), format: 'address', raw: msg.spender },
      { label: 'Value', value: formatValue(msg.value, 'amount'), format: 'amount', raw: msg.value },
      { label: 'Nonce', value: formatValue(msg.nonce, 'raw'), format: 'raw' },
      { label: 'Deadline', value: formatValue(msg.deadline, 'datetime'), format: 'datetime', raw: msg.deadline },
    ],
  },
  // DAI-style Permit (holder/spender/nonce/expiry/allowed)
  {
    match: (td) =>
      td.primaryType === 'Permit' &&
      td.types?.Permit?.some((f: any) => f.name === 'holder') &&
      td.types?.Permit?.some((f: any) => f.name === 'allowed'),
    operationName: 'DAI Permit',
    extract: (msg) => [
      { label: 'Holder', value: formatValue(msg.holder, 'address'), format: 'address', raw: msg.holder },
      { label: 'Spender', value: formatValue(msg.spender, 'address'), format: 'address', raw: msg.spender },
      { label: 'Nonce', value: formatValue(msg.nonce, 'raw'), format: 'raw' },
      { label: 'Expiry', value: formatValue(msg.expiry, 'datetime'), format: 'datetime', raw: msg.expiry },
      { label: 'Allowed', value: formatValue(msg.allowed, 'raw'), format: 'raw' },
    ],
  },
  // CoW Protocol GPv2 order, only at the pinned settlement contract.
  {
    match: isCowOrder,
    operationName: 'CoW Protocol Order',
    extract: cowOrderFields,
  },
  // Seaport 1.6 OrderComponents, only at the pinned Seaport deployment. A
  // BulkOrder (a tree of orders: OpenSea's several-items-at-once listing) is
  // not matched and reads critical, with its own line (clearsign-risk.ts): no
  // KeepKey checks who is paid in it. No real BulkOrder document is public to
  // test with.
  {
    match: isSeaportOrder,
    operationName: 'Seaport 1.6 Order',
    extract: seaportOrderFields,
    seaportListing,
    seaportItems,
  },
]

// ── Generic fallback ─────────────────────────────────────────────────────

function genericExtract(typedData: any): EIP712DecodedField[] {
  const primaryType = typedData.primaryType
  const typeDefs = typedData.types?.[primaryType]
  const message = typedData.message || {}

  if (!Array.isArray(typeDefs)) {
    // No type definition — dump top-level message keys
    return Object.entries(message).map(([key, val]) => ({
      label: humanizeFieldName(key),
      value: formatValue(val, typeof val === 'object' ? 'raw' : 'raw'),
      format: 'raw' as const,
    }))
  }

  return typeDefs.map((field: { name: string; type: string }) => {
    const format = autoDetectFormat(field.type, field.name)
    const rawVal = message[field.name]
    // For nested struct types, stringify the object
    const displayVal = typeof rawVal === 'object' && rawVal !== null
      ? JSON.stringify(rawVal)
      : rawVal
    return {
      label: humanizeFieldName(field.name),
      value: formatValue(displayVal, format),
      format,
      raw: String(rawVal ?? ''),
    }
  })
}

// ── Public API ───────────────────────────────────────────────────────────

function comparisonHashes(typedData: any): EIP712DecodedInfo['hashes'] {
  try {
    const domain = typedData.domain || {}
    // Match hdwallet's inferred domain type when a dApp omits it, and respect
    // the supplied order otherwise: changing that order changes the hash.
    const domainType = typedData.types?.EIP712Domain ?? [
      ['name', 'string'], ['version', 'string'], ['chainId', 'uint256'],
      ['verifyingContract', 'address'], ['salt', 'bytes32'],
    ].filter(([name]) => domain[name] !== undefined).map(([name, type]) => ({ name, type }))
    const domainHash = ethersUtils._TypedDataEncoder.hashStruct('EIP712Domain', { EIP712Domain: domainType }, domain)
    const { EIP712Domain: _domainType, ...messageTypes } = typedData.types || {}
    const messageHash = typedData.primaryType === 'EIP712Domain' ? undefined
      : ethersUtils._TypedDataEncoder.hashStruct(typedData.primaryType, messageTypes, typedData.message || {})
    return { domainHash, messageHash }
  } catch {
    // Never substitute a digest from a partial or reconstructed document.
    return undefined
  }
}

/** `signer` is the account asked to sign; a descriptor may name it "this wallet". */
export function decodeEIP712(typedData: any, signer?: string): EIP712DecodedInfo {
  const domain = typedData.domain || {}
  const primaryType = typedData.primaryType || 'Unknown'
  const message = typedData.message || {}
  const hashes = comparisonHashes(typedData)

  // Try known descriptors first
  for (const desc of KNOWN_DESCRIPTORS) {
    if (desc.match(typedData)) {
      const listing = desc.seaportListing?.(typedData)
      const items = desc.seaportItems?.(typedData)
      return {
        operationName: desc.operationName,
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId ? Number(domain.chainId) : undefined,
          verifyingContract: domain.verifyingContract,
        },
        primaryType,
        fields: desc.extract(message, typedData, signer),
        isKnownType: true,
        protocolIdentityVerified: desc.protocolIdentity ? desc.protocolIdentity(typedData, message) : true,
        hashes,
        ...(listing ? { seaportListing: listing } : {}),
        ...(items ? { seaportItems: items } : {}),
      }
    }
  }

  // Generic fallback
  return {
    operationName: humanizeFieldName(primaryType),
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId ? Number(domain.chainId) : undefined,
      verifyingContract: domain.verifyingContract,
    },
    primaryType,
    fields: genericExtract(typedData),
    isKnownType: false,
    protocolIdentityVerified: false,
    hashes,
  }
}
