import { createHash } from 'node:crypto'
import { utils as ethersUtils } from 'ethers'

import {
  ALPHA_DELEGATE_PUBLIC_KEY,
  ALPHA_DELEGATE_FINGERPRINT,
  CLEARSIGN_SCOPE_ETHEREUM,
  inspectAlphaCertificate,
} from './clearsign-alpha-ceremony'
import { UR_V4_ROUTERS } from './uniswap-ur'

export const CERTIFIED_METADATA_VERSION = 0x03
export const CERTIFIED_METADATA_KEY_ID = 0x80

export const EVM_ARG_ADDRESS = 1
export const EVM_ARG_AMOUNT = 2
export const EVM_ARG_BYTES = 3
export const EVM_ARG_TOKEN_AMOUNT = 5
/** v0x02/v0x05: 20 expected bytes follow the format byte. The schema applies
 * only when that calldata word is 12 zero bytes + exactly this address. */
export const EVM_ARG_ADDRESS_PINNED = 6
export const EVM_DECODER_PORTALS_NATIVE_ORDER_V1 = 1
export const EVM_DECODER_ACROSS_ARBITRUM_WETH_TO_ETHEREUM_V1 = 2

export interface EvmSchemaArg {
  name: string
  format: number
  decimals?: number
  symbol?: string
  /** v0x05: ROLE_* (1-5) on amounts, 0 otherwise. */
  role?: number
  /** EVM_ARG_ADDRESS_PINNED only: the one address this word may hold. */
  pinned?: string
}

/** v0x05 roles, numbered as Solana KKSOLSC1 v3. */
export const ROLE_SPEND_MAX = 1
export const ROLE_RECEIVE_MIN = 2
export const ROLE_SPEND_EXACT = 3
export const ROLE_RECEIVE_EXACT = 4
export const ROLE_CAP = 5
/** EVM only (firmware METADATA_ROLE_ALLOWANCE): an allowance another party may draw on. */
export const ROLE_ALLOWANCE = 6

/** Human-readable review (SRS-7.16 §3.7): firmware fills every value. */
export interface EvmIntent {
  title: string
  /** `{n}` = arg n, `{v}` = msg.value; <=96 chars. */
  template: string
  /** ROLE_SPEND_EXACT / ROLE_SPEND_MAX when msg.value moves; else 0. */
  valueRole: number
}

export interface EvmSchemaSpec {
  chainId: number
  contract: string
  selector: string
  method: string
  args: EvmSchemaArg[]
  /** Fixed v2 schemas account for every byte exactly. */
  expectedCalldataLength?: number
  /** v4 schemas select a reviewed firmware decoder for dynamic calldata. */
  decoder?: number
  minimumCalldataLength?: number
  maximumCalldataLength?: number
  displayFields?: string[]
  protocol?: string
  maintainedBy?: string
  action?: string
  provenance?: Record<string, string>
  intent?: EvmIntent
}

/** Relay Depository: one CREATE2 address on every chain (checked on chain
 * 2026-10-05; see shared/relayDeposit.ts). */
export const RELAY_DEPOSITORY_ADDRESS = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
export const RELAY_DEPOSIT_NATIVE_SELECTOR = '0x49290c1c'
export const RELAY_DEPOSIT_ERC20_SELECTOR = '0xe8017952'
const RELAY_PROVENANCE = {
  protocol: 'https://docs.relay.link/references/protocol/contracts/evm-depository',
  deployment: 'https://basescan.org/address/0x4cD00E387622C35bDDB9b4c962C136462338BC31',
}
const RELAY_TEMPLATE_TAIL = 'through Relay for {0}; delivery is by Relay'

function relayNativeEntries(chainIds: number[]): Record<string, EvmSchemaSpec> {
  return Object.fromEntries(chainIds.map((chainId): [string, EvmSchemaSpec] => [`${chainId}:${RELAY_DEPOSITORY_ADDRESS}:${RELAY_DEPOSIT_NATIVE_SELECTOR}`, {
    chainId,
    contract: RELAY_DEPOSITORY_ADDRESS,
    selector: RELAY_DEPOSIT_NATIVE_SELECTOR,
    method: 'depositNative',
    args: [
      { name: 'depositor', format: EVM_ARG_ADDRESS },
      { name: 'orderId', format: EVM_ARG_BYTES },
    ],
    expectedCalldataLength: 68,
    protocol: 'Relay',
    maintainedBy: 'Relay',
    action: 'Deposit the native coin for a Relay cross-chain order',
    provenance: RELAY_PROVENANCE,
    intent: { title: 'Relay', template: `Bridge {v} ${RELAY_TEMPLATE_TAIL}`, valueRole: ROLE_SPEND_EXACT },
  }]))
}

/**
 * Relay depositErc20(depositor, token, amount, orderId) of a reviewed token:
 * one entry per (chain, token), selected by the calldata's token word, which
 * the entry pins (format 6) so the symbol and decimals on the amount are that
 * token's. The device applies it only to exactly 132 bytes whose token word
 * is that address; anything else stays on the blind path.
 */
export function findRelayErc20DepositSchema(
  chainId: number,
  contract: string,
  selector: string,
  calldataLength: number,
  token?: string,
): EvmSchemaSpec | undefined {
  if (contract.toLowerCase() !== RELAY_DEPOSITORY_ADDRESS || selector !== RELAY_DEPOSIT_ERC20_SELECTOR || calldataLength !== 132 || !token) return undefined
  const address = token.toLowerCase()
  const identity = REVIEWED_EVM_TOKENS[`${chainId}:${address}`]
  if (!identity) return undefined
  return {
    chainId,
    contract: RELAY_DEPOSITORY_ADDRESS,
    selector: RELAY_DEPOSIT_ERC20_SELECTOR,
    method: 'depositErc20',
    args: [
      { name: 'depositor', format: EVM_ARG_ADDRESS },
      { name: 'token', format: EVM_ARG_ADDRESS_PINNED, pinned: address },
      { name: 'amount', format: EVM_ARG_TOKEN_AMOUNT, symbol: identity.symbol, decimals: identity.decimals, role: ROLE_SPEND_EXACT },
      { name: 'orderId', format: EVM_ARG_BYTES },
    ],
    expectedCalldataLength: 132,
    protocol: 'Relay',
    maintainedBy: 'Relay',
    action: `Deposit ${identity.symbol} for a Relay cross-chain order`,
    provenance: RELAY_PROVENANCE,
    intent: { title: 'Relay', template: `Bridge {2} ${RELAY_TEMPLATE_TAIL}`, valueRole: 0 },
  }
}

