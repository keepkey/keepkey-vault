import firmwareTokens717 from './firmware-token-table-717.json'

/**
 * The last screen a 7.17 KeepKey shows for a Seaport 1.6 OrderComponents
 * signed with the KeepKey-certified definition (batch 6-D): "Order summary",
 * or WARNING with one line per fact. The same rules as the firmware
 * (keepkey-firmware PR #1035, lib/firmware/erc7730_settle.c), so the card
 * never reads calmer than the device:
 *  - offer items are given; a consideration item paid to the signer is
 *    received (its smaller amount), net of the same coin given (its larger
 *    amount; WETH nets as ETH);
 *  - up to two distinct items of each kind are kept; more received are not
 *    listed, more coins given cannot be read, more NFTs given are counted;
 *  - a received coin the device knows (ETH, or an ERC-20 of its token table)
 *    under 0.0001 of one (0.01 for three to six decimals, one unit below) is
 *    dust;
 *  - an NFT item naming a coin of the table, of never_nft[] or 0xEeee; an
 *    item given by criteria; an ERC-721 ID of 2^64 or more outside the hashed
 *    ID collections; an ERC-20 given that the table does not list; a given
 *    item that cannot be read; NFTs past the two listed.
 * Chain 1 only (the only chain with a 6-D leaf). Undefined when the device
 * would refuse the review or the order cannot be read here: no prediction.
 */
export interface SeaportDeviceScreen { warning: boolean; lines: string[] }

const SLOTS = 2
const NATIVE = 0
const ERC20 = 1
const ERC721 = 2
const ERC1155 = 3
const CRITERIA_MAX = 5
const ZERO = '0x0000000000000000000000000000000000000000'
const EEEE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const WORD = (1n << 256n) - 1n

const TABLE = (firmwareTokens717 as unknown as { symbols: Record<string, [string, number]> }).symbols
/** erc7730_settle.c wrapped_native[]. */
const WRAPPED_NATIVE = new Set(['1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'])
/** erc7730_settle.c hashed_id_collections[]: ENS, Unstoppable Domains (UNS,
 *  CNS), Decentraland LAND and Names, Sorare, Rarible's shared ERC-721; since
 *  review r4, the eight ERC-721s with the most chain-1 Seaport 1.6 listings
 *  moving IDs of 2^64 or more over blocks 26263701-26313700, each read on
 *  chain. Other such collections (one deployment per collection: Feral File,
 *  more Zer0 Name Service, Kolectiv, Grados, Wilder Land, ...) still warn. */
export const HASHED_ID = new Set([
  '1:0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85',
  '1:0x049aba7510f45ba5b64ea9e658e342f904db358d',
  '1:0xd1e5b0ff1287aa9f9a268759062e4ab08b9dacbe',
  '1:0xf87e31492faf9a91b02ee0deaad50d51d56d5d4d',
  '1:0x2a187453064356c898cae034eaed119e1663acb8',
  '1:0x629a673a8242c2ac4b7b8c5d8735fbeac21a6205',
  '1:0xf6793da657495ffeff9ee6350824910abc21356c',
  '1:0x20262e3433306a4ff250a64d20a8e0f09b2c7f68', // ENS Commemorative
  '1:0x0bfa9aff76fd91756f837ab47e11bd99e04c15bd', // Unetwork Operator Software License
  '1:0x572e33ffa523865791ab1c26b42a86ac244df784', // Gucci
  '1:0x51bd5948cf84a1041d2720f56ded5e173396fc95', // Zer0 Name Service
  '1:0x05f81f870cbca79e9171f22886b58b5597a603aa', // Zer0 Name Service
  '1:0x741512954cb6f8e5d3cd9321c07462b05b7cc8d5', // OKX AI NFT
  '1:0xc2e9678a71e50e5aed036e00e9c5caeb1ac5987d', // Zero Name Service
  '1:0xc9154424b823b10579895ccbe442d41b9abd96ed', // Rarible
])
/** erc7730_settle.c never_nft[]: ERC-20s the table does not list. */
const NEVER_NFT: Record<string, string> = {
  '1:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'cbBTC',
  '1:0x6c3ea9036406852006290770bedfcaba0e23a0e8': 'PYUSD',
  '1:0x68749665ff8d2d112fa859aa293f07a622782f38': 'XAUt',
  '1:0x1abaea1f7c830bd89acc67ec4af516284b1bc33c': 'EURC',
  '1:0xae7ab96520de3a18e5e111b5eaab095312d7fe84': 'stETH',
  '1:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': 'wstETH',
  '1:0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 'USDe',
  '1:0x4d224452801aced8b2f0aebe155379bb5d594381': 'APE',
}

