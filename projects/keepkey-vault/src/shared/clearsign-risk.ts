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
import { acrossDepositView, decodeAcrossDepositV3, type AcrossDepositV3 } from './acrossDeposit'
import { RELAY_DEPOSITORY, decodeRelayDeposit, isZeroAddress, type RelayDeposit } from './relayDeposit'
import type {
  SigningRequestInfo,
  SimulatedHoldings,
  SolanaCertifiedArg,
  SolanaTxDecodedInstruction,
} from './types'
import { versionCompare } from './firmware-versions'
import { ERC7730_TRANSPORT_SUPPORTED } from './erc7730-support'

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

// ── Certified Solana description + simulated holdings ────────────────
// Both are rendered here so the approval overlay and any REST caller read the
// same words for the same bytes.

const SOL_DECIMALS = 9

/** Exact d / h / min / s, the way the device screen spells a duration. */
function duration(seconds: bigint): string {
  const parts: string[] = []
  const push = (value: bigint, unit: string) => { if (value > 0n) parts.push(`${value} ${unit}`) }
  push(seconds / 86_400n, 'd')
  push((seconds % 86_400n) / 3_600n, 'h')
  push((seconds % 3_600n) / 60n, 'min')
  push(seconds % 60n, 's')
  return parts.length > 0 ? parts.join(' ') : '0 s'
}

/** An amount of a token, named only when its identity was attested. Without
 *  that, raw base units and the mint — a ticker nobody signed for is exactly
 *  how a fake token passes for a real one. */
function tokenAmount(raw: string, mint?: string, symbol?: string, decimals?: number, full = false): string {
  if (symbol && decimals !== undefined) return `${units(raw, decimals)} ${symbol}`
  const of = mint ? ` of token ${full ? mint : shortAddr(mint)}` : ''
  return `${BigInt(raw).toLocaleString('en-US')} base units${of}`
}

/** One argument of a certified description, in the units its signed type
 *  fixes. `full` spells addresses out instead of shortening them. */
export function formatCertifiedArg(a: SolanaCertifiedArg, full = false): string {
  switch (a.kind) {
    case 'sol': return `${units(a.raw, SOL_DECIMALS)} SOL`
    case 'token': return tokenAmount(a.raw, a.mint, a.symbol, a.decimals, full)
    case 'duration': return duration(BigInt(a.raw))
    case 'pubkey': return full ? a.raw : shortAddr(a.raw)
    case 'opaque': return full ? a.raw : `${a.raw.slice(0, 8)}…`
    default: return BigInt(a.raw).toLocaleString('en-US')
  }
}

/**
 * What the wallet is left holding, as a sentence. An estimate from a
 * simulation on this computer, and it says so: a failed check reads "could not
 * simulate", never "no funds move".
 */
