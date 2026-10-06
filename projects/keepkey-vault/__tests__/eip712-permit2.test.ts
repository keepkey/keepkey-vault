import { describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'

import { decodeEIP712 } from '../src/bun/eip712-decoder'

const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const spender = '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85'
const domain = { name: 'Permit2', chainId: 1, verifyingContract: permit2 }
const tokenPermissions = [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }]
const orderInfo = [
  { name: 'reactor', type: 'address' }, { name: 'swapper', type: 'address' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  { name: 'additionalValidationContract', type: 'address' }, { name: 'additionalValidationData', type: 'bytes' },
]
const witnessEnvelope = (witnessType: string) => [
  { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: witnessType },
]

describe('Permit2 EIP-712 ClearSign decoding', () => {
  test('recognizes exact one-time signature transfer semantics', () => {
    const decoded = decodeEIP712({
      domain, primaryType: 'PermitTransferFrom',
      types: {
        PermitTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
        ],
        TokenPermissions: tokenPermissions,
      },
      message: { permitted: { token, amount: '1000000' }, spender, nonce: '7', deadline: '1800000000' },
    })
    expect(decoded.isKnownType).toBe(true)
    expect(decoded.protocolIdentityVerified).toBe(true)
    expect(decoded.operationName).toBe('Permit2 Signature Transfer')
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Maximum Amount', value: '1000000' }))
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Spender', value: spender }))
  })

  test('does not trust a Permit2 primary-type name with forged field widths', () => {
    const decoded = decodeEIP712({
      domain, primaryType: 'PermitSingle',
      types: {
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
        PermitDetails: [
          { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
          { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' },
        ],
      },
      message: { details: { token, amount: '1', expiration: '2', nonce: '3' }, spender, sigDeadline: '4' },
    })
    expect(decoded.isKnownType).toBe(false)
  })

  test('recognizes the fixed Permit2 envelope of a witness order and retains the witness', () => {
    const decoded = decodeEIP712({
      domain, primaryType: 'PermitWitnessTransferFrom',
      types: {
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Order' },
        ],
        TokenPermissions: tokenPermissions,
        Order: [{ name: 'reactor', type: 'address' }],
      },
      message: {
        permitted: { token, amount: '500' }, spender, nonce: '9', deadline: '1800000000',
        witness: { reactor: '0x0000000000000000000000000000000000000001' },
      },
    })
    expect(decoded.isKnownType).toBe(true)
    expect(decoded.operationName).toContain('Witness Transfer')
    expect(decoded.fields.find(field => field.label === 'Witness / Order')?.value).toContain('reactor')
  })

  test('decodes exact UniswapX V3 Dutch economic bounds', () => {
    const reactor = '0x0000000015757c461808EA25Eb309638B62681cf'
    const recipient = '0x1111111111111111111111111111111111111111'
    const info = { reactor, swapper: recipient, nonce: '12', deadline: '1800000000', additionalValidationContract: '0x0000000000000000000000000000000000000000', additionalValidationData: '0x' }
    const curve = { relativeBlocks: '0', relativeAmounts: [] }
    const decoded = decodeEIP712({
      domain, primaryType: 'PermitWitnessTransferFrom',
      types: {
        PermitWitnessTransferFrom: witnessEnvelope('V3DutchOrder'), TokenPermissions: tokenPermissions, OrderInfo: orderInfo,
        V3DutchOrder: [
          { name: 'info', type: 'OrderInfo' }, { name: 'cosigner', type: 'address' },
          { name: 'startingBaseFee', type: 'uint256' }, { name: 'baseInput', type: 'V3DutchInput' },
          { name: 'baseOutputs', type: 'V3DutchOutput[]' },
        ],
        V3DutchInput: [
          { name: 'token', type: 'address' }, { name: 'startAmount', type: 'uint256' },
          { name: 'curve', type: 'NonlinearDutchDecay' }, { name: 'maxAmount', type: 'uint256' },
          { name: 'adjustmentPerGweiBaseFee', type: 'uint256' },
        ],
        V3DutchOutput: [
          { name: 'token', type: 'address' }, { name: 'startAmount', type: 'uint256' },
          { name: 'curve', type: 'NonlinearDutchDecay' }, { name: 'recipient', type: 'address' },
          { name: 'minAmount', type: 'uint256' }, { name: 'adjustmentPerGweiBaseFee', type: 'uint256' },
        ],
        NonlinearDutchDecay: [{ name: 'relativeBlocks', type: 'uint256' }, { name: 'relativeAmounts', type: 'int256[]' }],
      },
      message: {
        permitted: { token, amount: '1100' }, spender: reactor, nonce: '12', deadline: '1800000000',
        witness: { info, cosigner: recipient, startingBaseFee: '1', baseInput: { token, startAmount: '1000', curve, maxAmount: '1100', adjustmentPerGweiBaseFee: '0' }, baseOutputs: [{ token: spender, startAmount: '950', curve, recipient, minAmount: '900', adjustmentPerGweiBaseFee: '0' }] },
      },
    })
    expect(decoded.isKnownType).toBe(true)
    expect(decoded.operationName).toBe('UniswapX V3 Dutch Order')
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Maximum Input', value: '1100' }))
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Output 1 Min Amount', value: '900' }))
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Output 1 Recipient', value: recipient }))
  })

  test('refuses a lookalike UniswapX order with a changed signed field type', () => {
    const decoded = decodeEIP712({
      domain, primaryType: 'PermitWitnessTransferFrom',
      types: {
        PermitWitnessTransferFrom: witnessEnvelope('PriorityOrder'), TokenPermissions: tokenPermissions, OrderInfo: orderInfo,
        PriorityOrder: [
          { name: 'info', type: 'OrderInfo' }, { name: 'cosigner', type: 'address' },
          { name: 'auctionStartBlock', type: 'uint48' }, { name: 'baselinePriorityFeeWei', type: 'uint256' },
          { name: 'input', type: 'PriorityInput' }, { name: 'outputs', type: 'PriorityOutput[]' },
        ],
        PriorityInput: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'mpsPerPriorityFeeWei', type: 'uint256' }],
        PriorityOutput: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'mpsPerPriorityFeeWei', type: 'uint256' }, { name: 'recipient', type: 'address' }],
      },
      message: { permitted: { token, amount: '1' }, spender, nonce: '1', deadline: '2', witness: {} },
    })
    expect(decoded.operationName).toContain('Witness Transfer')
    expect(decoded.operationName).not.toContain('Priority Order')
  })

  test('decodes exact UniswapX Hybrid hooks and minimum outputs', () => {
    const recipient = '0x1111111111111111111111111111111111111111'
    const reactor = '0x2222222222222222222222222222222222222222'
    const hybridInfo = [
      { name: 'reactor', type: 'address' }, { name: 'swapper', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      { name: 'preExecutionHook', type: 'address' }, { name: 'preExecutionHookData', type: 'bytes' }, { name: 'postExecutionHook', type: 'address' },
      { name: 'postExecutionHookData', type: 'bytes' }, { name: 'auctionResolver', type: 'address' },
    ]
    const decoded = decodeEIP712({
      domain, primaryType: 'PermitWitnessTransferFrom', types: {
        PermitWitnessTransferFrom: witnessEnvelope('HybridOrder'), TokenPermissions: tokenPermissions, OrderInfo: hybridInfo,
        HybridOrder: [
          { name: 'info', type: 'OrderInfo' }, { name: 'cosigner', type: 'address' }, { name: 'input', type: 'HybridInput' },
          { name: 'outputs', type: 'HybridOutput[]' }, { name: 'auctionStartBlock', type: 'uint256' },
          { name: 'baselinePriorityFee', type: 'uint256' }, { name: 'scalingFactor', type: 'uint256' }, { name: 'priceCurve', type: 'uint256[]' },
        ],
        HybridInput: [{ name: 'token', type: 'address' }, { name: 'maxAmount', type: 'uint256' }],
        HybridOutput: [{ name: 'token', type: 'address' }, { name: 'minAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
      }, message: {
        permitted: { token, amount: '1000' }, spender: reactor, nonce: '2', deadline: '1800000000',
        witness: {
          info: { reactor, swapper: recipient, nonce: '2', deadline: '1800000000', preExecutionHook: recipient, preExecutionHookData: '0x12', postExecutionHook: recipient, postExecutionHookData: '0x34', auctionResolver: recipient },
          cosigner: recipient, input: { token, maxAmount: '1000' }, outputs: [{ token: spender, minAmount: '900', recipient }],
          auctionStartBlock: '100', baselinePriorityFee: '2', scalingFactor: '3', priceCurve: ['4', '5'],
        },
      },
    })
    expect(decoded.operationName).toBe('UniswapX Hybrid Order')
    expect(decoded.protocolIdentityVerified).toBe(false)
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Output 1 Min Amount', value: '900' }))
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Pre-execution Hook', value: recipient }))
  })

  test('recovers and decodes a filled mainnet Exclusive Dutch order', () => {
    const reactor = '0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4'
    const swapper = '0x3673fC4C2e54B43D2d2548f339210eEF134ECe42'
    const types = {
      PermitWitnessTransferFrom: witnessEnvelope('ExclusiveDutchOrder'), TokenPermissions: tokenPermissions, OrderInfo: orderInfo,
      ExclusiveDutchOrder: [
        { name: 'info', type: 'OrderInfo' }, { name: 'decayStartTime', type: 'uint256' }, { name: 'decayEndTime', type: 'uint256' },
        { name: 'exclusiveFiller', type: 'address' }, { name: 'exclusivityOverrideBps', type: 'uint256' }, { name: 'inputToken', type: 'address' },
        { name: 'inputStartAmount', type: 'uint256' }, { name: 'inputEndAmount', type: 'uint256' }, { name: 'outputs', type: 'DutchOutput[]' },
      ],
      DutchOutput: [{ name: 'token', type: 'address' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
    }
    const witness = {
      info: { reactor, swapper, nonce: '900615141309732', deadline: '1789770869', additionalValidationContract: '0x0000000000000000000000000000000000000000', additionalValidationData: '0x' },
      decayStartTime: '1789770869', decayEndTime: '1789770869', exclusiveFiller: '0xD5D6079E5ed872e917f96871749eCc5bcaF77C41', exclusivityOverrideBps: '0',
      inputToken: token, inputStartAmount: '16190560', inputEndAmount: '16190560',
      outputs: [{ token: '0x0000000000000000000000000000000000000000', startAmount: '1', endAmount: '1', recipient: swapper }],
    }
    const message = { permitted: { token, amount: '16190560' }, spender: reactor, nonce: witness.info.nonce, deadline: witness.info.deadline, witness }
    const signature = '0x2570782f2c6df5318d9e947ed3c68e53e9aa62c9e7f0ce5f7458481c3a60ae200f01912ce627857477da5b107f533f00866806acc8b01e250ab5a0a362c0a7ad1b'
    expect(ethersUtils.verifyTypedData(domain, types, message, signature)).toBe(swapper)
    const decoded = decodeEIP712({ domain, primaryType: 'PermitWitnessTransferFrom', types, message })
    expect(decoded.operationName).toBe('UniswapX Exclusive Dutch Order')
    expect(decoded.protocolIdentityVerified).toBe(true)
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Maximum Input End Amount', value: '16190560' }))
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Output 1 End Amount', value: '1' }))
  })

  test('recovers and decodes a filled mainnet V2 Dutch order', () => {
    const reactor = '0x00000011F84B9aa48e5f8aA8B9897600006289Be'
    const swapper = '0x202D0CdF0Ed6e4fA97CD622b928Ae81fb63b6758'
    const types = {
      PermitWitnessTransferFrom: witnessEnvelope('V2DutchOrder'), TokenPermissions: tokenPermissions, OrderInfo: orderInfo,
      V2DutchOrder: [
        { name: 'info', type: 'OrderInfo' }, { name: 'cosigner', type: 'address' }, { name: 'baseInputToken', type: 'address' },
        { name: 'baseInputStartAmount', type: 'uint256' }, { name: 'baseInputEndAmount', type: 'uint256' }, { name: 'baseOutputs', type: 'DutchOutput[]' },
      ],
      DutchOutput: [{ name: 'token', type: 'address' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
    }
    const witness = {
      info: { reactor, swapper, nonce: '1993354547935594013883406195434979844065482924525441671038962187819644325891', deadline: '1789946041', additionalValidationContract: '0x0000000000000000000000000000000000000000', additionalValidationData: '0x' },
      cosigner: '0x4449Cd34d1eb1FEDCF02A1Be3834FfDe8E6A6180', baseInputToken: token,
      baseInputStartAmount: '1000000000', baseInputEndAmount: '1000000000',
      baseOutputs: [{ token: '0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2', startAmount: '868285926673830761284', endAmount: '863944497040461607478', recipient: swapper }],
    }
    const message = { permitted: { token, amount: '1000000000' }, spender: reactor, nonce: witness.info.nonce, deadline: witness.info.deadline, witness }
    const signature = '0xe344f4e01af410c1281e89600787acc1992c25c202db76cff88682bfac2a2a2963b81f1423374800c9599f0ab9985f79e7dc7b4b366b30701c2b1c2d76fa57e01c'
    expect(ethersUtils.verifyTypedData(domain, types, message, signature)).toBe(swapper)
    const decoded = decodeEIP712({ domain, primaryType: 'PermitWitnessTransferFrom', types, message })
    expect(decoded.operationName).toBe('UniswapX V2 Dutch Order')
    expect(decoded.protocolIdentityVerified).toBe(true)
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Maximum Input End Amount', value: '1000000000' }))
    expect(decoded.fields).toContainEqual(expect.objectContaining({ label: 'Output 1 End Amount', value: '863944497040461607478' }))
  })
})
