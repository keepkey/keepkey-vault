/**
 * Jupiter v6 swap instructions, decoded on this computer as advice.
 *
 * Firmware 7.16 shows a Jupiter swap only as raw data (the program is not in
 * its decoder, and most routes use lookup tables). The amounts are still in
 * the signed bytes, so Desktop reads them and says what the swap does.
 *
 * Layouts come from the program's own Anchor IDL (on-chain account
 * C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa, read 2026-10-29); program id
 * per https://developers.jup.ag/docs/swap/v1/common-errors, which links the
 * same IDL. The v1 instructions put the route plan BEFORE the amounts, so the
 * plan is walked step by step: reading the amounts from the end of the data
 * would trust bytes the program may never read. Any step this file cannot
 * walk, or bytes left over, leave a note, and a noted instruction is never
 * treated as decoded in full.
 */
import routeTypes from './jupiter-route-types.json'

export const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'

type Field = 'id' | 'plan' | 'planV2' | 'inAmount' | 'outAmount' | 'quotedInAmount' | 'quotedOutAmount'
  | 'slippageBps' | 'platformFeeBps' | 'platformFeeBpsV2' | 'positiveSlippageBps'

// sha256("global:<snake_name>")[0..8], checked against live transactions.
const V1_ROUTE_ACCOUNTS = ['tokenProgram', 'userTransferAuthority', 'userSourceTokenAccount', 'userDestinationTokenAccount', 'destinationTokenAccount', 'destinationMint', 'platformFeeAccount']
const SHARED_ACCOUNTS = ['tokenProgram', 'programAuthority', 'userTransferAuthority', 'sourceTokenAccount', 'programSourceTokenAccount', 'programDestinationTokenAccount', 'destinationTokenAccount', 'sourceMint', 'destinationMint', 'platformFeeAccount', 'token2022Program']
const V2_ACCOUNTS = ['userTransferAuthority', 'userSourceTokenAccount', 'userDestinationTokenAccount', 'sourceMint', 'destinationMint', 'sourceTokenProgram', 'destinationTokenProgram', 'destinationTokenAccount']
const SHARED_V2_ACCOUNTS = ['programAuthority', 'userTransferAuthority', 'sourceTokenAccount', 'programSourceTokenAccount', 'programDestinationTokenAccount', 'destinationTokenAccount', 'sourceMint', 'destinationMint', 'sourceTokenProgram', 'destinationTokenProgram']
const V1_IN: Field[] = ['plan', 'inAmount', 'quotedOutAmount', 'slippageBps', 'platformFeeBps']
const V1_OUT: Field[] = ['plan', 'outAmount', 'quotedInAmount', 'slippageBps', 'platformFeeBps']
const V2_IN: Field[] = ['inAmount', 'quotedOutAmount', 'slippageBps', 'platformFeeBpsV2', 'positiveSlippageBps', 'planV2']
const V2_OUT: Field[] = ['outAmount', 'quotedInAmount', 'slippageBps', 'platformFeeBpsV2', 'positiveSlippageBps', 'planV2']

const INSTRUCTIONS: Record<string, { name: string; accounts: string[]; fields: Field[] }> = {
  e517cb977ae3ad2a: { name: 'route', accounts: V1_ROUTE_ACCOUNTS, fields: V1_IN },
  '96564774a75d0e68': { name: 'routeWithTokenLedger', accounts: [...V1_ROUTE_ACCOUNTS, 'tokenLedger'], fields: ['plan', 'quotedOutAmount', 'slippageBps', 'platformFeeBps'] },
  d033ef977b2bed5c: { name: 'exactOutRoute', accounts: ['tokenProgram', 'userTransferAuthority', 'userSourceTokenAccount', 'userDestinationTokenAccount', 'destinationTokenAccount', 'sourceMint', 'destinationMint', 'platformFeeAccount', 'token2022Program'], fields: V1_OUT },
  c1209b3341d69c81: { name: 'sharedAccountsRoute', accounts: SHARED_ACCOUNTS, fields: ['id', ...V1_IN] },
  e6798f50779f6aaa: { name: 'sharedAccountsRouteWithTokenLedger', accounts: [...SHARED_ACCOUNTS, 'tokenLedger'], fields: ['id', 'plan', 'quotedOutAmount', 'slippageBps', 'platformFeeBps'] },
  b0d169a89a7d453e: { name: 'sharedAccountsExactOutRoute', accounts: SHARED_ACCOUNTS, fields: ['id', ...V1_OUT] },
  bb64facc31c4af14: { name: 'routeV2', accounts: V2_ACCOUNTS, fields: V2_IN },
  '9d8ab85215f4f324': { name: 'exactOutRouteV2', accounts: V2_ACCOUNTS, fields: V2_OUT },
  d19853937cfed8e9: { name: 'sharedAccountsRouteV2', accounts: SHARED_V2_ACCOUNTS, fields: ['id', ...V2_IN] },
  '3560e5cad8bbfa18': { name: 'sharedAccountsExactOutRouteV2', accounts: SHARED_V2_ACCOUNTS, fields: ['id', ...V2_OUT] },
}