/** Every reviewed-token depositErc20 entry (the worker's catalog listing). */
export function relayErc20DepositEntries(): EvmSchemaSpec[] {
  return Object.keys(REVIEWED_EVM_TOKENS).map((key) => {
    const [chainId, token] = key.split(':')
    return findRelayErc20DepositSchema(Number(chainId), RELAY_DEPOSITORY_ADDRESS, RELAY_DEPOSIT_ERC20_SELECTOR, 132, token)!
  })
}

/**
 * The catalog id for a spec, shared by the worker and Vault. An approve
 * pinned to Permit2 ends ':permit2'; a Relay depositErc20 ends with its
 * pinned token address; anything else is chain:contract:selector.
 */
export function evmEntryId(spec: Pick<EvmSchemaSpec, 'chainId' | 'contract' | 'selector' | 'args'>): string {
  const pinned = spec.args.find((arg) => arg.format === EVM_ARG_ADDRESS_PINNED)?.pinned?.toLowerCase()
  const suffix = !pinned ? '' : pinned === PERMIT2_ADDRESS ? ':permit2' : `:${pinned}`
  return `eip155:${spec.chainId}:${spec.contract}:${spec.selector}${suffix}`
}

export const CERTIFIED_EVM_CATALOG: Record<string, EvmSchemaSpec> = {
  '1:0x4cd00e387622c35bddb9b4c962c136462338bc31:0x49290c1c': {
    chainId: 1,
    contract: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
    selector: '0x49290c1c',
    method: 'bridgeDeposit',
    args: [
      { name: 'depositor', format: EVM_ARG_ADDRESS },
      { name: 'orderId', format: EVM_ARG_BYTES },
    ],
    expectedCalldataLength: 68,
    intent: {
      title: 'Relay',
      template: 'Bridge {v} through Relay for {0}; delivery is by Relay',
      valueRole: ROLE_SPEND_EXACT,
    },
  },
  // Relay Depository depositNative on Base and Arbitrum: the same contract
  // and description as the Ethereum entry above (whose method name,
  // bridgeDeposit, predates the ABI name and stays as signed).
  ...relayNativeEntries([8453, 42161]),
  '1:0xbf5a7f3629fb325e2a8453d595ab103465f75e62:0xa2e42c65': {
    chainId: 1,
    contract: '0xbf5A7F3629fB325E2a8453D595AB103465F75E62',
    selector: '0xa2e42c65',
    method: 'Portals swap',
    args: [],
    decoder: EVM_DECODER_PORTALS_NATIVE_ORDER_V1,
    minimumCalldataLength: 452,
    maximumCalldataLength: 16_388,
    displayFields: ['Output token', 'Minimum output', 'Recipient', 'Native input amount'],
    protocol: 'Portals',
    maintainedBy: 'Portals',
    action: 'Swap native ETH through the Portals router',
    provenance: {
      protocol: 'https://docs.portals.fi/',
      verifiedContract: 'https://eth.blockscout.com/address/0xbf5A7F3629fB325E2a8453D595AB103465F75E62?tab=contract',
    },
  },
  '42161:0xe35e9842fceaca96570b734083f4a58e8f7c5f2a:0x7b939232': {
    chainId: 42161,
    contract: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
    selector: '0x7b939232',
    method: 'Across bridge',
    args: [],
    decoder: EVM_DECODER_ACROSS_ARBITRUM_WETH_TO_ETHEREUM_V1,
    minimumCalldataLength: 420,
    maximumCalldataLength: 1024,
    displayFields: ['Recipient', 'Input', 'Output token', 'Minimum output', 'Destination chain', 'Exclusive relayer'],
    protocol: 'Across',
    maintainedBy: 'Across Protocol',
    action: 'Bridge native Arbitrum WETH to Ethereum WETH',
    provenance: {
      protocol: 'https://docs.across.to/reference/selected-contract-functions',
      deployment: 'https://github.com/across-protocol/contracts/blob/master/deployments/legacy-addresses.json',
      implementation: 'https://repo.sourcify.dev/contracts/full_match/42161/0xCfcDa84333431BCC9155F2368B8362f0D1dff8C9/',
    },
  },
}

/**
 * Reviewed ERC-20 deployments. KeepKey names the amount with this symbol, so a
 * token is listed by address only, never looked up by symbol (look-alikes
 * share symbols). Each entry agrees across the Uniswap Labs Default list
 * v22.24.0 and the contract's own symbol()/decimals(), checked 2026-10-03,
 * except one symbol: Arbitrum USDT0's symbol() is "USD₮0" (not ASCII, which
 * the device needs); "USDT0" is the list's ASCII transliteration. Its
 * decimals() agrees.
 */
export const REVIEWED_EVM_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  '8453:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
  '8453:0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  '8453:0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
  '8453:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8 },
  '8453:0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH', decimals: 18 },
  '42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT0', decimals: 6 },
  '42161:0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
  '42161:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
  '42161:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', decimals: 8 },
}

/** Uniswap Permit2: one CREATE2 address on every chain
 * (https://github.com/Uniswap/permit2). The approve spender in Uniswap's
 * swap flow; Universal Router then pulls tokens through it per signed permit. */
export const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3'
export const PERMIT2_PROVENANCE = 'https://github.com/Uniswap/permit2'

export const ERC20_APPROVE = '0x095ea7b3'
export const ERC20_TRANSFER = '0xa9059cbb'

