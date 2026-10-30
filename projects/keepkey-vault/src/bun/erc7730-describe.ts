/**
 * What a KeepKey ClearSign ERC-7730 definition makes the KeepKey show, read on
 * this computer from the exact envelope Desktop sends: the intent and every
 * field's label and value, formatted the way 7.16 formats them
 * (erc7730_field.c, erc7730_format.c; lines split as on the device), only
 * when this computer checked the envelope's signature up to KeepKey's
 * production root.
 *
 * Display only, with one exception: on 7.17 planErc7730EmbeddedCalls reads
 * the same way which inner definitions the device will ask for, so a
 * definition the device would refuse is not attached. An envelope this cannot
 * read gets no description, never a guessed one.
 *
 * 7.17 (erc7730_field.c, fsm_msg_ethereum.h): an embedded call is the
 * device's context line (callee, function, data length, value, authority)
 * followed by the inner definition's own intent and fields; a RECIPIENT
 * address reads "(this wallet)" or "NOT this wallet"; a TX_VALUE amount that
 * is not the call's value is refused.
 *
 * Formats: python-keepkey keepkeylib/erc7730_compiler.py (C773 program) and
 * keepkey-firmware erc7730_catalog.c (K773 envelope, Merkle proof, signature).
 */
import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1'
import { inspectAlphaCertificate, PRODUCTION_ROOT_PUBLIC_KEY } from './clearsign-alpha-ceremony'
import { REVIEWED_EVM_TOKENS } from '../shared/reviewed-evm-tokens'
import firmwareTokens from './firmware-token-table-716.json'
import { evmTokenIdentity } from '../shared/evm-contract-identity'
import { CHAINS } from '../shared/chains'
import type { Erc7730Description } from '../shared/types'

/**
 * Desktop's own names for contracts the ClearSign service describes. The
 * service and the signed definition carry no name or site, so these are ours:
 * site and owner from the Ethereum Foundation ERC-7730 registry (aave
 * calldata-lpv3.json, lido calldata-stETH.json: metadata.owner, info.url),
 * addresses from the same files' deployments. Keyed by chain:contract, which
 * the definition's signed header names.
 */
const AAVE_V3 = {
  name: 'Aave V3',
  url: 'https://aave.com',
  about: {
    // supply, deposit
    '0x617ba037': 'Deposits the token into Aave, where it earns interest. The collateral recipient gets aTokens for it, which are redeemed with a withdraw.',
    '0xe8eda9df': 'Deposits the token into Aave, where it earns interest. The collateral recipient gets aTokens for it, which are redeemed with a withdraw.',
    '0x69328dec': 'Takes a supplied token back out of Aave.', // withdraw
    '0xa415bcad': 'Borrows the token from Aave against supplied collateral. The loan accrues interest until it is repaid.', // borrow
    '0x573ade81': 'Pays back an Aave loan.', // repay
  } as Record<string, string>,
}
const LIDO = {
  name: 'Lido',
  url: 'https://lido.fi',
  about: { '0xa1903eab': 'Stakes ETH with Lido. You get stETH, whose balance grows with staking rewards.' } as Record<string, string>,
}
const PROTOCOLS: Record<string, typeof AAVE_V3> = {
  '1:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': AAVE_V3,
  '8453:0xa238dd80c259a72e81d7e4664a9801593f98d1c5': AAVE_V3,
  ...Object.fromEntries([10, 137, 42161, 43114].map((c) => [`${c}:0x794a61358d6845594f94dc1db02a252b5b4814ad`, AAVE_V3])),
  '1:0xae7ab96520de3a18e5e111b5eaab095312d7fe84': LIDO,
}