type Layout = string | { option: Layout } | { vec: Layout } | { array: [Layout, number] }
const TYPES = routeTypes as unknown as Record<string, { struct?: Layout[]; enum?: [string, Layout[]][] }>
const SIZES: Record<string, number> = { bool: 1, u8: 1, u16: 2, u32: 4, u64: 8, u128: 16 }

class Reader {
  pos: number
  venues: string[] = []
  constructor(private data: Uint8Array, start: number) { this.pos = start }
  take(n: number): Uint8Array {
    if (this.pos + n > this.data.length) throw Error('route plan runs past the end of the data')
    const out = this.data.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  uint(n: number): bigint {
    let v = 0n
    this.take(n).forEach((b, i) => { v |= BigInt(b) << BigInt(8 * i) })
    return v
  }
  /** Walk one borsh value of this layout; only the venue names are kept. */
  skip(t: Layout): void {
    if (typeof t === 'string') {
      if (t === 'bytes') { this.take(Number(this.uint(4))); return }
      if (SIZES[t]) { this.take(SIZES[t]); return }
      const def = TYPES[t]
      if (def?.struct) { def.struct.forEach((f) => this.skip(f)); return }
      if (def?.enum) {
        const tag = Number(this.uint(1))
        const variant = def.enum[tag]
        if (!variant) throw Error(`route step ${t} #${tag} is newer than this computer's Jupiter layout`)
        if (t === 'Swap') this.venues.push(variant[0])
        variant[1].forEach((f) => this.skip(f))
        return
      }
      throw Error(`unknown route type ${t}`)
    }
    if ('option' in t) { if (Number(this.uint(1)) === 1) this.skip(t.option); return }
    if ('vec' in t) { const n = Number(this.uint(4)); for (let i = 0; i < n; i++) this.skip(t.vec); return }
    for (let i = 0; i < t.array[1]; i++) this.skip(t.array[0])
  }
}

export interface JupiterDecoded {
  instructionName: string
  args: { name: string; type: 'u8' | 'u16' | 'u64' | 'string'; value: string }[]
  accountLabels: string[]
  note?: string
}

/** null = not a Jupiter v6 swap instruction this file knows. */
export function decodeJupiterSwap(data: Uint8Array): JupiterDecoded | null {
  if (data.length < 8) return null
  const ix = INSTRUCTIONS[Buffer.from(data.subarray(0, 8)).toString('hex')]
  if (!ix) return null
  const r = new Reader(data, 8)
  const args: JupiterDecoded['args'] = []
  try {
    for (const f of ix.fields) {
      if (f === 'plan' || f === 'planV2') r.skip({ vec: f === 'plan' ? 'RoutePlanStep' : 'RoutePlanStepV2' })
      else if (f === 'id' || f === 'platformFeeBps') args.push({ name: f, type: 'u8', value: r.uint(1).toString() })
      else if (f === 'slippageBps' || f === 'platformFeeBpsV2' || f === 'positiveSlippageBps') {
        args.push({ name: f === 'platformFeeBpsV2' ? 'platformFeeBps' : f, type: 'u16', value: r.uint(2).toString() })
      } else args.push({ name: f, type: 'u64', value: r.uint(8).toString() })
    }
  } catch (e: any) {
    // v2 amounts sit before the plan, so what was read stays true.
    return { instructionName: ix.name, args, accountLabels: ix.accounts, note: e?.message || String(e) }
  }
  args.push({ name: 'route', type: 'string', value: [...new Set(r.venues)].join(', ') })
  const left = data.length - r.pos
  return { instructionName: ix.name, args, accountLabels: ix.accounts, note: left > 0 ? `${left} trailing bytes not decoded` : undefined }
}
