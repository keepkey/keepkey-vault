import { createHash } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { utils as ethersUtils } from 'ethers'

import { uniswapReportFindings } from './uniswap-report'

const VERSION = 1
const CLASSIFICATION_VERIFIED = 1
const ARG_FORMAT_ADDRESS = 1
const ARG_FORMAT_AMOUNT = 2
const ARG_FORMAT_STRING = 4
const MAX_ARGS = 8
const MAX_VALUE_BYTES = 44
const MAX_STRING_BYTES = 32

const u8 = (value: number) => Buffer.from([value & 0xff])
const be16 = (value: number) => { const out = Buffer.alloc(2); out.writeUInt16BE(value); return out }
const be32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value >>> 0); return out }

function minimalBE(value: bigint): Buffer {
  if (value < 0n) throw new Error('negative amount')
  const bytes: number[] = []
  for (let cursor = value; cursor > 0n; cursor >>= 8n) bytes.unshift(Number(cursor & 0xffn))
  return Buffer.from(bytes)
}

function cleanHex(value: unknown, label: string, bytes?: number): Buffer {
  const clean = String(value ?? '').replace(/^0x/i, '')
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 || (bytes !== undefined && clean.length !== bytes * 2)) {
    throw new Error(`${label} must be${bytes === undefined ? '' : ` ${bytes}-byte`} hex`)
  }
  return Buffer.from(clean, 'hex')
}

function numberValue(value: unknown, label: string): bigint {
  try { return BigInt(value as any) } catch { throw new Error(`${label} must be an integer`) }
}

/** Hash exactly the transaction the device will sign. Runtime descriptions
 * are useless unless this digest agrees byte-for-byte with firmware. */
