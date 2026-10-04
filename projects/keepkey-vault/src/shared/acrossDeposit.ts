/**
 * Across SpokePool depositV3 — the second transaction of a Uniswap
 * cross-chain swap (e.g. Base → Ethereum). Decoded on this computer only:
 * the firmware cannot clear-sign it (v2 schemas need fixed 4+32n calldata;
 * the dynamic `message` and Across's appended integrator tag do not fit), so
 * the device still shows raw data and the AdvancedMode gate is unchanged.
 *
 * A deposit is recognised ONLY when `to` is a pinned SpokePool on that exact
 * chain and the calldata is a canonical ABI encoding. Anything else returns
 * null and takes the existing generic (blind) path.
 */

/** Across deployments, verbatim from the pinned commit. */
export const ACROSS_DEPLOYMENTS_PROVENANCE =
  'https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/broadcast/deployed-addresses.json'

export interface AcrossSpokePool {
  chainId: number
  /** Lowercase. */
  address: string
  chain: string
  /** SpokePool.wrappedNativeToken(): the only token a deposit can fund from msg.value. */
  wrappedNative: { address: string; symbol: string; decimals: number }
}

/**
 * Each entry checked on chain 2026-10-04 via public RPC: eth_chainId of the
 * RPC, SpokePool.chainId() (0x9a8a0592) equal to it, wrappedNativeToken()
 * (0x17fcb39b) with that token's symbol()/decimals(), and the EIP-1967
 * implementation's bytecode containing the depositV3 selector.
 */