/** Owner rule: WHO / WHAT / WHY / LIMIT. No digits outside placeholders, so
 * "Permit2" cannot be named in a template; the pinned address names it.
 * Permit2 is Uniswap's, but 1inch, 0x, CoW, Odos and others pull through it
 * too, so the words say it is shared rather than "the Uniswap" contract.
 * Changing this text changes the signed entry: a new signature (worker
 * deploy now, the offline ceremony under D-018) and a new screen review. */
export const PERMIT2_APPROVE_INTENT = {
  title: 'Shared approval',
  template: "Let Uniswap's shared approval contract, used by many apps, spend up to {1} for trades you sign",
}
export const GENERIC_APPROVE_INTENT = {
  title: 'Token approval',
  template: 'Allow {0} to spend up to {1}; only approve apps you trust',
}
export const TRANSFER_TEMPLATE = 'Send {1} to {0}'

/**
 * approve / transfer of a reviewed token: the fixed 68-byte ERC-20 shapes.
 * `spender` (approve only) selects the entry: Permit2 gets the pinned Uniswap
 * description, anything else (or absent) the generic one. It must be the
 * spender word of the calldata being signed: a pinned schema whose address
 * differs is refused by the device, not downgraded.
 */
export function findReviewedTokenSchema(
  chainId: number,
  contract: string,
  selector: string,
  calldataLength: number,
  spender?: string,
): EvmSchemaSpec | undefined {
  const address = contract.toLowerCase()
  const token = REVIEWED_EVM_TOKENS[`${chainId}:${address}`]
  if (!token || calldataLength !== 68) return undefined
  const common = { chainId, contract: address, selector, expectedCalldataLength: 68, protocol: 'ERC-20', maintainedBy: 'KeepKey' }
  const amount = (name: string, role: number): EvmSchemaArg =>
    ({ name, format: EVM_ARG_TOKEN_AMOUNT, symbol: token.symbol, decimals: token.decimals, role })
  if (selector === ERC20_APPROVE) {
    if (spender?.toLowerCase() === PERMIT2_ADDRESS) {
      return {
        ...common,
        method: 'approve',
        args: [
          { name: 'Spender', format: EVM_ARG_ADDRESS_PINNED, pinned: PERMIT2_ADDRESS },
          amount('Allowance', ROLE_ALLOWANCE),
        ],
        action: `Approve ${token.symbol} for Permit2 (Uniswap's shared approval contract)`,
        intent: { ...PERMIT2_APPROVE_INTENT, valueRole: 0 },
      }
    }
    return {
      ...common,
      method: 'approve',
      args: [{ name: 'Spender', format: EVM_ARG_ADDRESS }, amount('Allowance', ROLE_ALLOWANCE)],
      action: `Approve ${token.symbol} spending`,
      intent: { ...GENERIC_APPROVE_INTENT, valueRole: 0 },
    }
  }
  if (selector === ERC20_TRANSFER) {
    return {
      ...common,
      method: 'transfer',
      args: [{ name: 'Recipient', format: EVM_ARG_ADDRESS }, amount('Amount', ROLE_SPEND_EXACT)],
      action: `Send ${token.symbol}`,
      intent: { title: 'Token transfer', template: TRANSFER_TEMPLATE, valueRole: 0 },
    }
  }
  return undefined
}

export const EVM_NAME_RECORD_VERSION = 0x06

/** A vouched name for one address on one chain (firmware METADATA_VERSION_NAME).
 * The device shows it only beside that exact address; it describes nothing. */
export interface EvmNameRecord {
  chainId: number
  address: string
  name: string
  source: string
}

/** Uniswap Universal Router deployments, verbatim from Uniswap's own repo:
 * https://github.com/Uniswap/universal-router/tree/a9c574f6caf1d6f1b51facd3fe32dec7c4df392c/deploy-addresses
 * These are the Permit2 spenders in Uniswap's swap flow. */
export const UNIVERSAL_ROUTER_PROVENANCE =
  'https://github.com/Uniswap/universal-router/tree/a9c574f6caf1d6f1b51facd3fe32dec7c4df392c/deploy-addresses'
