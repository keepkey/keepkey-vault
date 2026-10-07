/**
 * Uniswap Universal Router execute() pre-check: a line-for-line TypeScript
 * port of the firmware decoder (keepkey-firmware lib/firmware/uniswap_ur.c at
 * 51f85368e: the streaming ur_stream_* decoder with V4_SWAP, and the
 * token-flow ur_summarize). Host-side only: it decides whether a certified
 * 0x07 decoder entry is worth requesting, which token identities it must
 * carry, and what the Desktop shows as advice. The device decodes the
 * calldata itself and is authoritative.
 *
 * It must accept and refuse exactly what the device does, and read the same
 * values: __tests__/uniswap-ur-firmware-parity.test.ts runs it on every call
 * the firmware's own model test reads, against the firmware's output
 * (scripts/uniswap-fw-oracle). A looser port would attach a certified entry
 * the device rejects with no fallback; a stricter one would send a swap the
 * device reads to the blind path.
 */

export const UR_EXECUTE = '0x3593564c'
export const UR_EXECUTE_NO_DEADLINE = '0x24856bc3'
/** Firmware UR_MAX_STEPS: plan steps per call (a V4 swap with a fee is two). */
export const UR_MAX_STEPS = 6
/** Firmware UR_MAX_HOOKS: distinct non-zero V4 hook contracts per call. */
export const UR_MAX_HOOKS = 3
/** Firmware UR_V4_MAX_PATH: PathKeys per V4 swap. */
export const UR_V4_MAX_PATH = 4
/**
 * Firmware V4_ROUTERS: routers whose V4Router reads ExactInputParams /
 * ExactOutputParams with minHopPriceX36, checked against their verified
 * source. UR 2.0 encodes V4 swaps without that field, so the same bytes would
 * mean other amounts there. Only Base's UR 2.1.2 is listed; the address is
 * reviewed on Base only (REVIEWED_UNIVERSAL_ROUTERS), so this is chain 8453.
 */
export const UR_V4_ROUTERS = ['0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40'] as const

/** Firmware UrKind, in its order (the parity fixture uses the numbers). */
export const UR_KINDS = [
  'V3_SWAP_EXACT_IN', 'V3_SWAP_EXACT_OUT', 'V2_SWAP_EXACT_IN', 'V2_SWAP_EXACT_OUT',
  'PERMIT2_PERMIT', 'WRAP_ETH', 'UNWRAP_WETH', 'SWEEP', 'PAY_PORTION', 'TRANSFER',
  'V4_SWAP_EXACT_IN', 'V4_SWAP_EXACT_OUT', 'V4_TAKE_PORTION',
] as const
export type UrKind = (typeof UR_KINDS)[number]

/** Firmware UrStep; every field is present (zero when unused), as there. */
export interface UrStep {
  kind: UrKind
  /** Swaps: path ends (0x00..00 is native ETH in V4). PERMIT2_PERMIT, SWEEP,
   * PAY_PORTION, TRANSFER, V4_TAKE_PORTION: the token. Lowercase 0x hex. */
  tokenIn: string
  /** Swaps: output token. PERMIT2_PERMIT: the spender. */
  tokenOut: string
  /** As encoded; 0x..01 and 0x..02 are the router's constants. */
  recipient: string
  /** Swaps: the exact amount. WRAP/UNWRAP/SWEEP: minimum. PAY_PORTION and
   * V4_TAKE_PORTION: bips. PERMIT2_PERMIT: allowance. */
  amount: bigint
  /** Swaps: minimum out (exact in) or maximum in (exact out). */
  limit: bigint
  /** PERMIT2_PERMIT only. */
  expiration: bigint
  payerIsUser: boolean
}

export interface UrPlan {
  steps: UrStep[]
  deadline?: bigint
  /** Every distinct non-zero V4 pool hook in the call, in path order. */
  hooks: string[]
}

/** Firmware UrSummary: what the device asks the user to approve. */
export interface UrSummary {
  exactIn: boolean
  /** msg.value pays (wrapped, or settled into a V4 pool). */
  inIsEth: boolean
  /** ETH is delivered (unwrapped, or taken from a V4 pool). */
  outIsEth: boolean
  tokenIn: string
  tokenOut: string
  /** exactIn: spend exactly amountIn, receive at least amountOut.
   * Otherwise: spend at most amountIn, receive exactly amountOut. */
  amountIn: bigint
  amountOut: bigint
  recipientIsSender: boolean
  recipient: string
  permit?: { token: string; amount: bigint; expiration: bigint }
  fee?: { bips: number; recipient: string }
  /** V4 pool hooks the swap runs through; the device shows each. */
  hooks: string[]
}