export function formatSimulatedHoldings(s: SimulatedHoldings): string {
  // Each figure the simulation established, and only those: an absent SOL
  // balance is one the simulation did not answer for, so it is left out of the
  // sentence and `note` says why — printing 0 would state the opposite.
  const holdings = [
    ...(s.solLamportsAfter !== undefined ? [`${units(s.solLamportsAfter, SOL_DECIMALS)} SOL`] : []),
    ...(s.tokensAfter ?? []).map((t) => tokenAmount(t.amountAfter, t.mint, t.symbol, t.decimals)),
  ]
  if (s.unavailable || holdings.length === 0) {
    // The note survives an unavailable result: "the tokens were never looked
    // up" and "the simulation then failed" are two separate facts.
    return `This computer could not simulate this transaction (${s.unavailable ?? 'no result'}), so it cannot say what you would be left holding. That is not the same as "nothing moves".${s.note ? ` ${s.note}` : ''}`
  }
  const whose = s.owner ? `your account ${shortAddr(s.owner)} would hold` : 'you would hold'
  return `Checked on this computer: if this goes through, ${whose} ${holdings.join(' and ')}.${s.note ? ` ${s.note}` : ''}`
}

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
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
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
  const across = decodeAcrossDepositV3(to, data, chainId)
  const catalog = req.rawRequestBody?.erc7730
  // Without a transport the catalog never reaches the device: treat as absent.
  const hasCatalog = ERC7730_TRANSPORT_SUPPORTED && typeof catalog === 'object' && catalog !== null
  const fields = req.calldataDecoded?.fields ?? []
  const field = (n: string) => fields.find((f) => f.name === n)?.value
  // Set only for a reviewed Universal Router whose calldata decodes the way
  // the device decodes it (evm-signing-preview uniswapSwapFields).
  const urSwap = field('Protocol') === 'Uniswap Universal Router' && field('Action')?.startsWith('Swap ')
    ? field('Action')!.replace(/^Swap /, 'Swaps ') : undefined
  const relay = decodeRelayDeposit(to, data, chainId)
  if ((sel === '0x095ea7b3' || sel === '0x39509351') && addrWord(0) && num(1) !== null) {
    const spender = addrWord(0)! + (addrWord(0) === RELAY_DEPOSITORY ? ' (the Relay Depository)' : ''), v = num(1)!
    const canonicalUniswapSetup = chainId === 42161
      && to === '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
      && spender === PERMIT2
    if (v === 0n) {
      add(token ? 'low' : 'medium', `Removes ${spender}'s permission to spend your ${token?.symbol ?? `token ${to}`}.`)
    } else if (canonicalUniswapSetup && v >= ALL_THRESHOLD) {
      add('medium', 'Standard Uniswap setup: gives canonical Permit2 persistent access to your Arbitrum USDT. You can revoke this allowance later.')
    } else {
      const scope = v >= ALL_THRESHOLD
        ? `ALL of your ${token?.symbol ?? `token at ${to}`}`
        : `up to ${amount(v)}`
      add('critical', `Lets ${spender} spend ${scope}, now and later, without asking you again.`)
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
  } else if (urSwap && req.calldataDecoded?.signedInsightBlob) {
    // Every command decoded, and a signed description attached that the device
    // verifies before it shows the swap: the amounts are on its screen, so
    // this is a check, not a blind signature.
    add('medium', `${urSwap} through the Uniswap Universal Router, a contract KeepKey has reviewed. Your KeepKey shows this swap on its screen from a signed description, and refuses it if that description is not genuine. Check the amounts there.`)
  } else if (across) {
    acrossDeposit(across, req, add)
  } else if (relay) {
    relayDeposit(relay, req, field('You send'), add)
  } else if (!req.deviceClearSigns || KNOWN_SELECTORS.has(sel)) {
    // A known selector reaching here did not parse (dirty address word,
    // trailing bytes): the device may accept it by length alone.
    add('high', `Your KeepKey cannot show what this call to ${to} does. It can use any token permission you already gave that contract. You would be signing blind.`)
    if (urSwap) add('low', `This computer reads it as: ${urSwap} through the Uniswap Universal Router. Your KeepKey will not confirm that.`)
  }

  if (field('Action')?.startsWith('Swap ')) {
    const min = field('Minimum output')
    if (!min || min === 'No minimum specified' || /^0(?:\.0+)?\s/.test(min)) add('high', 'Sets no minimum, so this swap can pay you back almost nothing.')
  }
  if (field('Token warning') || field('Input token warning')) add('high', 'Swaps a token KeepKey does not recognize. It may be a fake.')
}

/** A deposit to the Relay Depository. The calldata names what is sent and
 *  who is credited; where it arrives is Relay's off-chain order. */
function relayDeposit(d: RelayDeposit, req: SigningRequestInfo, decodedSent: string | undefined, add: (l: RiskLevel, t: string) => void) {
  const sent = d.kind === 'native'
    ? (evmNativeValue(req.value ?? '0', d.chainId) ?? 'the coin sent with this call')
    : (decodedSent ?? `${d.amount} base units of token ${d.token}`)
  const from = (req.from ?? '').toLowerCase()
  const credited = isZeroAddress(d.depositor) || d.depositor === from ? 'your account' : d.depositor
  const what = `Relay deposit on ${d.chain}: sends ${sent} to the Relay Depository, credited to ${credited}.`
  // A KeepKey-certified envelope (keyId 0x80) the device verifies, attached
  // by the preview; a caller's runtime blob is not one.
  const certified = req.deviceClearSigns || (!!req.calldataDecoded?.signedInsightBlob && req.calldataDecoded.insightKeyId === 0x80)
  if (certified) {
    add('medium', `${what} Your KeepKey shows this deposit from a KeepKey-certified description and refuses it if that description is not genuine. Check the amount there.`)
  } else {
    add('high', `${what} Your KeepKey cannot decode this deposit: its screen shows only raw data, so you are signing blind. Check these details here before approving.`)
  }
  if (credited !== 'your account' && from) add('high', `The deposit is credited to ${d.depositor}, not to the signing account.`)
  add('medium', "Where it arrives (destination chain, recipient and amount) is set by Relay's off-chain order, not by this transaction. Neither this computer nor your KeepKey can check it.")
}