export function runtimeEvmSighash(tx: any): Buffer {
  const chainId = Number(tx.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0 || chainId > 0xffffffff) throw new Error('chainId is invalid')
  const hasLegacy = tx.gasPrice !== undefined
  const has1559 = tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined
  if (hasLegacy === has1559) throw new Error(hasLegacy ? 'transaction mixes legacy and EIP-1559 fees' : 'transaction has no complete fee model')
  if (has1559 && (tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined)) throw new Error('EIP-1559 requires both fee fields')
  const unsigned = ethersUtils.serializeTransaction({
    chainId,
    nonce: numberValue(tx.nonce, 'nonce'),
    gasLimit: numberValue(tx.gasLimit, 'gasLimit'),
    to: ethersUtils.getAddress(String(tx.to)),
    value: numberValue(tx.value ?? 0, 'value'),
    data: ethersUtils.hexlify(cleanHex(tx.data ?? '0x', 'data')),
    ...(hasLegacy ? { gasPrice: numberValue(tx.gasPrice, 'gasPrice') } : {
      type: 2,
      maxFeePerGas: numberValue(tx.maxFeePerGas, 'maxFeePerGas'),
      maxPriorityFeePerGas: numberValue(tx.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
      accessList: [],
    }),
  })
  return Buffer.from(ethersUtils.arrayify(ethersUtils.keccak256(unsigned)))
}

function printable(value: string): string {
  const normalized = value
    .replaceAll('→', '->').replaceAll('≥', '>=').replaceAll('≤', '<=')
    .replaceAll('…', '...').replaceAll('–', '-').replaceAll('—', '-')
  if (!normalized || !/^[\x20-\x7e]+$/.test(normalized)) throw new Error('report contains non-printable text')
  return normalized
}

function chunks(value: string): string[] {
  const remaining = printable(value).trim().replace(/\s+/g, ' ')
  const out: string[] = []
  let cursor = remaining
  while (cursor.length) {
    let end = Math.min(MAX_STRING_BYTES, cursor.length)
    if (end < cursor.length) {
      const boundary = cursor.lastIndexOf(' ', end)
      if (boundary > 16) end = boundary
    }
    out.push(cursor.slice(0, end))
    cursor = cursor.slice(end).trimStart()
  }
  return out
}

export interface RuntimeDisplayField { name: string; value: string }

function encodeRuntimeField(field: RuntimeDisplayField): { format: number; value: Buffer } {
  if (['Input token', 'Output token', 'Recipient', 'Token contract', 'Spender'].includes(field.name)) {
    return { format: ARG_FORMAT_ADDRESS, value: cleanHex(field.value, field.name, 20) }
  }
  if (['Deadline', 'Spend', 'Spend at most', 'Spend wei', 'Receive', 'Receive at least'].includes(field.name)) {
    return { format: ARG_FORMAT_AMOUNT, value: minimalBE(numberValue(field.value, field.name)) }
  }
  const value = Buffer.from(printable(field.value), 'ascii')
  if (!value.length || value.length > MAX_STRING_BYTES) throw new Error(`${field.name} string exceeds ${MAX_STRING_BYTES} bytes`)
  return { format: ARG_FORMAT_STRING, value }
}

function permit2ApprovalFields(findings: Array<{ code: string; message: string }>): RuntimeDisplayField[] | undefined {
  if (findings.length !== 1 || findings[0].code !== 'UNISWAP_PERMIT2_TOKEN_APPROVAL') return undefined
  const match = findings[0].message.match(
    /^Authorize canonical Permit2 (0x[0-9a-f]{40}) to spend an unlimited amount of USDT from token contract (0x[0-9a-f]{40})\.$/i,
  )
  if (!match) return undefined
  const fields: RuntimeDisplayField[] = [
    { name: 'Protocol', value: 'Uniswap Permit2' },
    { name: 'Network', value: 'Arbitrum One' },
    { name: 'Token', value: 'USDT' },
    { name: 'Token contract', value: match[2] },
    { name: 'Spender', value: match[1] },
    { name: 'Allowance', value: 'Unlimited' },
    { name: 'Duration', value: 'Until revoked' },
  ]
  try {
    fields.forEach(field => encodeRuntimeField(field))
    return fields
  } catch { return undefined }
}

function directSwapFields(
  findings: Array<{ code: string; message: string }>,
  tx: any,
): RuntimeDisplayField[] | undefined {
  const ignored = new Set(['UNISWAP_LEGACY_ROUTER_CALL'])
  const economic = findings.filter(item => !ignored.has(item.code))
  if (economic.length !== 1) return undefined
  const finding = economic[0]
  const exactInput = finding.code === 'UNISWAP_EXACT_INPUT_SWAP'
  const exactOutput = finding.code === 'UNISWAP_EXACT_OUTPUT_SWAP'
  if (!exactInput && !exactOutput) return undefined

  const input = exactInput
    ? finding.message.match(/^([^ ]+) spends (the transaction native value|(\d+) base units) for at least (\d+) base units; path (.+); recipient (0x[0-9a-f]{40}); deadline (\d+)\.$/i)
    : finding.message.match(/^([^ ]+) receives (\d+) base units while spending at most (the transaction native value|(\d+) base units); path (.+); recipient (0x[0-9a-f]{40}); deadline (\d+)\.$/i)
  if (!input) return undefined

  const pathIndex = exactInput ? 5 : 5
  const path = input[pathIndex].split(/\s*(?:→|->)\s*/)
  if (path.length !== 2 || path.some(token => !/^0x[0-9a-f]{40}$/i.test(token))) return undefined
  const native = exactInput ? input[2] === 'the transaction native value' : input[3] === 'the transaction native value'
  const spend = native ? numberValue(tx.value ?? 0, 'value').toString() : (exactInput ? input[3] : input[4])
  const receive = exactInput ? input[4] : input[2]
  const recipient = exactInput ? input[6] : input[6]
  const deadline = exactInput ? input[7] : input[7]
  const fields: RuntimeDisplayField[] = [
    { name: 'Action', value: exactInput ? 'Exact input swap' : 'Exact output swap' },
    { name: exactInput ? 'Spend' : 'Spend at most', value: spend },
    { name: exactInput ? 'Receive at least' : 'Receive', value: receive },
    { name: 'Input token', value: path[0] },
    { name: 'Output token', value: path[1] },
    { name: 'Recipient', value: recipient },
    { name: 'Deadline', value: deadline },
    { name: 'Input kind', value: native ? 'native value' : 'ERC-20 allowance' },
  ]
  try {
    fields.forEach(field => encodeRuntimeField(field))
    return fields
  } catch { return undefined }
}

function universalExactInputFields(findings: Array<{ code: string; message: string }>): RuntimeDisplayField[] | undefined {
  const expected = new Set(['UNISWAP_UNIVERSAL_ROUTER_COMMANDS', 'UNISWAP_DEADLINE', 'UNISWAP_WRAP_ETH', 'UNISWAP_EXACT_INPUT_SWAP', 'UNISWAP_SWEEP'])
  if (findings.length !== expected.size || findings.some(item => !expected.has(item.code))) return undefined
  const byCode = Object.fromEntries(findings.map(item => [item.code, item.message]))
  const rawRoute = byCode.UNISWAP_UNIVERSAL_ROUTER_COMMANDS.match(/commands: (.+)\.$/)?.[1]
  const deadline = byCode.UNISWAP_DEADLINE.match(/deadline is (\d+)\./)?.[1]
  const wrapped = byCode.UNISWAP_WRAP_ETH.match(/Wrap (\d+) wei/)?.[1]
  const swap = byCode.UNISWAP_EXACT_INPUT_SWAP.match(/spends (\d+) base units for at least (\d+) base units; path (0x[0-9a-f]{40}) . (0x[0-9a-f]{40}); recipient ([^;]+); payer ([^.]+)\./i)
  const sweep = byCode.UNISWAP_SWEEP.match(/Sweep token (0x[0-9a-f]{40}) to (0x[0-9a-f]{40}), requiring at least (\d+) base units\./i)
  if (!rawRoute || !deadline || !wrapped || !swap || !sweep) return undefined
  if (wrapped !== swap[1] || swap[2] !== sweep[3] || swap[4].toLowerCase() !== sweep[1].toLowerCase()) return undefined
  const fields = [
    { name: 'Route', value: rawRoute.replaceAll('WRAP_ETH', 'WRAP').replaceAll('V2_SWAP_EXACT_IN', 'V2_EXACT_IN').replaceAll(' → ', '>') },
    { name: 'Deadline', value: deadline },
    { name: 'Spend wei', value: wrapped },
    { name: 'Receive at least', value: swap[2] },
    { name: 'Input token', value: swap[3] },
    { name: 'Output token', value: swap[4] },
    { name: 'Recipient', value: sweep[2] },
    { name: 'Payer', value: swap[6] },
  ]
  const normalized = fields.map(field => ({ name: printable(field.name), value: printable(field.value) }))
  try {
    normalized.forEach(field => encodeRuntimeField(field))
    return normalized
  } catch { return undefined }
}

function arbitrumV4ExactInputFields(tx: any): RuntimeDisplayField[] | undefined {
  const router = '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
  const usdt = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
  const zero = '0x0000000000000000000000000000000000000000'
  if (Number(tx.chainId) !== 42161 || String(tx.to).toLowerCase() !== router || BigInt(tx.value || 0) !== 0n) return undefined
  try {
    const iface = new ethersUtils.Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline)'])
    const decoded = iface.decodeFunctionData('execute', String(tx.data))
    const commands = String(decoded.commands).toLowerCase()
    const inputs: string[] = decoded.inputs
    if (commands !== '0x0a1004' || inputs.length !== 3) return undefined
    const permit = ethersUtils.defaultAbiCoder.decode([
      'tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)', 'bytes',
    ], inputs[0])
    const permitSingle = permit[0]
    if (permitSingle.details.token.toLowerCase() !== usdt || permitSingle.spender.toLowerCase() !== router
      || permitSingle.details.amount.toHexString().toLowerCase() !== `0x${'ff'.repeat(20)}`
      || ethersUtils.arrayify(permit[1]).length !== 65) return undefined

    const v4 = ethersUtils.defaultAbiCoder.decode(['bytes', 'bytes[]'], inputs[1])
    if (String(v4[0]).toLowerCase() !== '0x070b0e' || v4[1].length !== 3) return undefined
    const swap = ethersUtils.defaultAbiCoder.decode([
      'tuple(address currencyIn,tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 amountIn,uint128 amountOutMinimum)',
    ], v4[1][0])[0]
    if (swap.currencyIn.toLowerCase() !== usdt || swap.path.length !== 1
      || swap.path[0].intermediateCurrency.toLowerCase() !== zero
      || swap.path[0].hooks.toLowerCase() !== zero || swap.path[0].hookData !== '0x'
      || swap.amountIn.isZero() || swap.amountOutMinimum.isZero()) return undefined
    const settle = ethersUtils.defaultAbiCoder.decode(['address', 'uint256'], v4[1][1])
    const take = ethersUtils.defaultAbiCoder.decode(['address', 'address', 'uint256'], v4[1][2])
    const sweep = ethersUtils.defaultAbiCoder.decode(['address', 'address', 'uint256'], inputs[2])
    if (settle[0].toLowerCase() !== usdt || !settle[1].isZero()
      || take[0].toLowerCase() !== zero || take[1].toLowerCase() !== String(tx.from).toLowerCase() || !take[2].isZero()
      || sweep[0].toLowerCase() !== zero || sweep[1].toLowerCase() !== String(tx.from).toLowerCase() || !sweep[2].isZero()) return undefined
    return [
      { name: 'Protocol', value: 'Uniswap v4' },
      { name: 'Input asset', value: 'Arbitrum USDT' },
      { name: 'Input token', value: usdt },
      { name: 'Spend', value: swap.amountIn.toString() },
      { name: 'Output asset', value: 'Native ETH' },
      { name: 'Receive at least', value: swap.amountOutMinimum.toString() },
      { name: 'Recipient', value: String(tx.from) },
      { name: 'Deadline', value: decoded.deadline.toString() },
    ]
  } catch { return undefined }
}