// Commands.sol
const CMD_V3_SWAP_EXACT_IN = 0x00, CMD_V3_SWAP_EXACT_OUT = 0x01, CMD_SWEEP = 0x04, CMD_TRANSFER = 0x05
const CMD_PAY_PORTION = 0x06, CMD_V2_SWAP_EXACT_IN = 0x08, CMD_V2_SWAP_EXACT_OUT = 0x09
const CMD_PERMIT2_PERMIT = 0x0a, CMD_WRAP_ETH = 0x0b, CMD_UNWRAP_WETH = 0x0c, CMD_V4_SWAP = 0x10
/** Bit 7 is FLAG_ALLOW_REVERT; bit 6 is unused. Either set: not decoded. */
const CMD_FLAGS = 0xc0
const V3_HOP = 23
// v4-periphery Actions.sol (the version UR 2.1.2 on Base was built with)
const ACT_SWAP_EXACT_IN = 0x07, ACT_SWAP_EXACT_OUT = 0x09, ACT_SETTLE = 0x0b, ACT_TAKE = 0x0e, ACT_TAKE_PORTION = 0x10

const enum S {
  SELECTOR, HEAD, CMDS_LEN, CMDS, INPUTS_LEN, INPUT_HEAD, ELEM_LEN, FIELD, DYN_LEN, V3_PATH, V2_PATH,
  V4_HEAD, V4_ACTS_LEN, V4_ACTS, V4_PARAMS_LEN, V4_PARAM_HEAD, V4_PARAM_LEN, V4_ARGS, V4_SW_OFF,
  V4_SW_HEAD, V4_PATH_LEN, V4_PATH_HEAD, V4_PK, V4_PK_HOOKDATA, DONE,
}
// An input head word: what it holds (high nibble) and where it goes.
const F_ADDR = 0x10, F_U256 = 0x20, F_U160 = 0x30, F_U48 = 0x40, F_BOOL = 0x50, F_OFF = 0x60
const D_TOKEN_IN = 1, D_TOKEN_OUT = 2, D_RECIPIENT = 3, D_AMOUNT = 4, D_LIMIT = 5, D_EXPIRATION = 6

const SWAP_FIELDS = [F_ADDR | D_RECIPIENT, F_U256 | D_AMOUNT, F_U256 | D_LIMIT, F_OFF, F_BOOL | 7]
const PERMIT_FIELDS = [F_ADDR | D_TOKEN_IN, F_U160 | D_AMOUNT, F_U48 | D_EXPIRATION, F_U48, F_ADDR | D_TOKEN_OUT, F_U256, F_OFF]
const WRAP_FIELDS = [F_ADDR | D_RECIPIENT, F_U256 | D_AMOUNT]
const SWEEP_FIELDS = [F_ADDR | D_TOKEN_IN, F_ADDR | D_RECIPIENT, F_U256 | D_AMOUNT]
const COMMANDS: Record<number, { kind: number; fields: number[] }> = {
  [CMD_V3_SWAP_EXACT_IN]: { kind: 0, fields: SWAP_FIELDS },
  [CMD_V3_SWAP_EXACT_OUT]: { kind: 1, fields: SWAP_FIELDS },
  [CMD_V2_SWAP_EXACT_IN]: { kind: 2, fields: SWAP_FIELDS },
  [CMD_V2_SWAP_EXACT_OUT]: { kind: 3, fields: SWAP_FIELDS },
  [CMD_PERMIT2_PERMIT]: { kind: 4, fields: PERMIT_FIELDS },
  [CMD_WRAP_ETH]: { kind: 5, fields: WRAP_FIELDS },
  [CMD_UNWRAP_WETH]: { kind: 6, fields: WRAP_FIELDS },
  [CMD_SWEEP]: { kind: 7, fields: SWEEP_FIELDS },
  [CMD_PAY_PORTION]: { kind: 8, fields: SWEEP_FIELDS },
  [CMD_TRANSFER]: { kind: 9, fields: SWEEP_FIELDS },
  // Parsed by the V4_ states; the kind is set from its actions.
  [CMD_V4_SWAP]: { kind: 10, fields: [] },
}
const K_V2_IN = 2, K_V2_OUT = 3, K_PERMIT = 4, K_V3_IN = 0, K_V4_IN = 10, K_V4_OUT = 11, K_V4_FEE = 12

/** A plan step while it is built: raw bytes, as the firmware holds it. */
interface RawStep {
  kind: number
  tokenIn: Uint8Array
  tokenOut: Uint8Array
  recipient: Uint8Array
  amount: Uint8Array
  limit: Uint8Array
  expiration: bigint
  payerIsUser: boolean
}
const rawStep = (): RawStep => ({
  kind: 0, tokenIn: new Uint8Array(20), tokenOut: new Uint8Array(20), recipient: new Uint8Array(20),
  amount: new Uint8Array(32), limit: new Uint8Array(32), expiration: 0n, payerIsUser: false,
})
const isZero = (p: Uint8Array, n = p.length) => { for (let i = 0; i < n; i++) if (p[i] !== 0) return false; return true }
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
/** Top 32 - `bytes` bytes zero; the value (exact for <= 8 bytes, as uint64 there). */
function narrow(w: Uint8Array, bytes: number): bigint | null {
  let v = 0n
  for (let i = 0; i < 32; i++) {
    if (i < 32 - bytes && w[i] !== 0) return null
    v = (v << 8n) | BigInt(w[i])
  }
  return v
}
const isBalanceWord = (w: Uint8Array) => w[0] === 0x80 && isZero(w.subarray(1))
function narrowInt24(w: Uint8Array): boolean {
  const pad = (w[29] & 0x80) ? 0xff : 0x00
  for (let i = 0; i < 29; i++) if (w[i] !== pad) return false
  return true
}
const isV4SwapAction = (a: number) => a === ACT_SWAP_EXACT_IN || a === ACT_SWAP_EXACT_OUT

