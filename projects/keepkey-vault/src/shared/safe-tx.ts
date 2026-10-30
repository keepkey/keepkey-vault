/**
 * Safe's own helper contracts a Safe transaction may delegatecall, and the
 * singletons and fallback handlers it may switch to. Pinned from
 * https://github.com/safe-global/safe-deployments/tree/685f22be940739259cfc4148db3df7048f39a4e8/src/assets
 * for the EVM chains Desktop supports. Every address was checked on 2026-10-29
 * with eth_getCode on each chain listed: keccak256 of the code equals the
 * codeHash in that manifest (Robinhood 4663 via robinhood-rpc.publicnode.com).
 *
 * Advice for the approval card only. A Safe can delegatecall any address; a
 * pinned one is Safe's own code, so the card can say what it does.
 */

const CHAINS = [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114]

export type SafeContractKind = 'multisend' | 'multisend-call-only' | 'sign-message-lib' | 'migration'
  | 'to-l2-migration' | 'to-l2-setup' | 'singleton' | 'singleton-l2' | 'fallback-handler'
export interface SafeContract { name: string; version: string; kind: SafeContractKind; chains: number[] }

const c = (name: string, version: string, kind: SafeContractKind, chains = CHAINS): SafeContract => ({ name, version, kind, chains })

const SAFE_CONTRACTS: Record<string, SafeContract> = {
  '0x8d29be29923b68abfdd21e541b9374737b49cdad': c('MultiSend', '1.1.1', 'multisend', [1]),
  '0xa238cbeb142c10ef7ad8442c6d1f9e89e07e7761': c('MultiSend', '1.3.0', 'multisend'),
  '0x998739bfdaadde7c933b942a68053933098f9eda': c('MultiSend', '1.3.0', 'multisend'),
  '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526': c('MultiSend', '1.4.1', 'multisend'),
  '0x218543288004cd07832472d464648173c77d7eb7': c('MultiSend', '1.5.0', 'multisend'),
  '0x40a2accbd92bca938b02010e17a5b8929b49130d': c('MultiSendCallOnly', '1.3.0', 'multisend-call-only'),
  '0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b': c('MultiSendCallOnly', '1.3.0', 'multisend-call-only'),
  '0x9641d764fc13c8b624c04430c7356c1c7c8102e2': c('MultiSendCallOnly', '1.4.1', 'multisend-call-only'),
  '0xa83c336b20401af773b6219ba5027174338d1836': c('MultiSendCallOnly', '1.5.0', 'multisend-call-only'),
  '0xa65387f16b013cf2af4605ad8aa5ec25a2cba3a2': c('SignMessageLib', '1.3.0', 'sign-message-lib'),
  '0x98ffbbf51bb33a056b08ddf711f289936aaff717': c('SignMessageLib', '1.3.0', 'sign-message-lib'),
  '0xd53cd0ab83d845ac265be939c57f53ad838012c9': c('SignMessageLib', '1.4.1', 'sign-message-lib'),
  '0x4ffef8222648872b3de295ba1e49110e61f5b5aa': c('SignMessageLib', '1.5.0', 'sign-message-lib'),
  '0x526643f69b81b008f46d95cd5ced5ec0edffdac6': c('SafeMigration', '1.4.1', 'migration'),
  '0x6439e7abd8bb915a5263094784c5cf561c4172ac': c('SafeMigration', '1.5.0', 'migration'),
  '0xff83f6335d8930cbad1c0d439a841f01888d9f69': c('SafeToL2Migration', '1.4.1', 'to-l2-migration'),
  '0xbd89a1ce4dde368ffab0ec35506eece0b1ffdc54': c('SafeToL2Setup', '1.4.1', 'to-l2-setup'),
  '0x900c7589200010d6c6ecaae5b06ebe653bc2d82a': c('SafeToL2Setup', '1.5.0', 'to-l2-setup'),
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': c('Safe', '1.3.0', 'singleton'),
  '0x69f4d1788e39c87893c980c06edf4b7f686e2938': c('Safe', '1.3.0', 'singleton'),
  '0x41675c099f32341bf84bfc5382af534df5c7461a': c('Safe', '1.4.1', 'singleton'),
  '0xff51a5898e281db6dfc7855790607438df2ca44b': c('Safe', '1.5.0', 'singleton'),
  '0x3e5c63644e683549055b9be8653de26e0b4cd36e': c('SafeL2', '1.3.0', 'singleton-l2'),
  '0xfb1bffc9d739b8d520daf37df666da4c687191ea': c('SafeL2', '1.3.0', 'singleton-l2'),
  '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': c('SafeL2', '1.4.1', 'singleton-l2'),
  '0xedd160febbd92e350d4d398fb636302fccd67c7e': c('SafeL2', '1.5.0', 'singleton-l2'),
  '0xf48f2b2d2a534e402487b3ee7c18c33aec0fe5e4': c('CompatibilityFallbackHandler', '1.3.0', 'fallback-handler'),
  '0x017062a1de2fe6b99be3d9d37841fed19f573804': c('CompatibilityFallbackHandler', '1.3.0', 'fallback-handler'),
  '0xfd0732dc9e303f09fcef3a7388ad10a83459ec99': c('CompatibilityFallbackHandler', '1.4.1', 'fallback-handler'),
  '0x3efcbb83a4a7afcb4f68d501e2c2203a38be77f4': c('CompatibilityFallbackHandler', '1.5.0', 'fallback-handler'),
  '0x85a8ca358d388530ad0fb95d0cb89dd44fc242c3': c('ExtensibleFallbackHandler', '1.5.0', 'fallback-handler'),
}