function arbitrumV3ExactInputFields(tx: any): RuntimeDisplayField[] | undefined {
  const router = '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
  const usdt = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
  const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
  const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'
  const routerRecipient = '0x0000000000000000000000000000000000000002'
  if (Number(tx.chainId) !== 42161 || String(tx.to).toLowerCase() !== router || BigInt(tx.value || 0) !== 0n) return undefined
  try {
    const iface = new ethersUtils.Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline)'])
    const data = String(tx.data).toLowerCase()
    const decoded = iface.decodeFunctionData('execute', data)
    // Uniswap's current web client appends a 22-byte attribution footer after
    // canonical ABI calldata. Its eight-byte quote code varies per request.
    // The fixed framing is checked here and every byte is committed by tx_hash.
    const canonical = iface.encodeFunctionData('execute', Array.from(decoded)).toLowerCase()
    const footer = data.slice(canonical.length)
    if (!data.startsWith(canonical) || !/^756e6978000001a0[0-9a-f]{16}0000000c0100$/.test(footer)) return undefined
    if (String(decoded.commands).toLowerCase() !== '0x0a000c' || decoded.inputs.length !== 3) return undefined

    const permit = ethersUtils.defaultAbiCoder.decode([
      'tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)', 'bytes',
    ], decoded.inputs[0])
    const permitSingle = permit[0]
    if (permitSingle.details.token.toLowerCase() !== usdt || permitSingle.spender.toLowerCase() !== router
      || permitSingle.details.amount.toHexString().toLowerCase() !== `0x${'ff'.repeat(20)}`
      || ethersUtils.arrayify(permit[1]).length !== 65) return undefined

    const swap = ethersUtils.defaultAbiCoder.decode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool', 'uint256[]'], decoded.inputs[1],
    )
    const reencodedSwap = ethersUtils.defaultAbiCoder.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool', 'uint256[]'], Array.from(swap),
    ).toLowerCase()
    if (reencodedSwap !== String(decoded.inputs[1]).toLowerCase()) return undefined
    const expectedPath = `${usdt}${'000064'}${usdc.slice(2)}${'000064'}${weth.slice(2)}`
    if (String(swap[0]).toLowerCase() !== routerRecipient || swap[1].isZero() || !swap[2].isZero()
      || String(swap[3]).toLowerCase() !== expectedPath || swap[4] !== true || swap[5].length !== 0) return undefined

    const unwrap = ethersUtils.defaultAbiCoder.decode(['address', 'uint256'], decoded.inputs[2])
    const reencodedUnwrap = ethersUtils.defaultAbiCoder.encode(['address', 'uint256'], Array.from(unwrap)).toLowerCase()
    if (reencodedUnwrap !== String(decoded.inputs[2]).toLowerCase()
      || String(unwrap[0]).toLowerCase() !== String(tx.from).toLowerCase() || unwrap[1].isZero()) return undefined
    return [
      { name: 'Protocol', value: 'Uniswap v3' },
      { name: 'Input asset', value: 'Arbitrum USDT' },
      { name: 'Input token', value: usdt },
      { name: 'Spend', value: swap[1].toString() },
      { name: 'Output asset', value: 'Native ETH' },
      { name: 'Receive at least', value: unwrap[1].toString() },
      { name: 'Recipient', value: String(tx.from) },
      { name: 'Deadline', value: decoded.deadline.toString() },
    ]
  } catch { return undefined }
}

