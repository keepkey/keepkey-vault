/**
 * Risk level for a signing request, in plain English, derived ONLY from facts
 * in the payload.
 *
 * Purpose: stop "every request is red" desensitization. A text login, a
 * fee-only game move and a transaction that can move your SOL must not look
 * the same. Every level comes with the sentences that produced it, so the bar
 * is never a black box.
 *
 * Rules for future inputs (simulation, Pioneer reputation, AI review): they may
 * RAISE the level or add reasons; they must never lower a level set here.
 *
 * This runs on the host. It is "checked on this computer", not "verified" —
 * the device screen stays the authority.
 */
import { evmNativeValue } from './evmFeePreview'
import type { SigningRequestInfo, SolanaTxDecodedInstruction } from './types'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export interface RiskReason { level: RiskLevel; text: string }
export interface RiskAssessment { level: RiskLevel; headline: string; reasons: RiskReason[] }

const ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical']
const HEADLINE: Record<RiskLevel, string> = {
  low: 'Low risk',
  medium: 'Check before you sign',
  high: 'High risk: only sign if you trust this site',
  critical: 'Danger: reject unless you are certain',
}
const U64_MAX = (1n << 64n) - 1n

export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)

function units(raw: string, decimals: number): string {
  const v = BigInt(raw)
  const base = 10n ** BigInt(decimals)
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${(v / base).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`
}

const arg = (ix: SolanaTxDecodedInstruction, name: string) => ix.args.find((a) => a.name === name)?.value
const acct = (ix: SolanaTxDecodedInstruction, label: string) => ix.accounts.find((a) => a.label === label)?.pubkey

/** Plain sentence for an instruction KeepKey fully understands, or null. */
function describeKnown(ix: SolanaTxDecodedInstruction): RiskReason | null {
  const name = ix.instructionName
  if (ix.programName === 'System Program' && name === 'transfer') {
    const to = acct(ix, 'destination')
    return { level: 'low', text: `Sends ${units(arg(ix, 'lamports') ?? '0', 9)} SOL${to ? ` to ${shortAddr(to)}` : ''}.` }
  }
  if (name === 'transfer' || name === 'transferChecked') {
    const dec = arg(ix, 'decimals')
    const amount = dec ? units(arg(ix, 'amount') ?? '0', Number(dec)) : 'tokens'
    const mint = acct(ix, 'mint')
    return { level: 'low', text: `Sends ${amount}${dec && mint ? ` of token ${shortAddr(mint)}` : ''}.` }
  }
  if (name === 'approve' || name === 'approveChecked') {
    const raw = arg(ix, 'amount') ?? '0'
    const dec = arg(ix, 'decimals')
    const howMuch = BigInt(raw) === U64_MAX ? 'ALL of' : dec ? `up to ${units(raw, Number(dec))} of` : 'some of'
    const who = acct(ix, 'delegate')
    return { level: 'critical', text: `Lets ${who ? shortAddr(who) : 'another account'} spend ${howMuch} your tokens, now and later, without asking you again.` }
  }
  return null
}

// ── EVM ──────────────────────────────────────────────────────────────
// Addresses are shown in full: a 0x1234…abcd short form is cheap to grind
// for address poisoning. ponytail: lowercase hex, add EIP-55 checksums later.

const EVM_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
}
const KNOWN_SELECTORS = new Set(['0x095ea7b3', '0x39509351', '0xa22cb465', '0xa9059cbb'])
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const ALL_THRESHOLD = (1n << 160n) - 1n // uint160 max: Permit2's "unlimited"

function evmChainId(v: unknown): number {
  const n = typeof v === 'string' ? Number(v.startsWith('0x') ? parseInt(v, 16) : v) : Number(v)
  return n > 0 ? n : 1 // the /eth/sign-transaction handler signs a missing/0 chainId as 1
}

function evmTx(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void) {
  const to = (req.to ?? '').toLowerCase()
  const chainId = evmChainId(req.chainId)
  const rawData = typeof req.data === 'string' && req.data !== '' ? req.data : '0x'
  if (!/^0x([0-9a-fA-F]{2})*$/.test(rawData)) {
    add('high', 'This computer cannot read the call data. You would be signing blind.')
    return
  }
  const data = rawData.toLowerCase()
  const word = (i: number) => data.slice(10 + 64 * i, 74 + 64 * i)
  const addrWord = (i: number) => (/^0{24}[0-9a-f]{40}$/.test(word(i)) ? `0x${word(i).slice(24)}` : null)
  const num = (i: number) => (word(i).length === 64 ? BigInt(`0x${word(i)}`) : null)
  const token = EVM_TOKENS[`${chainId}:${to}`]
  const amount = (raw: bigint) => (token ? `${units(raw.toString(), token.decimals)} ${token.symbol}` : `${raw} units of token ${to}`)

  const native = evmNativeValue(req.value ?? '0', chainId)
  const sendsCoin = native !== null && !/^0 /.test(native)
  if (sendsCoin) add('low', `Sends ${native} to ${data === '0x' ? '' : 'the contract at '}${to}.`)
  if (data === '0x') {
    if (!sendsCoin) add('low', 'Calls no contract and sends nothing.')
    return
  }

  const sel = data.slice(0, 10)
  const catalog = req.rawRequestBody?.erc7730
  const hasCatalog = typeof catalog === 'object' && catalog !== null
  if ((sel === '0x095ea7b3' || sel === '0x39509351') && addrWord(0) && num(1) !== null) {
    const spender = addrWord(0)!, v = num(1)!
    if (v === 0n) {
      add(token ? 'low' : 'medium', `Removes ${spender}'s permission to spend your ${token?.symbol ?? `token ${to}`}.`)
    } else {
      add('critical', `Lets ${spender} spend ${v >= ALL_THRESHOLD ? 'ALL of' : `up to ${amount(v)} of`} your ${token?.symbol ?? 'tokens'}, now and later, without asking you again.`)
    }
  } else if (sel === '0xa22cb465' && addrWord(0) && num(1) !== null) {
    add(num(1) === 0n ? 'low' : 'critical', num(1) === 0n
      ? `Removes ${addrWord(0)}'s access to your NFTs in collection ${to}.`
      : `Lets ${addrWord(0)} take ALL of your NFTs in collection ${to}, now and later, without asking you again.`)
  } else if (sel === '0xa9059cbb' && data.length === 138 && addrWord(0) && num(1) !== null) {
    add(token ? 'low' : 'medium', token
      ? `Sends ${amount(num(1)!)} to ${addrWord(0)}.`
      : `Sends ${num(1)} units of token ${to} to ${addrWord(0)}. This computer does not recognize this token.`)
  } else if (hasCatalog) {
    add('high', `The site attached a signed description of this call. This computer cannot check it; your KeepKey checks it and refuses if it is not genuine. The call can still use any token permission you already gave ${to}.`)
  } else if (!req.deviceClearSigns || KNOWN_SELECTORS.has(sel)) {
    // A known selector reaching here did not parse (dirty address word,
    // trailing bytes): the device may accept it by length alone.
    add('high', `Your KeepKey cannot show what this call to ${to} does. It can use any token permission you already gave that contract. You would be signing blind.`)
  }

  const fields = req.calldataDecoded?.fields ?? []
  const field = (n: string) => fields.find((f) => f.name === n)?.value
  if (field('Action')?.startsWith('Swap ')) {
    const min = field('Minimum output')
    if (!min || min === 'No minimum specified' || /^0(?:\.0+)?\s/.test(min)) add('high', 'Sets no minimum, so this swap can pay you back almost nothing.')
  }
  if (field('Token warning') || field('Input token warning')) add('high', 'Swaps a token KeepKey does not recognize. It may be a fake.')
}

