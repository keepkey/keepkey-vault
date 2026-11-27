import type { SigningRequestInfo } from './types'
import { isVerifiedChange, utxoPreview } from './utxoPreview'
import { cosmosTxPreview } from './cosmosTxPreview'
import { evmMaxFee, evmNativeValue } from './evmFeePreview'
import { evmChainLabel } from './chains'

export type SigningReviewDepth = 'essentials' | 'guided' | 'audit'
export interface SigningReviewPreferences { depth: SigningReviewDepth; largeText: boolean }
export const DEFAULT_SIGNING_REVIEW: SigningReviewPreferences = { depth: 'guided', largeText: false }
export function signingReviewPreferences(value: unknown): SigningReviewPreferences {
  const v = value as Partial<SigningReviewPreferences> | null
  return { depth: v && ['essentials', 'guided', 'audit'].includes(v.depth || '') ? v.depth! : 'guided', largeText: v?.largeText === true }
}
export interface SigningReviewField { label: string; value: string }
export interface SigningReviewStep { title: string; why: string; compare: string }
export type SigningRequestKind = 'message' | 'typed' | 'contract' | 'transaction'
export interface SigningReviewGuide {
  title: string; purpose: string; warnings: string[]; fields: SigningReviewField[]; steps: SigningReviewStep[]; raw?: string
  kind: SigningRequestKind
  /** True only when the request TYPE guarantees the signature itself moves no
   *  funds: a plain message signature (never typed data, a typed hash, or a
   *  transaction-shaped Solana payload). Derived from the method and decoded
   *  shape, never from anything the requesting app claims. */
  noFundsMove: boolean
}

/** Advice for reading a request, never an assertion that a device page was
 * observed or that a host-decoded claim has been authenticated by firmware. */