/** The pinned Safe contract at this address on this chain, if any. */
export function safeContract(chainId: number, address: string): SafeContract | undefined {
  const k = SAFE_CONTRACTS[address.toLowerCase()]
  return k && k.chains.includes(chainId) ? k : undefined
}

export interface SafeInnerCall { operation: number; to: string; value: bigint; data: string }

/** multiSend(bytes): each call packed as operation (1 byte), to (20), value
 *  (32), data length (32), data. Null unless the bytes parse exactly. */
export function decodeMultiSend(data: string): SafeInnerCall[] | null {
  const hex = data.toLowerCase()
  if (!/^0x8d80ff0a([0-9a-f]{2})*$/.test(hex) || hex.length < 138) return null
  if (BigInt(`0x${hex.slice(10, 74)}`) !== 32n) return null
  const len = Number(BigInt(`0x${hex.slice(74, 138)}`))
  const body = hex.slice(138)
  // The bytes argument is padded to a whole word, and nothing follows it.
  if (len * 2 > body.length || Math.ceil(len / 32) * 64 !== body.length || /[^0]/.test(body.slice(len * 2))) return null
  const calls: SafeInnerCall[] = []
  let i = 0
  while (i < len * 2) {
    if (i + 170 > len * 2) return null
    const operation = parseInt(body.slice(i, i + 2), 16)
    const size = Number(BigInt(`0x${body.slice(i + 106, i + 170)}`))
    if (operation > 1 || i + 170 + size * 2 > len * 2) return null
    calls.push({
      operation,
      to: `0x${body.slice(i + 2, i + 42)}`,
      value: BigInt(`0x${body.slice(i + 42, i + 106)}`),
      data: `0x${body.slice(i + 170, i + 170 + size * 2)}`,
    })
    i += 170 + size * 2
  }
  return calls.length > 0 ? calls : null
}

/** The calls a SafeTx makes, in the order the approval card reads them: the
 *  call itself (operation 0), or each entry of a batch through a pinned
 *  MultiSend. Null for anything else. */
export function safeTxCalls(chainId: number, to: string, operation: number, value: bigint, data: string): SafeInnerCall[] | null {
  if (operation === 0) return [{ operation, to, value, data }]
  const kind = safeContract(chainId, to)?.kind
  return kind === 'multisend' || kind === 'multisend-call-only' ? decodeMultiSend(data) : null
}
