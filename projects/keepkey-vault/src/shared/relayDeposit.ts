/**
 * Relay Depository deposits — the transaction an in-app Relay swap or bridge
 * signs. The depository (https://docs.relay.link/references/protocol/contracts/evm-depository)
 * holds the deposit and credits it to `depositor` under the order `id`; the
 * destination chain, recipient and output are terms of Relay's off-chain
 * order and are NOT in the calldata, so nothing here can state them.
 *
 * Recognised ONLY at the depository address on a chain listed below and only
 * as the exact fixed-width ABI encoding (no trailing bytes). Anything else
 * returns null and takes the generic (blind) path.
 */

/** RelayDepository: one CREATE2 address on every chain. */
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'

/**
 * Chains where the depository was checked on chain 2026-10-05 via public RPC:
 * eth_getCode non-empty (8,628 bytes, not a proxy: no EIP-1967 slot) and the
 * bytecode contains the depositNative (0x49290c1c) and depositErc20
 * (0xe8017952) selectors. Real depositErc20 calls from Blockscout on
 * Ethereum, Base and Arbitrum are 132 bytes (selector + 4 words).
 */
export const RELAY_DEPOSITORY_CHAINS: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Smart Chain',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum',
  43114: 'Avalanche',
}

/** depositNative(address depositor, bytes32 id), payable. */
export const RELAY_DEPOSIT_NATIVE = '0x49290c1c'
/** depositErc20(address depositor, address token, uint256 amount, bytes32 id): transferFrom(msg.sender). */
export const RELAY_DEPOSIT_ERC20 = '0xe8017952'

export interface RelayDeposit {
  kind: 'native' | 'erc20'
  chainId: number
  chain: string
  /** Credited with the deposit (Relay docs: address(0) credits msg.sender). */
  depositor: string
  /** Lowercase token address (erc20 only). */
  token?: string
  /** Base units (erc20 only); the native amount is msg.value. */
  amount?: bigint
  /** The Relay order id (bytes32 hex). */
  id: string
}

const ZERO = '0x0000000000000000000000000000000000000000'

export function decodeRelayDeposit(to: string | undefined, data: string | undefined, chainId: number | undefined): RelayDeposit | null {
  if (!chainId || !RELAY_DEPOSITORY_CHAINS[chainId] || String(to || '').toLowerCase() !== RELAY_DEPOSITORY) return null
  const hex = String(data || '').toLowerCase()
  if (!/^0x[0-9a-f]*$/.test(hex)) return null
  const sel = hex.slice(0, 10)
  const words = sel === RELAY_DEPOSIT_NATIVE ? 2 : sel === RELAY_DEPOSIT_ERC20 ? 4 : 0
  if (!words || hex.length !== 10 + 64 * words) return null
  const word = (i: number) => hex.slice(10 + 64 * i, 74 + 64 * i)
  const address = (i: number) => (/^0{24}[0-9a-f]{40}$/.test(word(i)) ? `0x${word(i).slice(24)}` : null)
  const depositor = address(0)
  if (!depositor) return null
  const chain = RELAY_DEPOSITORY_CHAINS[chainId]
  if (words === 2) return { kind: 'native', chainId, chain, depositor, id: `0x${word(1)}` }
  const token = address(1)
  if (!token || token === ZERO) return null
  return { kind: 'erc20', chainId, chain, depositor, token, amount: BigInt(`0x${word(2)}`), id: `0x${word(3)}` }
}

export const isZeroAddress = (a: string) => a.toLowerCase() === ZERO