class Refused extends Error {}
const refuse = (): never => { throw new Refused() }

/** ur_stream_*: the decoder state machine, fed the whole call at once. */
class UrStream {
  steps: RawStep[] = []
  hooks: Uint8Array[] = []
  hasDeadline = false
  deadline = 0n
  total: number
  pos = 0
  at = 0
  base = 0
  len = 0
  heads = 0
  elem: number[] = []
  n = 0
  k = 0
  word = new Uint8Array(32)
  got = 0
  state = S.SELECTOR
  field = 0
  step = 0
  ncmds = 0
  cmds: number[] = []
  pstep = 0
  v4 = this.freshV4()

  constructor(total: number) { this.total = total }

  freshV4() {
    return {
      heads: 0, elem: [] as number[], base: 0, len: 0, sw: 0, path: 0, pk: [] as number[], pkb: 0,
      nacts: 0, acts: [] as number[], act: 0, npath: 0,
      settleCur: new Uint8Array(20), takeCur: new Uint8Array(20), swapDone: false,
    }
  }

  u32(): number { const v = narrow(this.word, 4); if (v === null) refuse(); return Number(v) }
  /** The next field starts at `at`: never behind what was read, never past the end. */
  nextAt(at: number) { if (at < this.pos || at > this.total) refuse(); this.at = at }
  nextInInput(rel: number) { if (rel > this.len || this.len - rel < 32) refuse(); this.nextAt(this.base + rel) }
  nextInParam(rel: number) { if (rel > this.v4.len || this.v4.len - rel < 32) refuse(); this.nextAt(this.v4.base + rel) }
  current() { return COMMANDS[this.cmds[this.step]] }
  cur(): RawStep { return this.steps[this.pstep] }
  addStep(): RawStep {
    if (this.steps.length >= UR_MAX_STEPS) refuse()
    const st = rawStep()
    this.steps.push(st)
    return st
  }
  nextInput() {
    if (this.step === this.ncmds) { this.state = S.DONE; return }
    this.state = S.ELEM_LEN
    this.nextAt(this.heads + this.elem[this.step])
  }
  /** The input in hand is complete; the next one starts at or past its end. */
  inputDone() {
    const end = this.base + this.len
    this.step++
    if (this.step < this.ncmds && this.heads + this.elem[this.step] < end) refuse()
    this.nextInput()
  }

  headField() {
    const c = this.current()
    const st = this.cur()
    const f = c.fields[this.field]
    const dst = ({ [D_TOKEN_IN]: st.tokenIn, [D_TOKEN_OUT]: st.tokenOut, [D_RECIPIENT]: st.recipient, [D_AMOUNT]: st.amount, [D_LIMIT]: st.limit } as Record<number, Uint8Array>)[f & 0x0f]
    const w = this.word
    switch (f & 0xf0) {
      case F_ADDR:
        if (narrow(w, 20) === null) refuse()
        if (dst) dst.set(w.subarray(12))
        break
      case F_U160:
        if (narrow(w, 20) === null) refuse()
        if (dst) dst.set(w)
        break
      case F_U256:
        if (dst) dst.set(w)
        break
      case F_U48: {
        const v = narrow(w, 6)
        if (v === null) refuse()
        if ((f & 0x0f) === D_EXPIRATION) st.expiration = v!
        break
      }
      case F_BOOL: {
        const v = narrow(w, 1)
        if (v === null || v > 1n) refuse()
        st.payerIsUser = v === 1n
        break
      }
      default: // F_OFF: the dynamic tail, relative to the payload
        this.n = this.u32()
    }
    this.field++
    if (this.field < c.fields.length) return this.nextInInput(32 * this.field)
    if (!c.fields.includes(F_OFF)) return this.inputDone()
    this.state = S.DYN_LEN
    this.nextInInput(this.n)
  }

  dynLen() {
    const kind = this.current().kind
    const n = this.u32()
    const start = this.pos - this.base
    if (kind === K_V2_IN || kind === K_V2_OUT) {
      if (n < 2 || n > 8) refuse()
      this.n = n
      this.k = 0
      this.state = S.V2_PATH
      return this.nextInInput(start)
    }
    if (n > this.len - start) refuse()
    if (kind === K_PERMIT) return this.inputDone()
    if (n < 20 + V3_HOP || (n - 20) % V3_HOP !== 0) refuse()
    this.n = n
    this.k = 0
    this.state = S.V3_PATH
    this.nextAt(this.pos)
  }

  v3PathByte(b: number) {
    const st = this.cur()
    // Exact-output paths are encoded output-first.
    const exactIn = st.kind === K_V3_IN
    if (this.k < 20) (exactIn ? st.tokenIn : st.tokenOut)[this.k] = b
    if (this.k >= this.n - 20) (exactIn ? st.tokenOut : st.tokenIn)[this.k - (this.n - 20)] = b
    if (++this.k === this.n) return this.inputDone()
    this.nextAt(this.pos)
  }

