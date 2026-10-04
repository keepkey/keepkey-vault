/**
 * Uniswap Universal Router execute() pre-check: a TypeScript port of the
 * firmware decoder (keepkey-firmware lib/firmware/uniswap_ur.c, ur_decode +
 * ur_summarize). Host-side only: it decides whether a certified 0x07 decoder
 * entry is worth requesting and which token identities it must carry. The
 * device decodes the calldata itself and is authoritative.
 *
 * Deliberately no looser than the firmware: anything the device would refuse
 * must be refused here too, or Desktop would attach a certified claim the
 * device rejects with no fallback. Being stricter only costs a blind-sign
 * prompt (e.g. 64-bit offsets are bounded by the calldata length here).
 */

export const UR_EXECUTE = '0x3593564c'
export const UR_EXECUTE_NO_DEADLINE = '0x24856bc3'
/** Firmware SIGNED_METADATA_UR_MAX_CALLDATA: a longer call is held and
 * reviewed after its last byte (token -> ETH is 1,028-1,294 B on Base; split
 * routes up to 1,402 B). */
export const UR_MAX_CALLDATA = 1472
/** Firmware UR_MAX_STEPS: ur_decode refuses more commands than this. */
export const UR_MAX_STEPS = 4

export type UrKind =
  | 'V3_SWAP_EXACT_IN' | 'V3_SWAP_EXACT_OUT' | 'V2_SWAP_EXACT_IN' | 'V2_SWAP_EXACT_OUT'
  | 'PERMIT2_PERMIT' | 'WRAP_ETH' | 'UNWRAP_WETH' | 'SWEEP' | 'PAY_PORTION' | 'TRANSFER'

export interface UrStep {
  kind: UrKind
  /** lowercase 0x addresses; swaps: path ends, others: the token */
  tokenIn?: string
  tokenOut?: string
  recipient?: string
  amount: bigint
  limit?: bigint
  spender?: string
  expiration?: bigint
  payerIsUser?: boolean
}

export interface UrSummary {
  exactIn: boolean
  inIsEth: boolean
  outIsEth: boolean
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOut: bigint
  recipientIsSender: boolean
  recipient: string
  permit?: { token: string; amount: bigint; expiration: bigint }
  fee?: { bips: number; recipient: string }
}

const CMD: Record<number, UrKind> = {
  0x00: 'V3_SWAP_EXACT_IN', 0x01: 'V3_SWAP_EXACT_OUT', 0x04: 'SWEEP', 0x05: 'TRANSFER',
  0x06: 'PAY_PORTION', 0x08: 'V2_SWAP_EXACT_IN', 0x09: 'V2_SWAP_EXACT_OUT',
  0x0a: 'PERMIT2_PERMIT', 0x0b: 'WRAP_ETH', 0x0c: 'UNWRAP_WETH',
}
const CMD_FLAGS = 0xc0
const V3_HOP = 23
const CONTRACT_BALANCE = 1n << 255n

class Bad extends Error {}
const need = (ok: boolean): void => { if (!ok) throw new Bad() }

function word(s: Uint8Array, off: number): Uint8Array {
  need(Number.isSafeInteger(off) && off >= 0 && off <= s.length && s.length - off >= 32)
  return s.subarray(off, off + 32)
}
const big = (b: Uint8Array): bigint => (b.length ? BigInt('0x' + Buffer.from(b).toString('hex')) : 0n)
/** A word holding an integer no wider than `bytes`. */
function uint(s: Uint8Array, off: number, bytes: number): bigint {
  const w = word(s, off)
  for (let i = 0; i < 32 - bytes; i++) need(w[i] === 0)
  return big(w)
}
/** An offset/length: bounded by the calldata, so it is a safe JS number. */
const index = (s: Uint8Array, off: number): number => {
  const v = uint(s, off, 8)
  need(v <= BigInt(s.length))
  return Number(v)
}
function address(s: Uint8Array, off: number): string {
  const w = word(s, off)
  for (let i = 0; i < 12; i++) need(w[i] === 0)
  return '0x' + Buffer.from(w.subarray(12)).toString('hex')
}
function bool(s: Uint8Array, off: number): boolean {
  const v = uint(s, off, 1)
  need(v <= 1n)
  return v === 1n
}
/** Dynamic `bytes` whose head word is at `head`; offset relative to s. */
function bytes(s: Uint8Array, head: number): Uint8Array {
  const off = index(s, head)
  const n = index(s, off)
  const start = off + 32
  need(start <= s.length && n <= s.length - start)
  return s.subarray(start, start + n)
}