/** Render a complete decoder result into the bounded v1 device format. The
 * top-level attribution is already cryptographically bound by chain, target
 * and selector, so the repeated "Official Uniswap ... call" finding is used
 * as the method title and omitted from the operation text. */
export function uniswapRuntimePages(tx: any): { method: string; pages: string[]; fields: RuntimeDisplayField[] } {
  const arbitrumV3 = arbitrumV3ExactInputFields(tx)
  if (arbitrumV3) return { method: 'Uniswap v3 exact-input swap', pages: arbitrumV3.map(item => item.value), fields: arbitrumV3 }
  const arbitrumV4 = arbitrumV4ExactInputFields(tx)
  if (arbitrumV4) return { method: 'Uniswap v4 exact-input swap', pages: arbitrumV4.map(item => item.value), fields: arbitrumV4 }
  const result = uniswapReportFindings(String(tx.data || '0x'), Number(tx.chainId), String(tx.to || ''))
  if (!result.findings.length) throw new Error('transaction is not a recognized official Uniswap call')
  if (!result.complete || result.limitations.length) {
    throw new Error(`Uniswap report is incomplete: ${result.limitations.map(item => item.code).join(', ') || 'unknown limitation'}`)
  }
  const approval = permit2ApprovalFields(result.findings)
  if (approval) return { method: 'Uniswap Permit2 approval', pages: approval.map(item => item.value), fields: approval }
  const compact = universalExactInputFields(result.findings)
  if (compact) return { method: 'Uniswap exact-input swap', pages: compact.map(item => item.value), fields: compact }
  const directSwap = directSwapFields(result.findings, tx)
  if (directSwap) return { method: 'Uniswap direct swap', pages: directSwap.map(item => item.value), fields: directSwap }
  const call = result.findings.find(item => /_CALL$/.test(item.code))
  const details = result.findings.filter(item => item !== call).map(item => item.message)
  if (!details.length) throw new Error('Uniswap report has no economic operation details')
  const pages = chunks(details.join(' | '))
  if (pages.length > MAX_ARGS) throw new Error(`Uniswap report needs ${pages.length} device fields; maximum is ${MAX_ARGS}`)
  const fields = pages.map((value, index) => ({ name: `Review ${index + 1}/${pages.length}`, value }))
  return { method: printable(call?.message.replace(/^Official /, '').replace(/ call: /, ': ').replace(/\.$/, '') || 'Uniswap transaction').slice(0, 64), pages, fields }
}