  v2PathWord() {
    const st = this.cur()
    if (narrow(this.word, 20) === null) refuse()
    if (this.k === 0) st.tokenIn.set(this.word.subarray(12))
    if (this.k === this.n - 1) st.tokenOut.set(this.word.subarray(12))
    if (++this.k === this.n) return this.inputDone()
    this.nextInInput(this.pos - this.base)
  }

  // ---- V4_SWAP: abi.encode(bytes actions, bytes[] params) inside the input.
  // Accepted action lists (UR 2.1.2's V4Router resolves them completely):
  //   SWAP_EXACT_IN|SWAP_EXACT_OUT, SETTLE, [TAKE_PORTION,] TAKE
  //   SETTLE, SWAP_EXACT_IN, [TAKE_PORTION,] TAKE

  v4ParamStart() {
    const at = this.v4.heads + this.v4.elem[this.v4.act]
    // Params in index order, none starting inside the previous one.
    if (this.v4.act > 0 && at < this.v4.base + this.v4.len) refuse()
    if (at < this.base) refuse()
    this.state = S.V4_PARAM_LEN
    this.nextInInput(at - this.base)
  }

  v4Done() {
    const st = this.cur()
    // SETTLE pays the swap's input, TAKE takes its output.
    if (!same(this.v4.settleCur, st.tokenIn) || !same(this.v4.takeCur, st.tokenOut) || same(st.tokenIn, st.tokenOut)) refuse()
    if (this.steps.length > this.pstep + 1 && !same(this.steps[this.pstep + 1].tokenIn, st.tokenOut)) refuse()
    // Native ETH is settled from the router's balance (msg.value), whatever
    // the payer flag says (DeltaResolver._settle).
    if (isZero(st.tokenIn)) st.payerIsUser = false
    this.inputDone()
  }

  v4ParamDone() {
    if (++this.v4.act < this.v4.nacts) return this.v4ParamStart()
    this.v4Done()
  }

  v4ActionByte(b: number) {
    this.v4.acts[this.k++] = b
    if (this.k < this.v4.nacts) return this.nextAt(this.pos)
    const a = this.v4.acts
    const n = this.v4.nacts
    const swapFirst = isV4SwapAction(a[0]) && a[1] === ACT_SETTLE
    const settleFirst = a[0] === ACT_SETTLE && a[1] === ACT_SWAP_EXACT_IN
    const portion = n === 4 && a[2] === ACT_TAKE_PORTION
    if (!(swapFirst || settleFirst) || a[n - 1] !== ACT_TAKE || (n !== 3 && !portion) ||
        (portion && a[0] === ACT_SWAP_EXACT_OUT)) refuse()
    this.cur().kind = a[0] === ACT_SWAP_EXACT_OUT ? K_V4_OUT : K_V4_IN
    if (portion) this.addStep().kind = K_V4_FEE
    this.state = S.V4_PARAMS_LEN
    this.nextInInput(this.v4.heads) // the params offset, for now
  }

  /** SETTLE (currency, amount, payerIsUser), TAKE (currency, recipient,
   * amount), TAKE_PORTION (currency, recipient, bips). */
  v4Arg() {
    const st = this.cur()
    const a = this.v4.acts[this.v4.act]
    const fee = a === ACT_TAKE_PORTION ? this.steps[this.pstep + 1] : undefined
    const w = this.word
    if (this.field === 0 || (this.field === 1 && a !== ACT_SETTLE)) {
      if (narrow(w, 20) === null) refuse()
    }
    switch (this.field) {
      case 0:
        (a === ACT_SETTLE ? this.v4.settleCur : a === ACT_TAKE ? this.v4.takeCur : fee!.tokenIn).set(w.subarray(12))
        break
      case 1:
        if (a === ACT_TAKE) st.recipient.set(w.subarray(12))
        else if (a === ACT_TAKE_PORTION) fee!.recipient.set(w.subarray(12))
        else if (!this.v4.swapDone) {
          // SETTLE first pays what the swap then spends: OPEN_DELTA here pays nothing.
          if (isZero(w)) refuse()
          st.amount.set(w)
        } else if (!isZero(w)) refuse() // after the swap only OPEN_DELTA
        break
      default:
        if (a === ACT_SETTLE) {
          const v = narrow(w, 1)
          if (v === null || v > 1n) refuse()
          st.payerIsUser = v === 1n
          // The user paying the router's own balance: refused.
          if (!this.v4.swapDone && st.payerIsUser && isBalanceWord(st.amount)) refuse()
        } else if (a === ACT_TAKE_PORTION) {
          fee!.amount.set(w)
        } else if (!isZero(w) && (st.kind !== K_V4_OUT || !same(w, st.amount))) {
          // TAKE: the whole credit, or exactly an exact-output swap's amount.
          refuse()
        }
    }
    if (++this.field < 3) return this.nextInParam(32 * this.field)
    this.v4ParamDone()
  }