export function signingReviewGuide(request: SigningRequestInfo): SigningReviewGuide {
  const fields: SigningReviewField[] = []
  const add = (label: string, value: unknown) => { if (typeof value === 'string' && value) fields.push({ label, value }) }
  const message = request.ethMessageDecoded || request.solanaMessageDecoded
  const typed = request.typedDataDecoded
  const messageMethod = !!message || /sign-message|sign-offchain-message|sign-typed-hash/.test(request.method) || request.method === '/eth/sign'
  const data = typeof request.data === 'string' ? request.data : typeof request.rawRequestBody?.data === 'string' ? request.rawRequestBody.data : ''
  const contract = request.method === '/eth/sign-transaction' && !/^(0x)?$/.test(data)
  const warnings: string[] = []
  if (request.firmwareCannotSign) warnings.push('The connected firmware cannot sign this request. Do not try to approve it through a different review setting.')
  if (request.needsBlindSigning || request.requiresBlindSigningConsent || request.requiresAdvancedMode) warnings.push('The device cannot independently explain every part of this payload. Review the warning and raw data before deciding whether to continue.')
  if (messageMethod || typed) warnings.push('A signature can authorize actions now or later. Confirm the requesting app and the complete message or permissions.')
  add('Requesting app', request.appName)
  add('Account', request.from || request.ethMessageDecoded?.address || request.solanaMessageDecoded?.signer)
  add('Network', request.method.startsWith('/eth/') && request.chainId !== undefined ? evmChainLabel(request.chainId)?.name || `Chain ${request.chainId}` : request.chain || (request.chainId ? `Chain ${request.chainId}` : undefined))
  if (typed) {
    add('Request type', typed.primaryType)
    add('Domain name', typed.domain.name)
    add('Domain version', typed.domain.version)
    if (typed.domain.chainId !== undefined) add('Domain chain', String(typed.domain.chainId))
    add('Verifying contract', typed.domain.verifyingContract)
    for (const field of typed.fields) add(field.label, field.value)
  } else if (messageMethod) {
    add('Message', message?.messageText)
    if (message?.messageText && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(message.messageText)) {
      warnings.push('This message contains hidden or direction-changing characters. Inspect the byte view before signing.')
    }
    if (message?.messageText === '') add('Message length', '0 characters')
    if (message?.messageText === undefined) warnings.push('Readable message text is unavailable. Compare the full bytes or digest shown by your KeepKey.')
  } else {
    let recipient = request.to
    let destinationLabel = contract ? 'Contract' : 'Recipient'
    // Canonical ERC-20 address words: never label the token contract as the
    // transfer recipient or allowance spender, including unknown tokens.
    if (contract && /^0x(?:a9059cbb|095ea7b3)0{24}[a-f0-9]{40}[a-f0-9]{64}$/i.test(data)) {
      const approve = data.slice(2, 10).toLowerCase() === '095ea7b3'
      recipient = `0x${data.slice(34, 74)}`
      destinationLabel = approve ? 'Spender' : 'Recipient'
      add('Token contract', request.to)
      const units = BigInt(`0x${data.slice(74)}`)
      add(approve ? 'Allowance' : 'Token amount', approve && units === (1n << 256n) - 1n ? 'Unlimited' : `${units} token base units`)
      if (approve && units === (1n << 256n) - 1n) warnings.push('This approval grants an unlimited allowance. Check the spender and whether a smaller limit would meet your intent.')
    }
    add(destinationLabel, recipient)
    if (request.method !== '/eth/sign-transaction') add('Requested value', request.value)
  }
  const utxo = request.method === '/utxo/sign-transaction' ? utxoPreview(request.rawRequestBody) : undefined
  if (utxo) {
    utxo.sends.forEach((output, i) => { add(`Output ${i + 1} address${output.unverified ? ' (unverified change)' : ''}`, output.address); add(`Output ${i + 1} amount`, output.amount) })
    add('Network fee', utxo.fee); add('Memo', utxo.memo)
    if (utxo.warning) warnings.push(utxo.warning)
  } else if (request.method === '/utxo/sign-transaction' && Array.isArray(request.rawRequestBody?.outputs)) {
    request.rawRequestBody.outputs.forEach((output: any, i: number) => {
      if (isVerifiedChange(output)) return
      add(`Output ${i + 1} address`, output?.address)
      if (typeof output?.amount === 'string' && /^[0-9]+$/.test(output.amount)) add(`Output ${i + 1} amount`, `${output.amount} base units`)
    })
  }
  const cosmos = cosmosTxPreview(request.method, request.rawRequestBody)
  if (cosmos) {
    cosmos.messages.forEach((message, i) => { add(`Action ${i + 1}`, message.type); message.rows.forEach(row => add(row.label, row.value)) })
    add('Network fee', cosmos.fee); add('Memo', cosmos.memo)
  }
  if (request.tronDecoded) {
    add('Signed destination', request.tronDecoded.to); add('Signed amount', request.tronDecoded.amount)
    add('Token contract', request.tronDecoded.tokenContract); add('Fee limit', request.tronDecoded.feeLimit); add('Memo', request.tronDecoded.memo)
  }
  if (request.method === '/xrp/sign-transaction') {
    const tag = (request.rawRequestBody?.payment as any)?.destinationTag
    if ((typeof tag === 'string' && /^[0-9]{1,10}$/.test(tag)) || (typeof tag === 'number' && Number.isInteger(tag) && tag >= 0 && tag <= 0xffffffff)) add('Destination tag', String(tag))
  }
  if (request.method === '/eth/sign-transaction') {
    const value = evmNativeValue(request.value, request.chainId)
    add(value ? 'Native value' : 'Native value (raw)', value || request.value)
    add('Maximum network fee', evmMaxFee(request.rawRequestBody, request.chainId))
  }
  if (request.solanaMessageDecoded?.classification.startsWith('solana-transaction')) warnings.push('This payload has transaction structure. The signature may authorize a Solana transaction.')
  const title = typed ? 'Review structured data' : messageMethod ? 'Review a message signature' : contract ? 'Review a contract action' : 'Review a transaction'
  const purpose = typed ? 'Check the domain and every permission or action before creating this signature.'
    : messageMethod ? 'Read the complete message and decide whether you intend to authorize it.'
    : 'Compare every action, destination, amount, network and fee with what you intended.'
  const steps: SigningReviewStep[] = [
    { title: 'Request and account', why: 'This identifies who is asking and which account would authorize the action.', compare: 'Match the requesting app, account and network with your intent.' },
    typed ? { title: 'Domain and signed fields', why: 'The domain scopes the signature. The fields define its permissions, destinations and limits.', compare: 'Check the chain, verifying contract and every signed field. A familiar domain name alone is not proof of identity.' }
      : messageMethod ? { title: 'Message or digest', why: 'These are the bytes your signature commits to. A message can grant authority without sending a transaction immediately.', compare: 'Read every message page. When the device shows a digest, compare the complete digest using the detailed reference below.' }
      : { title: 'Destination, amount and fee', why: 'These details determine where value goes and the maximum cost you accept.', compare: 'Compare the complete address, amount, token and fee. Include routing tags, memos and each external output when present.' },
    typed ? { title: 'Limits and recipients', why: 'Signed permissions can grant spending authority or authorize actions after this review.', compare: 'Check every recipient, spender, limit and expiry. Inspect the original data or digest when the device shows it.' }
      : messageMethod ? { title: 'Context and permissions', why: 'The text explains what the requesting app wants you to authorize.', compare: 'For a sign-in request, check the site, account, nonce and expiration. Reject unexpected permissions or text you do not understand.' }
      : { title: 'Names and descriptions', why: 'A contact label helps identify a destination. Firmware must verify its proof before it can show a certified name.', compare: 'Compare the raw address too. App-side names, simulations and explanations are advice; check what your KeepKey actually displays.' },
    { title: 'Final decision', why: 'The device button authorizes the request after its required reviews.', compare: 'Approve only when all details agree. Reject or cancel if anything is unfamiliar or different.' },
  ]
  let raw: string | undefined
  // Audit only public signing references. Never traverse arbitrary request
  // objects containing wallet witnesses, secrets or authentication material.
  if (typed) raw = JSON.stringify({ domain: typed.domain, type: typed.primaryType, fields: typed.fields, hashes: typed.hashes }, null, 2)
  else raw = request.solanaMessageDecoded?.messageHex || request.ethMessageDecoded?.messageRaw || data || undefined
  const kind: SigningRequestKind = typed ? 'typed' : messageMethod ? 'message' : contract ? 'contract' : 'transaction'
  const noFundsMove = kind === 'message'
    && !/sign-typed-hash/.test(request.method)
    && !request.solanaMessageDecoded?.classification.startsWith('solana-transaction')
  return { title, purpose, warnings, fields, steps, raw, kind, noFundsMove }
}

/** Decode the actual SSD1306 page-layout buffer, preserving every source bit. */
export function emulatorReviewPixels(frame: Uint8Array): Uint8ClampedArray {
  if (frame.length !== 2048) throw new Error('Invalid 256 by 64 emulator frame')
  const pixels = new Uint8ClampedArray(256 * 64 * 4)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) {
    const on = (frame[(y >> 3) * 256 + x] >> (y & 7)) & 1
    const i = (y * 256 + x) * 4
    pixels[i] = on ? 232 : 15; pixels[i + 1] = on ? 224 : 19; pixels[i + 2] = on ? 208 : 25; pixels[i + 3] = 255
  }
  return pixels
}