/** A depositV3 to a pinned Across SpokePool. Decoded here only: the device
 *  shows it as raw data, so the blind line stays and AdvancedMode still gates. */
function acrossDeposit(d: AcrossDepositV3, req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void) {
  const v = acrossDepositView(d)
  const from = (req.from ?? '').toLowerCase()
  let value: bigint | null = null
  try { value = BigInt(req.value === undefined || req.value === '' || req.value === '0x' ? 0 : req.value) } catch { /* unreadable: no claim about it */ }
  add('high', `Across bridge deposit to the Across SpokePool on ${d.pool.chain}. Your KeepKey cannot decode bridge deposits yet: its screen shows only raw data, so you are signing blind. Check these details here before approving.`)
  if (value !== null && value > 0n) {
    if (d.inputToken !== d.pool.wrappedNative.address || value !== d.inputAmount) {
      add('high', `The coin sent with this call does not match the deposit (${v.sent}). The SpokePool will reject it and you would still pay the network fee.`)
    }
  } else if (value === 0n && d.inputAmount > 0n) {
    add('medium', `Takes ${v.sent} from your balance, using the token permission you gave this SpokePool.`)
  }
  add('low', `A relayer pays ${v.received} to ${d.recipient} on ${v.destination} by ${v.fillDeadline}. If nobody fills it in time, the deposit is refunded to ${d.depositor}.`)
  if (from && d.recipient !== from) add('high', `The bridged funds go to ${d.recipient}, which is NOT the account signing this (${from}).`)
  if (from && d.depositor !== from) add('high', `Refunds go to ${d.depositor}, which is NOT the account signing this (${from}).`)
  if (d.outputAmount === 0n) add('high', 'The recipient is set to receive nothing.')
  if (!v.destinationKnown) add('medium', `This computer does not recognize destination ${v.destination}.`)
  if (!v.inputTokenKnown || !v.outputTokenKnown) add('medium', 'This computer cannot name every token in this deposit; amounts are shown in base units.')
  if (v.fee) add(v.feeBps !== null && v.feeBps > 300n ? 'medium' : 'low', `Bridge fee: ${v.fee}.`)
  if (d.message !== '0x') add('high', `Also passes ${(d.message.length - 2) / 2} bytes of instructions that run at the recipient on ${v.destination}. This computer cannot read them.`)
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
    const chainId = Number(d.domain.chainId)
    const spender = String(f('Spender')?.raw || '').toLowerCase()
    const token = String(f('Token')?.raw || '').toLowerCase()
    const officialArbitrumUniswap = d.primaryType === 'PermitSingle' && d.isKnownType
      && d.protocolIdentityVerified !== false && chainId === 42161 && contract === PERMIT2
      && spender === '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
      && token === '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
    if (officialArbitrumUniswap) {
      add('medium', `Allows the official Uniswap Universal Router to spend ${all ? 'an unlimited amount of' : 'up to'} Arbitrum USDT through Permit2 until ${f('Expiration')?.value || 'the displayed expiration'}. Review the swap amount on the following transaction.`)
    } else {
      const howMuch = all ? 'ALL of' : raw !== undefined ? `up to ${f('Value')?.value ?? f('Amount')?.value ?? raw} of` : 'some of'
      add('critical', `Lets ${f('Spender')?.raw ?? 'another account'} spend ${howMuch} your tokens, now and later. This signature alone is enough; no transaction from you is needed.`)
    }
  } else if (/^(OrderComponents|BulkOrder)$/.test(d.primaryType)) {
    add('critical', 'This is a marketplace order. Anyone holding this signature can take the listed items at the price in the order.')
  }
  const structured = !!req.firmwareVersion && versionCompare(req.firmwareVersion, '7.15.0') >= 0
  if (structured) {
    add('low', 'Your KeepKey will request and display the structured fields that it hashes for this signature.')
  } else {
    add('high', 'Your KeepKey can only show a code (hash) for this signature, not what it says. You would be signing blind.')
  }
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
        // stays what it would be, and the certified name says what the call
        // IS — it is not a statement that the call is safe.
        const what = req.solanaCertified
          ? `this call as "${req.solanaCertified.programName} — ${req.solanaCertified.instructionName}"`
          : `this call's details`
        add(canMoveFunds ? 'high' : 'medium', canMoveFunds
          ? `Runs app code (${apps}) that is able to move your SOL or tokens. Your KeepKey shows ${what} from a KeepKey-certified description, so check the amounts on its screen.`
          : `Runs app code (${apps}) that cannot move your SOL or tokens. Your KeepKey shows ${what} from a KeepKey-certified description. You only pay the network fee.`)
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
    // The amounts the signed description names, in its own labels, and what
    // they add up to in SOL. Arithmetic over signed values — never a cap on
    // what the program's own code can move.
    if (req.solanaCertified && req.solanaCertified.args.length > 0) {
      add('low', `The signed description says: ${req.solanaCertified.args.map((a) => `${a.label} ${formatCertifiedArg(a)}`).join(' · ')}.`)
    }
    // NOT A TOTAL, and it must not read as one. Two figures with two different
    // provenances: the lamports the signed description names, read out of the
    // instruction's own bytes, and the fee ceiling read from this
    // transaction's ComputeBudget instructions. Account rent — which a program
    // that opens an account charges, and which the SoltoshiDICE dapp's own
    // warning puts alongside its 0.01 SOL deposit — is in neither, so a sum
    // presented as "what this call puts up" understated the real ask by ~2x.
    //
    // The caveat belongs to the NAMED figure, not to the fee: an unresolved
    // lookup table withholds the fee by design, and hanging the caveat off it
    // left "SOL deposit 0.01 SOL" standing alone in exactly the case where the
    // bytes are least complete.
    const solArgs = (req.solanaCertified?.args ?? []).filter((a) => a.kind === 'sol')
    const namedSol = solArgs.reduce((total, a) => total + BigInt(a.raw), 0n)
    const fee = d.maxNetworkFeeLamports
    if (namedSol > 0n) {
      add('low', `SOL named in this call: ${units(namedSol.toString(), SOL_DECIMALS)} SOL (${solArgs.map((a) => a.label).join(' + ')}), ${fee
        ? `plus up to ${units(fee, SOL_DECIMALS)} SOL of network fee`
        : 'and the network fee could not be read from these bytes'}. Account rent is extra and is not in these bytes, so this is not the total SOL leaving your wallet, and it is not a limit on what the program can move.`)
    } else if (fee) {
      add('low', `Network fee: up to ${units(fee, SOL_DECIMALS)} SOL.`)
    }
  } else if (req.method === '/eth/sign-transaction') {
    evmTx(req, add)
    if (reasons.length === 0) add('low', 'Your KeepKey decodes this call on its screen. Check the recipient and amount there.')
    // A verified human rating can only add a reason, so it can only raise the level.
    const rating = req.clearSignReport?.rating
    if (rating) {
      add(rating.riskLevel, `An auditor rates this contract ${rating.riskLevel} risk: ${rating.riskReasons[0] || 'see findings'}.`
        + (rating.raterPinned ? '' : ' The rater is not yet pinned in this Vault.'))
    }
  } else if (req.method === '/eth/sign-typed-data') {
    evmTypedData(req, add)
  } else if (req.method === '/eth/sign') {
    evmMessage(req, add)
  } else if (req.solanaDecodeError || /^\/solana\/sign-(transaction|and-send)/.test(req.method)) {
    add('high', 'KeepKey cannot read this transaction at all. You would be signing blind.')
  } else {
    return null
  }

  // Last, and deliberately at 'low': a simulation is an estimate this computer
  // made, so it may add an answer but never change the verdict above. The level
  // is the maximum over the reasons, so this line cannot move it either way.
  if (req.simulatedOutflow) add('low', formatSimulatedHoldings(req.simulatedOutflow))

  const level = reasons.reduce<RiskLevel>(
    (max, r) => (ORDER.indexOf(r.level) > ORDER.indexOf(max) ? r.level : max), 'low')
  // Riskiest sentence first — it is the one the user must not skim past.
  reasons.sort((a, b) => ORDER.indexOf(b.level) - ORDER.indexOf(a.level))
  return { level, headline: HEADLINE[level], reasons }
}