export const CERTIFIED_EVM_NAMES: EvmNameRecord[] = [
  { chainId: 1, address: '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV1' },
  { chainId: 1, address: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV1_2_V2Support' },
  { chainId: 1, address: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV2' },
  { chainId: 1, address: '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV2_1_1' },
  { chainId: 1, address: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV2_1_2' },
  { chainId: 42161, address: '0x4c60051384bd2d3c01bfc845cf5f4b44bcbe9de5', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV1' },
  { chainId: 42161, address: '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 42161, address: '0x5e325eda8064b456f4781070c0738d849c824258', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV1_2_V2Support' },
  { chainId: 42161, address: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV2' },
  { chainId: 42161, address: '0x8b844f885672f333bc0042cb669255f93a4c1e6b', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV2_1_1' },
  { chainId: 42161, address: '0x2d01411773c8c24805306e89a41f7855c3c4fe65', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV2_1_2' },
  { chainId: 56, address: '0x5dc88340e1c5c6366864ee415d6034cadd1a9897', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV1' },
  { chainId: 56, address: '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 56, address: '0x4dae2f939acf50408e13d58534ff8c2776d45265', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV1_2_V2Support' },
  { chainId: 56, address: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV2' },
  { chainId: 56, address: '0x8b844f885672f333bc0042cb669255f93a4c1e6b', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV2_1_1' },
  { chainId: 56, address: '0xdc264714f68d84cf29bc605589405e78bdbe7c9f', name: 'Uniswap Universal Router', source: 'bsc.json UniversalRouterV2_1_2' },
  { chainId: 8453, address: '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 8453, address: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV1_2_V2Support' },
  { chainId: 8453, address: '0x6ff5693b99212da76ad316178a184ab56d299b43', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV2' },
  { chainId: 8453, address: '0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV2_1_1' },
  { chainId: 8453, address: '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV2_1_2' },
  { chainId: 10, address: '0xb555edf5dcf85f42ceef1f3630a52a108e55a654', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV1' },
  { chainId: 10, address: '0xec8b0f7ffe3ae75d7ffab09429e3675bb63503e4', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 10, address: '0xcb1355ff08ab38bbce60111f1bb2b784be25d7e8', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV1_2_V2Support' },
  { chainId: 10, address: '0x851116d9223fabed8e56c0e6b8ad0c31d98b3507', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV2' },
  { chainId: 10, address: '0x8b844f885672f333bc0042cb669255f93a4c1e6b', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV2_1_1' },
  { chainId: 10, address: '0xc09255d86db563cbc11c2fcf4a0c512e160111b4', name: 'Uniswap Universal Router', source: 'optimism.json UniversalRouterV2_1_2' },
  { chainId: 137, address: '0x4c60051384bd2d3c01bfc845cf5f4b44bcbe9de5', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV1' },
  { chainId: 137, address: '0x643770e279d5d0733f21d6dc03a8efbabf3255b4', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV1_2_NoV2Support' },
  { chainId: 137, address: '0xec7be89e9d109e7e3fec59c222cf297125fefda2', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV1_2_V2Support' },
  { chainId: 137, address: '0x1095692a6237d83c6a72f3f5efedb9a670c49223', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV2' },
  { chainId: 137, address: '0x8b844f885672f333bc0042cb669255f93a4c1e6b', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV2_1_1' },
  { chainId: 137, address: '0xdc264714f68d84cf29bc605589405e78bdbe7c9f', name: 'Uniswap Universal Router', source: 'polygon.json UniversalRouterV2_1_2' },
]

export function findEvmNameRecord(chainId: number | undefined, address: string | undefined): EvmNameRecord | undefined {
  if (!chainId || !address) return undefined
  const a = address.toLowerCase()
  return CERTIFIED_EVM_NAMES.find((r) => r.chainId === chainId && r.address === a)
}

export function buildEvmNameBody(record: EvmNameRecord): Buffer {
  const name = ascii(record.name, 24, 'name')
  return Buffer.concat([
    u8(EVM_NAME_RECORD_VERSION),
    be32(record.chainId),
    hexBytes(record.address, 20, 'address'),
    u8(name.length),
    name,
    u8(1), be32(0), u8(CERTIFIED_METADATA_KEY_ID),
  ])
}

function ascii(value: string, max: number, label: string): Buffer {
  const bytes = Buffer.from(String(value || ''), 'ascii')
  if (bytes.length < 1 || bytes.length > max || bytes.toString('ascii') !== value) {
    throw new Error(`${label} must be 1-${max} printable ASCII characters`)
  }
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e || byte === 0x25) {
      throw new Error(`${label} contains a character the device will not render`)
    }
  }
  return bytes
}

function hexBytes(value: string, length: number, label: string): Buffer {
  const clean = String(value || '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== length * 2) {
    throw new Error(`${label} must be exactly ${length} bytes of hex`)
  }
  return Buffer.from(clean, 'hex')
}

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff])
}

function be16(value: number): Buffer {
  const out = Buffer.alloc(2)
  out.writeUInt16BE(value)
  return out
}

function be32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value)
  return out
}

export function findCertifiedEvmSchemaSpec(
  chainId: number | undefined,
  contract: string | undefined,
  data: string | undefined,
): EvmSchemaSpec | undefined {
  if (!chainId || !contract || !data) return undefined
  const calldata = data.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]+$/.test(calldata) || calldata.length < 8 || calldata.length % 2 !== 0) return undefined
  const selector = `0x${calldata.slice(0, 8)}`
  // approve: the spender word picks pinned vs generic; a dirty word pins nothing.
  const word = calldata.slice(8, 72)
  const spender = selector === ERC20_APPROVE && /^0{24}[0-9a-f]{40}$/.test(word) ? `0x${word.slice(24)}` : undefined
  return findCertifiedEvmSchemaByShape(chainId, contract, selector, calldata.length / 2, spender, relayDepositToken(selector, calldata))
}

/** depositErc20's token word (a clean address), which selects its entry. */
export function relayDepositToken(selector: string, calldataHex: string): string | undefined {
  if (selector.toLowerCase() !== RELAY_DEPOSIT_ERC20_SELECTOR) return undefined
  const word = calldataHex.replace(/^0x/i, '').toLowerCase().slice(72, 136)
  return /^0{24}[0-9a-f]{40}$/.test(word) ? `0x${word.slice(24)}` : undefined
}

/** Match without sending transaction arguments to a remote schema service
 * (only an approve's spender or a Relay depositErc20's token address, which
 * select the description). */
export function findCertifiedEvmSchemaByShape(
  chainId: number | undefined,
  contract: string | undefined,
  selector: string | undefined,
  calldataLength: number | undefined,
  spender?: string,
  token?: string,
): EvmSchemaSpec | undefined {
  if (!chainId || !contract || !selector || !Number.isInteger(calldataLength)) return undefined
  const normalizedSelector = selector.toLowerCase()
  if (!/^0x[0-9a-f]{8}$/.test(normalizedSelector)) return undefined
  const spec = CERTIFIED_EVM_CATALOG[`${chainId}:${contract.toLowerCase()}:${normalizedSelector}`]
  if (!spec) {
    return findReviewedTokenSchema(chainId, contract, normalizedSelector, calldataLength!, spender)
      ?? findRelayErc20DepositSchema(chainId, contract, normalizedSelector, calldataLength!, token)
  }
  if (spec.expectedCalldataLength !== undefined) {
    if (calldataLength !== spec.expectedCalldataLength) return undefined
  } else {
    if (!spec.decoder || spec.minimumCalldataLength === undefined || spec.maximumCalldataLength === undefined) return undefined
    if (calldataLength < spec.minimumCalldataLength || calldataLength > spec.maximumCalldataLength) return undefined
    if (spec.decoder === EVM_DECODER_PORTALS_NATIVE_ORDER_V1 && (calldataLength - 4) % 32 !== 0) return undefined
  }
  return spec
}

/** Serialize a device-decoded v2 or v4 schema. */
export function buildEvmSchemaBody(spec: EvmSchemaSpec): Buffer {
  if (!Number.isInteger(spec.chainId) || spec.chainId <= 0 || spec.chainId > 0xffffffff) {
    throw new Error('schema chainId must be a nonzero uint32')
  }
  const method = ascii(spec.method, 64, 'method')
  if (spec.decoder !== undefined) {
    if (![EVM_DECODER_PORTALS_NATIVE_ORDER_V1,
      EVM_DECODER_ACROSS_ARBITRUM_WETH_TO_ETHEREUM_V1].includes(spec.decoder) || spec.args.length !== 0) {
      throw new Error('unsupported EVM dynamic decoder')
    }
    if (spec.minimumCalldataLength === undefined || spec.maximumCalldataLength === undefined) {
      throw new Error('dynamic schema requires calldata bounds')
    }
    return Buffer.concat([
      u8(0x04),
      be32(spec.chainId),
      hexBytes(spec.contract, 20, 'contract'),
      hexBytes(spec.selector, 4, 'selector'),
      be16(method.length),
      method,
      u8(spec.decoder),
      u8(1), be32(0), u8(CERTIFIED_METADATA_KEY_ID),
    ])
  }
  const intent = spec.intent
  if (intent) validateEvmIntent(spec, intent)
  if (spec.expectedCalldataLength !== 4 + 32 * spec.args.length) {
    throw new Error('schema argument widths do not account for the complete calldata')
  }
  const parts: Buffer[] = [
    u8(intent ? 0x05 : 0x02),
    be32(spec.chainId),
    hexBytes(spec.contract, 20, 'contract'),
    hexBytes(spec.selector, 4, 'selector'),
    be16(method.length),
    method,
    u8(spec.args.length),
  ]
  for (const arg of spec.args) {
    const name = ascii(arg.name, 32, 'argument name')
    if (![EVM_ARG_ADDRESS, EVM_ARG_AMOUNT, EVM_ARG_BYTES, EVM_ARG_TOKEN_AMOUNT, EVM_ARG_ADDRESS_PINNED].includes(arg.format)) {
      throw new Error(`unsupported EVM schema format ${arg.format}`)
    }
    if ((arg.pinned !== undefined) !== (arg.format === EVM_ARG_ADDRESS_PINNED)) {
      throw new Error(`argument ${arg.name}: a pinned address belongs only on format ${EVM_ARG_ADDRESS_PINNED}`)
    }
    parts.push(u8(name.length), name, u8(arg.format))
    if (arg.format === EVM_ARG_ADDRESS_PINNED) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(arg.pinned!)) throw new Error(`argument ${arg.name}: pinned address must be 20 bytes of 0x hex`)
      parts.push(hexBytes(arg.pinned!, 20, 'pinned address'))
    }
    if (arg.format === EVM_ARG_TOKEN_AMOUNT) {
      const symbol = ascii(arg.symbol || '', 10, 'token symbol')
      if (!Number.isInteger(arg.decimals) || arg.decimals! < 0 || arg.decimals! > 36) {
        throw new Error('token decimals must be 0-36')
      }
      parts.push(u8(arg.decimals!), u8(symbol.length), symbol)
    }
    if (intent) parts.push(u8(arg.role ?? 0))
  }
  if (intent) {
    const title = ascii(intent.title, 20, 'intent title')
    const template = ascii(intent.template, 96, 'intent template')
    parts.push(u8(intent.valueRole), u8(title.length), title, u8(template.length), template)
  }
  parts.push(u8(1), be32(0), u8(CERTIFIED_METADATA_KEY_ID))
  return Buffer.concat(parts)
}

const isAmount = (format: number) => format === EVM_ARG_AMOUNT || format === EVM_ARG_TOKEN_AMOUNT

/** Mirrors firmware signed_metadata_intent_valid(): certify only what it accepts. */
export function validateEvmIntent(spec: EvmSchemaSpec, intent: EvmIntent): void {
  if (![0, ROLE_SPEND_MAX, ROLE_SPEND_EXACT].includes(intent.valueRole)) throw new Error('value role must be 0, spend-max or spend-exact')
  spec.args.forEach((arg, i) => {
    const role = arg.role ?? 0
    if (isAmount(arg.format) ? role < ROLE_SPEND_MAX || role > ROLE_ALLOWANCE : role !== 0) {
      throw new Error(`argument ${i} (${arg.name}) has an invalid role ${role}`)
    }
  })
  const used = new Set<number>()
  let value = false
  let width = 0
  const literal = intent.template.replace(/\{(v|\d)\}/g, (_, p) => {
    if (p === 'v') {
      value = true
      width += 90
      return ''
    }
    const i = Number(p)
    const arg = spec.args[i]
    if (!arg || ![EVM_ARG_ADDRESS, EVM_ARG_ADDRESS_PINNED, EVM_ARG_AMOUNT, EVM_ARG_TOKEN_AMOUNT].includes(arg.format)) {
      throw new Error(`template placeholder {${p}} is out of range or not displayable in a sentence`)
    }
    used.add(i)
    width += isAmount(arg.format) ? 90 : 13
    return ''
  })
  if (/[{}]/.test(literal)) throw new Error('template has a stray brace')
  // Firmware refuses digits outside placeholders: numbers come only from signed bytes.
  if (/[0-9]/.test(literal)) throw new Error('template states a number of its own; values must come from placeholders')
  width += literal.length
  if (width > 280) throw new Error(`template can expand to ${width} chars; firmware limit is 280`)
  spec.args.forEach((arg, i) => {
    if (isAmount(arg.format) && !used.has(i)) throw new Error(`template must state amount ${arg.name}`)
  })
  if (value !== (intent.valueRole !== 0)) throw new Error('{v} must appear exactly when the value has a role')
}

/** One device screen as signed_metadata_build_intent_review() emits it. */
export interface ExpectedScreen {
  title: string
  body: string
  /** The same screen when the amount is 2^256-1. */
  unlimited?: string
  /** Set when this text is not pinned exactly by firmware source. */
  approximate?: string
}

export const EXAMPLE_ADDRESS = '0x909ef6b32dfdc12ca86aa710b54c991af3c5f82e'
const EXAMPLE_WHOLE_UNITS = 25n
const ROLE_TEXT: Record<number, string> = {
  [ROLE_SPEND_MAX]: 'You spend at most',
  [ROLE_RECEIVE_MIN]: 'You receive at least',
  [ROLE_SPEND_EXACT]: 'You spend',
  [ROLE_RECEIVE_EXACT]: 'You receive',
  [ROLE_CAP]: 'Each use at most',
  [ROLE_ALLOWANCE]: 'Can spend up to',
}

/**
 * The certified (KeepKey-tier) v0x05 review, screen by screen: summary,
 * Limits, Contract, details, who. Example values: addresses are
 * EXAMPLE_ADDRESS unless pinned, token amounts are 25 whole units, {v} is
 * the firmware doc's 0.007988 ETH. Undefined for schemas without an intent.
 */
export function expectedEvmScreens(spec: EvmSchemaSpec, alias = 'KeepKey Alpha 716'): ExpectedScreen[] | undefined {
  const intent = spec.intent
  if (!intent) return undefined
  const checksum = (a: string) => ethersUtils.getAddress(a)
  const text = (arg: EvmSchemaArg, shorten: boolean, unlimited: boolean): string => {
    if (arg.format === EVM_ARG_ADDRESS || arg.format === EVM_ARG_ADDRESS_PINNED) {
      const full = checksum(arg.pinned ?? EXAMPLE_ADDRESS)
      return shorten ? `${full.slice(0, 6)}...${full.slice(-4)}` : full
    }
    if (arg.format === EVM_ARG_TOKEN_AMOUNT) return unlimited ? `UNLIMITED ${arg.symbol}` : `${EXAMPLE_WHOLE_UNITS} ${arg.symbol}`
    if (arg.format === EVM_ARG_AMOUNT) return unlimited ? 'UNLIMITED' : `${EXAMPLE_WHOLE_UNITS * 10n ** 18n} wei`
    return '<32 bytes as hex, 16 per screen: 1/2, 2/2>'
  }
  const VALUE = '0.007988 ETH'
  const VALUE_NOTE = 'msg.value uses the chain native-amount formatter (ethereumFormatAmount)'
  const fill = (unlimited: boolean) =>
    intent.template.replace(/\{(v|\d)\}/g, (_, p) => (p === 'v' ? VALUE : text(spec.args[Number(p)], true, unlimited)))
  const capped = spec.args.some((arg) => (arg.role === ROLE_CAP || arg.role === ROLE_ALLOWANCE) && arg.format === EVM_ARG_TOKEN_AMOUNT)
  const screens: ExpectedScreen[] = [{
    title: intent.title,
    body: fill(false),
    ...(capped ? { unlimited: fill(true) } : {}),
    ...(intent.template.includes('{v}') ? { approximate: VALUE_NOTE } : {}),
  }]
  if (intent.valueRole) screens.push({ title: 'Limits', body: `${ROLE_TEXT[intent.valueRole]}\n${VALUE}`, approximate: VALUE_NOTE })
  for (const arg of spec.args) {
    if (!arg.role) continue
    screens.push({
      title: 'Limits',
      body: `${ROLE_TEXT[arg.role]}\n${text(arg, false, false)}`,
      ...((arg.role === ROLE_CAP || arg.role === ROLE_ALLOWANCE) && arg.format === EVM_ARG_TOKEN_AMOUNT ? { unlimited: `${ROLE_TEXT[arg.role]}\n${text(arg, false, true)}` } : {}),
    })
  }
  screens.push({ title: 'Contract', body: `${spec.method}\n${checksum(spec.contract)}` })
  spec.args.forEach((arg, i) => {
    if (arg.role) return
    const address = arg.format === EVM_ARG_ADDRESS || arg.format === EVM_ARG_ADDRESS_PINNED
    if (!address && arg.format !== EVM_ARG_BYTES && intent.template.includes(`{${i}}`)) return
    screens.push({
      title: arg.name,
      body: text(arg, false, false),
      ...(arg.format === EVM_ARG_ADDRESS_PINNED
        ? { approximate: 'assumes firmware shows a pinned address like format 1 (full EIP-55); the format-6 renderer is not merged yet' }
        : arg.format === EVM_ARG_BYTES ? { approximate: 'paged hex of the decoded word' } : {}),
    })
  })
  screens.push({
    title: 'KeepKey ClearSign',
    body: `Described by ${alias} ${ALPHA_DELEGATE_FINGERPRINT}\ncertified by KeepKey`,
    approximate: "the alias comes from the chain's certificate; this is the alpha certificate's alias",
  })
  return screens
}

/** Backwards-compatible name retained for existing v2 callers/tests. */
export const buildEvmV2SchemaBody = buildEvmSchemaBody

export function buildCertifiedEvmEnvelope(
  spec: EvmSchemaSpec,
  certificateHex: string,
  delegatePrivateKeyHex: string,
): { signedPayload: string; keyId: number; fingerprint: string; alias: string } {
  const certificate = hexBytes(certificateHex, 139, 'alpha certificate')
  const certificateInfo = inspectAlphaCertificate(certificate.toString('hex'))
  // The device accepts a description only on its certificate's chain.
  if (certificateInfo.chainId !== spec.chainId) {
    throw new Error(`certificate is scoped to ${certificateInfo.chainId}, not chain ${spec.chainId}`)
  }
  const privateKey = hexBytes(delegatePrivateKeyHex, 32, 'delegate private key')
  const signingKey = new ethersUtils.SigningKey(`0x${privateKey.toString('hex')}`)
  const publicKey = ethersUtils.computePublicKey(signingKey.publicKey, true).slice(2).toLowerCase()
  if (publicKey !== ALPHA_DELEGATE_PUBLIC_KEY) {
    throw new Error(`delegate private key does not match reviewed signer ${ALPHA_DELEGATE_FINGERPRINT}`)
  }

  const body = buildEvmSchemaBody(spec)
  return signCertifiedEvmBody(body, certificate, certificateInfo.alias, signingKey)
}

/** A certified name record; the certificate must be scoped to its chain. */
export function buildCertifiedEvmNameEnvelope(
  record: EvmNameRecord,
  certificateHex: string,
  delegatePrivateKeyHex: string,
): { signedPayload: string; keyId: number; fingerprint: string; alias: string } {
  const certificate = hexBytes(certificateHex, 139, 'alpha certificate')
  const certificateInfo = inspectAlphaCertificate(certificate.toString('hex'))
  if (certificateInfo.chainId !== record.chainId) {
    throw new Error(`certificate is scoped to ${certificateInfo.chainId}, not chain ${record.chainId}`)
  }
  const privateKey = hexBytes(delegatePrivateKeyHex, 32, 'delegate private key')
  const signingKey = new ethersUtils.SigningKey(`0x${privateKey.toString('hex')}`)
  const publicKey = ethersUtils.computePublicKey(signingKey.publicKey, true).slice(2).toLowerCase()
  if (publicKey !== ALPHA_DELEGATE_PUBLIC_KEY) {
    throw new Error(`delegate private key does not match reviewed signer ${ALPHA_DELEGATE_FINGERPRINT}`)
  }
  return signCertifiedEvmBody(buildEvmNameBody(record), certificate, certificateInfo.alias, signingKey)
}

// ── v0x07: certified Uniswap Universal Router decoder ────────────────────────

export const EVM_DECODER_VERSION = 0x07
/** Firmware METADATA_DECODER_UNISWAP_UR. */
export const EVM_DECODER_UNISWAP_UR = 1
export const UR_SELECTORS = ['0x3593564c', '0x24856bc3'] as const // execute(bytes,bytes[],uint256), execute(bytes,bytes[])
export const UR_METHOD = 'execute'
export const UR_TITLE = 'Uniswap'
export const UR_MAX_TOKENS = 4

/**
 * Universal Routers whose execute() the device decodes (firmware uniswap_ur.c).
 * Addresses verbatim from Uniswap's deploy-addresses at the pinned commit in
 * UNIVERSAL_ROUTER_PROVENANCE (re-fetched 2026-10-03: unchanged on main).
 * Only the generations the firmware vectors and command layout were checked
 * against: UR 1.2 (V2 support), UR 2.0 and UR 2.1.2. UR 2.1.2 is the router
 * the Uniswap app sends to; its vectors are real Base calls. V4_SWAP (0x10) is
 * decoded only for UR 2.1.2 on Base (UR_V4_ROUTERS: its V4Router layout was
 * checked against the verified source); elsewhere a V4 route is refused.
 */
export const REVIEWED_UNIVERSAL_ROUTERS: EvmNameRecord[] = [
  { chainId: 8453, address: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV1_2_V2Support' },
  { chainId: 8453, address: '0x6ff5693b99212da76ad316178a184ab56d299b43', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV2' },
  { chainId: 8453, address: '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', name: 'Uniswap Universal Router', source: 'base.json UniversalRouterV2_1_2' },
  { chainId: 1, address: '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV1_2_V2Support' },
  { chainId: 1, address: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV2' },
  { chainId: 1, address: '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85', name: 'Uniswap Universal Router', source: 'mainnet.json UniversalRouterV2_1_2' },
  { chainId: 42161, address: '0x5e325eda8064b456f4781070c0738d849c824258', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV1_2_V2Support' },
  { chainId: 42161, address: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV2' },
  { chainId: 42161, address: '0x2d01411773c8c24805306e89a41f7855c3c4fe65', name: 'Uniswap Universal Router', source: 'arbitrum.json UniversalRouterV2_1_2' },
]

/** True when the device decodes V4_SWAP for this router (firmware V4_ROUTERS). */
export function urV4Router(chainId: number | undefined, router: string | undefined): boolean {
  return chainId === 8453 && (UR_V4_ROUTERS as readonly string[]).includes(String(router).toLowerCase())
}

export function findReviewedUniversalRouter(chainId: number | undefined, router: string | undefined): EvmNameRecord | undefined {
  if (!chainId || !router) return undefined
  const a = router.toLowerCase()
  return REVIEWED_UNIVERSAL_ROUTERS.find((r) => r.chainId === chainId && r.address === a)
}

export interface EvmDecoderToken { address: string; symbol: string; decimals: number }

/** Token identities for a swap entry: REVIEWED_EVM_TOKENS by exact chain:address
 * only, never by symbol. Undefined if any is unreviewed, repeated, or the count
 * is outside 1..4. */
export function reviewedSwapTokens(chainId: number, addresses: string[]): EvmDecoderToken[] | undefined {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > UR_MAX_TOKENS) return undefined
  const seen = new Set<string>()
  const out: EvmDecoderToken[] = []
  for (const raw of addresses) {
    const address = String(raw).toLowerCase()
    const token = REVIEWED_EVM_TOKENS[`${chainId}:${address}`]
    if (!token || seen.has(address)) return undefined
    seen.add(address)
    out.push({ address, ...token })
  }
  return out
}

/** Serialize the 0x07 body (trailer up to key_id; the signature is appended). */
export function buildEvmDecoderBody(chainId: number, router: string, selector: string, tokens: EvmDecoderToken[]): Buffer {
  if (!Number.isInteger(chainId) || chainId <= 0 || chainId > 0xffffffff) throw new Error('decoder chainId must be a nonzero uint32')
  if (!findReviewedUniversalRouter(chainId, router)) throw new Error('router is not a reviewed Universal Router on this chain')
  if (!(UR_SELECTORS as readonly string[]).includes(String(selector).toLowerCase())) throw new Error('selector is not a Universal Router execute()')
  if (tokens.length < 1 || tokens.length > UR_MAX_TOKENS) throw new Error(`decoder entry needs 1-${UR_MAX_TOKENS} tokens`)
  const method = ascii(UR_METHOD, 64, 'method')
  const title = ascii(UR_TITLE, 20, 'title')
  const parts: Buffer[] = [
    u8(EVM_DECODER_VERSION),
    be32(chainId),
    hexBytes(router, 20, 'router'),
    hexBytes(selector, 4, 'selector'),
    be16(method.length), method,
    u8(EVM_DECODER_UNISWAP_UR),
    u8(title.length), title,
    u8(tokens.length),
  ]
  for (const token of tokens) {
    if (!/^[A-Za-z0-9]{1,10}$/.test(token.symbol)) throw new Error(`token symbol ${token.symbol} must be 1-10 of [A-Za-z0-9]`)
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) throw new Error('token decimals must be 0-36')
    parts.push(hexBytes(token.address, 20, 'token address'), u8(token.decimals), u8(token.symbol.length), Buffer.from(token.symbol, 'ascii'))
  }
  parts.push(u8(1), be32(0), u8(CERTIFIED_METADATA_KEY_ID))
  return Buffer.concat(parts)
}

/** A certified 0x07 swap entry; the certificate must be scoped to `chainId`. */
export function buildCertifiedEvmDecoderEnvelope(
  chainId: number,
  router: string,
  selector: string,
  tokens: EvmDecoderToken[],
  certificateHex: string,
  delegatePrivateKeyHex: string,
): { signedPayload: string; keyId: number; fingerprint: string; alias: string } {
  const body = buildEvmDecoderBody(chainId, router, selector, tokens)
  const certificate = hexBytes(certificateHex, 139, 'alpha certificate')
  const certificateInfo = inspectAlphaCertificate(certificate.toString('hex'))
  if (certificateInfo.chainId !== chainId) {
    throw new Error(`certificate is scoped to ${certificateInfo.chainId}, not chain ${chainId}`)
  }
  const privateKey = hexBytes(delegatePrivateKeyHex, 32, 'delegate private key')
  const signingKey = new ethersUtils.SigningKey(`0x${privateKey.toString('hex')}`)
  const publicKey = ethersUtils.computePublicKey(signingKey.publicKey, true).slice(2).toLowerCase()
  if (publicKey !== ALPHA_DELEGATE_PUBLIC_KEY) {
    throw new Error(`delegate private key does not match reviewed signer ${ALPHA_DELEGATE_FINGERPRINT}`)
  }
  return signCertifiedEvmBody(body, certificate, certificateInfo.alias, signingKey)
}

/**
 * The device review for a swap entry (signed_metadata_build_ur_review), with
 * placeholders: {in}/{out} are "<amount> <SYM>" ("ETH" when wrapped from
 * msg.value / unwrapped), read by the device from the calldata.
 */
export function expectedUniswapScreens(chainId: number, router: string, alias = 'KeepKey Alpha 716'): Array<ExpectedScreen & { exactOut?: string; numbered?: string; when?: string }> {
  const v4 = urV4Router(chainId, router)
  return [
    { title: UR_TITLE, body: 'Swap {in} for at least {out}', exactOut: 'Swap at most {in} for {out}' },
    { title: 'Limits', body: 'You spend\n{in}', exactOut: 'You spend at most\n{in}' },
    { title: 'Limits', body: 'You receive at least\n{out}', exactOut: 'You receive\n{out}' },
    { title: 'Recipient', body: 'Output goes to\n{recipient, full EIP-55}', when: 'the output goes anywhere but the sender' },
    {
      title: 'Allowance',
      body: 'This router may spend up to {amount} until YYYY-MM-DD UTC',
      unlimited: 'This router may spend up to UNLIMITED {SYM} until YYYY-MM-DD UTC',
      when: 'the call carries a Permit2 permit (spender must be this router)',
    },
    {
      title: 'Fee',
      body: 'x.xx% of the output to\n{fee recipient, full EIP-55}',
      when: v4 ? "the call pays a portion of the output (PAY_PORTION, or a V4 swap's TAKE_PORTION); at most one" : 'the call pays a portion of the output (PAY_PORTION); at most one',
    },
    // V4 pools are decoded only through this router (firmware V4_ROUTERS).
    ...(v4 ? [{
      title: 'Pool hook',
      body: 'The swap runs this hook contract\n{hook, full EIP-55}',
      numbered: 'Pool hook {i}/{n}',
      when: 'the swap runs through a Uniswap v4 pool with a hook contract: one screen per distinct hook, at most 3 (hookData must be empty)',
    }] : []),
    { title: 'Contract', body: `${UR_METHOD}\n${ethersUtils.getAddress(router)}` },
    {
      title: 'KeepKey ClearSign',
      body: `Described by ${alias} ${ALPHA_DELEGATE_FINGERPRINT}\ncertified by KeepKey`,
      approximate: `the alias comes from the chain's certificate (chain ${chainId})`,
    },
  ]
}

function signCertifiedEvmBody(
  body: Buffer,
  certificate: Buffer,
  alias: string,
  signingKey: InstanceType<typeof ethersUtils.SigningKey>,
): { signedPayload: string; keyId: number; fingerprint: string; alias: string } {
  const digest = createHash('sha256').update(body).digest('hex')
  const signature = signingKey.signDigest(`0x${digest}`)
  const compact = Buffer.concat([
    hexBytes(signature.r, 32, 'signature r'),
    hexBytes(signature.s, 32, 'signature s'),
    u8(27 + (signature.recoveryParam ?? 0)),
  ])
  const inner = Buffer.concat([body, compact])
  const envelope = Buffer.concat([u8(CERTIFIED_METADATA_VERSION), certificate, inner])
  return {
    signedPayload: `0x${envelope.toString('hex')}`,
    keyId: CERTIFIED_METADATA_KEY_ID,
    fingerprint: ALPHA_DELEGATE_FINGERPRINT,
    alias,
  }
}

export function isCertifiedEvmMetadata(metadata: unknown): boolean {
  const candidate = metadata as { signedPayload?: unknown; keyId?: unknown } | null
  if (!candidate || candidate.keyId !== CERTIFIED_METADATA_KEY_ID) return false
  const payload = candidate.signedPayload
  if (payload instanceof Uint8Array) return payload.length > 140 && payload[0] === CERTIFIED_METADATA_VERSION
  if (typeof payload !== 'string') return false
  const clean = payload.replace(/^0x/i, '')
  return clean.length > 280 && clean.slice(0, 2).toLowerCase() === '03' && /^[0-9a-fA-F]+$/.test(clean)
}