export const REVIEWED_ACROSS_SPOKE_POOLS: AcrossSpokePool[] = [
  { chainId: 1, address: '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5', chain: 'Ethereum', wrappedNative: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18 } },
  { chainId: 10, address: '0x6f26bf09b1c792e3228e5467807a900a503c0281', chain: 'Optimism', wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 } },
  { chainId: 56, address: '0x4e8e101924ede233c13e2d8622dc8aed2872d505', chain: 'BNB Smart Chain', wrappedNative: { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18 } },
  { chainId: 130, address: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', chain: 'Unichain', wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 } },
  { chainId: 137, address: '0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096', chain: 'Polygon', wrappedNative: { address: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', symbol: 'WPOL', decimals: 18 } },
  { chainId: 324, address: '0xe0b015e54d54fc84a6cb9b666099c46ade9335ff', chain: 'zkSync', wrappedNative: { address: '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91', symbol: 'WETH', decimals: 18 } },
  { chainId: 480, address: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', chain: 'World Chain', wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 } },
  { chainId: 8453, address: '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64', chain: 'Base', wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 } },
  { chainId: 42161, address: '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a', chain: 'Arbitrum', wrappedNative: { address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', symbol: 'WETH', decimals: 18 } },
  { chainId: 43114, address: '0xfe9d541c92e4e90437c7152a00244886de37a658', chain: 'Avalanche', wrappedNative: { address: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', symbol: 'WAVAX', decimals: 18 } },
  { chainId: 59144, address: '0x7e63a5f1a8f0b4d0934b2f2327daed3f6bb2ee75', chain: 'Linea', wrappedNative: { address: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', symbol: 'WETH', decimals: 18 } },
  { chainId: 81457, address: '0x2d509190ed0172ba588407d4c2df918f955cc6e1', chain: 'Blast', wrappedNative: { address: '0x4300000000000000000000000000000000000004', symbol: 'WETH', decimals: 18 } },
  { chainId: 534352, address: '0x3bad7ad0728f9917d1bf08af5782dcbd516cdd96', chain: 'Scroll', wrappedNative: { address: '0x5300000000000000000000000000000000000004', symbol: 'WETH', decimals: 18 } },
  { chainId: 7777777, address: '0x13fdac9f9b4777705db45291bbff3c972c6d1d97', chain: 'Zora', wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 } },
]

export function findReviewedAcrossSpokePool(chainId: number | undefined, address: string | undefined): AcrossSpokePool | undefined {
  if (!chainId || !address) return undefined
  const a = address.toLowerCase()
  return REVIEWED_ACROSS_SPOKE_POOLS.find((p) => p.chainId === chainId && p.address === a)
}

/** depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes) */
export const ACROSS_DEPOSIT_V3 = '0x7b939232'
/** Bytes allowed after the ABI encoding (Across integrator tag, e.g. 1dc0de…). */
const MAX_TRAILING_BYTES = 64
const HEAD_WORDS = 12
const U32_MAX = 0xffffffffn

export interface AcrossDepositV3 {
  pool: AcrossSpokePool
  depositor: string
  recipient: string
  inputToken: string
  outputToken: string
  inputAmount: bigint
  outputAmount: bigint
  destinationChainId: bigint
  exclusiveRelayer: string
  quoteTimestamp: number
  fillDeadline: number
  exclusivityParameter: number
  /** 0x-hex, '0x' when empty. A non-empty message makes the relayer call the recipient. */
  message: string
  /** 0x-hex of the bytes after the ABI encoding ('0x' when none). The contract ignores them. */
  trailing: string
}

/** null unless `to` is a reviewed SpokePool on `chainId` and `data` is a canonical depositV3. */
export function decodeAcrossDepositV3(to: string | undefined, data: string | undefined, chainId: number | undefined): AcrossDepositV3 | null {
  const pool = findReviewedAcrossSpokePool(chainId, to)
  if (!pool || typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return null
  const hex = data.slice(2).toLowerCase()
  if (`0x${hex.slice(0, 8)}` !== ACROSS_DEPOSIT_V3) return null
  const body = hex.slice(8)
  const word = (i: number) => body.slice(64 * i, 64 * i + 64)
  if (body.length < 64 * (HEAD_WORDS + 1)) return null
  const addr = (i: number) => (/^0{24}[0-9a-f]{40}$/.test(word(i)) ? `0x${word(i).slice(24)}` : null)
  const num = (i: number) => BigInt(`0x${word(i)}`)
  const u32 = (i: number) => (num(i) <= U32_MAX ? Number(num(i)) : null)

  const addrs = [0, 1, 2, 3, 7].map(addr)
  const times = [8, 9, 10].map(u32)
  if (addrs.some((a) => a === null) || times.some((t) => t === null)) return null
  // The one offset a standard encoder writes for this signature.
  if (num(11) !== BigInt(HEAD_WORDS * 32)) return null
  const len = num(12)
  const tail = body.slice(64 * (HEAD_WORDS + 1))
  const padded = ((len + 31n) / 32n) * 32n * 2n
  if (padded > BigInt(tail.length)) return null
  const message = tail.slice(0, Number(len) * 2)
  if (!/^0*$/.test(tail.slice(Number(len) * 2, Number(padded)))) return null
  const trailing = tail.slice(Number(padded))
  if (trailing.length / 2 > MAX_TRAILING_BYTES) return null

  const [depositor, recipient, inputToken, outputToken, exclusiveRelayer] = addrs as string[]
  const [quoteTimestamp, fillDeadline, exclusivityParameter] = times as number[]
  return {
    pool, depositor, recipient, inputToken, outputToken,
    inputAmount: num(4), outputAmount: num(5), destinationChainId: num(6),
    exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter,
    message: `0x${message}`, trailing: `0x${trailing}`,
  }
}

// ── Display ─────────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** SpokePool MAX_EXCLUSIVITY_PERIOD_SECONDS: at or below it the parameter is an offset. */
const MAX_EXCLUSIVITY_PERIOD_SECONDS = 31_536_000

function units(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${(raw / base).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`
}

const poolForChain = (chainId: bigint) =>
  chainId <= BigInt(Number.MAX_SAFE_INTEGER) ? REVIEWED_ACROSS_SPOKE_POOLS.find((p) => BigInt(p.chainId) === chainId) : undefined

/** The token's identity, only for a pool's verified wrapped-native token. */
function knownToken(chainId: bigint, token: string) {
  const w = poolForChain(chainId)?.wrappedNative
  return w && w.address === token ? w : undefined
}

export function acrossChainName(chainId: bigint): string | undefined {
  return poolForChain(chainId)?.chain
}

export const acrossLocalTime = (seconds: number) => new Date(seconds * 1000).toLocaleString()

export interface AcrossDepositView {
  sent: string
  received: string
  destination: string
  destinationKnown: boolean
  /** null when the two sides are not the same known asset. */
  fee: string | null
  feeBps: bigint | null
  inputTokenKnown: boolean
  outputTokenKnown: boolean
  exclusiveRelayer: string
  fillDeadline: string
  integratorTag: string | null
}

export function acrossDepositView(d: AcrossDepositV3): AcrossDepositView {
  const src = BigInt(d.pool.chainId)
  const inTok = knownToken(src, d.inputToken)
  const outTok = knownToken(d.destinationChainId, d.outputToken)
  const amount = (raw: bigint, tok: ReturnType<typeof knownToken>, token: string) =>
    tok ? `${units(raw, tok.decimals)} ${tok.symbol}` : `${raw.toLocaleString('en-US')} base units of token ${token}`
  const destName = acrossChainName(d.destinationChainId)
  const sameAsset = !!inTok && !!outTok && inTok.symbol === outTok.symbol && inTok.decimals === outTok.decimals
  const feeRaw = d.inputAmount - d.outputAmount
  const feeBps = sameAsset && d.inputAmount > 0n ? (feeRaw * 10_000n) / d.inputAmount : null
  const pct = (bps: bigint) => `${bps < 0n ? '-' : ''}${(bps < 0n ? -bps : bps) / 100n}.${((bps < 0n ? -bps : bps) % 100n).toString().padStart(2, '0')}%`
  const excl = d.exclusiveRelayer === ZERO_ADDRESS
    ? 'None (any relayer may fill)'
    : d.exclusivityParameter === 0
      ? `${d.exclusiveRelayer} (no exclusivity window)`
      : d.exclusivityParameter <= MAX_EXCLUSIVITY_PERIOD_SECONDS
        ? `${d.exclusiveRelayer} (only it may fill for ${d.exclusivityParameter} s after the deposit)`
        : `${d.exclusiveRelayer} (only it may fill until ${acrossLocalTime(d.exclusivityParameter)})`
  const tag = d.trailing === '0x' ? null
    : d.trailing.startsWith('0x1dc0de') ? `${d.trailing} (Across integrator tag, ignored by the contract)`
      : `${d.trailing} (extra bytes, ignored by the contract)`
  return {
    sent: amount(d.inputAmount, inTok, d.inputToken),
    received: amount(d.outputAmount, outTok, d.outputToken),
    destination: destName ? `${destName} (chain id ${d.destinationChainId})` : `chain id ${d.destinationChainId} (not recognized)`,
    destinationKnown: !!destName,
    fee: feeBps === null ? null : `${units(feeRaw < 0n ? -feeRaw : feeRaw, inTok!.decimals)} ${inTok!.symbol}${feeRaw < 0n ? ' (you receive more than you send)' : ''} (${pct(feeBps)})`,
    feeBps,
    inputTokenKnown: !!inTok,
    outputTokenKnown: !!outTok,
    exclusiveRelayer: excl,
    fillDeadline: acrossLocalTime(d.fillDeadline),
    integratorTag: tag,
  }
}