  /** Exact{In,Out}putParams: (currency, PathKey[] path, uint256[]
   * minHopPriceX36, uint128 amount, uint128 limit). */
  v4SwapHead() {
    const st = this.cur()
    const exactIn = st.kind === K_V4_IN
    const w = this.word
    switch (this.field) {
      case 0:
        if (narrow(w, 20) === null) refuse()
        ;(exactIn ? st.tokenIn : st.tokenOut).set(w.subarray(12))
        break
      case 1:
        this.v4.path = this.u32() // relative to the struct, for now
        break
      case 2:
        this.u32()
        break
      case 3:
        if (narrow(w, 16) === null) refuse()
        if (exactIn && this.v4.acts[0] === ACT_SETTLE) {
          if (!isZero(w)) refuse() // spends what SETTLE paid in: OPEN_DELTA
        } else {
          if (isZero(w)) refuse()
          st.amount.set(w)
        }
        break
      default:
        if (narrow(w, 16) === null) refuse()
        st.limit.set(w)
        this.state = S.V4_PATH_LEN
        return this.nextInParam(this.v4.sw + this.v4.path)
    }
    this.field++
    this.nextInParam(this.v4.sw + 32 * this.field)
  }

  v4PathkeyStart() {
    const at = this.v4.path + this.v4.pk[this.k]
    if (at < this.v4.base) refuse()
    this.v4.pkb = (at - this.v4.base) >>> 0 // uint32_t, as the firmware stores it
    this.field = 0
    this.state = S.V4_PK
    this.nextInParam(this.v4.pkb)
  }

  addHook(h: Uint8Array) {
    if (this.hooks.some((x) => same(x, h))) return
    if (this.hooks.length >= UR_MAX_HOOKS) refuse()
    this.hooks.push(h.slice())
  }

  /** PathKey (intermediateCurrency, uint24 fee, int24 tickSpacing, hooks, bytes hookData). */
  v4Pathkey() {
    const st = this.cur()
    const w = this.word
    switch (this.field) {
      case 0:
        if (narrow(w, 20) === null) refuse()
        if (st.kind === K_V4_IN) st.tokenOut.set(w.subarray(12))
        else if (this.k === 0) st.tokenIn.set(w.subarray(12))
        break
      case 1:
        if (narrow(w, 3) === null) refuse()
        break
      case 2:
        if (!narrowInt24(w)) refuse()
        break
      case 3:
        if (narrow(w, 20) === null) refuse()
        if (!isZero(w.subarray(12))) this.addHook(w.subarray(12))
        break
      default: {
        const v = this.u32()
        this.state = S.V4_PK_HOOKDATA
        return this.nextInParam(this.v4.pkb + v)
      }
    }
    this.field++
    this.nextInParam(this.v4.pkb + 32 * this.field)
  }

  v4Word() {
    switch (this.state) {
      case S.V4_HEAD:
        if (this.field === 0) this.n = this.u32()
        else this.v4.heads = this.u32()
        if (++this.field < 2) return this.nextInInput(32)
        this.state = S.V4_ACTS_LEN
        return this.nextInInput(this.n)
      case S.V4_ACTS_LEN: {
        const v = this.u32()
        if (v < 3 || v > 4) refuse()
        this.v4.nacts = v
        this.k = 0
        this.state = S.V4_ACTS
        return this.nextAt(this.pos)
      }
      case S.V4_PARAMS_LEN:
        if (this.u32() !== this.v4.nacts) refuse()
        this.v4.heads = this.pos
        this.k = 0
        this.state = S.V4_PARAM_HEAD
        return this.nextAt(this.pos)
      case S.V4_PARAM_HEAD:
        this.v4.elem[this.k] = this.u32()
        if (++this.k < this.v4.nacts) return this.nextAt(this.pos)
        this.v4.act = 0
        return this.v4ParamStart()
      case S.V4_PARAM_LEN:
        this.v4.len = this.u32()
        if (this.v4.len > this.base + this.len - this.pos) refuse()
        this.v4.base = this.pos
        this.field = 0
        this.state = isV4SwapAction(this.v4.acts[this.v4.act]) ? S.V4_SW_OFF : S.V4_ARGS
        return this.nextInParam(0)
      case S.V4_ARGS:
        return this.v4Arg()
      case S.V4_SW_OFF:
        this.v4.sw = this.u32()
        this.state = S.V4_SW_HEAD
        return this.nextInParam(this.v4.sw)
      case S.V4_SW_HEAD:
        return this.v4SwapHead()
      case S.V4_PATH_LEN: {
        const v = this.u32()
        if (v === 0 || v > UR_V4_MAX_PATH) refuse()
        this.v4.npath = v
        this.v4.path = this.pos
        this.k = 0
        this.state = S.V4_PATH_HEAD
        return this.nextAt(this.pos)
      }
      case S.V4_PATH_HEAD:
        this.v4.pk[this.k] = this.u32()
        if (++this.k < this.v4.npath) return this.nextAt(this.pos)
        this.k = 0
        return this.v4PathkeyStart()
      case S.V4_PK:
        return this.v4Pathkey()
      case S.V4_PK_HOOKDATA:
        // hookData is opaque input to a third-party contract: none is accepted.
        if (!isZero(this.word)) refuse()
        if (++this.k < this.v4.npath) return this.v4PathkeyStart()
        this.v4.swapDone = true
        return this.v4ParamDone()
      default:
        refuse()
    }
  }