export function buildUniswapRuntimeEnvelope(tx: any, keyId: number, privateKey: Uint8Array, timestamp = Math.floor(Date.now() / 1000)) {
  if (!Number.isInteger(keyId) || !([1, 2, 3, 0x80].includes(keyId))) throw new Error('signer keyId must be a runtime slot or certified delegate')
  if (privateKey.length !== 32) throw new Error('runtime signer private key must be 32 bytes')
  const chainId = Number(tx.chainId)
  const contract = cleanHex(tx.to, 'to', 20)
  const data = cleanHex(tx.data, 'data')
  if (data.length < 4) throw new Error('data has no selector')
  const txHash = runtimeEvmSighash(tx)
  const { method, pages, fields } = uniswapRuntimePages(tx)
  const methodBytes = Buffer.from(method, 'ascii')
  const body: Buffer[] = [u8(VERSION), be32(chainId), contract, data.subarray(0, 4), txHash, be16(methodBytes.length), methodBytes, u8(pages.length)]
  fields.forEach((field) => {
    const name = Buffer.from(field.name, 'ascii')
    const encoded = encodeRuntimeField(field)
    if (encoded.value.length > MAX_VALUE_BYTES) throw new Error(`${field.name} exceeds the firmware value bound`)
    body.push(u8(name.length), name, u8(encoded.format), be16(encoded.value.length), encoded.value)
  })
  body.push(u8(CLASSIFICATION_VERIFIED), be32(timestamp), u8(keyId))
  const payload = Buffer.concat(body)
  const signature = secp256k1.sign(createHash('sha256').update(payload).digest(), privateKey, { lowS: false })
  return {
    signedPayload: `0x${Buffer.concat([payload, Buffer.from(signature.toCompactRawBytes()), Buffer.from([27 + (signature.recovery ?? 0)])]).toString('hex')}`,
    keyId,
    txHash: `0x${txHash.toString('hex')}`,
    method,
    pages,
  }
}