function evmTypedData(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void) {
  const d = req.typedDataDecoded
  if (!d) {
    add('high', 'This computer could not read this signature request, and your KeepKey shows only a code (hash) for it. You would be signing blind.')
    return
  }
  const f = (label: string) => d.fields.find((x) => x.label === label)
  if (d.operationName === 'x402 EIP-3009 Payment') {
    add('medium', `Authorizes a payment of ${f('Value')?.value ?? 'an amount'} to ${f('Pay To')?.raw ?? 'another account'}. Anyone holding this signature can collect it until ${f('Valid Before')?.value ?? 'it expires'}.`)
    return
  }
  const contract = d.domain.verifyingContract?.toLowerCase()
  if (/^Permit/.test(d.primaryType) || contract === PERMIT2) {
    const raw = f('Value')?.raw ?? f('Amount')?.raw ?? d.fields.find((x) => /Amount$/.test(x.label))?.raw
    let all = f('Allowed')?.value === 'true'
    try { if (raw !== undefined) all ||= BigInt(raw) >= ALL_THRESHOLD } catch { /* odd amount: shown as "some of" */ }
    const howMuch = all ? 'ALL of' : raw !== undefined ? `up to ${f('Value')?.value ?? f('Amount')?.value ?? raw} of` : 'some of'
    add('critical', `Lets ${f('Spender')?.raw ?? 'another account'} spend ${howMuch} your tokens, now and later. This signature alone is enough; no transaction from you is needed.`)
  } else if (/^(OrderComponents|BulkOrder)$/.test(d.primaryType)) {
    add('critical', 'This is a marketplace order. Anyone holding this signature can take the listed items at the price in the order.')
  }
  add('high', 'Your KeepKey can only show a code (hash) for this signature, not what it says. You would be signing blind.')
}

