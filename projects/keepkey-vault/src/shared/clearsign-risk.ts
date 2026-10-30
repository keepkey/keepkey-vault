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
import { acrossDepositView, decodeAcrossDepositV3, findReviewedAcrossSpokePool, type AcrossDepositV3 } from './acrossDeposit'
import { RELAY_DEPOSITORY, decodeRelayDeposit, isZeroAddress, type RelayDeposit } from './relayDeposit'
import { ACROSS_NAMED_TOKENS, REVIEWED_EVM_TOKENS } from './reviewed-evm-tokens'
import type {
  EIP712DecodedField,
  EIP712DecodedInfo,
  SafeCallPreview,
  SigningRequestInfo,
  SimulatedHoldings,
  SolanaCertifiedArg,
  SolanaTxDecodedInfo,
  SolanaTxDecodedInstruction,
  ThorVaultCheck,
} from './types'
import { versionCompare } from './firmware-versions'
import { base64PayloadBytes, certifiedEnvelopeShown, evmSignedChainId as evmChainId } from './certified-evm-envelope'
import { typedDataSpendAmounts } from './typedDataRows'
import { knownSpenderName } from './evm-known-spenders'
import { nftMarketplaceOperator } from './nft-marketplaces'
import { cosmosDepositPreview } from './cosmosDepositPreview'
import { SOLANA_TOKEN_IDENTITIES } from './solana-token-identities'
import { lookalikeOf } from './address-lookalike'
import { decodeMultiSend, deviceWarnsSafeDelegatecall, eip55, safeContract } from './safe-tx'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export interface RiskReason { level: RiskLevel; text: string }
/** The one verdict the user sees (owner rule 2026-10-16): green = the KeepKey
 *  shows it (natively or from a certified description), yellow = this computer
 *  knows it but this KeepKey firmware cannot show it yet, red = unknown, or
 *  anything a normal app does not do. `level` stays the per-reason scale. */
export type SigningTier = 'green' | 'yellow' | 'red'
export interface RiskAssessment { level: RiskLevel; tier: SigningTier; headline: string; reasons: RiskReason[] }

const ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical']
const TIER_HEADLINE: Record<SigningTier, string> = {
  green: 'Shown on your KeepKey',
  yellow: 'Known, but your KeepKey cannot show it yet',
  red: 'Unknown or unusual: only sign if you trust this site',
}
const USED_BEFORE_HEADLINE = 'Used before, but your KeepKey cannot show this call'
const UNCHECKED_HEADLINE = 'Shown on your KeepKey, but this computer could not check one payee'
const U64_MAX = (1n << 64n) - 1n

/** A protocol Desktop knows and decodes in full, on firmware that cannot show
 *  it yet. Owner rule: known is normal, so say "not on this firmware yet",
 *  not "signing blind". The device still needs AdvancedMode for raw data. */
function notOnThisFirmware(what: string, req: SigningRequestInfo): string {
  // A request this firmware refuses outright gets one reason for that
  // (assessSigningRisk); AdvancedMode would not help, so it is not mentioned.
  if (req.firmwareCannotSign) return 'Check the details here.'
  return `${firmwareName(req)} cannot show ${what} on the device yet, so the device shows raw data and needs Advanced Mode to sign. Later firmware may add it. Check the details here.`
}

const firmwareName = (req: SigningRequestInfo) => req.firmwareVersion ? `KeepKey firmware ${req.firmwareVersion}` : 'This KeepKey firmware'

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

/** Programs the firmware decodes itself (lib/firmware/solana.c; mirrored in
 *  bun/solana-consent.ts FIRMWARE_LAYOUTS). Token-2022 is left out: 7.16.0
 *  shows every Token-2022 instruction as raw data. */
const SOLANA_FIRMWARE_PROGRAMS = new Set([
  '11111111111111111111111111111111',            // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'Stake11111111111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
])
const SOLANA_MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
])
const SOLANA_MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const SOLANA_ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'

/** Does the device itself show this instruction? Memo v2 text, a canonical
 *  ATA create (System and SPL Token in slots 4 and 5), and the programs
 *  firmware decodes, each decoded in full here. MintTo and Burn are left out:
 *  released firmware since 7.14.2 shows them only as raw data. */
function solanaFirmwareShows(ix: SolanaTxDecodedInstruction): boolean {
  if (ix.programId === SOLANA_MEMO_V2) return true
  if (ix.status !== 'known' || ix.note) return false
  if (ix.programId === SOLANA_ATA_PROGRAM) {
    return ix.accounts[4]?.pubkey === '11111111111111111111111111111111'
      && ix.accounts[5]?.pubkey === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  }
  if (ix.instructionName === 'mintTo' || ix.instructionName === 'burn') return false
  return SOLANA_FIRMWARE_PROGRAMS.has(ix.programId)
}

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

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN_2022])
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
type TokenAccounts = SolanaTxDecodedInfo['tokenAccounts']

/** An amount of a mint, named only from the checked table. */
function solanaTokenAmount(raw: string, mint: string | undefined): string {
  if (!mint) return `${BigInt(raw).toLocaleString('en-US')} base units of a token this computer could not check`
  const id = SOLANA_TOKEN_IDENTITIES[mint]
  return tokenAmount(raw, mint, id?.symbol, id?.decimals, true)
}

/** The token account a Jupiter swap pays out to: the optional
 *  destinationTokenAccount when set (left empty it is the program id),
 *  otherwise the user's own. */
function jupiterOutput(ix: SolanaTxDecodedInstruction): string | undefined {
  const optional = acct(ix, 'destinationTokenAccount')
  return optional && optional !== JUPITER_V6 ? optional : acct(ix, 'userDestinationTokenAccount')
}

/** Plain sentence for an instruction KeepKey fully understands, or null.
 *  `from` is the signing account, or the user a Jupiter route names when the
 *  request has none; `signer` only the request's own signing account.
 *  `swapOutputs` the accounts a Jupiter swap in this transaction pays out to. */