function decodeStep(cmd: number, input: Uint8Array): UrStep {
  const kind = CMD[cmd]
  need(kind !== undefined)
  switch (kind) {
    case 'V3_SWAP_EXACT_IN':
    case 'V3_SWAP_EXACT_OUT': {
      const exactIn = kind === 'V3_SWAP_EXACT_IN'
      const recipient = address(input, 0)
      const amount = big(word(input, 32))
      const limit = big(word(input, 64))
      const path = bytes(input, 96)
      const payerIsUser = bool(input, 128)
      need(path.length >= 20 + V3_HOP && (path.length - 20) % V3_HOP === 0)
      const first = '0x' + Buffer.from(path.subarray(0, 20)).toString('hex')
      const last = '0x' + Buffer.from(path.subarray(path.length - 20)).toString('hex')
      // Exact-output paths are encoded output-first.
      return { kind, recipient, amount, limit, payerIsUser, tokenIn: exactIn ? first : last, tokenOut: exactIn ? last : first }
    }
    case 'V2_SWAP_EXACT_IN':
    case 'V2_SWAP_EXACT_OUT': {
      const recipient = address(input, 0)
      const amount = big(word(input, 32))
      const limit = big(word(input, 64))
      const off = index(input, 96)
      const payerIsUser = bool(input, 128)
      const n = Number(uint(input, off, 8))
      need(n >= 2 && n <= 8)
      const path: string[] = []
      for (let i = 0; i < n; i++) path.push(address(input, off + 32 + 32 * i))
      return { kind, recipient, amount, limit, payerIsUser, tokenIn: path[0], tokenOut: path[n - 1] }
    }
    case 'PERMIT2_PERMIT': {
      // PermitSingle{details{token, amount, expiration, nonce}, spender, sigDeadline}, bytes signature
      const tokenIn = address(input, 0)
      const amount = uint(input, 32, 20)
      const expiration = uint(input, 64, 6)
      uint(input, 96, 6) // nonce
      const spender = address(input, 128)
      word(input, 160) // sigDeadline
      bytes(input, 192) // signature
      return { kind, tokenIn, amount, expiration, spender }
    }
    case 'WRAP_ETH':
    case 'UNWRAP_WETH':
      return { kind, recipient: address(input, 0), amount: big(word(input, 32)) }
    default: // SWEEP, PAY_PORTION, TRANSFER
      return { kind, tokenIn: address(input, 0), recipient: address(input, 32), amount: big(word(input, 64)) }
  }
}

/** ur_decode: every command fully understood, or null (never a partial plan). */
export function urDecode(calldata: Uint8Array): UrStep[] | null {
  try {
    need(calldata.length >= 4)
    const selector = '0x' + Buffer.from(calldata.subarray(0, 4)).toString('hex')
    const hasDeadline = selector === UR_EXECUTE
    need(hasDeadline || selector === UR_EXECUTE_NO_DEADLINE)
    const body = calldata.subarray(4)
    const commands = bytes(body, 0)
    const inputsOff = index(body, 32)
    if (hasDeadline) uint(body, 64, 8)
    const n = Number(uint(body, inputsOff, 8))
    need(commands.length > 0 && commands.length <= UR_MAX_STEPS && n === commands.length)
    // bytes[] element heads are relative to the first head word.
    const headsStart = inputsOff + 32
    need(headsStart <= body.length)
    const heads = body.subarray(headsStart)
    const steps: UrStep[] = []
    for (let i = 0; i < commands.length; i++) {
      need((commands[i] & CMD_FLAGS) === 0)
      steps.push(decodeStep(commands[i], bytes(heads, 32 * i)))
    }
    return steps
  } catch (e) {
    if (e instanceof Bad) return null
    throw e
  }
}

const isConstant = (recipient: string | undefined, which: 0 | 1 | 2) =>
  recipient === '0x' + which.toString(16).padStart(40, '0')
const MSG_SENDER = 1
const ADDRESS_THIS = 2
const isSwap = (k: UrKind) => k.includes('_SWAP_')
const isExactIn = (k: UrKind) => k === 'V3_SWAP_EXACT_IN' || k === 'V2_SWAP_EXACT_IN'
const U256 = 1n << 256n

/**
 * ur_summarize: only [PERMIT2_PERMIT | WRAP_ETH] -> one swap (or a split of
 * two exact-in swaps of the same pair) -> [PAY_PORTION] -> [SWEEP |
 * UNWRAP_WETH] -> [clean-up: ETH back to the same recipient].
 * `router` is the called contract; `value` msg.value.
 */