function evmMessage(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void) {
  const m = req.ethMessageDecoded
  const raw = String(m?.messageRaw ?? req.data ?? '')
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    add('high', 'You are signing a 32-byte code, not text. Some apps accept this as approval of a payment or order you cannot see.')
  } else if (m?.isUtf8Text && m.messageText !== undefined && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(m.messageText)) {
    add('low', 'You are signing a text message. Some apps treat signed text as a login or an approval, so read it on your KeepKey screen.')
  } else if (m) {
    add('medium', 'You are signing data that is not readable text. Only the site knows what it means.')
  } else {
    add('medium', 'This message was not decoded on this computer. Read it on your KeepKey screen.')
  }
}

/** null = no assessment for this request type yet (bar hidden). */
export function assessSigningRisk(req: SigningRequestInfo): RiskAssessment | null {
  const reasons: RiskReason[] = []
  const add = (level: RiskLevel, text: string) => reasons.push({ level, text })

  if (req.solanaMessageDecoded) {
    const c = req.solanaMessageDecoded.classification
    if (c === 'solana-transaction' || c === 'solana-transaction-message') {
      add('critical', 'This "message" is really a transaction. Signing it could move your money.')
    } else if (c === 'binary-message') {
      add('medium', 'You are signing data that is not readable text. Only the site knows what it means.')
    } else {
      add('low', 'You are signing a text message. It cannot move your money by itself.')
    }
  } else if (req.solanaDecoded) {
    const d = req.solanaDecoded
    const assets = d.assetPrograms ?? []
    const unknown = d.instructions.filter((i) => i.status === 'unknown-program')

    for (const ix of d.instructions) {
      if (ix.status === 'known') {
        const r = describeKnown(ix)
        if (r) reasons.push(r)
      } else if (ix.status === 'known-program-unknown-ix' && assets.includes(ix.programName)) {
        add('high', `Uses a ${ix.programName} action KeepKey does not recognize. It could move your funds or hand over control of them.`)
      }
    }
    for (const key of d.fundedKeysGivenToUnknownProgram ?? []) {
      add('high', `Gives ${shortAddr(key)} permission to act for you in this app. That address can then send transactions without your KeepKey.`)
    }
    if (unknown.length > 0) {
      const apps = [...new Set(unknown.map((i) => i.programName))].join(', ')
      const canMoveFunds = assets.length > 0 || !!d.altResolutionIncomplete
      if (req.deviceClearSigns) {
        // Vault found a certified description of these exact bytes, which the
        // device verifies and shows. The app code still runs, so the level
        // stays what it would be.
        add(canMoveFunds ? 'high' : 'medium', canMoveFunds
          ? `Runs app code (${apps}) that is able to move your SOL or tokens. Your KeepKey shows this call's details from a KeepKey-certified description, so check the amounts on its screen.`
          : `Runs app code (${apps}) that cannot move your SOL or tokens. Your KeepKey shows this call's details from a KeepKey-certified description. You only pay the network fee.`)
      } else if (canMoveFunds) {
        add('high', `Runs app code KeepKey cannot read (${apps}). That code is able to move your SOL or tokens, and nobody can show you how much before you sign.`)
      } else {
        add('medium', `Runs app code KeepKey cannot read (${apps}), but it cannot move your SOL or tokens. You only pay the network fee.`)
      }
    }
    if (d.altResolutionIncomplete) {
      add('high', 'Part of this transaction is hidden and could not be looked up.')
    }
    if (reasons.length === 0) add('low', 'KeepKey can read every step of this transaction.')
  } else if (req.method === '/eth/sign-transaction') {
    evmTx(req, add)
    if (reasons.length === 0) add('low', 'Your KeepKey decodes this call on its screen. Check the recipient and amount there.')
  } else if (req.method === '/eth/sign-typed-data') {
    evmTypedData(req, add)
  } else if (req.method === '/eth/sign') {
    evmMessage(req, add)
  } else if (req.solanaDecodeError || /^\/solana\/sign-(transaction|and-send)/.test(req.method)) {
    add('high', 'KeepKey cannot read this transaction at all. You would be signing blind.')
  } else {
    return null
  }

  const level = reasons.reduce<RiskLevel>(
    (max, r) => (ORDER.indexOf(r.level) > ORDER.indexOf(max) ? r.level : max), 'low')
  // Riskiest sentence first — it is the one the user must not skim past.
  reasons.sort((a, b) => ORDER.indexOf(b.level) - ORDER.indexOf(a.level))
  return { level, headline: HEADLINE[level], reasons }
}