export interface UniswapRuntimeSigner {
  alias: string
  keyId: number
  privateKeyHex: string
  publicKeyHex: string
  fingerprint: string
}

export function validateUniswapRuntimeSigner(input: UniswapRuntimeSigner): UniswapRuntimeSigner {
  const privateKey = cleanHex(input.privateKeyHex, 'private key', 32)
  const publicKeyHex = Buffer.from(secp256k1.getPublicKey(privateKey, true)).toString('hex')
  const fingerprint = createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 8)
  if (publicKeyHex !== String(input.publicKeyHex).replace(/^0x/i, '').toLowerCase() || fingerprint !== String(input.fingerprint).toLowerCase()) {
    throw new Error('runtime signer public identity does not match its private key')
  }
  if (!Number.isInteger(input.keyId) || input.keyId < 1 || input.keyId > 3) throw new Error('runtime signer keyId must be 1..3')
  const alias = printable(String(input.alias || '')).slice(0, 31)
  if (!alias) throw new Error('runtime signer alias is required')
  return { ...input, alias, publicKeyHex, fingerprint }
}

/** Standalone provider handler. It owns the live annotation key; Vault never
 * receives that private key. Unknown, noncanonical, incomplete, or oversized
 * Uniswap reports return 422 and are never stamped as verified. */
export function createUniswapRuntimeProvider(signerInput: UniswapRuntimeSigner) {
  const signer = validateUniswapRuntimeSigner(signerInput)
  const privateKey = Buffer.from(signer.privateKeyHex.replace(/^0x/i, ''), 'hex')
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'keepkey-uniswap-runtime-clearsign' })
    if (request.method === 'GET' && url.pathname === '/signer') return json({
      alias: signer.alias, keyId: signer.keyId, publicKeyHex: signer.publicKeyHex, fingerprint: signer.fingerprint,
    })
    if (request.method === 'POST' && url.pathname === '/sign') {
      const length = Number(request.headers.get('content-length') || 0)
      if (!Number.isFinite(length) || length > 128 * 1024) return json({ error: 'request too large' }, 413)
      let tx: any
      try { tx = await request.json() } catch { return json({ error: 'invalid JSON' }, 400) }
      try {
        const result = buildUniswapRuntimeEnvelope(tx, signer.keyId, privateKey)
        return json({ success: true, classification: 'VERIFIED', ...result })
      } catch (error: any) {
        return json({ classification: 'OPAQUE', error: error?.message || 'transaction refused' }, 422)
      }
    }
    return json({ error: 'not found' }, 404)
  }
}
