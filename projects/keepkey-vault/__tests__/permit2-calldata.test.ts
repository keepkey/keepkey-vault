import { describe, expect, test } from 'bun:test'
import { utils as ethersUtils } from 'ethers'

import { decodePermit2Call, permit2ReportFindings } from '../src/bun/permit2-calldata'

const detail = 'tuple(address token,uint160 amount,uint48 expiration,uint48 nonce)'
const permission = 'tuple(address token,uint256 amount)'
const transfer = 'tuple(address to,uint256 requestedAmount)'
const iface = new ethersUtils.Interface([
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
  `function permit(address owner,tuple(${detail} details,address spender,uint256 sigDeadline) permitSingle,bytes signature)`,
  `function permitTransferFrom(tuple(${permission} permitted,uint256 nonce,uint256 deadline) permit,${transfer} transferDetails,address owner,bytes signature)`,
  `function permitWitnessTransferFrom(tuple(${permission}[] permitted,uint256 nonce,uint256 deadline) permit,${transfer}[] transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)`,
])
const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const owner = '0x909Ef6B32DfDc12CA86aA710b54c991af3C5F82E'
const spender = '0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA'

describe('Permit2 calldata ClearSign decoder', () => {
  test('decodes unlimited on-chain allowance', () => {
    const data = iface.encodeFunctionData('approve', [token, spender, (1n << 160n) - 1n, 1_900_000_000])
    const report = permit2ReportFindings(data, 1, permit2)
    expect(report.complete).toBe(true)
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'PERMIT2_ALLOWANCE', message: expect.stringContaining('unlimited amount'),
    }))
  })

  test('decodes a submitted signed allowance without exposing signature bytes', () => {
    const data = iface.encodeFunctionData('permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)', [
      owner, [[token, 123, 1_900_000_000, 7], spender, 1_900_000_001], `0x${'ab'.repeat(65)}`,
    ])
    const decoded = decodePermit2Call(data)!
    expect(decoded.decoded).toMatchObject({
      owner: owner.toLowerCase(), spender: spender.toLowerCase(), signatureBytes: 65,
      details: [{ token: token.toLowerCase(), amount: '123', expiration: '1900000000', nonce: '7' }],
    })
    expect(JSON.stringify(decoded)).not.toContain('abababababababab')
  })

  test('decodes one-time signature transfer execution bounds', () => {
    const data = iface.encodeFunctionData('permitTransferFrom', [
      [[token, 500], 9, 1_900_000_000], [spender, 450], owner, `0x${'11'.repeat(65)}`,
    ])
    const report = permit2ReportFindings(data, 1, permit2)
    expect(report.complete).toBe(true)
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'PERMIT2_SIGNATURE_TRANSFER',
      message: expect.stringContaining(`move up to 500 base units of ${token.toLowerCase()}`),
    }))
    expect(report.findings.find(item => item.code === 'PERMIT2_SIGNATURE_TRANSFER')?.message)
      .toContain(`requested transfer 450 to ${spender.toLowerCase()}`)
  })

  test('retains witness commitment and fails closed on malformed batch cardinality', () => {
    const witness = `0x${'22'.repeat(32)}`
    const data = iface.encodeFunctionData('permitWitnessTransferFrom', [
      [[[token, 500], [spender, 600]], 9, 1_900_000_000], [[owner, 450]], owner,
      witness, 'Example witness)Example(bytes32 salt)', `0x${'33'.repeat(65)}`,
    ])
    const report = permit2ReportFindings(data, 1, permit2)
    expect(report.complete).toBe(false)
    expect(report.findings.find(item => item.code === 'PERMIT2_SIGNATURE_TRANSFER')?.message).toContain(witness)
    expect(report.limitations).toContainEqual(expect.objectContaining({ code: 'PERMIT2_BATCH_LENGTH_MISMATCH' }))
  })

  test('does not authenticate matching calldata on an unmanifested chain or target', () => {
    const data = iface.encodeFunctionData('approve', [token, spender, 1, 1_900_000_000])
    expect(permit2ReportFindings(data, 143, permit2).complete).toBe(false)
    expect(permit2ReportFindings(data, 1, owner).limitations)
      .toContainEqual(expect.objectContaining({ code: 'PERMIT2_IDENTITY_UNVERIFIED' }))
  })
})