const ABSENT = 0xffff
const CATALOG_PURPOSE = new TextEncoder().encode('KEEPKEY:ERC7730:CATALOG\0')
const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256')
  for (const part of parts) h.update(part)
  return Uint8Array.from(h.digest())
}
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`
/** format_escaped: a byte outside 0x21..0x7e as \xNN, a backslash doubled; a
 *  label (`spaces`) keeps a lone space between two other characters. */
const escaped = (text: string, spaces = true) => {
  const bytes = new TextEncoder().encode(text)
  return Array.from(bytes, (b, i) => b === 0x5c ? '\\\\'
    : (b <= 0x20 && !(spaces && b === 0x20 && i > 0 && i < bytes.length - 1 && bytes[i - 1] !== 0x20 && bytes[i + 1] !== 0x20)) || b >= 0x7f
      ? `\\x${b.toString(16).padStart(2, '0')}` : String.fromCharCode(b)).join('')
}
/** The 7.16 token table (tokenByChainAddress): what the device names a token. */
const DEVICE_TOKENS: Record<string, Array<string | number>> = {
  ...firmwareTokens.symbols, // [ticker, decimals]
  [`1:0x${'e'.repeat(40)}`]: ['ETH', 18], // the Ethereum-mainnet sentinel
}

/** ethereumFormatAmount's native tickers (ethereum.c); any other chain shows Wei. */
const NATIVE_TICKERS: Record<number, string> = {
  1: 'ETH', 2: 'EXP', 8: 'UBQ', 10: 'ETH', 20: 'EOSC', 28: 'ETSC', 30: 'RBTC', 40: 'TLOS', 56: 'BNB', 61: 'ETC',
  64: 'ELLA', 100: 'xDAI', 137: 'POL', 8453: 'ETH', 42161: 'ETH', 43114: 'AVAX',
}
/** A native amount as the device prints it (ethereumFormatNativeAmount): under 1 gwei, or on a chain it has no ticker for, in Wei. */
function deviceNative(v: bigint, chainId: number): string {
  const ticker = NATIVE_TICKERS[chainId]
  if (v < 1_000_000_000n || !ticker) return `${v} Wei`
  const fraction = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return `${v / 10n ** 18n}${fraction ? `.${fraction}` : ''} ${ticker}`
}

/** The certificate alias, when the envelope's catalog signature verifies the
 *  way 7.16 verifies it (clearsign_root_verify_erc7730_catalog): a production
 *  root certificate for this chain, and the delegate's signature over the
 *  Merkle root the program and its proof lead to. */
function catalogSigner(program: Uint8Array, proof: Uint8Array[], cert: Uint8Array, sig: Uint8Array, chainId: bigint, root?: string): string | undefined {
  try {
    const c = inspectAlphaCertificate(hex(cert).slice(2), undefined, root)
    if (BigInt(c.chainId) !== chainId) return undefined
    let node = sha256(Uint8Array.of(0), program)
    for (const sibling of proof) {
      const [a, b] = hex(node) <= hex(sibling) ? [node, sibling] : [sibling, node]
      node = sha256(Uint8Array.of(1), a, b)
    }
    return secp256k1.verify(sig, sha256(CATALOG_PURPOSE, node), Uint8Array.from(Buffer.from(c.delegatePublicKey, 'hex')), { lowS: false }) ? c.alias : undefined
  } catch {
    return undefined
  }
}

interface Leaf { kind: number; value: bigint | string | boolean }

/** The device refuses this call with this definition (the reason is its own
 *  failure text); Desktop can see that before it is sent. */
export class Erc7730Refusal extends Error {}

/** 7.17 formatter flags (erc7730_capabilities.h). */
const FLAG_RECIPIENT = 1
const FLAG_TX_VALUE = 2
/** ERC7730_EMBED_MAX_DEPTH: an embedded call is followed from levels 0 and 1. */
const EMBED_MAX_DEPTH = 2
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
/** Safe setup(): `to` (word 2) is delegatecalled when nonzero. */
const SAFE_SETUP = '0xb63e800d'
/** Safe execTransaction and its relatives (erc7730_workflow.c safe_exec_selector): operation is word 3. */
const SAFE_EXEC = new Set(['0x6a761202', '0x468721a7', '0x5229073f', '0x6928e74b', '0xc6fe8747', '0xb0c19912', '0x2b99e506'])
/** An inner approve() gets the device's own allowance screens, which the card does not show. */
const INNER_APPROVALS = new Set(['0x095ea7b3', '0x39509351'])

/** One call the device reviews: the transaction (depth 0) or an embedded call. */
interface Level {
  chainId: number
  /** The definition's contract (@.to). */
  to: string
  /** The calldata; '' for typed data. */
  data: string
  /** @.value */
  value: bigint
  /** Typed data (depth 0 only): the message in the program's node order, read in place of calldata. */
  typed?: any[]
  /** @.from: the signer at depth 0 (undefined when not matched), else whose authority the call runs with. */
  from?: string
  /** The device's signing address, for "(this wallet)"; undefined when not matched. */
  signer?: string
  depth: number
}

interface Walk {
  /** Check each envelope's signature up to this root (undefined: no check, the plan). */
  root?: string
  /** An embedded call's definition envelope (hex), by callee and selector. */
  inner: (callee: string, selector: string) => string | undefined
  /** Plan only: embedded calls with no definition yet; their screens are not read. */
  missing?: Array<{ contractAddress: string; selector: string }>
}

type Field = Erc7730Description['fields'][number]

/** A Safe setup() or execTransaction that delegatecalls, read from the level's calldata as the device reads it. */
function safeDelegatecall(data: string): boolean {
  const selector = data.slice(0, 10).toLowerCase()
  const word = selector === SAFE_SETUP ? 2 : SAFE_EXEC.has(selector) ? 3 : -1
  return word >= 0 && /[1-9a-f]/i.test(data.slice(10 + 64 * word, 10 + 64 * (word + 1)))
}

/** The intent, interpolated summary and fields of one level, as the device shows them. Throws when it cannot say. */
function readLevel(envelopeHex: string, call: Level, walk: Walk): { signedBy: string; intent: string; parts: string[]; fields: Field[] } {
  const envelope = Uint8Array.from(Buffer.from(envelopeHex.replace(/^0x/i, ''), 'hex'))
  const program = envelope.subarray(10, 10 + u32(envelope, 6))
  let at = 10 + program.length
  const proof = Array.from({ length: envelope[at] }, (_, i) => envelope.subarray(at + 1 + 32 * i, at + 33 + 32 * i))
  at += 1 + 32 * proof.length
  const cert = envelope.subarray(at + 2, at + 2 + u16(envelope, at))
  const sig = envelope.subarray(at + 2 + cert.length, at + 66 + cert.length)
  const chainId = BigInt(hex(program.subarray(10, 18)))
  const signedBy = walk.root === undefined ? '' : catalogSigner(program, proof, cert, sig, chainId, walk.root)
  if (signedBy === undefined || chainId !== BigInt(call.chainId)) throw new Error('not signed for this chain')
  // An embedded call's definition names its callee and selector (H8).
  if (call.depth > 0 && (hex(program.subarray(18, 38)) !== call.to.toLowerCase()
    || hex(program.subarray(38, 42)) !== call.data.slice(0, 10).toLowerCase())) throw new Erc7730Refusal('ERC-7730 inner definition does not match')

  // Sections: u8 type | be32 length | body.
  const section: Record<number, Uint8Array> = {}
  for (let i = 0, p = 179; i < program[178]; i++) {
    section[program[p]] = program.subarray(p + 5, p + 5 + u32(program, p + 1))
    p += 5 + u32(program, p + 1)
  }
  const s = section[1]
  const strings: string[] = []
  for (let i = 0, p = 2; i < u16(s, 0); i++) { strings.push(escaped(new TextDecoder().decode(s.subarray(p + 2, p + 2 + u16(s, p))))); p += 2 + u16(s, p) }
  const n = section[2]
  const nodes = Array.from({ length: u16(n, 0) }, (_, i) => ({ kind: n[2 + 9 * i], size: u16(n, 3 + 9 * i), first: u16(n, 5 + 9 * i), count: u16(n, 7 + 9 * i), length: u16(n, 9 + 9 * i) }))
  const pt = section[3]
  const paths: Array<{ source: number; index: number; steps: number[] }> = []
  for (let i = 0, p = 2; i < u16(pt, 0); i++) {
    const steps: number[] = []
    let q = p + 4
    for (let k = 0; k < pt[p + 1]; k++) {
      if (pt[q] === 1) { steps.push(u32(pt, q + 1) | 0); q += 5 } else if (pt[q] === 2) { steps.push(-1); q += 1 } else throw new Error('slice') // slices: 7.16 never runs them
    }
    paths.push({ source: pt[p], index: u16(pt, p + 2), steps })
    p = q
  }
  const lt = section[4] ?? Uint8Array.of(0, 0)
  const literals: Array<{ kind: number; bytes: Uint8Array }> = []
  for (let i = 0, p = 2; i < u16(lt, 0); i++) { literals.push({ kind: lt[p], bytes: lt.subarray(p + 3, p + 3 + u16(lt, p + 1)) }); p += 3 + u16(lt, p + 1) }
  const ft = section[6]
  const formatters: Array<{ kind: number; flags: number; args: Map<number, { source: number; index: number }> }> = []
  for (let i = 0, p = 2; i < u16(ft, 0); i++) {
    const args = new Map<number, { source: number; index: number }>()
    for (let k = 0; k < ft[p + 2]; k++) args.set(ft[p + 3 + 4 * k], { source: ft[p + 4 + 4 * k], index: u16(ft, p + 5 + 4 * k) })
    formatters.push({ kind: ft[p], flags: ft[p + 1], args })
    p += 3 + 4 * ft[p + 2]
  }
  // Calldata definitions only (erc7730_catalog.c): the device refuses a typed-data definition with either.
  if (call.typed && formatters.some((f) => f.kind === 13 || f.flags & FLAG_TX_VALUE)) throw new Error('a calldata-only formatter in typed data')
  const dt = section[7]
  const display = Array.from({ length: u16(dt, 0) }, (_, i) => ({ op: dt[2 + 8 * i], a: u16(dt, 4 + 8 * i), b: u16(dt, 6 + 8 * i) }))

  // The calldata, decoded with the ABI the program carries.
  const type = (i: number): string => {
    const { kind, size, first, count, length } = nodes[i]
    return [, `uint${size}`, `int${size}`, 'address', 'bool', `bytes${size}`, 'bytes', 'string'][kind]
      ?? (kind === 8 ? `(${Array.from({ length: count }, (_, k) => type(first + k)).join(',')})`
        : kind === 9 ? `${type(first)}[${length === ABSENT ? '' : length}]` : '?')
  }
  const root = nodes[0]
  const args = call.typed ?? ethersUtils.defaultAbiCoder.decode(
    Array.from({ length: root.count }, (_, k) => type(root.first + k)), `0x${call.data.slice(10)}`)

  const leaf = (kind: number, v: any): Leaf => ({
    kind,
    value: kind === 1 || kind === 2 ? BigInt(v.toString()) : kind === 3 ? String(v).toLowerCase() : v,
  })
  const literal = (i: number): Leaf => {
    const { kind, bytes } = literals[i]
    if (kind === 1 || kind === 7) return { kind: 1, value: BigInt(bytes.length ? hex(bytes) : 0) }
    if (kind === 5) return { kind: 3, value: hex(bytes) }
    if (kind === 6) return { kind: 4, value: bytes[0] === 1 }
    if (kind === 4) return { kind: 7, value: strings[u16(bytes, 0)] }
    return { kind: 6, value: hex(bytes) }
  }
  /** Every value a path names: one, or one per array element ("[]"). */
  const resolve = (i: number): Leaf[] => {
    const path = paths[i]
    if (path.source === 3) return [literal(path.index)]
    if (path.source === 2) {
      if (call.typed) {
        if (path.index !== 2) throw new Error('typed data has only @.to')
        return [{ kind: 3, value: call.to.toLowerCase() }]
      }
      if (path.index === 3) return [{ kind: 1, value: call.value }]
      if (path.index === 1 && !call.from) throw new Error('signer not matched')
      return [{ kind: 3, value: String(path.index === 1 ? call.from : call.to).toLowerCase() }]
    }
    let at: Array<{ node: number; value: any }> = [{ node: 0, value: args }]
    for (const step of path.steps) {
      at = at.flatMap(({ node, value }) => {
        const { kind, first } = nodes[node]
        if (step === -1) return [...value].map((v) => ({ node: first, value: v }))
        return [{ node: kind === 8 ? first + step : first, value: value[step] }]
      })
    }
    return at.map(({ node, value }) => leaf(nodes[node].kind, value))
  }
  const argument = (f: { args: Map<number, { source: number; index: number }> }, role: number) => {
    const a = f.args.get(role)
    return a === undefined ? undefined : a.source === 1 ? resolve(a.index) : a.source === 2 ? [literal(a.index)] : [{ kind: 7, value: strings[a.index] }]
  }

  const signer = call.signer?.toLowerCase()
  const raw = ({ kind, value }: Leaf) => kind === 3 ? ethersUtils.getAddress(value as string)
    : kind === 7 ? escaped(value as string, false) : String(value)
  const scaled = (v: bigint, decimals: number) => {
    const base = 10n ** BigInt(decimals)
    const fraction = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
    return `${v / base}${fraction ? `.${fraction}` : ''}`
  }
  const nativeOf = (v: bigint) => deviceNative(v, call.chainId)
  const format = (index: number): { value: string; note?: string } => {
    const f = formatters[index]
    if (f.kind === 13) throw new Error('an embedded call is a field of its own')
    const values = resolve(f.args.get(1)!.index)
    let note: string | undefined
    const value = values.map((v, i) => {
      const pick = (role: number) => { const list = argument(f, role); return list?.[list.length === 1 ? 0 : i] }
      const n = v.value as bigint
      switch (f.kind) {
        case 2:
          // TX_VALUE: the amount must be this call's own @.value, or the device refuses.
          if (f.flags & FLAG_TX_VALUE && n !== call.value) throw new Erc7730Refusal('ERC-7730 value does not match the call')
          return nativeOf(n)
        case 3: {
          const token = String(pick(2)!.value)
          // Roles 7/8: the signer's message ("Max") once the amount reaches the threshold.
          const threshold = pick(7)
          const message = threshold && n >= (threshold.value as bigint) ? pick(8)?.value : undefined
          const known = /^0x0{40}$/.test(token) ? undefined : DEVICE_TOKENS[`${call.chainId}:${token}`]
          // Role 22: addresses the signer says stand for the native coin, never over the device's table.
          const aliases = f.args.get(22)
          const set = aliases && literals[aliases.index].bytes
          const alias = !known && set && Array.from({ length: u16(set, 0) }, (_, k) => literal(u16(set, 2 + 2 * k)).value).includes(token)
          const ours = REVIEWED_EVM_TOKENS[`${call.chainId}:${token}`] ?? evmTokenIdentity(call.chainId, token)
          if (!known && !alias && ours && ours.symbol !== 'UNKNOWN') note = `This computer reads it as ${scaled(n, ours.decimals)} ${ours.symbol}.`
          const shown = known ? `${scaled(n, Number(known[1]))} ${known[0]}`
            : alias ? `Signer native alias:\n${ethersUtils.getAddress(token)}\n${nativeOf(n)}`
              : `${n}\nunknown token\n${ethersUtils.getAddress(token)}`
          return message ? `Signer: ${message}\n${shown}` : shown
        }
        case 4: return `Token ID ${n}\nCollection\n${ethersUtils.getAddress(String(pick(3)!.value))}`
        case 5: {
          if (pick(9)?.value === 'blockheight') return `Block ${n}`
          return n <= 253402300799n ? `${new Date(Number(n) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}\n(${n})` : `${n}\n(not a date)`
        }
        case 6: {
          if (n >= 2n ** 64n) return `${n} s`
          const parts = ([[86400n, 'd'], [3600n, 'h'], [60n, 'm'], [1n, 's']] as const)
            .map(([unit, name], k, all) => [k === 0 ? n / unit : (n % all[k - 1][0]) / unit, name] as const)
            .filter(([count]) => count > 0n).map(([count, name]) => `${count}${name}`)
          return `${parts.join(' ') || '0s'}\n(${n} s)`
        }
        case 7: {
          const base = pick(5)!.value as string
          return `unit set by signer\n${scaled(n, Number(pick(4)?.value ?? 0))}${base ? ` ${base}` : ''}\nraw ${n}`
        }
        case 8: {
          const map = literals[f.args.get(10)!.index].bytes
          for (let k = 0; k < u16(map, 0); k++) {
            if (literal(u16(map, 2 + 4 * k)).value === v.value) return `label set by signer\n${strings[u16(map, 4 + 4 * k)]} (${raw(v)})`
          }
          return `${raw(v)} (unmapped)`
        }
        // addressName: the device derives the signer and marks it; a
        // RECIPIENT field marks every other address "NOT this wallet".
        case 10: {
          if (v.kind !== 3) return raw(v)
          if (f.flags & FLAG_RECIPIENT) {
            if (!signer) throw new Error('signer not matched')
            return `${raw(v)}\n${v.value === signer ? '(this wallet)' : 'NOT this wallet'}`
          }
          return v.value === signer ? `${raw(v)}\n(this wallet)` : raw(v)
        }
        default: return raw(v)
      }
    }).join('\n')
    return { value, ...(note ? { note } : {}) }
  }

  const delegatecall = safeDelegatecall(call.data)
  const selector = call.data.slice(0, 10).toLowerCase()
  /** An embedded call (7.17, kind 13): per element, the device's context line,
   *  then the inner definition's own intent and fields. */
  const embedded = (index: number, label: string): Field[] => {
    const f = formatters[index]
    const out: Field[] = []
    resolve(f.args.get(1)!.index).forEach((bytes, i) => {
      const pick = (role: number) => { const list = argument(f, role); return list?.[list.length === 1 ? 0 : i] }
      // A Safe delegatecall is never shown as the callee's own action.
      if (delegatecall) throw new Erc7730Refusal('DELEGATECALL cannot be clear-signed')
      const callee = String(pick(15)!.value).toLowerCase()
      const value = pick(17)?.value as bigint | undefined
      const spender = pick(18)?.value as string | undefined
      const data = String(bytes.value).toLowerCase()
      const length = (data.length - 2) / 2
      const innerSelector = data.slice(0, 10)
      const context = (withFunction: boolean) => `To ${ethersUtils.getAddress(callee)}`
        + (length === 0 ? '\nNo data' : `${withFunction ? `\nFunction ${innerSelector}` : ''}\nData ${length} bytes`)
        + (value === undefined ? '' : `\nValue ${nativeOf(value)}`)
        + (spender === undefined ? '' : `\nAs ${ethersUtils.getAddress(spender)}`)
      // No data and nothing a definition could describe: the context is all of it.
      if (length === 0 && (value !== undefined || selector === SAFE_SETUP)
        && (callee === ZERO_ADDRESS || (SAFE_EXEC.has(selector) && !delegatecall))) {
        out.push({ label, value: context(false) })
        return
      }
      if (call.depth >= EMBED_MAX_DEPTH || length < 4 || (length - 4) % 32 !== 0) throw new Erc7730Refusal('Inner call cannot be clear-signed')
      if (INNER_APPROVALS.has(innerSelector)) throw new Error('inner approval')
      const envelope = walk.inner(callee, innerSelector)
      if (!envelope) {
        if (!walk.missing) throw new Erc7730Refusal('Inner call cannot be clear-signed')
        walk.missing.push({ contractAddress: callee, selector: innerSelector })
        return
      }
      // An inner definition that shows @.value needs one from the calldata.
      if (value === undefined && readsValue(Uint8Array.from(Buffer.from(envelope.replace(/^0x/i, ''), 'hex')))) {
        throw new Erc7730Refusal('Inner call cannot be clear-signed')
      }
      out.push({ label, value: context(true) })
      const inner = readLevel(envelope, {
        chainId: call.chainId, to: callee, data, value: value ?? 0n,
        // ERC-7730: inside the call @.from is whose authority it runs with, else the contract making it.
        from: spender ?? call.to.toLowerCase(), signer: call.signer, depth: call.depth + 1,
      }, walk)
      out.push({ label: 'Inner action', value: inner.intent, depth: call.depth + 1 }, ...inner.fields)
    })
    return out
  }

  let intent = ''
  const parts: string[] = []
  const fields: Field[] = []
  const depth = call.depth > 0 ? { depth: call.depth } : {}
  for (const d of display) {
    if (d.op === 1) {
      intent = strings[d.a]
      // Said before any field, whatever the definition shows, at whatever level.
      if (delegatecall) fields.push({ label: 'DELEGATECALL', value: "Runs the contract in 'to' as the Safe, with its full authority. Not checked.", ...depth })
    } else if (d.op === 2) parts.push(strings[d.a])
    else if (d.op === 3) parts.push(format(d.a).value)
    else if (d.op === 4 && formatters[d.b].kind === 13) fields.push(...embedded(d.b, strings[d.a]).map((x) => ({ ...depth, ...x })))
    else if (d.op === 4) fields.push({ label: strings[d.a], ...format(d.b), ...depth })
    else if (d.op === 10) break
    // 5/6 groups and 7/8 array runs only frame fields; a field's own path
    // names every element it shows.
  }
  if (!intent) throw new Error('no intent')
  return { signedBy, intent, parts, fields }
}

/** The program reads @.value: a path to it, or a TX_VALUE field (erc7730_catalog.c reads_value). */
function readsValue(envelope: Uint8Array): boolean {
  const program = envelope.subarray(10, 10 + u32(envelope, 6))
  const section: Record<number, Uint8Array> = {}
  for (let i = 0, p = 179; i < program[178]; i++) {
    section[program[p]] = program.subarray(p + 5, p + 5 + u32(program, p + 1))
    p += 5 + u32(program, p + 1)
  }
  const pt = section[3]
  for (let i = 0, p = 2; i < u16(pt, 0); i++) {
    if (pt[p] === 2 && u16(pt, p + 2) === 3) return true
    let q = p + 4
    for (let k = 0; k < pt[p + 1]; k++) {
      if (pt[q] !== 1 && pt[q] !== 2) throw new Error('path step') // erc7730_program.c knows only these two
      q += pt[q] === 1 ? 5 : 1
    }
    p = q
  }
  const ft = section[6]
  for (let i = 0, p = 2; i < u16(ft, 0); i++) {
    if (ft[p + 1] & FLAG_TX_VALUE) return true
    p += 3 + 4 * ft[p + 2]
  }
  return false
}

const toBigint = (value: unknown) => {
  const v = String(value ?? '')
  return BigInt(v === '' || v === '0x' ? 0 : v)
}
const innerLookup = (chainId: number, definitions: readonly InnerDefinition[] | undefined) => (callee: string, selector: string) =>
  definitions?.find((d) => Number(d.chainId) === chainId && String(d.contractAddress).toLowerCase() === callee
    && String(d.selectorOrTypeHash).toLowerCase().slice(0, 10) === selector)?.envelope

/** A definition the device may ask for by callee and selector (an Erc7730Catalog entry). */
export interface InnerDefinition { chainId?: unknown; contractAddress?: unknown; selectorOrTypeHash?: unknown; envelope: string }

/**
 * The description of `call` from a K773 envelope (hex), or undefined when its
 * signature does not check out to the production root, or the envelope or the
 * calldata cannot be read the way the device reads them. `from` is the signing
 * address only when this computer has matched it to the signing key; without
 * it, @.from cannot be shown and no address reads "(this wallet)".
 *
 * 7.17: an embedded call is described from `inner`, the same checked
 * definitions the device is sent (catalog.definitions); one that is missing,
 * or that the device would refuse, leaves the call without a description.
 * `rootPublicKey`: tests only (a TEST-root fixture); the production root otherwise.
 */
export function describeErc7730Call(
  envelopeHex: string,
  call: { chainId: number; to: string; data: string; value?: unknown; from?: string },
  inner?: readonly InnerDefinition[],
  rootPublicKey: string = PRODUCTION_ROOT_PUBLIC_KEY,
): Erc7730Description | undefined {
  try {
    return describeLevel(envelopeHex, {
      chainId: call.chainId, to: call.to, data: call.data, value: toBigint(call.value), from: call.from, signer: call.from, depth: 0,
    }, { root: rootPublicKey, inner: innerLookup(call.chainId, inner) })
  } catch {
    return undefined
  }
}

/**
 * The description of an EIP-712 document from a typed-data (kind 2) envelope,
 * the way 7.17 shows it: each definition field once, in its format. The
 * values no field shows are shown raw by the device after the fields (the
 * card lists every value in its own typed-data section). `from` as for calls.
 * Typed data has one container, @.to: the domain's verifyingContract.
 */
export function describeErc7730TypedData(envelopeHex: string, typedData: any, from?: string): Erc7730Description | undefined {
  try {
    const contract = String(typedData?.domain?.verifyingContract ?? '')
    if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return undefined
    const types = typedData.types ?? {}
    // The message in the program's node order: struct members in declared order.
    const tuple = (type: string, value: any): any => {
      const array = /^(.*)\[(\d*)\]$/.exec(type)
      if (array) return (value as any[]).map((v) => tuple(array[1], v))
      return Array.isArray(types[type]) ? types[type].map((m: { name: string; type: string }) => tuple(m.type, value[m.name])) : value
    }
    return describeLevel(envelopeHex, {
      chainId: Number(typedData.domain.chainId), to: contract, data: '', value: 0n, from, signer: from, depth: 0,
      typed: tuple(String(typedData.primaryType), typedData.message),
    }, { root: PRODUCTION_ROOT_PUBLIC_KEY, inner: () => undefined })
  } catch {
    return undefined
  }
}

/** A depth-0 level's description, with its protocol and explorer link. Throws when it cannot say. */
function describeLevel(envelopeHex: string, call: Level, walk: Walk): Erc7730Description {
  const { signedBy, intent, parts, fields } = readLevel(envelopeHex, call, walk)
  const to = call.to.toLowerCase()
  const protocol = PROTOCOLS[`${call.chainId}:${to}`]
  const about = call.typed ? undefined : protocol?.about[call.data.slice(0, 10).toLowerCase()]
  const explorer = CHAINS.find((c) => c.chainFamily === 'evm' && c.chainId === String(call.chainId))?.explorerAddressUrl
  return {
    signedBy,
    intent,
    ...(parts.length ? { summary: parts.join(' ') } : {}),
    fields,
    ...(protocol ? { protocol: { name: protocol.name, url: protocol.url, ...(about ? { about } : {}) } } : {}),
    ...(explorer?.startsWith('https://') ? { explorerUrl: explorer.replace('{{address}}', ethersUtils.getAddress(to)) } : {}),
  }
}

/**
 * Before a definition with embedded calls is attached (7.17): which inner
 * definitions the device will ask for, read from the calldata the same way,
 * with those in `known` followed further down. `refused` is the device's own
 * reason when Desktop can already see it would refuse this call with this
 * definition (a Safe DELEGATECALL, an inner call it cannot follow, a value
 * that does not match), or why the calldata cannot be read. No signature
 * checks: the device makes them.
 */
export function planErc7730EmbeddedCalls(
  envelopeHex: string,
  call: { chainId: number; to: string; data: string; value?: unknown },
  known: readonly InnerDefinition[],
): { missing: Array<{ contractAddress: string; selector: string }>; refused?: string } {
  const missing: Array<{ contractAddress: string; selector: string }> = []
  try {
    readLevel(envelopeHex, {
      // @.from and "(this wallet)" change no screen count and no lookup.
      chainId: call.chainId, to: call.to, data: call.data, value: toBigint(call.value), from: ZERO_ADDRESS, signer: ZERO_ADDRESS, depth: 0,
    }, { inner: innerLookup(call.chainId, known), missing })
    return { missing }
  } catch (error: any) {
    return { missing, refused: error instanceof Erc7730Refusal ? error.message : `cannot be read (${error?.message || 'error'})` }
  }
}
