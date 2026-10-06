/**
 * EIP-712 typed data decoder — extracts human-readable fields for signing approval UI.
 *
 * Two tiers:
 * 1. Known descriptors (Permit2, ERC-2612 Permit, DAI Permit) matched by contract + primaryType
 * 2. Generic fallback — reads types[primaryType] and auto-detects format from Solidity type names
 */
import type { EIP712DecodedField, EIP712DecodedInfo } from '../shared/types'

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
  extract: (message: any) => EIP712DecodedField[]
  protocolIdentity?: (typedData: any, message: any) => boolean
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

export function decodeEIP712(typedData: any): EIP712DecodedInfo {
  const domain = typedData.domain || {}
  const primaryType = typedData.primaryType || 'Unknown'
  const message = typedData.message || {}

  // Try known descriptors first
  for (const desc of KNOWN_DESCRIPTORS) {
    if (desc.match(typedData)) {
      return {
        operationName: desc.operationName,
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId ? Number(domain.chainId) : undefined,
          verifyingContract: domain.verifyingContract,
        },
        primaryType,
        fields: desc.extract(message),
        isKnownType: true,
        protocolIdentityVerified: desc.protocolIdentity ? desc.protocolIdentity(typedData, message) : true,
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
  }
}