  onByte(b: number) {
    if (this.state === S.CMDS) {
      if ((b & CMD_FLAGS) !== 0 || !COMMANDS[b]) refuse()
      this.cmds[this.k++] = b
      if (this.k < this.ncmds) return this.nextAt(this.pos)
      this.state = S.INPUTS_LEN
      return this.nextAt(4 + this.heads)
    }
    if (this.state === S.V4_ACTS) return this.v4ActionByte(b)
    this.v3PathByte(b)
  }

  onWord() {
    switch (this.state) {
      case S.SELECTOR: {
        const sel = '0x' + Buffer.from(this.word.subarray(0, 4)).toString('hex')
        if (sel === UR_EXECUTE) this.hasDeadline = true
        else if (sel !== UR_EXECUTE_NO_DEADLINE) refuse()
        this.state = S.HEAD
        return this.nextAt(this.pos)
      }
      case S.HEAD:
        // commands offset, inputs offset[, deadline]: relative to the body.
        if (this.field === 2) {
          const v = narrow(this.word, 8)
          if (v === null) refuse()
          this.deadline = v!
        } else if (this.field === 0) this.base = this.u32()
        else this.heads = this.u32()
        if (++this.field < (this.hasDeadline ? 3 : 2)) return this.nextAt(this.pos)
        this.state = S.CMDS_LEN
        return this.nextAt(4 + this.base)
      case S.CMDS_LEN: {
        const v = this.u32()
        if (v === 0 || v > UR_MAX_STEPS) refuse()
        this.ncmds = v
        this.k = 0
        this.state = S.CMDS
        return this.nextAt(this.pos)
      }
      case S.INPUTS_LEN:
        if (this.u32() !== this.ncmds) refuse()
        this.heads = this.pos // element heads are relative to the first one
        this.k = 0
        this.state = S.INPUT_HEAD
        return this.nextAt(this.pos)
      case S.INPUT_HEAD:
        this.elem[this.k] = this.u32()
        if (++this.k < this.ncmds) return this.nextAt(this.pos)
        this.step = 0
        return this.nextInput()
      case S.ELEM_LEN: {
        this.len = this.u32()
        if (this.len > this.total - this.pos) refuse()
        this.base = this.pos
        this.pstep = this.steps.length
        this.addStep().kind = this.current().kind
        this.field = 0
        this.state = S.FIELD
        if (this.cmds[this.step] === CMD_V4_SWAP) {
          this.v4 = this.freshV4()
          this.state = S.V4_HEAD
        }
        return this.nextInInput(0)
      }
      case S.FIELD:
        return this.headField()
      case S.DYN_LEN:
        return this.dynLen()
      case S.V2_PATH:
        return this.v2PathWord()
      default:
        return this.v4Word()
    }
  }

  feed(data: Uint8Array) {
    for (let i = 0; i < data.length; i++) {
      const off = this.pos++
      if (off < this.at || this.state === S.DONE) continue // not read
      if (this.state === S.CMDS || this.state === S.V3_PATH || this.state === S.V4_ACTS) {
        this.onByte(data[i])
        continue
      }
      this.word[this.got++] = data[i]
      if (this.got === (this.state === S.SELECTOR ? 4 : 32)) {
        this.got = 0
        this.onWord()
      }
    }
  }
}

const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex')
const big = (b: Uint8Array) => BigInt(hex(b))

/** ur_decode: every command fully understood, or null (never a partial plan). */
export function urDecode(calldata: Uint8Array): UrPlan | null {
  if (calldata.length > 0xffffffff) return null
  const s = new UrStream(calldata.length)
  try {
    s.feed(calldata)
    if (s.state !== S.DONE || s.pos !== s.total) return null
  } catch (e) {
    if (e instanceof Refused) return null
    throw e
  }
  return {
    steps: s.steps.map((t) => ({
      kind: UR_KINDS[t.kind], tokenIn: hex(t.tokenIn), tokenOut: hex(t.tokenOut), recipient: hex(t.recipient),
      amount: big(t.amount), limit: big(t.limit), expiration: t.expiration, payerIsUser: t.payerIsUser,
    })),
    ...(s.hasDeadline ? { deadline: s.deadline } : {}),
    hooks: s.hooks.map(hex),
  }
}

const ZERO = '0x' + '0'.repeat(40)
const U256 = 1n << 256n
const CONTRACT_BALANCE = 1n << 255n
const constant = (which: number) => '0x' + which.toString(16).padStart(40, '0')
const MSG_SENDER = constant(1)
const ADDRESS_THIS = constant(2)
const SWAP_KINDS: ReadonlySet<UrKind> = new Set(['V3_SWAP_EXACT_IN', 'V3_SWAP_EXACT_OUT', 'V2_SWAP_EXACT_IN', 'V2_SWAP_EXACT_OUT', 'V4_SWAP_EXACT_IN', 'V4_SWAP_EXACT_OUT'])
const isSwap = (k: UrKind) => SWAP_KINDS.has(k)
const isExactIn = (k: UrKind) => k === 'V3_SWAP_EXACT_IN' || k === 'V2_SWAP_EXACT_IN' || k === 'V4_SWAP_EXACT_IN'
const isV4 = (k: UrKind) => k === 'V4_SWAP_EXACT_IN' || k === 'V4_SWAP_EXACT_OUT'
/** A bips word: 1..10000. */
const feeBips = (a: bigint) => (a >= 1n && a <= 10_000n ? Number(a) : undefined)