export function urSummarize(steps: UrStep[], router: string, value: bigint): UrSummary | null {
  const r = router.toLowerCase()
  // The router itself, by placeholder or by its own address: either way it
  // holds the funds for a later step. Apps encode both (firmware is_router).
  const isRouter = (x: string | undefined) => isConstant(x, ADDRESS_THIS) || x === r
  let i = 0
  let permit: UrStep | undefined
  let wrap: UrStep | undefined
  if (steps[i]?.kind === 'PERMIT2_PERMIT') permit = steps[i++]
  else if (steps[i]?.kind === 'WRAP_ETH') wrap = steps[i++]
  let swap = steps[i++]
  if (!swap || !isSwap(swap.kind)) return null
  // A split route: a second exact-in swap of the same pair, paid and delivered
  // the same way. Its totals are what the user spends and is guaranteed (each
  // swap enforces its own minimum).
  if (steps[i] && isSwap(steps[i].kind)) {
    const b = steps[i++]
    const amount = swap.amount + b.amount
    const limit = swap.limit! + b.limit!
    if (!isExactIn(swap.kind) || !isExactIn(b.kind) || b.tokenIn !== swap.tokenIn ||
        b.tokenOut !== swap.tokenOut || b.recipient !== swap.recipient ||
        b.payerIsUser !== swap.payerIsUser ||
        swap.amount === CONTRACT_BALANCE || b.amount === CONTRACT_BALANCE ||
        amount >= U256 || limit >= U256) return null
    swap = { ...swap, amount, limit }
  }
  let fee: UrStep | undefined
  const tail: UrStep[] = [] // final, then clean-up
  if (steps[i]?.kind === 'PAY_PORTION') fee = steps[i++]
  while (tail.length < 2 && (steps[i]?.kind === 'SWEEP' || steps[i]?.kind === 'UNWRAP_WETH')) tail.push(steps[i++])
  if (i !== steps.length) return null
  const final: UrStep | undefined = tail[0]
  let cleanup: UrStep | undefined = tail[1]

  const exactIn = isExactIn(swap.kind)
  const out: UrSummary = {
    exactIn, inIsEth: false, outIsEth: false, tokenIn: swap.tokenIn!, tokenOut: swap.tokenOut!,
    amountIn: 0n, amountOut: exactIn ? swap.limit! : swap.amount, recipientIsSender: false, recipient: '',
  }
  if (wrap) {
    // ETH in: the router wraps msg.value and pays from its own balance. Exact
    // out spends at most its limit, which may not exceed what was sent.
    if (swap.payerIsUser || value === 0n || !isRouter(wrap.recipient) ||
        (wrap.amount !== value && wrap.amount !== CONTRACT_BALANCE) ||
        (exactIn && swap.amount !== value && swap.amount !== CONTRACT_BALANCE) ||
        (!exactIn && swap.limit! > value)) return null
    out.inIsEth = true
    out.amountIn = value
  } else {
    if (value !== 0n || !swap.payerIsUser || swap.amount === CONTRACT_BALANCE) return null
    out.amountIn = exactIn ? swap.amount : swap.limit!
  }
  if (permit) {
    if (permit.spender !== r || permit.tokenIn !== swap.tokenIn) return null
    out.permit = { token: permit.tokenIn!, amount: permit.amount, expiration: permit.expiration! }
  }

  let deliver: UrStep = swap
  if (!isRouter(swap.recipient)) {
    // Delivered by the swap itself: what follows is clean-up.
    if (fee || cleanup) return null
    cleanup = final
  } else {
    // Held by the router: a final step must deliver it, after any fee.
    if (!final || final.amount === CONTRACT_BALANCE) return null
    if (final.kind === 'SWEEP' && final.tokenIn !== swap.tokenOut) return null
    if (fee) {
      if (fee.amount === 0n || fee.amount > 10_000n || fee.tokenIn !== swap.tokenOut ||
          isRouter(fee.recipient)) return null
      out.fee = { bips: Number(fee.amount), recipient: fee.recipient! }
      // The user's floor is what the final step guarantees after the fee.
      if (exactIn) out.amountOut = final.amount
    }
    if (isRouter(final.recipient)) return null
    // Apps put the floor on the final step and leave the swap's limit at 0:
    // the user is guaranteed the larger of the two.
    if (exactIn && !fee && final.amount > out.amountOut) out.amountOut = final.amount
    out.outIsEth = final.kind === 'UNWRAP_WETH'
    deliver = final
  }
  // Apps add one clean-up step returning leftover ETH (unwrapped, or swept as
  // address 0). Allowed only to the recipient the review names.
  if (cleanup && (cleanup.recipient !== deliver.recipient ||
                  (cleanup.kind === 'SWEEP' && !isConstant(cleanup.tokenIn, 0)))) return null
  out.recipientIsSender = isConstant(deliver.recipient, MSG_SENDER)
  out.recipient = deliver.recipient!
  return out
}

/** Every token the device review names, so the entry must identify each. */
export function urTokenSet(s: UrSummary): string[] {
  const set = new Set<string>()
  if (!s.inIsEth) set.add(s.tokenIn)
  if (!s.outIsEth) set.add(s.tokenOut)
  if (s.permit) set.add(s.permit.token)
  return [...set]
}

/** Decode + summarize a call to `router`, or null when the device would not. */
export function urPrecheck(router: string, data: string, value: bigint):
  { selector: string; summary: UrSummary; tokens: string[] } | null {
  const hex = String(data || '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 || hex.length / 2 > UR_MAX_CALLDATA) return null
  if (value < 0n || value >= 1n << 256n) return null
  const steps = urDecode(Buffer.from(hex, 'hex'))
  const summary = steps && urSummarize(steps, router, value)
  if (!summary) return null
  return { selector: `0x${hex.slice(0, 8).toLowerCase()}`, summary, tokens: urTokenSet(summary) }
}