interface Item { kind: number; token: string; id: bigint; amount: bigint }
const same = (a: Item, b: Item) => a.kind === b.kind && a.token === b.token && a.id === b.id

/** Adds `amount` of `item` to its slot or a new one; false when full or the total overflows. */
function keep(slots: Item[], item: Item, amount: bigint): boolean {
  const slot = slots.find((s) => same(s, item))
  if (slot) {
    if (slot.amount + amount > WORD) return false
    slot.amount += amount
    return true
  }
  if (slots.length >= SLOTS) return false
  slots.push({ ...item, amount })
  return true
}

function uint(value: unknown): bigint | undefined {
  try {
    const n = BigInt(typeof value === 'number' ? value : String(value ?? '').trim())
    return n >= 0n && n <= WORD ? n : undefined
  } catch { return undefined }
}

function units(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${amount / base}${fraction ? `.${fraction}` : ''}`
}

export function seaportDeviceScreen(typedData: any, signer: string | undefined): SeaportDeviceScreen | undefined {
  const chainId = Number(typedData?.domain?.chainId)
  const message = typedData?.message
  if (chainId !== 1 || typedData?.primaryType !== 'OrderComponents' || !signer || !message) return undefined
  if (!Array.isArray(message.offer) || !Array.isArray(message.consideration)) return undefined
  const me = signer.toLowerCase()
  const table = (token: string) => TABLE[`${chainId}:${token}`]
  const coinTicker = (token: string) => table(token)?.[0] ?? NEVER_NFT[`${chainId}:${token}`]

  const received: Item[] = []
  const given: Item[] = []
  const givenNft: Item[] = []
  let givenNftMore = 0
  let gives = false
  let givenUnread = false
  let receivedAny = false
  let unlisted = false
  let givesUnknownToken = false
  let givesByCriteria = false
  let largeNftId = false
  let nftPlaceholder = false
  let coinAsNft: string | undefined

  const items = [
    ...message.offer.map((i: any) => ({ i, to: undefined as string | undefined })),
    ...message.consideration.map((i: any) => ({ i, to: String(i?.recipient ?? '') })),
  ]
  for (const { i, to } of items) {
    const kind = uint(i?.itemType)
    const id = uint(i?.identifierOrCriteria)
    const start = uint(i?.startAmount)
    const end = uint(i?.endAmount)
    const token = String(i?.token ?? '').toLowerCase()
    // An item type beyond Seaport's: the device refuses the review.
    if (kind === undefined || kind > BigInt(CRITERIA_MAX) || id === undefined || start === undefined || end === undefined) return undefined
    if (!/^0x[0-9a-f]{40}$/.test(token) || (to !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(to))) return undefined
    const k = Number(kind)
    if (k >= ERC721) {
      // Shown as Seaport moves it (erc7730_settle_format_nft_amount).
      if (token === EEEE) nftPlaceholder = true
      else coinAsNft ??= coinTicker(token)
    }
    const native = token === ZERO
    let readable = true
    if (k <= ERC20) readable = native === (k === NATIVE) && token !== EEEE
    const item: Item = { kind: k, token, id: k <= ERC20 ? 0n : id, amount: start < end ? start : end }
    const max = start > end ? start : end
    // The firmware's table answers 0xEeee as ETH on chain 1 (EthTestToken), so
    // the 2^64 line skips it there, as it skips any coin: its own line says it.
    if (readable && k === ERC721 && id >= 1n << 64n && token !== EEEE && !coinTicker(token) && !HASHED_ID.has(`${chainId}:${token}`)) largeNftId = true
    if (to !== undefined) {
      if (to.toLowerCase() === me) {
        receivedAny = true
        if (!readable || !keep(received, item, item.amount)) unlisted = true
      }
      continue
    }
    gives = true
    if (k > ERC1155) givesByCriteria = true
    if (readable && k === ERC20 && !table(token)) givesUnknownToken = true
    if (!readable) {
      givenUnread = true
    } else if (k <= ERC20) {
      if (!keep(given, item, max)) givenUnread = true
    } else {
      const full = givenNft.length >= SLOTS
      const kept = givenNft.some((s) => same(s, item))
      if (!keep(givenNft, item, max)) {
        if (full && !kept) givenNftMore++
        else givenUnread = true
      }
    }
  }

  const nativeOrWrapped = (item: Item) => item.kind === NATIVE
    || (item.kind === ERC20 && !!table(item.token) && WRAPPED_NATIVE.has(`${chainId}:${item.token}`))
  const net: Item[] = []
  for (const r of received) {
    let left: Item | undefined = { ...r }
    for (const g of given) {
      if (!same(g, left) && !(nativeOrWrapped(g) && nativeOrWrapped(left))) continue
      if (left.amount <= g.amount) { left = undefined; break }
      left.amount -= g.amount
    }
    if (left) net.push(left)
  }
  let anyKnown = false
  let anyAbove = false
  let dust: string | undefined
  for (const n of net) {
    const decimals = n.kind === NATIVE ? 18 : n.kind === ERC20 ? table(n.token)?.[1] : undefined
    if (decimals === undefined) continue
    const floor = 10n ** BigInt(decimals > 6 ? decimals - 4 : decimals > 2 ? decimals - 2 : 0)
    if (n.amount >= floor) anyAbove = true
    else if (!anyKnown) dust = `${units(floor, decimals)} ${n.kind === NATIVE ? 'ETH' : table(n.token)![0]}`
    anyKnown = true
  }
  let base: 'calm' | 'nothing' | 'unvalued' | 'dust' = 'calm'
  let receipt: string | undefined
  if (net.length === 0 && !unlisted) {
    base = 'nothing'
    receipt = receivedAny ? 'This wallet gets back no more than it gives.' : 'Nothing in this order is paid to this wallet.'
  } else if (gives && !anyKnown) {
    base = 'unvalued'
    receipt = 'This wallet gets only unknown tokens or NFTs.'
  } else if (gives && !anyAbove) {
    base = 'dust'
  }

  const lines: string[] = []
  if (coinAsNft) lines.push(`An NFT item names the token ${coinAsNft}: Seaport moves its ID as an amount of ${coinAsNft}.`)
  if (nftPlaceholder) lines.push("An NFT item names 0xEeee...EEeE, the native coin's placeholder: it is not an NFT contract.")
  if (givesByCriteria) lines.push('This wallet gives an item by criteria: the buyer picks its ID (on a token, the ID is an amount).')
  if (largeNftId) lines.push('An NFT ID is 2^64 or more: if its contract is a token, Seaport moves that many units of it.')
  if (givesUnknownToken) lines.push('This wallet gives a token the device does not know: if it is an NFT collection, Seaport moves the NFT whose ID is the amount.')
  if (givenUnread) lines.push('This wallet gives an item the device cannot read.')
  if (givenNftMore) lines.push('This wallet gives more items than this screen lists.')
  if (receipt) lines.push(receipt)
  if (base === 'dust') lines.push(`This wallet gets under ${dust}.`)
  return { warning: lines.length > 0, lines }
}