/**
 * ur_summarize: the plan read as token flow through the router, accepted only
 * if it says one thing. The user pays with one asset (msg.value, or one token
 * the payerIsUser swaps pull, after an optional Permit2 permit naming this
 * router); one asset reaches one recipient (from swaps, or by SWEEP /
 * UNWRAP_WETH of what the router holds; leftover ETH may go back to the same
 * recipient). Router-paid swaps (splits, multi-hop through V2/V3/V4 pools) are
 * free to the user. amountIn is the sum the user pays, amountOut the sum of the
 * minimums every delivery enforces; all swaps exact-in or all exact-out; at
 * most one fee. `router` is the called contract, `value` msg.value.
 */
export function urSummarize(plan: UrPlan, router: string, value: bigint): UrSummary | null {
  const steps = plan.steps
  if (steps.length === 0 || steps.length > UR_MAX_STEPS || value < 0n || value >= U256) return null
  const r = router.toLowerCase()
  // The router itself, by placeholder or by its own address: either way it
  // holds the funds for a later step. Apps encode both.
  const isRouter = (x: string) => x === ADDRESS_THIS || x === r
  const v4Router = (UR_V4_ROUTERS as readonly string[]).includes(r)
  const eth = value !== 0n
  let permit: UrStep | undefined
  let firstSwap: UrStep | undefined
  let lastSwap: UrStep | undefined
  let recipient: string | undefined
  let payerToken: string | undefined
  // The asset delivered to someone other than the router: ETH or a token.
  let z: { eth: boolean; token: string } | undefined
  const sameAsset = (isEth: boolean, token: string) => {
    if (!z) { z = { eth: isEth, token: isEth ? ZERO : token }; return true }
    return z.eth === isEth && (isEth || z.token === token)
  }
  const sameRecipient = (to: string) => {
    if (isRouter(to)) return false
    recipient ??= to
    return recipient === to
  }
  let exactIn = true
  let usesEth = false
  let spent = 0n

  // Pass 1: what is paid, by whom, and what each swap delivers where.
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    switch (s.kind) {
      case 'PERMIT2_PERMIT':
        if (i !== 0) return null
        permit = s
        break
      case 'WRAP_ETH':
        // Wraps msg.value (or, with none, what the router holds).
        if (!isRouter(s.recipient) || !(s.amount === CONTRACT_BALANCE || (eth && s.amount === value))) return null
        usesEth ||= eth
        break
      case 'UNWRAP_WETH': case 'SWEEP': case 'PAY_PORTION': case 'V4_TAKE_PORTION':
        break // pass 2
      default: {
        if (!isSwap(s.kind)) return null // TRANSFER
        if (!firstSwap) {
          firstSwap = s
          exactIn = isExactIn(s.kind)
        } else if (exactIn !== isExactIn(s.kind)) return null
        lastSwap = s
        const v4 = isV4(s.kind)
        if (v4 && !v4Router) return null
        // Only a V4 swap moves native ETH.
        if (!v4 && (s.tokenIn === ZERO || s.tokenOut === ZERO)) return null
        if (s.payerIsUser) {
          // The user's token, pulled through Permit2: one token only, and
          // never "the router's balance" taken from the user.
          if (eth || s.amount === CONTRACT_BALANCE || (payerToken && payerToken !== s.tokenIn)) return null
          payerToken = s.tokenIn
          spent += exactIn ? s.amount : s.limit
          if (spent >= U256) return null
        } else if (v4 && s.tokenIn === ZERO) {
          usesEth ||= eth
        }
        if (!isRouter(s.recipient) && (!sameRecipient(s.recipient) || !sameAsset(v4 && s.tokenOut === ZERO, s.tokenOut))) return null
      }
    }
  }
  if (!firstSwap || !lastSwap) return null

  const out: UrSummary = {
    exactIn, inIsEth: false, outIsEth: false, tokenIn: ZERO, tokenOut: ZERO, amountIn: 0n, amountOut: 0n,
    recipientIsSender: false, recipient: ZERO, hooks: [...plan.hooks],
  }
  // Input side.
  if (eth) {
    // msg.value must be put to use: wrapped, or settled into a V4 pool.
    if (!usesEth || permit) return null
    if (!exactIn) {
      // Exact output may not be allowed to spend more than was sent.
      let limits = 0n
      for (const s of steps) {
        if (!isSwap(s.kind)) continue
        limits += s.limit
        if (limits >= U256) return null
      }
      if (limits > value) return null
    }
    out.inIsEth = true
    out.tokenIn = firstSwap.tokenIn
    out.amountIn = value
  } else {
    if (!payerToken) return null
    out.tokenIn = payerToken
    out.amountIn = spent
  }
  if (permit) {
    if (permit.tokenOut /* spender */ !== r || permit.tokenIn !== payerToken) return null
    out.permit = { token: permit.tokenIn, amount: permit.amount, expiration: permit.expiration }
  }

  // Pass 2: the asset delivered from the router, the recipient, the fee.
  for (const s of steps) {
    if (z) break
    if (s.kind === 'SWEEP') sameAsset(s.tokenIn === ZERO, s.tokenIn)
    else if (s.kind === 'UNWRAP_WETH' && !isRouter(s.recipient)) sameAsset(true, ZERO)
  }
  if (!z) return null // nothing reaches anyone
  const asset = z as { eth: boolean; token: string }
  let direct = 0n, swept = 0n, held = 0n
  let consumed = false
  let fromRouterStep = false
  let feeIndex = -1
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    switch (s.kind) {
      case 'SWEEP':
      case 'UNWRAP_WETH': {
        const isEth = s.kind === 'UNWRAP_WETH' || s.tokenIn === ZERO
        if (s.kind === 'UNWRAP_WETH' && isRouter(s.recipient)) {
          consumed ||= !asset.eth // WETH -> ETH inside the route
          break
        }
        if (!sameRecipient(s.recipient)) return null
        if (asset.eth !== isEth || (!isEth && asset.token !== s.tokenIn)) {
          // Only leftover ETH may go back besides the asset (clean-up).
          if (!isEth) return null
          break
        }
        if (s.amount === CONTRACT_BALANCE) return null
        swept += s.amount
        if (swept >= U256) return null
        fromRouterStep = true
        break
      }
      case 'PAY_PORTION':
      case 'V4_TAKE_PORTION': {
        const bips = feeBips(s.amount)
        if (feeIndex >= 0 || bips === undefined || isRouter(s.recipient)) return null
        feeIndex = i
        out.fee = { bips, recipient: s.recipient }
        break
      }
      default: {
        if (!isSwap(s.kind)) break
        let g = exactIn ? s.limit : s.amount
        if (!isRouter(s.recipient)) {
          const next = steps[i + 1]
          if (next?.kind === 'V4_TAKE_PORTION') {
            // The fee comes out of this swap's credit before TAKE.
            const bips = feeBips(next.amount)
            if (!exactIn || bips === undefined || s.limit * BigInt(bips) >= U256) return null
            g = s.limit - (s.limit * BigInt(bips)) / 10_000n
          }
          direct += g
          if (direct >= U256) return null
        } else if (!asset.eth && s.tokenOut === asset.token) {
          held += g
          if (held >= U256) return null
        }
        if (!s.payerIsUser && !asset.eth && s.tokenIn === asset.token) consumed = true // the router spends the asset again
      }
    }
  }
  if (!recipient) return null
  const fee = feeIndex >= 0 ? steps[feeIndex] : undefined
  if (fee) {
    // PAY_PORTION takes from what the router holds for the user (the token,
    // or WETH/ETH before an unwrap); TAKE_PORTION from its own swap's output,
    // which must deliver to the user.
    if (fee.kind === 'PAY_PORTION') {
      let heldFee = !asset.eth ? fee.tokenIn === asset.token : fee.tokenIn === ZERO
      for (let i = 0; i < steps.length && !heldFee && asset.eth; i++) {
        const s = steps[i]
        heldFee = isSwap(s.kind) && isRouter(s.recipient) && s.tokenOut === fee.tokenIn
      }
      if (!heldFee || !fromRouterStep) return null
    } else {
      if (feeIndex === 0) return null
      const swap = steps[feeIndex - 1]
      if (swap.kind !== 'V4_SWAP_EXACT_IN' || isRouter(swap.recipient)) return null
    }
  }
  // What the router holds for the user: its SWEEP / UNWRAP minimums, or, with
  // no fee taken from it and nothing spending it again, the larger of those
  // and the minimums of the swaps that filled it.
  let fromRouter = swept
  if ((!fee || fee.kind !== 'PAY_PORTION') && !consumed && !asset.eth && held > swept) fromRouter = held
  direct += fromRouter
  if (direct >= U256) return null

  out.outIsEth = asset.eth
  out.tokenOut = asset.eth ? lastSwap.tokenOut : asset.token
  out.amountOut = direct
  out.recipientIsSender = recipient === MSG_SENDER
  out.recipient = recipient
  return out
}

/**
 * Every token the device review names, so the certified entry must identify
 * each (signed_metadata.c decoder_matches): the paid token unless ETH, the
 * delivered token unless ETH, and the Permit2 token. Never native ETH, never
 * an intermediate token of a multi-hop route.
 */
export function urTokenSet(s: UrSummary): string[] {
  const set = new Set<string>()
  if (!s.inIsEth) set.add(s.tokenIn)
  if (!s.outIsEth) set.add(s.tokenOut)
  if (s.permit) set.add(s.permit.token)
  return [...set]
}

/** Decode + summarize a call to `router`, or null when the device would not. */
export function urPrecheck(router: string, data: string, value: bigint):
  { selector: string; plan: UrPlan; summary: UrSummary; tokens: string[] } | null {
  const hex = String(data || '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null
  if (value < 0n || value >= U256) return null
  const plan = urDecode(Buffer.from(hex, 'hex'))
  const summary = plan && urSummarize(plan, router, value)
  if (!plan || !summary) return null
  return { selector: `0x${hex.slice(0, 8).toLowerCase()}`, plan, summary, tokens: urTokenSet(summary) }
}