function describeKnown(ix: SolanaTxDecodedInstruction, tokenAccounts: TokenAccounts, from?: string, swapOutputs = new Set<string>(), signer?: string): RiskReason | null {
  const name = ix.instructionName
  if (ix.programName === 'System Program' && name === 'transfer') {
    const to = acct(ix, 'destination')
    const lamports = arg(ix, 'lamports')
    const sol = lamports ? `${units(lamports, 9)} SOL` : 'SOL'
    // Funding your own wrapped-SOL account is how a SOL swap starts.
    const held = to ? tokenAccounts?.[to] : undefined
    if (to && from && held?.owner === from && held.mint === 'So11111111111111111111111111111111111111112') {
      return { level: 'low', text: `Moves ${sol} into your own wrapped-SOL account ${shortAddr(to)}.` }
    }
    return { level: 'low', text: `Sends ${sol}${to ? ` to ${shortAddr(to)}` : ''}.` }
  }
  // A durable-nonce transaction does not expire: it stays valid until it is
  // sent or its nonce is advanced, which only the nonce authority can do.
  // Checked against the signer only: a route's user is named by the same
  // bytes that name the nonce authority.
  if (ix.programName === 'System Program' && name === 'advanceNonceAccount') {
    const nonce = acct(ix, 'nonceAccount') ?? 'a nonce account', authority = acct(ix, 'nonceAuthority')
    if (signer && authority === signer) {
      return { level: 'low', text: `Uses durable nonce account ${shortAddr(nonce)}, which your own account controls: this transaction does not expire until it is sent or you advance that nonce.` }
    }
    return { level: 'high', text: signer && authority
      ? `Uses durable nonce account ${nonce}, controlled by ${authority}, which is NOT the account signing this (${signer}). This transaction does not expire, and only that account can cancel it.`
      : `Uses durable nonce account ${nonce}. This transaction does not expire, and this computer could not check who can cancel it.` }
  }
  if (ix.programName === 'Stake Program' && name === 'delegateStake') {
    const stake = acct(ix, 'stakeAccount'), vote = acct(ix, 'voteAccount')
    return { level: 'low', text: `Delegates ${stake ? `stake account ${shortAddr(stake)}` : 'a stake account'} to ${vote ? `validator vote account ${shortAddr(vote)}` : 'a validator'}.` }
  }
  if (ix.programName === 'Stake Program' && name === 'deactivate') {
    const stake = acct(ix, 'stakeAccount')
    return { level: 'low', text: `Deactivates ${stake ? `stake account ${shortAddr(stake)}` : 'a stake account'}.` }
  }
  if (name === 'transfer' || name === 'transferChecked') {
    const dec = arg(ix, 'decimals'), raw = arg(ix, 'amount')
    const dest = acct(ix, 'destination')
    const held = dest ? tokenAccounts?.[dest] : undefined
    const mint = acct(ix, 'mint') ?? held?.mint
    const id = mint ? SOLANA_TOKEN_IDENTITIES[mint] : undefined
    // transferChecked fails unless its decimals match the mint, so a named
    // mint with other decimals is not the token it claims to be.
    const amount = !raw ? 'tokens'
      : id && (dec === undefined || Number(dec) === id.decimals) ? solanaTokenAmount(raw, mint)
        : dec ? `${units(raw, Number(dec))}${mint ? ` of token ${mint}` : ''}`
          : solanaTokenAmount(raw, mint)
    // The token account is not the person: name the wallet that holds it.
    const to = held ? ` to ${held.owner}${held.owner === from ? ' (your own account)' : ''}` : dest ? ` to token account ${dest}` : ''
    return { level: 'low', text: `Sends ${amount}${to}.` }
  }
  // Closing a token account sends all of its SOL (rent, and for wrapped SOL
  // the balance, e.g. a swap's SOL output) to `destination`.
  if (TOKEN_PROGRAMS.has(ix.programId) && name === 'closeAccount') {
    const account = acct(ix, 'account'), dest = acct(ix, 'destination')
    if (!account || !dest) return null
    const swapOut = swapOutputs.has(account)
    const what = swapOut ? `the account ${account} that receives the swap output` : `token account ${account}`
    if (!from) return { level: 'medium', text: `Closes ${what} and sends everything in it to ${dest}. This computer could not check whether that is your account.` }
    if (dest === from) {
      return { level: 'low', text: swapOut ? `Unwraps the swap output and sends it to ${dest} (your own account).` : `Closes token account ${shortAddr(account)} and returns its SOL to ${dest} (your own account).` }
    }
    const yours = swapOut || acct(ix, 'owner') === from || tokenAccounts?.[account]?.owner === from
    if (!yours) return { level: 'low', text: `Closes token account ${account}, which is not yours, and sends its SOL to ${dest}.` }
    return { level: 'high', text: swapOut
      ? `The swap output goes to ${dest}, which is NOT the account signing this (${from}): this step closes ${account} and sends everything in it there.`
      : `Closes your token account ${account} and sends its SOL to ${dest}, which is NOT the account signing this (${from}).` }
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

/** A Jupiter v6 swap, from the amounts in its own instruction data
 *  (bun/solana-jupiter.ts). The device shows it as raw data, so this is the
 *  only place the amounts are read back to the user. */
function jupiterSwap(ix: SolanaTxDecodedInstruction, d: SolanaTxDecodedInfo, req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void) {
  const a = (n: string) => { const v = arg(ix, n); return v === undefined ? undefined : BigInt(v) }
  const slip = a('slippageBps'), fee = a('platformFeeBps')
  const quotedOut = a('quotedOutAmount'), quotedIn = a('quotedInAmount')
  // The amounts did not read: the note line says so, nothing to state here.
  if (slip === undefined || (quotedOut === undefined && quotedIn === undefined)) return
  const src = acct(ix, 'userSourceTokenAccount') ?? acct(ix, 'sourceTokenAccount')
  const out = jupiterOutput(ix)
  // The mint the account actually holds over the instruction's own label.
  const srcHeld = src ? d.tokenAccounts?.[src] : undefined
  const outHeld = out ? d.tokenAccounts?.[out] : undefined
  const inLabel = acct(ix, 'sourceMint'), outLabel = acct(ix, 'destinationMint')
  const inMint = srcHeld?.mint ?? inLabel
  const outMint = outHeld?.mint ?? outLabel
  if (srcHeld && inLabel && srcHeld.mint !== inLabel) add('high', `This swap says it spends token ${inLabel}, but the account it spends from holds token ${srcHeld.mint}.`)
  if (outHeld && outLabel && outHeld.mint !== outLabel) add('high', `This swap says it pays out token ${outLabel}, but the account that receives it holds token ${outHeld.mint}.`)
  const pct = (bps: bigint) => `${Number(bps) / 100}%`
  const venues = arg(ix, 'route') ? `, routed through ${arg(ix, 'route')}` : ''
  const fw = notOnThisFirmware('Jupiter swaps', req)
  if (quotedOut !== undefined) {
    const min = slip >= 10_000n ? 0n : quotedOut * (10_000n - slip) / 10_000n
    const amountIn = a('inAmount')
    // The token-ledger forms swap whatever an earlier step set aside.
    const what = amountIn !== undefined ? solanaTokenAmount(amountIn.toString(), inMint)
      : 'the tokens an earlier step of this transaction sets aside'
    add('medium', `Swaps ${what} for at least ${solanaTokenAmount(min.toString(), outMint)} through Jupiter (quoted ${solanaTokenAmount(quotedOut.toString(), outMint)}, ${pct(slip)} slippage${venues}). ${fw}`)
    if (min === 0n) add('high', 'Sets no minimum, so this swap can pay you back almost nothing.')
    else if (slip >= 5_000n) add('high', `Accepts up to ${pct(slip)} less than the quote, so this swap can pay you back far less.`)
  } else {
    const max = quotedIn! * (10_000n + slip) / 10_000n
    add('medium', `Buys ${solanaTokenAmount(String(a('outAmount') ?? 0n), outMint)} for at most ${solanaTokenAmount(max.toString(), inMint)} through Jupiter (quoted ${solanaTokenAmount(quotedIn!.toString(), inMint)}, ${pct(slip)} slippage${venues}). ${fw}`)
    if (slip >= 5_000n) add('high', `Accepts paying up to ${pct(slip)} more than the quote.`)
  }
  // Integrator fees run up to about 1%; well past that it is not a fee.
  if (fee !== undefined && fee > 100n) add('high', `${pct(fee)} of this swap goes to the app as a fee.`)
  else if (fee) add('low', `App fee: ${pct(fee)} of this swap.`)
  // The swap's own transfer authority is in the signed bytes, so a caller
  // that did not say who signs (decode-transaction) is still checked.
  const me = req.from ?? acct(ix, 'userTransferAuthority')
  const holder = outHeld?.owner
  if (!holder || !me) add('medium', 'This computer could not check which account receives the swap output.')
  else if (holder !== me) add('high', `The swap output goes to ${holder}, which is NOT the account signing this (${me}).`)
}

// ── EVM ──────────────────────────────────────────────────────────────
// Addresses are shown in full: a 0x1234…abcd short form is cheap to grind
// for address poisoning. ponytail: lowercase hex, add EIP-55 checksums later.

// The reviewed token identities the certified entries use (Base USDC etc.),
// plus the risk bar's own Ethereum stablecoins and its Arbitrum USDT wording.
const EVM_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  ...REVIEWED_EVM_TOKENS,
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
}
const KNOWN_SELECTORS = new Set(['0x095ea7b3', '0x39509351', '0xa22cb465', '0xa9059cbb'])
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const ALL_THRESHOLD = (1n << 160n) - 1n // uint160 max: Permit2's "unlimited"

/** uint96 max: the largest "infinite" approval a real token uses (UNI, COMP).
 * At or above it an amount is not a bound, whatever the request calls it. */
const BOUND_LIMIT = (1n << 96n) - 1n

/**
 * How loud a spend permission is. Danger is kept for what a normal dapp flow
 * does not ask for: a grant with no real bound to a spender KeepKey has not
 * reviewed. Every other case still says exactly what is granted, at a lower
 * level, so the top warning keeps its meaning.
 *   reviewed spender, bounded        check before you sign
 *   reviewed spender, standard flow  check before you sign   (see callers)
 *   reviewed spender, unbounded      high
 *   unreviewed spender, bounded      high
 *   unreviewed spender, unbounded    danger
 * "Unbounded" includes an amount this code could not read and a token it does
 * not know: both are treated as the worst case.
 */
function spendPermissionLevel(recognizedSpender: string | undefined, unbounded: boolean, standardFlow = false): RiskLevel {
  if (!recognizedSpender) return unbounded ? 'critical' : 'high'
  return !unbounded || standardFlow ? 'medium' : 'high'
}

/** A KeepKey-certified description (keyId 0x80) Desktop attached itself, in a
 *  form this firmware shows, for this exact call. A caller's blob is not one:
 *  Desktop never checked it, and the device refuses a forged one. */
function certifiedBlobShown(req: SigningRequestInfo): boolean {
  const d = req.calldataDecoded
  if (!d?.signedInsightBlob || d.insightSource === 'caller') return false
  return certifiedEnvelopeShown(base64PayloadBytes(d.signedInsightBlob), d.insightKeyId, req.firmwareVersion, req)
}

/** What the verdict tier rests on: the device shows it, the device shows it
 *  but this computer could not check a payee in it, this computer knows the
 *  protocol and decodes it in full, this account has used the contract before,
 *  or none of these. */
type Recognition = 'shows' | 'unchecked' | 'known' | 'used' | 'unknown'

/** `notShown` says the device cannot show a protocol yet; a call inside a
 *  SafeTx passes its own (the card says that once for the whole SafeTx). */
function evmTx(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void,
  notShown = (what: string) => notOnThisFirmware(what, req)): Recognition {
  const to = (req.to ?? '').toLowerCase()
  const chainId = evmChainId(req.chainId)
  const rawData = typeof req.data === 'string' && req.data !== '' ? req.data : '0x'
  if (!/^0x([0-9a-fA-F]{2})*$/.test(rawData)) {
    add('high', 'This computer cannot read the call data. You would be signing blind.')
    return 'unknown'
  }
  const data = rawData.toLowerCase()
  const word = (i: number) => data.slice(10 + 64 * i, 74 + 64 * i)
  const addrWord = (i: number) => (/^0{24}[0-9a-f]{40}$/.test(word(i)) ? `0x${word(i).slice(24)}` : null)
  const num = (i: number) => (word(i).length === 64 ? BigInt(`0x${word(i)}`) : null)
  const token = EVM_TOKENS[`${chainId}:${to}`]
  const amount = (raw: bigint) => (token ? `${units(raw.toString(), token.decimals)} ${token.symbol}` : `${raw} units of token ${to}`)

  const from = (req.from ?? '').toLowerCase()
  const native = evmNativeValue(req.value ?? '0', chainId)
  const sendsCoin = native !== null && !/^0 /.test(native)
  // A 0x / CoW EthFlow / Relay Router swap Desktop decoded in full
  // (bun/swap-decoders): the coin it sends is what the swap pays, not a payment.
  const swapCall = req.calldataDecoded?.source === 'local' && req.calldataDecoded.functionType === 'swap'
  // A Relay deposit states its own amount and destination contract below.
  if (sendsCoin && !decodeRelayDeposit(to, data, chainId) && !swapCall) add('low', `Sends ${native} to ${data === '0x' ? '' : 'the contract at '}${to}.`)
  if (data === '0x') {
    if (!sendsCoin) add('low', 'Calls no contract and sends nothing.')
    return 'shows'
  }
  let recognition: Recognition = 'unknown'

  const sel = data.slice(0, 10)
  const across = decodeAcrossDepositV3(to, data, chainId)
  // A KeepKey ClearSign service definition Desktop fetched and checked for this
  // call (evm-signing-preview). A caller's catalog is never sent, so it is not one.
  const erc7730 = Boolean(req.erc7730)
  const fields = req.calldataDecoded?.fields ?? []
  const field = (n: string) => fields.find((f) => f.name === n)?.value
  // Set only for a reviewed Universal Router whose calldata decodes the way
  // the device decodes it, or as a one-pool v4 plan the device does not show
  // (evm-signing-preview uniswapSwapFields).
  const urSwap = field('Protocol') === 'Uniswap Universal Router' && field('Action')?.startsWith('Swap ')
    ? field('Action')!.replace(/^Swap /, 'Swaps ') : undefined
  const relay = decodeRelayDeposit(to, data, chainId)
  const thorProtocol = thorDepositProtocol(req)
  const thorSwap = thorProtocol ? field('Action') : undefined
  // A standard token reverts a transfer/approve that carries native coin.
  const coinOnTokenCall = () => { if (sendsCoin) add('high', `Also sends ${native} to the token contract, which a token transfer or approval does not do.`) }
  if ((sel === '0x095ea7b3' || sel === '0x39509351') && addrWord(0) && num(1) !== null) {
    if (token) recognition = 'known'
    coinOnTokenCall()
    const spender = addrWord(0)! + (addrWord(0) === RELAY_DEPOSITORY ? ' (the Relay Depository)' : ''), v = num(1)!
    const canonicalUniswapSetup = chainId === 42161
      && to === '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
      && spender === PERMIT2
    if (v === 0n) {
      add(token ? 'low' : 'medium', `Removes ${spender}'s permission to spend your ${token?.symbol ?? `token ${to}`}.`)
    } else if (canonicalUniswapSetup && v >= ALL_THRESHOLD) {
      add('medium', 'Standard Uniswap setup: gives canonical Permit2 persistent access to your Arbitrum USDT. You can revoke this allowance later.')
    } else {
      const all = v >= ALL_THRESHOLD
      const scope = all ? `ALL of your ${token?.symbol ?? `token at ${to}`}` : `up to ${amount(v)}`
      const known = req.recognizedSpender
      const who = known ? `${known} (${spender})` : spender
      const text = `Lets ${who} spend ${scope}, now and later, without asking you again.`
      // An unknown token may be an NFT: approve(to, tokenId) has the same
      // selector. One the device shows natively is a token it names.
      const unbounded = v >= BOUND_LIMIT || (!token && !req.deviceClearSigns)
      // Approving canonical Permit2 once, for everything, is how Permit2 is set up.
      const permit2Setup = known === 'Uniswap Permit2' && addrWord(0) === PERMIT2
      add(spendPermissionLevel(known, unbounded, permit2Setup), permit2Setup && all
        ? `Standard Permit2 setup: gives canonical Permit2 persistent access to your ${token?.symbol ?? `token at ${to}`}. You can revoke this allowance later.`
        : text)
    }
  } else if (sel === '0xa22cb465' && addrWord(0) && num(1) !== null && num(1) !== 0n && nftMarketplaceOperator(chainId, addrWord(0)!)) {
    // Approving a marketplace's own transfer operator is how listing on it is
    // set up: named, and not danger. Any other operator stays below.
    if (!req.deviceClearSigns) recognition = 'known'
    const market = nftMarketplaceOperator(chainId, addrWord(0)!)!
    add(spendPermissionLevel(market, true, true), `Standard marketplace setup: lets ${market} (${addrWord(0)}) move ALL of your NFTs in collection ${to} when a listing you sign sells. You can revoke this later.${req.deviceClearSigns ? '' : ` ${notOnThisFirmware('NFT approvals', req)}`}`)
  } else if (sel === '0xa22cb465' && addrWord(0) && num(1) !== null) {
    add(num(1) === 0n ? 'low' : 'critical', num(1) === 0n
      ? `Removes ${addrWord(0)}'s access to your NFTs in collection ${to}.`
      : `Lets ${addrWord(0)} take ALL of your NFTs in collection ${to}, now and later, without asking you again.`)
  } else if (sel === '0xa9059cbb' && data.length === 138 && addrWord(0) && num(1) !== null) {
    if (token) recognition = 'known'
    coinOnTokenCall()
    add(token ? 'low' : 'medium', token
      ? `Sends ${amount(num(1)!)} to ${addrWord(0)}.`
      : `Sends ${num(1)} units of token ${to} to ${addrWord(0)}. This computer does not recognize this token.`)
    // Contracts that do not credit a plain transfer: tokens sent there are stuck.
    const rcpt = addrWord(0)!
    const sink = rcpt === to ? 'the token contract itself'
      : rcpt === PERMIT2 ? 'Uniswap Permit2'
        : rcpt === RELAY_DEPOSITORY ? 'the Relay Depository'
          : findReviewedAcrossSpokePool(chainId, rcpt) ? 'an Across SpokePool'
            : req.recognizedRecipient
    if (sink) add('high', `Sends the tokens straight to ${sink} (${rcpt}), which does not credit a plain transfer. A normal app never does this, and the tokens may be lost.`)
  } else if (erc7730) {
    // The device verifies the definition and shows the call from it.
    const d = req.erc7730Description
    const what = d ? `${d.summary ?? d.intent}${d.protocol ? ` on ${d.protocol.name}` : ''}` : `This call to ${to}`
    // Calm when this computer read the same description; gold only when it could not.
    add(d ? 'low' : 'medium', `${what}: your KeepKey shows it from a KeepKey ClearSign description.`)
    // A swap Desktop also decoded: output or leftovers going to anyone else is not normal.
    if (swapCall) swapDestinations(req, field, add)
  } else if (urSwap && req.calldataDecoded?.signedInsightBlob) {
    recognition = 'known'
    // Every command decoded, and a signed description attached that the device
    // verifies before it shows the swap: the amounts are on its screen, so
    // this is a check, not a blind signature.
    add('medium', `${urSwap} through the Uniswap Universal Router, a contract KeepKey has reviewed. Your KeepKey shows this swap on its screen from a signed description, and refuses it if that description is not genuine. Check the amounts there.`)
  } else if (across) {
    recognition = 'known'
    acrossDeposit(across, req, add, notShown)
  } else if (relay) {
    recognition = 'known'
    relayDeposit(relay, req, field('You send'), add, notShown)
  } else if (swapCall) {
    recognition = 'known'
    decodedSwap(req, field, add, notShown)
  } else if (thorProtocol) {
    recognition = thorSwap ? 'known' : 'unknown'
    // A fully decoded deposit to the router pinned for this chain is a normal
    // swap: say what it does, not "unknown contract".
    const what = thorSwap ?? `${thorProtocol} deposit of ${field('Input amount')} with memo "${field('Memo (exact)')}", an action this computer does not decode`
    add(req.deviceClearSigns && thorSwap ? 'low' : 'medium', req.deviceClearSigns
      ? `${what}. Your KeepKey shows this deposit on its screen; check it there.`
      : `${what}. ${notShown('this deposit')}`)
    thorVault(req.thorVault, thorProtocol, field('Vault') ?? '', String(req.to ?? ''), req.firmwareVersion, add)
  } else if (urSwap && !req.deviceClearSigns) {
    recognition = 'known'
    add('medium', `${urSwap} through the Uniswap Universal Router, a contract KeepKey has reviewed. ${notShown('this swap')}`)
  } else if (!req.deviceClearSigns && certifiedBlobShown(req)) {
    // No decoder here, but the device verifies the certified description and
    // shows the call from it, so this is not a blind signature.
    add('medium', `Your KeepKey shows this call to ${to} from a KeepKey-certified description.`)
  } else if (!req.deviceClearSigns || KNOWN_SELECTORS.has(sel)) {
    // A known selector reaching here did not parse (dirty address word,
    // trailing bytes): the device may accept it by length alone.
    // This computer's own record that this account used this exact contract on
    // this chain is a known pattern; a name the contract gives itself is not.
    const usedBefore = Boolean(req.priorUse) && native !== null && !sendsCoin && !KNOWN_SELECTORS.has(sel)
    if (usedBefore) recognition = 'used'
    add(usedBefore ? 'medium' : 'high', `Your KeepKey cannot show what this call to ${to} does. You would be signing blind.`)
    if (req.contractName) {
      const { name, symbol } = req.contractName
      add('low', `This contract's token is named "${name}"${symbol !== name ? ` (${symbol})` : ''}. Not verified: any contract can use any name.`)
    }
    if (req.priorUse) {
      const { count, since } = req.priorUse
      add('low', `You have used this contract from this account at least ${count === 1 ? 'once' : `${count} times`} before, since ${new Date(since).toLocaleString('en-US', { month: 'short', year: 'numeric' })}.`)
    }
  }

  if (field('Action')?.startsWith('Swap ')) {
    const min = field('Minimum output')
    if (!min || min === 'No minimum specified' || /^0(?:\.0+)?\s/.test(min)) add('high', 'Sets no minimum, so this swap can pay you back almost nothing.')
  }
  if (field('Token warning') || field('Input token warning')) add('high', 'Swaps a token KeepKey does not recognize. It may be a fake.')
  if (urSwap) {
    // uniswapSwapFields marks the signing account; a bare address is someone else.
    const recipient = field('Recipient')
    if (from && recipient && /^0x[0-9a-f]{40}$/.test(recipient) && recipient !== from) {
      add('high', `The swap output goes to ${recipient}, which is NOT the account signing this (${from}).`)
    }
    const fee = /^(\d+)\.(\d{2})% of the output to (0x[0-9a-f]{40})$/.exec(field('Fee') ?? '')
    // Uniswap's own interface fee is 0.15-0.25%; above 1% it is not a fee.
    if (fee && Number(fee[1]) * 100 + Number(fee[2]) > 100) add('high', `${fee[1]}.${fee[2]}% of the swap output goes to ${fee[3]}, not to you.`)
    else if (fee) add('low', `Fee: ${fee[1]}.${fee[2]}% of the swap output goes to ${fee[3]}.`)
  }
  if (thorSwap) {
    thorDestination(req, field('Output destination'), field('Output chain'), from, add)
    thorAffiliate(field('Memo (exact)') ?? '', add)
  }
  return recognition
}

/** THORChain or Mayachain, when calldata-decoder named the router this deposit calls. */
function thorDepositProtocol(req: SigningRequestInfo): 'THORChain' | 'Mayachain' | undefined {
  const d = req.calldataDecoded
  return d?.source === 'local' && (d.dappName === 'THORChain' || d.dappName === 'Mayachain') ? d.dappName : undefined
}

/** The vault a router deposit pays, against the network's active vaults
 *  (bun/thor-vaults.ts). Advice: the device cannot check a vault. 7.16 labels
 *  every vault UNVERIFIED; 7.14 shows "Using Asgard vault", which is no check. */
function thorVault(c: ThorVaultCheck | undefined, protocol: string, vault: string, router: string, fw: string | undefined, add: (l: RiskLevel, t: string) => void) {
  const name = protocol === 'Mayachain' ? 'Maya' : protocol
  if (c?.status === 'current') {
    // The 7.15 builds disagree (release/7.15 "Using Asgard vault", 7.15-b6
    // "Pays UNVERIFIED vault"), so 7.15 names no screen.
    const label = fw && versionCompare(fw, '7.15.0') < 0
      ? `its "Using Asgard vault" screen shows the address but is not a check`
      : fw && versionCompare(fw, '7.16.0') >= 0 ? 'it labels this one UNVERIFIED'
      : 'its screen shows the address but is not a check'
    add('low', `Pays vault ${vault}, one of ${name}'s active ${c.chain} vaults in all ${c.sources} ${name} sources this computer asked. Your KeepKey cannot check vaults itself, so ${label}.`)
  } else if (c?.status === 'retiring') {
    add('medium', `Pays vault ${vault}, which ${name} is retiring: every ${name} source this computer asked lists it as retiring on ${c.chain}. ${name} still accepts deposits to it while it moves funds to the new vaults; a fresh quote would use an active vault. Your KeepKey cannot check vaults itself.`)
  } else if (c?.status === 'not-current') {
    add('critical', c.currentRouter !== undefined
      ? `Calls router ${router}, but ${name}'s vault ${vault} uses router ${c.currentRouter || '(none)'} on ${c.chain}. A normal ${name} app does not do this.`
      : `Pays vault ${vault}, which is NOT one of ${name}'s active ${c.chain} vaults. Funds sent to a wrong or retired vault can be lost. A normal ${name} app does not do this.`)
  } else if (c) {
    add('medium', `This computer could not check vault ${vault} against ${name}'s active vaults${c.reason ? ` (${c.reason})` : ''}, and your KeepKey cannot check vaults itself.`)
  } else {
    add('medium', `Vault ${vault} was not checked against ${name}'s active vaults here, and your KeepKey cannot check vaults itself.`)
  }
}

/** Whose a THORChain/Maya swap memo's payout address is. `from` is the EVM
 *  signer, or undefined when the deposit is not from an EVM account. */
function thorPayout(req: SigningRequestInfo, dest: string | undefined, from: string | undefined): 'none' | 'own' | 'not-signer' | 'not-own' | 'unknown' {
  // A memo may name a refund address after the payout one: DEST/REFUND.
  dest = dest?.split('/')[0]
  if (!dest || dest === 'self') return 'none'
  const evm = /^0x[0-9a-fA-F]{40}$/.test(dest)
  if (req.memoDestinationOwn === true || (from && evm && dest.toLowerCase() === from)) return 'own'
  if (from && evm) return 'not-signer'
  return req.memoDestinationOwn === false ? 'not-own' : 'unknown'
}

function thorDestination(req: SigningRequestInfo, dest: string | undefined, chain: string | undefined, from: string | undefined, add: (l: RiskLevel, t: string) => void) {
  const payout = thorPayout(req, dest, from)
  dest = dest?.split('/')[0]
  const on = chain ? ` on ${chain}` : ''
  if (payout === 'own') add('low', `The swap pays out to ${dest}${on}, one of your own addresses.`)
  else if (payout === 'not-signer') add('high', `The swap pays out to ${dest}, which is NOT the account signing this (${from}).`)
  else if (payout === 'not-own') add('high', `The swap pays out to ${dest}${on}, which is NOT one of this wallet's addresses.`)
  else if (payout === 'unknown') add('medium', `This computer cannot tell whether ${dest}${on} is your address. Check it on your KeepKey screen.`)
}

/** A router deposit Desktop names in full: a decoded swap, to a vault every
 *  source lists as active, paying out to the user or the signer. */
function thorDepositShown(req: SigningRequestInfo): boolean {
  const field = (n: string) => req.calldataDecoded?.fields.find((f) => f.name === n)?.value
  const payout = thorPayout(req, field('Output destination'), (req.from ?? '').toLowerCase() || undefined)
  return Boolean(field('Action')) && req.thorVault?.status === 'current' && (payout === 'own' || payout === 'none')
}

/** The memo's affiliate fee (`...:AFFILIATE:BPS`, or several as `A/B:BPS/BPS`).
 *  THORChain and Maya take it from the swap and pay it to the affiliates. */
function thorAffiliate(memo: string, add: (l: RiskLevel, t: string) => void) {
  const [, , , , who = '', bps = ''] = memo.split(':')
  if (!who && !bps) return
  const fees = bps.split('/')
  if (!who || fees.length !== who.split('/').length || !fees.every((f) => /^\d{1,5}$/.test(f))) {
    add('medium', `This computer cannot read the affiliate fee in this memo ("${who}:${bps}").`)
    return
  }
  const total = fees.reduce((sum, f) => sum + Number(f), 0)
  const pct = `${Math.floor(total / 100)}.${String(total % 100).padStart(2, '0')}%`
  // Wallets and interfaces charge well under 1%; above 1% it is not a fee.
  if (total > 100) add('high', `${pct} of this swap goes to ${who}, not to you.`)
  else add('low', `Affiliate fee: ${pct} of this swap goes to ${who}.`)
}

/** A THORChain/Maya memo limit (`LIMIT` or streaming `LIMIT/INTERVAL/QUANTITY`),
 *  as thor-swap-preview reads it. Null when it cannot be read. */
function thorMemoLimit(raw: string): bigint | null {
  const m = /^(\d{1,20})(?:[eE](\d{1,2}))?$/.exec(/^(.*)\/\d{1,5}\/\d{1,5}$/.exec(raw)?.[1] ?? raw)
  if (!m || m[1].length + Number(m[2] || '0') > 20) return null
  return BigInt(m[1]) * 10n ** BigInt(m[2] || '0')
}

/** A native THORChain/Maya MsgDeposit. The device parses a swap memo and shows
 *  its terms, or shows the memo itself; there is no vault to check. */
function nativeThorDeposit(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void): Recognition {
  const chain = req.method === '/thorchain/sign-amino-deposit' ? 'THORChain' : 'Maya'
  const p = cosmosDepositPreview(req.rawRequestBody, chain)
  if (!p) {
    add('high', `This computer cannot read this ${chain} deposit. Read it on your KeepKey screen.`)
    return 'unknown'
  }
  const sent = `${p.inputAmount} ${p.inputAsset}`
  if (p.warning.includes('differ')) add('high', 'This deposit carries two different memos. A normal app sends the same memo in both places.')
  if (!p.outputAsset || !p.destination) {
    add('medium', `Deposits ${sent} to ${chain} with memo "${p.memo}", an action this computer does not decode. Read the memo on your KeepKey screen.`)
    return 'known'
  }
  // A zero or unreadable limit is no minimum, as on the router path.
  const noMinimum = !thorMemoLimit(p.memo.split(':')[3] ?? '')
  add('low', `Swap ${sent} for ${noMinimum ? `${p.outputAsset} with NO MINIMUM` : `at least ${p.minimum}`} via ${chain}. Your KeepKey shows this swap on its screen; check it there.`)
  if (noMinimum) add('high', 'Sets no minimum, so this swap can pay you back almost nothing.')
  thorDestination(req, p.destination, p.outputAsset.split('.')[0], undefined, add)
  thorAffiliate(p.memo, add)
  // A payout this computer cannot attribute is not named calmly.
  return thorPayout(req, p.destination, undefined) === 'unknown' ? 'known' : 'shows'
}

/** A deposit to the Relay Depository. The calldata names what is sent and
 *  who is credited; where it arrives is Relay's off-chain order. */
function relayDeposit(d: RelayDeposit, req: SigningRequestInfo, decodedSent: string | undefined, add: (l: RiskLevel, t: string) => void,
  notShown: (what: string) => string) {
  const sent = d.kind === 'native'
    ? (evmNativeValue(req.value ?? '0', d.chainId) ?? 'the coin sent with this call')
    : (decodedSent ?? `${d.amount} base units of token ${d.token}`)
  const from = (req.from ?? '').toLowerCase()
  const credited = isZeroAddress(d.depositor) || d.depositor === from ? 'your account' : d.depositor
  const what = `Relay deposit on ${d.chain}: sends ${sent} to the Relay Depository, credited to ${credited}.`
  // A KeepKey-certified envelope (keyId 0x80) the device verifies, attached
  // by the preview; a caller's runtime blob is not one.
  const certified = req.deviceClearSigns || certifiedBlobShown(req)
  if (certified) {
    add('medium', `${what} Your KeepKey shows this deposit from a KeepKey-certified description and refuses it if that description is not genuine. Check the amount there.`)
  } else {
    add('medium', `${what} ${notShown('Relay deposits')}`)
  }
  if (credited !== 'your account' && from) add('high', `The deposit is credited to ${d.depositor}, not to the signing account.`)
  add('medium', "Where it arrives (destination chain, recipient and amount) is set by Relay's off-chain order, not by this transaction. Neither this computer nor your KeepKey can check it.")
}

/** A 0x Settler, CoW EthFlow or Relay Router swap to its pinned contract that
 *  Desktop decoded in full (bun/swap-decoders). Advice from this computer: the
 *  device shows raw data. A normal swap back to the signer is calm; output or
 *  leftovers going to anyone else is not normal. */
function decodedSwap(req: SigningRequestInfo, field: (n: string) => string | undefined, add: (l: RiskLevel, t: string) => void,
  notShown = (what: string) => notOnThisFirmware(what, req)) {
  const from = (req.from ?? '').toLowerCase()
  const protocol = field('Protocol') ?? 'this protocol'
  const dest = field('Output destination') ?? ''
  const shown = req.deviceClearSigns || certifiedBlobShown(req)
  add('medium', `Swap through ${protocol} (contract ${req.to}): pays ${field('Input amount')} for at least ${field('Minimum output')}, sent to ${dest === from ? 'your account' : dest}. ${shown
    ? 'Your KeepKey shows this call from a KeepKey-certified description and refuses it if that description is not genuine. Check the amounts there.'
    : notShown(`${protocol} swaps`)}`)
  swapDestinations(req, field, add)
  const fee = field('Relay fee')
  if (fee) add('low', `Relay fee: ${fee}.`)
  const validTo = field('Valid until')
  if (validTo) add('low', `This places a CoW order: the ETH waits in CoW's EthFlow contract until a solver fills it, by ${validTo}. If nobody fills it, the ETH can be refunded to the account that placed the order after that time.`)
}

/** A decoded swap (bun/swap-decoders) whose output or leftovers go to anyone
 *  but the signing account. */
function swapDestinations(req: SigningRequestInfo, field: (n: string) => string | undefined, add: (l: RiskLevel, t: string) => void) {
  const from = (req.from ?? '').toLowerCase()
  const dest = field('Output destination') ?? ''
  if (from && dest !== from) add('high', `The swap output goes to ${dest}, which is NOT the account signing this (${from}).`)
  const refund = field('Leftover refund to')
  if (from && refund && /^0x[0-9a-f]{40}$/.test(refund) && refund !== from) add('high', `Leftover coins are refunded to ${refund}, which is NOT the account signing this (${from}).`)
}

/** A depositV3 to a pinned Across SpokePool. Decoded here only: the device
 *  shows it as raw data and AdvancedMode still gates, but a known protocol is
 *  normal, so the line says so instead of "signing blind". */
function acrossDeposit(d: AcrossDepositV3, req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void, notShown: (what: string) => string) {
  const v = acrossDepositView(d, { ...ACROSS_NAMED_TOKENS, ...EVM_TOKENS })
  const from = (req.from ?? '').toLowerCase()
  let value: bigint | null = null
  try { value = BigInt(req.value === undefined || req.value === '' || req.value === '0x' ? 0 : req.value) } catch { /* unreadable: no claim about it */ }
  add('medium', `Across bridge deposit to the Across SpokePool on ${d.pool.chain}, a contract KeepKey knows. ${notShown('Across deposits')}`)
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
  if (!v.destinationKnown) add('high', `This computer does not recognize destination ${v.destination}. Funds bridged there may never arrive.`)
  if (!v.outputTokenKnown) add('high', `This computer cannot name the token the recipient gets (${d.outputToken}). It may be worth nothing.`)
  else if (!v.inputTokenKnown) add('medium', 'This computer cannot name every token in this deposit; amounts are shown in base units.')
  // Real Across fees are well under 1%. Far above that, the relayer that
  // fills the deposit keeps the difference.
  const relayer = isZeroAddress(d.exclusiveRelayer) ? 'the relayer' : `the exclusive relayer ${d.exclusiveRelayer}`
  if (v.fee && v.feeBps !== null && v.feeBps > 1000n) add('high', `Bridge fee: ${v.fee}. That is not a normal Across fee: ${relayer} keeps it.`)
  else if (v.fee) add(v.feeBps !== null && v.feeBps > 300n ? 'medium' : 'low', `Bridge fee: ${v.fee}.`)
  if (d.message !== '0x') add('high', `Also passes ${(d.message.length - 2) / 2} bytes of instructions that run at the recipient on ${v.destination}. This computer cannot read them.`)
}

/** The bytes as text, when they are printable UTF-8 (a sign-in message), else undefined. */
function printableUtf8(hex: string): string | undefined {
  if (!/^0x([0-9a-fA-F]{2})+$/.test(hex)) return undefined
  try {
    const bytes = new Uint8Array(hex.slice(2).match(/../g)!.map((b) => parseInt(b, 16)))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return /^[\x20-\x7e\t\n\r\u00a0-\uffff]+$/.test(text) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? text : undefined
  } catch { return undefined }
}

/** A message the Safe signs as its own (EIP-1271), from a SafeMessage or an
 *  on-chain SignMessageLib call. Readable text (a sign-in) is normal; a hash
 *  can stand for any permit or order the app hashed in. True = unreadable. */
function safeSignsMessage(safe: string, hex: string, add: (l: RiskLevel, t: string) => void): boolean {
  const text = printableUtf8(hex)
  if (text) {
    add('medium', `Your Safe (${safe}) signs this text as its own, so apps that check the Safe's signature accept it: "${text.length > 200 ? text.slice(0, 200) + '…' : text}"`)
    return false
  }
  add('high', `Approves a message for your whole Safe (${safe}). Apps use this to make the Safe sign permits and orders, and this computer cannot read what it approves.`)
  return true
}

// ── Safe transactions ────────────────────────────────────────────────
// The KeepKey shows a SafeTx's to, value and nonce, and its data as raw hex
// (7.16 decodes only an embedded approve). Desktop decodes the data here as
// advice and says so; it never claims the device checked it.

/** Safe's own settings calls (OwnerManager, ModuleManager, GuardManager,
 *  FallbackManager), by selector: the number of argument words. Read only
 *  when the Safe calls itself. */
const SAFE_SELF_CALLS: Record<string, number> = {
  '0x0d582f13': 2, // addOwnerWithThreshold(address,uint256)
  '0xf8dc5dd9': 3, // removeOwner(address,address,uint256)
  '0xe318b52b': 3, // swapOwner(address,address,address)
  '0x694e80c3': 1, // changeThreshold(uint256)
  '0x610b5925': 1, // enableModule(address)
  '0xe009cfde': 2, // disableModule(address,address)
  '0xe19a9dd9': 1, // setGuard(address)
  '0xe068df37': 1, // setModuleGuard(address), Safe 1.5.0
  '0xf08a0323': 1, // setFallbackHandler(address)
  '0x7de7edef': 1, // changeMasterCopy(address), Safe 1.1.1 and older
  '0x3365582c': 2, // setDomainVerifier(bytes32,address), ExtensibleFallbackHandler
}
const SAFE_MIGRATIONS: Record<string, string> = {
  '0xf6682ab0': 'Safe', // migrateSingleton()
  '0xed007fc6': 'Safe, with its standard fallback handler', // migrateWithFallbackHandler()
  '0x07f464a4': 'SafeL2', // migrateL2Singleton()
  '0x68cb3d94': 'SafeL2, with its standard fallback handler', // migrateL2WithFallbackHandler()
}
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

interface SafeCtx {
  chainId: number
  safe: string
  known: { address: string; name: string }[]
  req: SigningRequestInfo
  add: (l: RiskLevel, t: string) => void
  /** Set when a delegatecall to a pinned Safe contract is not Safe{Wallet}'s
   *  standard use of it: an unpinned target or handler argument, or a
   *  delegatecall inside a batch. */
  offStandard?: boolean
}

/** What this computer calls an address, if anything: never a verification. */
function safeName(ctx: SafeCtx, a: string): string | undefined {
  return ctx.known.find((k) => k.address === a)?.name
}
const safeWho = (ctx: SafeCtx, a: string) => { const n = safeName(ctx, a); return n ? `${n} (${a})` : a }

/** True when the address imitates one this computer knows (address poisoning). */
function safePoisoned(ctx: SafeCtx, a: string, prefix: string): boolean {
  const twin = safeName(ctx, a) ? undefined : lookalikeOf(a, ctx.known)
  if (twin) ctx.add('high', `${prefix}${a} looks like ${twin.name} (${twin.address}) but is a different address. Address-poisoning scams use look-alikes like this, so compare every character on your KeepKey.`)
  return Boolean(twin)
}

function safeSend(ctx: SafeCtx, to: string, value: bigint, prefix: string) {
  const amount = evmNativeValue(value.toString(), ctx.chainId) ?? `${value} wei`
  const name = safeName(ctx, to)
  if (name) return ctx.add('low', `${prefix}Sends ${amount} from your Safe to ${name} (${to}).`)
  ctx.add('medium', `${prefix}Sends ${amount} from your Safe to ${to}, an address not in your address book. Check it on your KeepKey.`)
  safePoisoned(ctx, to, prefix)
}

/** The Safe calling itself to change its own settings. False = not read. */
function safeSelfCall(ctx: SafeCtx, data: string, prefix: string): boolean {
  const sel = data.slice(0, 10)
  const words = SAFE_SELF_CALLS[sel]
  if (words === undefined || data.length !== 10 + 64 * words) return false
  const word = (i: number) => data.slice(10 + 64 * i, 74 + 64 * i)
  const addrs = Array.from({ length: words }, (_, i) => (/^0{24}/.test(word(i)) ? `0x${word(i).slice(24)}` : ''))
  const num = (i: number) => BigInt(`0x${word(i)}`)
  const sigs = (n: bigint) => `${n} owner signature${n === 1n ? '' : 's'}`
  const addr = (i: number) => addrs[i]
  const { add } = ctx
  switch (sel) {
    case '0x0d582f13':
      if (!addr(0)) return false
      add('medium', `${prefix}Adds ${safeWho(ctx, addr(0))} as an owner of your Safe, and the Safe then needs ${sigs(num(1))}.`)
      safePoisoned(ctx, addr(0), prefix)
      return true
    case '0xf8dc5dd9':
      if (!addr(0) || !addr(1)) return false
      add('medium', `${prefix}Removes owner ${safeWho(ctx, addr(1))} from your Safe, and the Safe then needs ${sigs(num(2))}.`)
      return true
    case '0xe318b52b':
      if (!addr(0) || !addr(1) || !addr(2)) return false
      add('medium', `${prefix}Replaces owner ${safeWho(ctx, addr(1))} of your Safe with ${safeWho(ctx, addr(2))}.`)
      safePoisoned(ctx, addr(2), prefix)
      return true
    case '0x694e80c3':
      add('medium', `${prefix}Changes your Safe to need ${sigs(num(0))} for every transaction.`)
      return true
    case '0x610b5925':
      if (!addr(0)) return false
      add('medium', `${prefix}Enables ${safeWho(ctx, addr(0))} as a module of your Safe. A module can move funds and run calls from your Safe without owner signatures, until it is disabled.`)
      return true
    case '0xe009cfde':
      if (!addr(0) || !addr(1)) return false
      add('low', `${prefix}Disables module ${safeWho(ctx, addr(1))} on your Safe.`)
      return true
    case '0xe19a9dd9':
    case '0xe068df37': {
      if (!addr(0)) return false
      const what = sel === '0xe19a9dd9' ? 'transaction guard' : 'module guard'
      add(addr(0) === ZERO_ADDRESS ? 'low' : 'medium', addr(0) === ZERO_ADDRESS
        ? `${prefix}Removes your Safe's ${what}.`
        : `${prefix}Sets ${safeWho(ctx, addr(0))} as your Safe's ${what}. It checks every transaction ${sel === '0xe19a9dd9' ? 'your Safe runs' : 'a module runs from your Safe'} and can refuse them.`)
      return true
    }
    case '0xf08a0323': {
      if (!addr(0)) return false
      const handler = safeContract(ctx.chainId, addr(0))
      if (handler?.kind === 'fallback-handler') add('low', `${prefix}Sets your Safe's fallback handler to Safe's standard ${handler.name} ${handler.version} (${addr(0)}).`)
      else if (addr(0) === ZERO_ADDRESS) add('medium', `${prefix}Removes your Safe's fallback handler. Apps then cannot check your Safe's signatures (EIP-1271).`)
      else add('medium', `${prefix}Sets ${safeWho(ctx, addr(0))} as your Safe's fallback handler. It answers calls your Safe does not handle itself, including the signature checks (EIP-1271) apps use to accept your Safe's signatures.`)
      return true
    }
    case '0x7de7edef': {
      if (!addr(0)) return false
      const singleton = safeContract(ctx.chainId, addr(0))
      if (singleton?.kind === 'singleton' || singleton?.kind === 'singleton-l2') {
        add('medium', `${prefix}Upgrades your Safe to the standard ${singleton.name} ${singleton.version} contract (${addr(0)}).`)
      } else {
        add('critical', `${prefix}Replaces the code your Safe runs with ${addr(0)}, which is not a standard Safe contract. That code would control everything your Safe holds.`)
      }
      return true
    }
    case '0x3365582c':
      if (!addr(1)) return false
      add(addr(1) === ZERO_ADDRESS ? 'low' : 'medium', addr(1) === ZERO_ADDRESS
        ? `${prefix}Removes the signature checker your Safe uses for app domain 0x${word(0)}.`
        : `${prefix}Lets ${safeWho(ctx, addr(1))} answer signature checks for your Safe for one app domain (0x${word(0)}). Apps on that domain accept what it approves as your Safe's signature.`)
      return true
  }
  return false
}

/** A plain call (operation 0) from the Safe. True = decoded here in full.
 *  `preview` is bun's preview of this call (SigningRequestInfo.safeCalls). */
function safeCall(ctx: SafeCtx, to: string, value: bigint, data: string, prefix: string, preview: SafeCallPreview | undefined): boolean {
  if (data === '0x') {
    safeSend(ctx, to, value, prefix)
    return true
  }
  if (to === ctx.safe) {
    if (safeSelfCall(ctx, data, prefix)) return true
    ctx.add('high', `${prefix}Makes your Safe call itself with data this computer cannot read. Your KeepKey shows that data only as raw hex.`)
    return false
  }
  // Read by the same rules as a call sent from an account: a token transfer or
  // approve, an Across or Relay deposit, a THORChain deposit or a Universal
  // Router swap. The card says once that the device shows SafeTx.data as hex.
  const lines: RiskReason[] = []
  const recognition = evmTx({
    id: ctx.req.id, method: '/eth/sign-transaction', appName: ctx.req.appName, chainId: ctx.chainId,
    from: ctx.safe, to, data, value: value.toString(), calldataDecoded: preview?.calldataDecoded,
    recognizedSpender: preview?.recognizedSpender, recognizedRecipient: preview?.recognizedRecipient,
  }, (level, text) => lines.push({ level, text }), () => '')
  if (recognition === 'known' || (KNOWN_SELECTORS.has(data.slice(0, 10)) && /^0x[0-9a-f]{8}0{24}[0-9a-f]{104}$/.test(data))) {
    for (const l of lines) ctx.add(l.level, prefix + l.text.trimEnd())
    if (data.startsWith('0xa9059cbb')) {
      const rcpt = `0x${data.slice(34, 74)}`
      if (!safePoisoned(ctx, rcpt, prefix) && safeName(ctx, rcpt)) ctx.add('low', `${prefix}${rcpt} is ${safeName(ctx, rcpt)}.`)
    }
    return recognition === 'known'
  }
  // A KeepKey ClearSign service definition for this exact call, checked here.
  const d = preview?.erc7730Description
  if (d) {
    ctx.add('medium', `${prefix}${d.summary ?? d.intent}${d.protocol ? ` on ${d.protocol.name}` : ''} (${to}), as this computer reads it from a KeepKey ClearSign description.`)
    return true
  }
  ctx.add('high', `${prefix}Makes your Safe call ${to} with data this computer cannot read. Your KeepKey shows that data only as raw hex.`)
  return false
}

const delegatecallLine = (to: string, prefix = '') =>
  `${prefix}Runs code from ${to} inside your Safe (delegatecall). That code can do anything with what the Safe holds.`

/** A delegatecall to one of Safe's own pinned helpers: 'known' = decoded in
 *  full, 'unknown' = described but part of it unreadable, undefined = not one. */
function safeDelegateCall(ctx: SafeCtx, to: string, data: string): Recognition | undefined {
  const pinned = safeContract(ctx.chainId, to)
  if (!pinned) return undefined
  const sel = data.slice(0, 10)
  const word = (i: number) => data.slice(10 + 64 * i, 74 + 64 * i)
  if (pinned.kind === 'multisend' || pinned.kind === 'multisend-call-only') {
    const calls = decodeMultiSend(data)
    if (!calls) return undefined
    ctx.add('low', `Runs ${calls.length} call${calls.length === 1 ? '' : 's'} in one batch through Safe's standard ${pinned.name} ${pinned.version} contract.`)
    let decoded = true
    calls.forEach((c, i) => {
      const prefix = `Call ${i + 1} of ${calls.length}: `
      if (c.operation === 1) {
        ctx.add('high', delegatecallLine(c.to, prefix))
        ctx.offStandard = true
        decoded = false
      } else if (!safeCall(ctx, c.to, c.value, c.data, prefix, ctx.req.safeCalls?.[i])) decoded = false
    })
    return decoded ? 'known' : 'unknown'
  }
  if (pinned.kind === 'sign-message-lib' && sel === '0x85a5affe' && data.length >= 138 && BigInt(`0x${word(0)}`) === 32n) {
    const len = Number(BigInt(`0x${word(1)}`))
    const body = data.slice(138)
    if (len * 2 > body.length || Math.ceil(len / 32) * 64 !== body.length) return undefined
    ctx.add('low', `Signs a message on-chain for your Safe through Safe's standard SignMessageLib ${pinned.version}.`)
    return safeSignsMessage(ctx.safe, `0x${body.slice(0, len * 2)}`, ctx.add) ? 'unknown' : 'known'
  }
  if (pinned.kind === 'migration' && SAFE_MIGRATIONS[sel] && data.length === 10) {
    ctx.add('medium', `Upgrades your Safe to the standard ${SAFE_MIGRATIONS[sel]} ${pinned.version}, through Safe's own SafeMigration contract.`)
    return 'known'
  }
  // migrateToL2(address), setupToL2(address), migrateFromV111(address,address)
  const toL2 = (pinned.kind === 'to-l2-migration' && (sel === '0xef2624ae' || sel === '0xd9a20812'))
    || (pinned.kind === 'to-l2-setup' && sel === '0xfe51f643')
  if (toL2 && data.length === (sel === '0xd9a20812' ? 138 : 74) && /^0{24}/.test(word(0))) {
    const target = `0x${word(0).slice(24)}`
    const singleton = safeContract(ctx.chainId, target)
    if (singleton?.kind !== 'singleton-l2') {
      ctx.offStandard = true
      ctx.add('critical', `Switches the code your Safe runs to ${target}, which is not a standard SafeL2 contract. That code would control everything your Safe holds.`)
      return 'known'
    }
    ctx.add('medium', `Switches your Safe to the standard SafeL2 ${singleton.version} contract, through Safe's own ${pinned.name}.`)
    if (sel === '0xd9a20812') {
      const handler = /^0{24}/.test(word(1)) ? `0x${word(1).slice(24)}` : ''
      const known = Boolean(handler) && safeContract(ctx.chainId, handler)?.kind === 'fallback-handler'
      if (!known) ctx.offStandard = true
      if (!handler) return 'unknown'
      ctx.add(known ? 'low' : 'medium', known ? `Also sets Safe's standard fallback handler (${handler}).` : `Also sets ${handler} as your Safe's fallback handler. It answers the signature checks (EIP-1271) apps use to accept your Safe's signatures.`)
    }
    return 'known'
  }
  return undefined
}

/** A SafeTx, decoded here. 'shows' = the device shows all of it (a coin send,
 *  a rejection); 'known' = decoded here, the device shows the data as hex. */
function safeTx(req: SigningRequestInfo, d: NonNullable<SigningRequestInfo['typedDataDecoded']>, add: (l: RiskLevel, t: string) => void): Recognition {
  const f = (label: string) => String(d.fields.find((x) => x.label === label)?.raw ?? '')
  const safe = (d.domain.verifyingContract ?? '').toLowerCase()
  const from = (req.from ?? '').toLowerCase()
  const ctx: SafeCtx = {
    chainId: evmChainId(d.domain.chainId ?? req.chainId), safe, req, add,
    known: [
      ...(from ? [{ address: from, name: 'this KeepKey account' }] : []),
      ...(safe ? [{ address: safe, name: 'your Safe' }] : []),
      ...(req.knownAddresses ?? []).map((k) => ({
        address: k.address.toLowerCase(), name: k.own ? 'your KeepKey account' : k.name ? `your contact ${k.name}` : 'a saved contact',
      })),
    ],
  }
  const to = f('To').toLowerCase()
  const data = /^(0x)?$/.test(f('Data')) ? '0x' : f('Data').toLowerCase()
  let value: bigint
  try { value = BigInt(f('Value') || '0') } catch { value = -1n }
  if (!/^0x[0-9a-f]{40}$/.test(to) || !/^0x([0-9a-f]{2})*$/.test(data) || value < 0n || !/^[01]$/.test(f('Operation'))) {
    add('high', 'This computer cannot read this Safe transaction. Your KeepKey shows its fields as they are.')
    return 'unknown'
  }
  if (f('Operation') === '1') {
    const helper = safeDelegateCall(ctx, to, data)
    if (helper) {
      // The firmware warns about every delegatecall it cannot check, Safe's own
      // included. It reads the chain from the domain alone (0 when it has none).
      const pinned = safeContract(ctx.chainId, to)!
      if (deviceWarnsSafeDelegatecall(req.firmwareVersion, Number(d.domain.chainId ?? 0), to, data)) {
        const screen = `Your KeepKey will show "Delegatecall: SafeTx gives ${eip55(to)} your Safe's full authority. Not checked."`
        if (ctx.offStandard) add('high', `${screen} Take it seriously here: this is not how Safe{Wallet} uses Safe's ${pinned.name}. Read the other lines on this card before you approve.`)
        else add('low', `${screen} That is expected here: it says so for any delegatecall it cannot check itself, and ${eip55(to)} is Safe's own ${pinned.name} ${pinned.version} contract at its standard address, which Safe{Wallet} uses this way.`)
      }
      return helper
    }
    add('high', delegatecallLine(to))
    return 'unknown'
  }
  // Safe{Wallet}'s "Reject": an empty transaction with the pending one's number.
  if (to === safe && data === '0x' && value === 0n) {
    add('low', `Rejects pending transaction #${f('Nonce')}: an empty transaction from your Safe to itself with the same number, so the pending one can never run.`)
    return 'shows'
  }
  const decoded = safeCall(ctx, to, value, data, '', req.safeCalls?.[0])
  return data === '0x' ? 'shows' : decoded ? 'known' : 'unknown'
}

/**
 * What a SafeTx gas refund pays (Safe handlePayment, v1.3.0+): only when
 * gasPrice > 0, (gas used + baseGas) × gasPrice, where the inner call gets
 * safeTxGas, so gasPrice × (safeTxGas + baseGas) plus the call's overhead; in
 * gasToken, or in the native coin (then at no more than the executor's own gas
 * price) when gasToken is zero; to refundReceiver, or tx.origin when zero.
 */
function safeGasRefund(d: EIP712DecodedInfo, f: (label: string) => EIP712DecodedField | undefined): string {
  const raw = (label: string) => String(f(label)?.raw ?? '0')
  const num = (label: string) => { try { return BigInt(raw(label) || '0') } catch { return 0n } }
  const zero = (label: string) => /^(0x)?0*$/.test(raw(label))
  const receiver = zero('Refund Receiver') ? 'the account that executes it (tx.origin)' : raw('Refund Receiver')
  const gasToken = raw('Gas Token').toLowerCase()
  const gasPrice = num('Gas Price')
  if (gasPrice === 0n) {
    return `Names a gas refund (token ${zero('Gas Token') ? 'the native coin' : gasToken}, receiver ${receiver}) with a gas price of 0, so executing it pays no refund. Normal Safe transactions leave all three at zero.`
  }
  const total = gasPrice * (num('Safe Tx Gas') + num('Base Gas'))
  const chainId = d.domain.chainId
  const token = EVM_TOKENS[`${chainId}:${gasToken}`]
  const amount = zero('Gas Token') ? evmNativeValue(total.toString(), chainId) ?? `${total} wei`
    : token ? `${units(total.toString(), token.decimals)} ${token.symbol}` : `${total} base units of token ${gasToken}`
  return `Pays a gas refund out of your Safe when it is executed: up to ${amount} (gas price ${gasPrice} × (safeTxGas ${num('Safe Tx Gas')} + baseGas ${num('Base Gas')}), plus Safe's own call overhead${zero('Gas Token') ? ", at no more than the executor's own gas price" : ''}), to ${receiver}. Normal Safe transactions leave the refund at zero.`
}

function evmTypedData(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void): Recognition {
  const d = req.typedDataDecoded
  if (!d) {
    add('high', 'This computer could not read this signature request, and your KeepKey shows only a code (hash) for it. You would be signing blind.')
    return 'unknown'
  }
  const f = (label: string) => d.fields.find((x) => x.label === label)
  if (d.operationName === 'x402 EIP-3009 Payment') {
    add('medium', `Authorizes a payment of ${f('Value')?.value ?? 'an amount'} to ${f('Pay To')?.raw ?? 'another account'}. Anyone holding this signature can collect it until ${f('Valid Before')?.value ?? 'it expires'}.`)
    return !!req.firmwareVersion && versionCompare(req.firmwareVersion, '7.15.0') >= 0 ? 'shows' : 'unknown'
  }
  const contract = d.domain.verifyingContract?.toLowerCase()
  // A known document whose spend line stays at "check before you sign":
  // firmware that cannot show it still leaves it known, not unknown.
  let knownCalm = false
  // A payee this computer could not check: never green, even when shown.
  let unverified = false
  // The meaning sits in bytes the device shows only as raw hex.
  let opaque = false
  // A SafeTx whose data this computer decoded ('known'): the device shows it as hex.
  let safeRecognition: Recognition | undefined
  const delegate = f('Agent Address')?.raw ?? f('Delegate')?.raw ?? f('Session Key')?.raw
  if (/ApproveAgent$/.test(d.primaryType) || delegate) {
    // Owner rule: handing over signing power is never a normal request.
    const unlimited = d.primaryType === 'Delegation' && f('Caveats')?.value === '[]'
      && /^0x(ff){32}$/i.test(String(f('Authority')?.raw ?? ''))
    add(unlimited ? 'critical' : 'high', `Gives ${delegate || 'another account'} the power to act for your account. It can then sign without your KeepKey.${unlimited ? ' There are no limits on what it can do.' : ''}`)
  } else if (d.primaryType === 'SafeTx') {
    safeRecognition = safeTx(req, d, add)
    opaque = safeRecognition === 'unknown'
  } else if (d.primaryType === 'SafeMessage') {
    // EIP-1271: the Safe treats this as its own signature.
    opaque = safeSignsMessage(d.domain.verifyingContract || 'unknown Safe', String(f('Message')?.raw ?? ''), add)
  } else if (/^Permit/.test(d.primaryType) || contract === PERMIT2) {
    const raw = f('Value')?.raw ?? f('Amount')?.raw ?? d.fields.find((x) => /Amount$/.test(x.label))?.raw
    // Every amount counts: a batch can hide an unlimited entry behind a small first one.
    const amounts = typedDataSpendAmounts(d)
    // DAI's `allowed`: anything but an explicit false is a grant of everything.
    const allowed = f('Allowed')?.value
    let all = (allowed !== undefined && !/^(false|0)$/i.test(String(allowed).trim())) || amounts.some((a) => a.unlimited)
    try { if (raw !== undefined) all ||= BigInt(raw) >= ALL_THRESHOLD } catch { /* odd amount: shown as "some of" */ }
    const chainId = Number(d.domain.chainId)
    const spender = String(f('Spender')?.raw || '').toLowerCase()
    const token = String(f('Token')?.raw || '').toLowerCase()
    const officialArbitrumUniswap = d.primaryType === 'PermitSingle' && d.isKnownType
      && d.protocolIdentityVerified !== false && chainId === 42161 && contract === PERMIT2
      && spender === '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
      && token === '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
    const identified = d.isKnownType && d.protocolIdentityVerified !== false
    if (officialArbitrumUniswap) {
      add('medium', `Allows the official Uniswap Universal Router to spend ${all ? 'an unlimited amount of' : 'up to'} Arbitrum USDT through Permit2 until ${f('Expiration')?.value || 'the displayed expiration'}. Review the swap amount on the following transaction.`)
      knownCalm = true
    } else {
      // Name the tokens only when every unlimited entry has a name; one unnamed
      // unlimited token must not hide behind a named one.
      const unlimited = amounts.filter((a) => a.unlimited)
      const symbols = [...new Set(unlimited.map((a) => a.symbol))]
      const named = unlimited.length > 0 && symbols.every(Boolean)
      // One unnamed token (a PermitSingle) is that token, not every token you hold.
      const howMuch = all ? (named ? `ALL of your ${symbols.join(' and ')}`
        : amounts.length <= 1 && token ? `ALL of token ${f('Token')!.raw}` : 'ALL of your tokens')
        : amounts.length ? `up to ${amounts.map((a) => a.text).join(' and ')}`
        : raw !== undefined ? `up to ${raw} of your tokens` : 'some of your tokens'
      // A UniswapX order to the reactor the decoder verified, paying out only
      // to this account, is a normal swap even though the reactor has no name record.
      const from = req.from?.toLowerCase()
      const recipients = d.fields.filter((x) => /^Output \d+ Recipient$/.test(x.label))
      const ownSwap = /^UniswapX /.test(d.operationName) && d.protocolIdentityVerified === true && !!from
        && String(f('Swapper')?.raw ?? '').toLowerCase() === from
        && recipients.length > 0 && recipients.every((x) => String(x.raw ?? '').toLowerCase() === from)
      const known = identified ? req.recognizedSpender ?? (ownSwap ? 'UniswapX' : undefined) : undefined
      const who = f('Spender')?.raw ? (known ? `${known} (${f('Spender')!.raw})` : f('Spender')!.raw) : 'another account'
      const unbounded = all || amounts.length === 0 || amounts.some((a) => a.raw === undefined || a.raw >= BOUND_LIMIT)
      // A signature transfer (Permit*TransferFrom) is spent once, not an allowance.
      const once = /TransferFrom$/.test(d.primaryType)
      // A Permit2 allowance to a reviewed router is what Uniswap asks for on
      // every swap, usually for the maximum with an expiry. Only a certified
      // name record earns this: a name from Desktop's own spender list is
      // advice, and most of those contracts never take a Permit2 allowance.
      // A one-time transfer for everything is not that flow.
      const routerPermit = contract === PERMIT2 && !once && !!known && known === req.recognizedSpender && known !== 'Uniswap Permit2'
        && !knownSpenderName(chainId, spender)
      const level = spendPermissionLevel(known, unbounded, routerPermit)
      add(level, once
        ? `Lets ${who} take ${howMuch}, once. This signature alone is enough; no transaction from you is needed.`
        : `Lets ${who} spend ${howMuch}, now and later. This signature alone is enough; no transaction from you is needed.`)
      knownCalm = identified && ORDER.indexOf(level) <= ORDER.indexOf('medium')
    }
  } else if (d.operationName === 'CoW Protocol Order' && d.isKnownType) {
    // The decoder matched it at the pinned GPv2Settlement on this chain.
    const from = req.from?.toLowerCase()
    const receiver = String(f('Receiver')?.raw ?? '').toLowerCase()
    // A zero receiver pays the order's owner, the account signing it.
    const own = /^0x0{40}$/.test(receiver) || (!!from && receiver === from)
    const sell = f('Sell')?.value ?? f('Sell at most')?.value
    const buy = f('Receive at least')?.value ?? f('Receive')?.value
    const deal = f('Order Kind')?.raw === 'sell' ? `sells ${sell} for at least ${buy}` : `buys ${buy} for at most ${sell}`
    add('medium', `CoW Protocol swap order: ${deal}, paid to ${own ? 'this wallet' : receiver}, valid until ${f('Valid Until')?.value}. Nothing moves until a solver fills it at this price or better.`)
    if (!own) add('high', `The tokens bought go to ${receiver}, which is NOT the account signing this (${from || 'unknown'}).`)
    const unnamed = [sell, buy].filter((v) => / base units of /.test(v ?? ''))
    if (unnamed.length) add('medium', `This computer cannot name ${unnamed.length === 2 ? 'either token' : 'one of the tokens'} in this order, so ${unnamed.length === 2 ? 'those amounts are' : 'that amount is'} in base units.`)
    if (!/^(0x)?0*$/.test(String(f('Fee')?.raw ?? '0'))) add('low', `Fee: ${f('Fee')!.value}, taken from what you sell.`)
    knownCalm = own
  } else if (/^(OrderComponents|BulkOrder)$/.test(d.primaryType)) {
    const listing = d.isKnownType ? d.seaportListing : undefined
    const from = req.from?.toLowerCase()
    const others = listing?.payments.filter((p) => p.role === 'other') ?? []
    const own = listing?.payments.filter((p) => p.role === 'offerer') ?? []
    const seller = !!listing && !!from && listing.offerer.toLowerCase() === from
    const proceeds = own.reduce((sum, p) => sum + BigInt(p.raw), 0n)
    // Under a millionth of a coin or token is no price: it is how a phishing
    // listing takes the NFT for nothing. Unnamed currency: worth unknown.
    const named = listing?.decimals !== undefined
    const dust = named && proceeds < 10n ** BigInt(Math.max(listing!.decimals! - 6, 0))
    // royaltyInfo could not be asked here (no RPC that serves eth_call, or no
    // answer in time): one other payee may be the creator fee, if it takes no
    // more than a creator fee can. OpenSea caps creator earnings at 10% of the
    // price (support.opensea.io/en/articles/8867026). Inside that bound it is
    // not danger, but this computer did not check the payee, so the card is
    // yellow at most. More than that, or a second unknown payee, stays red.
    const uncheckedSum = others.reduce((sum, p) => sum + BigInt(p.raw), 0n)
    const unchecked = listing?.creatorFeeUnchecked && new Set(others.map((p) => p.recipient.toLowerCase())).size === 1
      && uncheckedSum * 10n <= BigInt(listing.totalRaw) && uncheckedSum < proceeds ? others : []
    // A normal listing: the signer sells its own NFTs, is paid a real amount in
    // a currency this computer names, and every other payee is a marketplace
    // fee address it knows or the collection's own creator fee.
    if (listing && seller && own.length > 0 && others.length === unchecked.length && named && !dust) {
      const fees = listing.payments.filter((p) => p.role === 'opensea-fee')
      const creator = listing.payments.filter((p) => p.role === 'creator-fee')
      add('medium', `Seaport listing: sells ${listing.items.join(', ')} for ${listing.total}. You receive ${own.map((p) => p.amount).join(' + ')}${fees.length ? `, and ${fees.map((p) => p.amount).join(' + ')} goes to OpenSea's fee address` : ''}${creator.length ? `, and ${creator.map((p) => p.amount).join(' + ')} goes to the creator fee address the collection names on chain (${creator[0].recipient})` : ''}. Anyone can buy at this price until ${listing.endTime}; nothing moves until a buyer pays it.`)
      unverified = unchecked.length > 0
      if (unverified) add('medium', `Also pays ${unchecked.map((p) => p.amount).join(' + ')} to ${unchecked[0].recipient}. This computer could not ask the collection for its creator fee (ERC-2981 royaltyInfo), so it could not check that this is the creator fee address.`)
      knownCalm = true
    } else {
      add('critical', 'This is a marketplace order. Anyone holding this signature can take the listed items at the price in the order.')
      if (listing && seller && proceeds === 0n) add('critical', `Pays you nothing for ${listing.items.join(', ')}. A real listing pays the seller.`)
      else if (listing && seller && dust) add('critical', `Pays you only ${own.map((p) => p.amount).join(' + ')} for ${listing.items.join(', ')}. That is not a real price.`)
      if (listing && !named) add('high', `Paid in a token this computer cannot name (${listing.total}), so it cannot tell what this price is worth.`)
      for (const p of others) add('critical', `Pays ${p.amount} to ${p.recipient}, which is neither the seller nor a marketplace fee address this computer knows.`)
    }
  }
  if (d.primaryType === 'SafeTx') {
    // Safe pays gasPrice × gas in gasToken to refundReceiver when this executes.
    // Safe{Wallet} leaves all three at zero, so a set refund is a hidden payout.
    const set = (label: string) => !/^(0x)?0*$/.test(String(f(label)?.raw ?? '0'))
    if (set('Gas Price') || set('Gas Token') || set('Refund Receiver')) add('high', safeGasRefund(d, f))
  }
  const structured = !!req.firmwareVersion && versionCompare(req.firmwareVersion, '7.15.0') >= 0
  if (structured) {
    add('low', 'Your KeepKey will request and display the structured fields that it hashes for this signature.')
    if (safeRecognition === 'known') add('low', "Your KeepKey may show this Safe transaction's call data only as raw hex. The description of it here is from this computer, not from your KeepKey.")
  } else if (knownCalm) {
    // Before 7.15 the device shows a typed signature only as two hash codes.
    add('medium', `${firmwareName(req)} cannot show this ${d.operationName} on the device yet: it shows only the signature's hash codes and needs Advanced Mode to sign. Later firmware shows it. Check the details here.`)
  } else {
    add('high', 'Your KeepKey can only show a code (hash) for this signature, not what it says. You would be signing blind.')
  }
  return opaque ? 'unknown' : structured ? (safeRecognition === 'known' ? 'known' : unverified ? 'unchecked' : 'shows') : knownCalm ? 'known' : 'unknown'
}

/** What the typed-data verdict rests on, for the ClearSign report: 'shows'
 *  only when the device shows the meaning, not raw hex standing for it. */
export function typedDataRecognition(req: SigningRequestInfo): Recognition {
  return evmTypedData(req, () => {})
}

function evmMessage(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void): Recognition {
  const m = req.ethMessageDecoded
  const raw = String(m?.messageRaw ?? req.data ?? '')
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    add('high', 'You are signing a 32-byte code, not text. Some apps accept this as approval of a payment or order you cannot see.')
  } else if (m?.isUtf8Text && m.messageText !== undefined && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(m.messageText)) {
    // The device draws only printable ASCII as characters; every other byte,
    // each byte of a non-English letter or emoji included, appears as \xNN.
    if (/^[\x20-\x7e\t\n\r]*$/.test(m.messageText)) {
      add('low', 'You are signing a text message. Some apps treat signed text as a login or an approval, so read it on your KeepKey screen.')
      return 'shows'
    }
    // Text-direction and invisible characters make the text read differently
    // from what is signed. Not U+200C/U+200D: emoji and some scripts need them.
    if (/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(m.messageText)) {
      add('high', 'This text contains hidden characters that can change how it reads, such as reversed text. Normal apps do not use them.')
    }
    add('medium', 'You are signing a text message. Your KeepKey shows its non-English letters and symbols as \\xNN codes, so read the text here.')
    return 'known'
  } else if (m) {
    add('medium', 'You are signing data that is not readable text. Only the site knows what it means.')
  } else {
    add('medium', 'This message was not decoded on this computer. Read it on your KeepKey screen.')
  }
  return 'unknown'
}

/** TRON: the firmware shows a plain TRX or TRC-20 transfer (tronDecoded);
 *  everything else it shows as raw data, so this reads it (tronCall). */
function tronTx(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void): Recognition {
  const t = req.tronDecoded
  if (t) {
    const unverified = t.kind === 'TRC-20 transfer' && !/ USDT$/.test(t.amount)
    // Only the REST gate's firmware check says the device shows it (7.15+,
    // TRX or a token in its table); 7.14 blind-signs every transfer. From 7.16
    // a TRC-20 outside its table is "TRON Blind Sign" behind AdvancedMode, and
    // then the device shows the contract, base units and recipient.
    const shown = req.requiresAdvancedMode === false
    const fieldsAfterWarning = !shown && t.kind === 'TRC-20 transfer'
      && !!req.firmwareVersion && versionCompare(req.firmwareVersion, '7.16.0') >= 0
    add(unverified || !shown ? 'medium' : 'low', `Sends ${t.amount} to ${t.to}.${unverified ? ` This computer does not recognize token ${t.tokenContract}.` : ''} ${shown
      ? 'Your KeepKey shows this transfer; check it there.'
      : fieldsAfterWarning
        ? `${firmwareName(req)} does not know this token: it warns "TRON Blind Sign" and needs Advanced Mode, then shows the token contract, the amount in base units and the recipient. Check those on your KeepKey.`
        : `${firmwareName(req)} cannot show this transfer on the device: it signs it blind, without the amount or recipient, and needs Advanced Mode. Check them here.`}`)
    if (t.minimumOutput === 'NO MINIMUM IN SIGNED MEMO') add('high', 'Sets no minimum, so this swap can pay you back almost nothing.')
    return shown ? 'shows' : 'known'
  }
  const c = req.tronCall
  const fw = (what: string) => add('medium', notOnThisFirmware(what, req))
  if (!c) {
    add('high', 'KeepKey cannot read this transaction at all. You would be signing blind.')
    return 'unknown'
  }
  switch (c.kind) {
    case 'TRC-20 approve': {
      const who = c.spenderName ? `${c.spenderName} (${c.spender})` : c.spender
      const token = c.tokenSymbol ?? `token ${c.token}`
      if (c.revoke) {
        add('low', `Removes ${who}'s permission to spend your ${token}.`)
      } else {
        const permit2Setup = c.spenderName === 'SunSwap Permit2'
        const level = spendPermissionLevel(c.spenderName, c.unlimited || !c.tokenSymbol, permit2Setup)
        add(level, permit2Setup && c.unlimited
          ? `Standard SunSwap setup: gives SunSwap Permit2 (${c.spender}) persistent access to your ${token}. You can revoke this allowance later.`
          : `Lets ${who} spend ${c.unlimited ? `ALL of your ${token}` : `up to ${c.amount}`}, now and later, without asking you again.`)
        // The USDT-TRC20 approval scam: a site asks for an unlimited approve
        // to its own address, then drains the wallet with transferFrom.
        if (level === 'critical') add('critical', `${c.spender} is not a contract KeepKey knows. Sites that steal ${token} ask for exactly this approval; whoever controls that address can take your ${token} at any time.`)
      }
      fw('TRC-20 approvals')
      return 'known'
    }
    case 'Stake TRX':
      add('low', `Stakes ${c.amount} for ${c.resource}. The TRX stays locked until you unstake it and the network's waiting period ends.`)
      break
    case 'Unstake TRX':
      add('low', `Unstakes ${c.amount} of ${c.resource} stake. You can withdraw it once the network's waiting period ends.`)
      break
    case 'Withdraw unstaked TRX':
      add('low', 'Moves TRX whose unstaking waiting period has ended back to your balance.')
      break
    case 'Claim voting rewards':
      add('low', 'Claims your voting rewards to your balance.')
      break
    case 'Vote':
      add('low', `Votes for ${c.votes.map((v) => `${v.witness} (${v.count} votes)`).join(', ')}. This replaces your earlier votes.`)
      break
    case 'Delegate resources':
      add('low', `Lends the ${c.resource} of ${c.amount} of your stake to ${c.receiver}${c.locked ? ', locked for a period' : ''}. The TRX stays yours and you can reclaim it${c.locked ? ' once the lock ends' : ''}.`)
      break
    case 'Reclaim delegated resources':
      add('low', `Takes back the ${c.resource} of ${c.amount} of stake you lent to ${c.receiver}.`)
      break
    case 'SunSwap swap':
      add('medium', `Swaps ${c.amountIn} for at least ${c.amountOutMin} through the ${c.contractName} (${c.contract}).`)
      if (c.noMinimum) add('high', 'Sets no minimum, so this swap can pay you back almost nothing.')
      if (c.to !== c.owner) add('high', `The swap output goes to ${c.to}, which is NOT the account signing this (${c.owner}).`)
      if (c.callValue) add('medium', `Also sends ${c.callValue} to the contract.`)
      fw('SunSwap swaps')
      return 'known'
    case 'Contract call':
      if (c.contractName) {
        add('medium', `Calls the ${c.contractName} (${c.contract}), a swap contract SUN.io publishes. This computer cannot read the swap amounts, so check them in the app before you sign.`)
      } else {
        add('high', `Your KeepKey cannot show what this call to ${c.contract} does. You would be signing blind.`)
      }
      if (c.callValue) add('medium', `Also sends ${c.callValue} to the contract.`)
      return 'unknown'
  }
  fw('TRON staking and voting')
  return 'known'
}

/** Cosmos Hub amino: hdwallet builds each of these message types on the
 *  device, which shows its fields; any other type it refuses to sign. */
const COSMOS_ON_DEVICE = new Set(['cosmos-sdk/MsgSend', 'cosmos-sdk/MsgDelegate', 'cosmos-sdk/MsgUndelegate',
  'cosmos-sdk/MsgBeginRedelegate', 'cosmos-sdk/MsgWithdrawDelegationReward', 'cosmos-sdk/MsgTransfer'])

function cosmosAmino(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void): Recognition {
  const body = req.rawRequestBody as { signerAddress?: string; signDoc?: { msgs?: unknown } } | undefined
  const msgs = Array.isArray(body?.signDoc?.msgs) ? body!.signDoc!.msgs as { type?: unknown; value?: any }[] : []
  if (msgs.length === 0) {
    add('high', 'This computer could not read this Cosmos request.')
    return 'unknown'
  }
  const signer = body?.signerAddress ?? req.from
  // Only the chain's own coin has fixed decimals; every other denom as signed.
  const coin = (c: any) => (c?.denom === 'uatom' && /^\d+$/.test(String(c?.amount)) ? `${units(String(c.amount), 6)} ATOM` : `${c?.amount ?? '?'} ${c?.denom ?? '?'}`)
  const notYou = (who: unknown) => { if (signer && typeof who === 'string' && who !== signer) add('high', `This message acts for ${who}, which is NOT the account signing this (${signer}).`) }
  let shows = true
  for (const m of msgs) {
    const v = m?.value ?? {}
    const type = String(m?.type ?? 'unknown')
    const denoms = [v.amount, v.token].flat().filter(Boolean).map((c: any) => c?.denom)
    if (!COSMOS_ON_DEVICE.has(type) || denoms.some((d: unknown) => d !== 'uatom')) shows = false
    switch (type) {
      case 'cosmos-sdk/MsgSend':
        notYou(v.from_address)
        add('low', `Sends ${(Array.isArray(v.amount) ? v.amount : [v.amount]).map(coin).join(' + ')} to ${v.to_address}.`)
        break
      case 'cosmos-sdk/MsgDelegate':
        notYou(v.delegator_address)
        add('low', `Stakes ${coin(v.amount)} with validator ${v.validator_address}. Unstaking it later takes the chain's unbonding period.`)
        break
      case 'cosmos-sdk/MsgUndelegate':
        notYou(v.delegator_address)
        add('low', `Unstakes ${coin(v.amount)} from validator ${v.validator_address}. It returns to your balance after the chain's unbonding period.`)
        break
      case 'cosmos-sdk/MsgBeginRedelegate':
        notYou(v.delegator_address)
        add('low', `Moves ${coin(v.amount)} of stake from validator ${v.validator_src_address} to ${v.validator_dst_address}.`)
        break
      case 'cosmos-sdk/MsgWithdrawDelegationReward':
        notYou(v.delegator_address)
        add('low', `Claims your staking rewards from validator ${v.validator_address}.`)
        break
      case 'cosmos-sdk/MsgTransfer':
        notYou(v.sender)
        add('low', `Sends ${coin(v.token)} over IBC (${v.source_port}/${v.source_channel}) to ${v.receiver} on another chain. Check the receiver: an IBC transfer cannot be called back once it arrives.`)
        if (typeof v.memo === 'string' && v.memo) add('medium', `Also carries instructions for the receiving chain: "${v.memo.length > 200 ? v.memo.slice(0, 200) + '…' : v.memo}". Your KeepKey does not show them.`)
        break
      default:
        add(/authz|MsgGrant|MsgExec/i.test(type) ? 'critical' : 'high', /authz|MsgGrant|MsgExec/i.test(type)
          ? `Gives another account power to act for your account (${type}). That account can then move your funds without your KeepKey.`
          : `This computer does not recognize message type ${type}. Your KeepKey signs only sends, staking and IBC transfers, so it will refuse this.`)
    }
  }
  if (shows) add('low', 'Your KeepKey shows each of these on its screen; check them there.')
  return shows ? 'shows' : 'unknown'
}

/** null = no assessment for this request type yet (bar hidden). */
export function assessSigningRisk(req: SigningRequestInfo): RiskAssessment | null {
  const reasons: RiskReason[] = []
  const add = (level: RiskLevel, text: string) => reasons.push({ level, text })
  let recognition: Recognition = 'unknown'

  if (req.solanaMessageDecoded) {
    const m = req.solanaMessageDecoded
    const c = m.classification
    // Text with control characters other than tab and line breaks is not
    // decoded in full, whatever share of it reads as text.
    const readable = m.messageText !== undefined && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(m.messageText)
    if (c === 'solana-transaction' || c === 'solana-transaction-message') {
      add('critical', 'This "message" is really a transaction. Signing it could move your money.')
    } else if (c === 'binary-message' || !readable) {
      add('medium', 'You are signing data that is not readable text. Only the site knows what it means.')
    } else if (m.plainText === true) {
      // The firmware shows plain ASCII text and checks it holds no signer key.
      add('low', 'You are signing a text message. It cannot move your money by itself.')
      recognition = 'shows'
    } else {
      add('low', 'You are signing a text message. Your KeepKey blocks it unless Advanced Mode is on, then shows it only as raw bytes, so read the text here.')
      recognition = 'known'
    }
  } else if (req.solanaDecoded) {
    const d = req.solanaDecoded
    const assets = d.assetPrograms ?? []
    const unknown = d.instructions.filter((i) => i.status === 'unknown-program')
    const swaps = d.instructions.filter((i) => i.status === 'known' && i.programId === JUPITER_V6)
    const me = req.from ?? swaps.map((i) => acct(i, 'userTransferAuthority')).find(Boolean)
    const swapOutputs = new Set(swaps.map(jupiterOutput).filter((k): k is string => !!k))

    for (const ix of d.instructions) {
      if (ix.status === 'known' && ix.programId === JUPITER_V6) {
        jupiterSwap(ix, d, req, add)
        if (ix.note) add('medium', `This Jupiter step has bytes this computer cannot account for (${ix.note}), so it is not decoded in full.`)
      } else if (ix.status === 'known') {
        const r = describeKnown(ix, d.tokenAccounts, me, swapOutputs, req.from)
        if (r) reasons.push(r)
        // Token-2022 lets a token's issuer add a transfer fee or a hook that
        // runs on every transfer; nothing here reads those settings.
        if (ix.programId === TOKEN_2022 && /^transfer/.test(ix.instructionName ?? '')) {
          const mint = acct(ix, 'mint') ?? d.tokenAccounts?.[acct(ix, 'destination') ?? '']?.mint
          if (!mint || !SOLANA_TOKEN_IDENTITIES[mint]) add('medium', 'This is a Token-2022 token. Its issuer can charge a fee or run its own code on every transfer, and this computer did not check this token\'s settings.')
        }
        if (ix.note) add('medium', `This ${ix.programName} step has bytes this computer cannot account for, so it is not decoded in full.`)
      } else if (ix.status === 'known-program-unknown-ix' && assets.includes(ix.programName)) {
        add('high', `Uses a ${ix.programName} action KeepKey does not recognize. It could move your funds or hand over control of them.`)
      } else if (ix.status === 'known-program-unknown-ix' && !SOLANA_MEMO_PROGRAMS.has(ix.programId)) {
        add('medium', `Uses ${ix.programName}, a program KeepKey knows by name, but this computer cannot decode this action.`)
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
        add('medium', canMoveFunds
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
    // A memo moves nothing; the decoder has no layout for it yet. A note means
    // bytes were cut short or left over, so that step is not decoded in full.
    const decoded = !d.altResolutionIncomplete
      && d.instructions.every((i) => (i.status === 'known' && !i.note) || SOLANA_MEMO_PROGRAMS.has(i.programId))
    // Only a firmware check that ran says the device shows it: a caller that
    // never asked (no firmware version) leaves requiresAdvancedMode unset.
    const firmwareShows = d.instructions.every(solanaFirmwareShows) && req.requiresAdvancedMode === false && !req.firmwareCannotSign
    recognition = req.deviceClearSigns || (decoded && firmwareShows) ? 'shows'
      : decoded ? 'known' : 'unknown'
    // Decoded here but not on the device: say so even when the steps above
    // read calm, so a named send is not taken for a device-shown one.
    if (recognition === 'known' && !req.firmwareCannotSign && !reasons.some((r) => r.text.includes('raw data'))) {
      add('low', 'This computer decodes every step of this transaction. Your KeepKey shows it as raw data.')
    } else if (reasons.length === 0 && recognition === 'shows') {
      add('low', 'Your KeepKey shows every step of this transaction.')
    }
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
    recognition = evmTx(req, add)
    // The device verifies a KeepKey-certified description and shows it. It
    // shows a THORChain/Maya vault only as UNVERIFIED and the memo as text:
    // shown once this computer has decoded the swap, matched the vault to one
    // of the network's active vaults and the payout to the user.
    const shown = req.deviceClearSigns || req.certifiedEvmSchema || certifiedBlobShown(req) || req.erc7730
    if (shown && (!thorDepositProtocol(req) || thorDepositShown(req))) recognition = 'shows'
    if (reasons.length === 0) add('low', 'Your KeepKey decodes this call on its screen. Check the recipient and amount there.')
    // A verified human rating can only add a reason, so it can only raise the level.
    const rating = req.clearSignReport?.rating
    if (rating) {
      add(rating.riskLevel, `An auditor rates this contract ${rating.riskLevel} risk: ${rating.riskReasons[0] || 'see findings'}.`
        + (rating.raterPinned ? '' : ' The rater is not yet pinned in this Vault.'))
    }
  } else if (req.method === '/eth/sign-typed-data') {
    recognition = evmTypedData(req, add)
  } else if (req.method === '/eth/sign') {
    recognition = evmMessage(req, add)
  } else if (req.method === '/thorchain/sign-amino-deposit' || req.method === '/mayachain/sign-amino-deposit') {
    recognition = nativeThorDeposit(req, add)
  } else if (req.method === '/tron/sign-transaction') {
    recognition = tronTx(req, add)
  } else if (/^\/cosmos\/sign-amino/.test(req.method)) {
    recognition = cosmosAmino(req, add)
  } else if (req.solanaDecodeError || /^\/solana\/sign-(transaction|and-send)/.test(req.method)) {
    add('high', 'KeepKey cannot read this transaction at all. You would be signing blind.')
  } else {
    return null
  }
  // The device refuses it whatever AdvancedMode is set to: promise an update
  // only where the newest firmware clear-signs it.
  if (req.firmwareCannotSign) {
    add('medium', `${firmwareName(req)} cannot sign this: your KeepKey will refuse it. ${req.firmwareUpdateClearSigns
      ? 'Updating your KeepKey firmware fixes this.'
      : 'Newer firmware does not show it on the device either.'}`)
  }

  // Last, and deliberately at 'low': a simulation is an estimate this computer
  // made, so it may add an answer but never change the verdict above. The level
  // is the maximum over the reasons, so this line cannot move it either way.
  if (req.simulatedOutflow) add('low', formatSimulatedHoldings(req.simulatedOutflow))

  const level = reasons.reduce<RiskLevel>(
    (max, r) => (ORDER.indexOf(r.level) > ORDER.indexOf(max) ? r.level : max), 'low')
  // Riskiest sentence first — it is the one the user must not skim past.
  reasons.sort((a, b) => ORDER.indexOf(b.level) - ORDER.indexOf(a.level))
  const tier: SigningTier = ORDER.indexOf(level) >= ORDER.indexOf('high') || recognition === 'unknown' ? 'red'
    : recognition === 'shows' ? 'green' : 'yellow'
  const headline = req.firmwareCannotSign
    ? `${firmwareName(req)} cannot sign this${req.firmwareUpdateClearSigns ? '. Update your firmware' : ''}`
    : tier !== 'yellow' ? TIER_HEADLINE[tier]
    : recognition === 'used' ? USED_BEFORE_HEADLINE : recognition === 'unchecked' ? UNCHECKED_HEADLINE : TIER_HEADLINE[tier]
  return { level, tier, headline, reasons }
}
