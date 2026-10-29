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
  SigningRequestInfo,
  SimulatedHoldings,
  SolanaCertifiedArg,
  SolanaTxDecodedInstruction,
} from './types'
import { versionCompare } from './firmware-versions'
import { base64PayloadBytes, certifiedEnvelopeShown, evmSignedChainId as evmChainId } from './certified-evm-envelope'
import { typedDataSpendAmounts } from './typedDataRows'

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
const U64_MAX = (1n << 64n) - 1n

/** A protocol Desktop knows and decodes in full, on firmware that cannot show
 *  it yet. Owner rule: known is normal, so say "not on this firmware yet",
 *  not "signing blind". The device still needs AdvancedMode for raw data. */
function notOnThisFirmware(what: string, fw?: string): string {
  return `${fw ? `KeepKey firmware ${fw}` : 'This KeepKey firmware'} cannot show ${what} on the device yet, so the device shows raw data and needs Advanced Mode to sign. Later firmware may add it. Check the details here.`
}

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

/** Plain sentence for an instruction KeepKey fully understands, or null. */
function describeKnown(ix: SolanaTxDecodedInstruction): RiskReason | null {
  const name = ix.instructionName
  if (ix.programName === 'System Program' && name === 'transfer') {
    const to = acct(ix, 'destination')
    const lamports = arg(ix, 'lamports')
    return { level: 'low', text: `Sends ${lamports ? `${units(lamports, 9)} SOL` : 'SOL'}${to ? ` to ${shortAddr(to)}` : ''}.` }
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
    const amount = dec && raw ? units(raw, Number(dec)) : 'tokens'
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

/** What the verdict tier rests on: the device shows it, this computer knows the
 *  protocol and decodes it in full, this account has used the contract before,
 *  or none of these. */
type Recognition = 'shows' | 'known' | 'used' | 'unknown'

function evmTx(req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void): Recognition {
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
  // A Relay deposit states its own amount and destination contract below.
  if (sendsCoin && !decodeRelayDeposit(to, data, chainId)) add('low', `Sends ${native} to ${data === '0x' ? '' : 'the contract at '}${to}.`)
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
  // the device decodes it (evm-signing-preview uniswapSwapFields).
  const urSwap = field('Protocol') === 'Uniswap Universal Router' && field('Action')?.startsWith('Swap ')
    ? field('Action')!.replace(/^Swap /, 'Swaps ') : undefined
  const relay = decodeRelayDeposit(to, data, chainId)
  const thorProtocol = req.calldataDecoded?.source === 'local' ? req.calldataDecoded.dappName : undefined
  const thorSwap = (thorProtocol === 'THORChain' || thorProtocol === 'Mayachain') ? field('Action') : undefined
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
  } else if (urSwap && req.calldataDecoded?.signedInsightBlob) {
    recognition = 'known'
    // Every command decoded, and a signed description attached that the device
    // verifies before it shows the swap: the amounts are on its screen, so
    // this is a check, not a blind signature.
    add('medium', `${urSwap} through the Uniswap Universal Router, a contract KeepKey has reviewed. Your KeepKey shows this swap on its screen from a signed description, and refuses it if that description is not genuine. Check the amounts there.`)
  } else if (across) {
    recognition = 'known'
    acrossDeposit(across, req, add)
  } else if (relay) {
    recognition = 'known'
    relayDeposit(relay, req, field('You send'), add)
  } else if (thorSwap) {
    recognition = 'known'
    // A fully decoded deposit to the router pinned for this chain is a normal
    // swap: say what it does, not "unknown contract".
    add(req.deviceClearSigns ? 'low' : 'medium', req.deviceClearSigns
      ? `${thorSwap}. Your KeepKey shows this deposit on its screen; check it there.`
      : `${thorSwap}. ${notOnThisFirmware('this deposit', req.firmwareVersion)}`)
  } else if (urSwap && !req.deviceClearSigns) {
    recognition = 'known'
    add('medium', `${urSwap} through the Uniswap Universal Router, a contract KeepKey has reviewed. ${notOnThisFirmware('this swap', req.firmwareVersion)}`)
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
    const dest = field('Output destination')
    if (from && dest && /^0x[0-9a-fA-F]{40}$/.test(dest) && dest.toLowerCase() !== from) {
      add('high', `The swap pays out to ${dest}, which is NOT the account signing this (${from}).`)
    }
  }
  return recognition
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
  const certified = req.deviceClearSigns || certifiedBlobShown(req)
  if (certified) {
    add('medium', `${what} Your KeepKey shows this deposit from a KeepKey-certified description and refuses it if that description is not genuine. Check the amount there.`)
  } else {
    add('medium', `${what} ${notOnThisFirmware('Relay deposits', req.firmwareVersion)}`)
  }
  if (credited !== 'your account' && from) add('high', `The deposit is credited to ${d.depositor}, not to the signing account.`)
  add('medium', "Where it arrives (destination chain, recipient and amount) is set by Relay's off-chain order, not by this transaction. Neither this computer nor your KeepKey can check it.")
}

/** A depositV3 to a pinned Across SpokePool. Decoded here only: the device
 *  shows it as raw data and AdvancedMode still gates, but a known protocol is
 *  normal, so the line says so instead of "signing blind". */
function acrossDeposit(d: AcrossDepositV3, req: SigningRequestInfo, add: (l: RiskLevel, t: string) => void) {
  const v = acrossDepositView(d, { ...ACROSS_NAMED_TOKENS, ...EVM_TOKENS })
  const from = (req.from ?? '').toLowerCase()
  let value: bigint | null = null
  try { value = BigInt(req.value === undefined || req.value === '' || req.value === '0x' ? 0 : req.value) } catch { /* unreadable: no claim about it */ }
  add('medium', `Across bridge deposit to the Across SpokePool on ${d.pool.chain}, a contract KeepKey knows. ${notOnThisFirmware('Across deposits', req.firmwareVersion)}`)
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
  // The meaning sits in bytes the device shows only as raw hex.
  let opaque = false
  const delegate = f('Agent Address')?.raw ?? f('Delegate')?.raw ?? f('Session Key')?.raw
  if (/ApproveAgent$/.test(d.primaryType) || delegate) {
    // Owner rule: handing over signing power is never a normal request.
    const unlimited = d.primaryType === 'Delegation' && f('Caveats')?.value === '[]'
      && /^0x(ff){32}$/i.test(String(f('Authority')?.raw ?? ''))
    add(unlimited ? 'critical' : 'high', `Gives ${delegate || 'another account'} the power to act for your account. It can then sign without your KeepKey.${unlimited ? ' There are no limits on what it can do.' : ''}`)
  } else if (d.primaryType === 'SafeTx' && !/^(0x)?$/.test(String(f('Data')?.raw ?? ''))) {
    // The device decodes only an embedded approve and warns on delegatecall;
    // any other call inside a Safe transaction shows as hex, and so it is here.
    opaque = true
    const to = f('To')?.raw || 'another contract'
    add('high', f('Operation')?.raw === '1'
      ? `Runs code from ${to} inside your Safe (delegatecall). That code can do anything with what the Safe holds.`
      : `Makes your Safe call ${to} with data this computer cannot read. Your KeepKey shows that data only as raw hex.`)
  } else if (d.primaryType === 'SafeMessage') {
    // EIP-1271: the Safe treats this as its own signature. Readable text (a
    // sign-in) is normal; a hash can stand for any permit or order the app hashed in.
    const safe = d.domain.verifyingContract || 'unknown Safe'
    const text = printableUtf8(String(f('Message')?.raw ?? ''))
    if (text) {
      add('medium', `Your Safe (${safe}) signs this text as its own, so apps that check the Safe's signature accept it: "${text.length > 200 ? text.slice(0, 200) + '…' : text}"`)
    } else {
      opaque = true
      add('high', `Approves a message for your whole Safe (${safe}). Apps use this to make the Safe sign permits and orders, and this computer cannot read what it approves.`)
    }
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
      const howMuch = all ? `ALL of your ${named ? symbols.join(' and ') : 'tokens'}`
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
      // A Permit2 permit to a reviewed router is what Uniswap asks for on every
      // swap, usually for the maximum with an expiry.
      const routerPermit = contract === PERMIT2 && !!known && known === req.recognizedSpender && known !== 'Uniswap Permit2'
      const level = spendPermissionLevel(known, unbounded, routerPermit)
      // A signature transfer (Permit*TransferFrom) is spent once, not an allowance.
      const once = /TransferFrom$/.test(d.primaryType)
      add(level, once
        ? `Lets ${who} take ${howMuch}, once. This signature alone is enough; no transaction from you is needed.`
        : `Lets ${who} spend ${howMuch}, now and later. This signature alone is enough; no transaction from you is needed.`)
      knownCalm = identified && ORDER.indexOf(level) <= ORDER.indexOf('medium')
    }
  } else if (/^(OrderComponents|BulkOrder)$/.test(d.primaryType)) {
    add('critical', 'This is a marketplace order. Anyone holding this signature can take the listed items at the price in the order.')
  }
  if (d.primaryType === 'SafeTx') {
    // Safe pays gasPrice × gas in gasToken to refundReceiver when this executes.
    // Safe{Wallet} leaves all three at zero, so a set refund is a hidden payout.
    const set = (label: string) => !/^(0x)?0*$/.test(String(f(label)?.raw ?? '0'))
    if (set('Gas Price') || set('Gas Token') || set('Refund Receiver')) {
      add('high', `Pays a gas refund out of your Safe when it is executed, to ${set('Refund Receiver') ? f('Refund Receiver')!.raw : 'whoever executes it'}. Normal Safe transactions leave the refund at zero.`)
    }
  }
  const structured = !!req.firmwareVersion && versionCompare(req.firmwareVersion, '7.15.0') >= 0
  if (structured) {
    add('low', 'Your KeepKey will request and display the structured fields that it hashes for this signature.')
  } else if (knownCalm) {
    add('medium', notOnThisFirmware(`this ${d.operationName}`, req.firmwareVersion))
  } else {
    add('high', 'Your KeepKey can only show a code (hash) for this signature, not what it says. You would be signing blind.')
  }
  return opaque ? 'unknown' : structured ? 'shows' : knownCalm ? 'known' : 'unknown'
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

    for (const ix of d.instructions) {
      if (ix.status === 'known') {
        const r = describeKnown(ix)
        if (r) reasons.push(r)
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
    const firmwareShows = d.instructions.every(solanaFirmwareShows) && req.requiresAdvancedMode === false
    recognition = req.deviceClearSigns || (decoded && firmwareShows) ? 'shows'
      : decoded ? 'known' : 'unknown'
    if (reasons.length === 0) {
      add('low', recognition === 'shows'
        ? 'Your KeepKey shows every step of this transaction.'
        : 'This computer decodes every step of this transaction. Your KeepKey shows it as raw data.')
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
    // The device verifies a KeepKey-certified description and shows it.
    if (req.deviceClearSigns || req.certifiedEvmSchema || certifiedBlobShown(req) || req.erc7730) recognition = 'shows'
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
  const tier: SigningTier = ORDER.indexOf(level) >= ORDER.indexOf('high') || recognition === 'unknown' ? 'red'
    : recognition === 'shows' ? 'green' : 'yellow'
  return { level, tier, headline: tier === 'yellow' && recognition === 'used' ? USED_BEFORE_HEADLINE : TIER_HEADLINE[tier], reasons }
}
