/**
 * 2026 ClearSign expansion researched from primary protocol sources.
 *
 * These fixtures deliberately live beside, rather than inside,
 * clearsign-golden.json. The golden file is a frozen 51-flow Python parity
 * artifact; changing it would make the existing "51/51 matches Python" claim
 * false. `_clearsign.js` layers these fixtures onto that corpus and binds each
 * one to the deterministic test transaction's real sighash.
 *
 * Calldata is ABI-encoded by ethers from the cited canonical function
 * signature. Nothing below is hand-written selector/calldata hex.
 */
const ethersPackage = require('ethers')
const Interface = ethersPackage.Interface || ethersPackage.utils.Interface

const ADDRESS = 1
const STRING = 4
const TOKEN_AMOUNT = 5

const RECIPIENT = '0x742d35cc6634c0532950a20547b231011e30c8e7'
const SPENDER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'

function utf8Hex(value) {
  return Buffer.from(value, 'utf8').toString('hex')
}

function addressArg(name, value) {
  return { name, format: ADDRESS, value: value.toLowerCase().replace(/^0x/, '') }
}

function stringArg(name, value) {
  return { name, format: STRING, value: utf8Hex(value) }
}

function tokenAmountArg(name, amount, decimals, symbol) {
  let amountHex = BigInt(amount).toString(16)
  if (amountHex.length % 2) amountHex = `0${amountHex}`
  const symbolBytes = Buffer.from(symbol, 'ascii')
  const value = Buffer.concat([
    Buffer.from([decimals, symbolBytes.length]),
    symbolBytes,
    Buffer.from(amountHex, 'hex'),
  ])
  return { name, format: TOKEN_AMOUNT, value: value.toString('hex') }
}

function normalizeAbiValue(value) {
  if (typeof value === 'bigint') return value.toString(10)
  if (Array.isArray(value)) return value.map(normalizeAbiValue)
  return value
}

function encodeFunction(signature, method, args) {
  const iface = new Interface([`function ${signature}`])
  const normalized = args.map(normalizeAbiValue)
  // ethers v6 (the declared dev dependency) and the legacy v4 hoisted in the
  // monorepo expose the same ABI coder through different method names.
  if (typeof iface.encodeFunctionData === 'function') return iface.encodeFunctionData(method, normalized)
  return iface.functions[method].encode(normalized)
}

function uint256Word(value) {
  return Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex')
}

function makeFlow({ key, protocol, category, method, signature, to, abiArgs, displayArgs,
  value = '0', chainId = 1, why, sources }) {
  const calldata = encodeFunction(signature, method, abiArgs).slice(2)
  return {
    key,
    protocol,
    category,
    chainId,
    to: to.toLowerCase().replace(/^0x/, ''),
    value,
    selector: calldata.slice(0, 8),
    calldata,
    method,
    signature,
    args: displayArgs,
    why,
    sources,
  }
}

// Morpho Blue wstETH/WETH market 0xc54d…ec41, fetched from the official
// Morpho API. Keeping the full tuple makes this a real, existing market shape.
const MORPHO_MARKET = [
  WETH,
  WSTETH,
  '0x2a01EB9496094dA03c4E364Def50f5aD1280AD72',
  '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
  945000000000000000n,
]

const usdcTransfer = encodeFunction('transfer(address,uint256)', 'transfer', [RECIPIENT, 1000000n])
const usdcTransferBytes = Buffer.from(usdcTransfer.slice(2), 'hex')
const packedSafeCall = `0x${Buffer.concat([
  Buffer.from([0]), // CALL, not DELEGATECALL
  Buffer.from(USDC.slice(2), 'hex'),
  uint256Word(0),
  uint256Word(usdcTransferBytes.length),
  usdcTransferBytes,
]).toString('hex')}`

const flows = [
  makeFlow({
    key: 'base-optimism-portal-deposit-eth',
    protocol: 'Base Bridge',
    category: 'bridges',
    method: 'depositTransaction',
    signature: 'depositTransaction(address,uint256,uint64,bool,bytes)',
    to: '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e',
    abiArgs: [RECIPIENT, 100000000000000000n, 100000n, false, '0x'],
    value: '100000000000000000',
    displayArgs: [
      stringArg('route', 'Ethereum to Base'),
      addressArg('recipient', RECIPIENT),
      tokenAmountArg('amount', 100000000000000000n, 18, 'ETH'),
      stringArg('L2 gas limit', '100000'),
    ],
    why: 'Deposits payable ETH through the official Base OptimismPortal and mints it to the recipient on Base.',
    sources: [
      'https://docs.base.org/base-chain/specs/protocol/bridging/deposits',
      'https://docs.base.org/base-chain/network-information/base-contracts',
      'https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/src/L1/OptimismPortal2.sol',
    ],
  }),
  makeFlow({
    key: 'lido-withdrawal-queue-request',
    protocol: 'Lido',
    category: 'staking-withdrawals',
    method: 'requestWithdrawals',
    signature: 'requestWithdrawals(uint256[],address)',
    to: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1',
    abiArgs: [[1000000000000000000n, 2000000000000000000n], RECIPIENT],
    displayArgs: [
      tokenAmountArg('total', 3000000000000000000n, 18, 'stETH'),
      stringArg('requests', '2 withdrawals: 1 + 2 stETH'),
      addressArg('owner', RECIPIENT),
    ],
    why: 'Locks stETH in Lido withdrawal requests and mints transferable unstETH claim NFTs to the owner.',
    sources: [
      'https://docs.lido.fi/contracts/withdrawal-queue-erc721',
      'https://github.com/lidofinance/lido-dao/blob/master/contracts/0.8.9/WithdrawalQueue.sol',
    ],
  }),
  makeFlow({
    key: 'lido-withdrawal-queue-claim-batch',
    protocol: 'Lido',
    category: 'staking-withdrawals',
    method: 'claimWithdrawals',
    signature: 'claimWithdrawals(uint256[],uint256[])',
    to: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1',
    abiArgs: [[12345n, 12346n], [100n, 100n]],
    displayArgs: [
      stringArg('requests', 'unstETH #12345, #12346'),
      stringArg('count', 'claim 2 finalized requests'),
      stringArg('recipient', 'signing wallet'),
    ],
    why: 'Burns two finalized unstETH claim NFTs and returns their reserved ETH to the signing wallet.',
    sources: ['https://docs.lido.fi/contracts/withdrawal-queue-erc721'],
  }),
  makeFlow({
    key: 'morpho-blue-borrow-weth',
    protocol: 'Morpho Blue',
    category: 'lending',
    method: 'borrow',
    signature: 'borrow(tuple(address,address,address,address,uint256),uint256,uint256,address,address)',
    to: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    abiArgs: [MORPHO_MARKET, 100000000000000000n, 0n, RECIPIENT, RECIPIENT],
    displayArgs: [
      stringArg('market', 'Morpho wstETH / WETH 94.5%'),
      tokenAmountArg('borrow', 100000000000000000n, 18, 'WETH'),
      addressArg('debt owner', RECIPIENT),
      addressArg('receiver', RECIPIENT),
    ],
    why: 'Creates WETH debt against the specified Morpho market and sends borrowed funds to the receiver.',
    sources: [
      'https://docs.morpho.org/developers/contracts/morpho/',
      'https://docs.morpho.org/developers/contracts/addresses/',
      'https://api.morpho.org/v0/blue/markets/1:0xc54d7acf14de29e0e5527cabd7a576506870346a78a11a6762e2cca66322ec41',
      'https://github.com/morpho-org/morpho-blue/blob/main/src/interfaces/IMorpho.sol',
    ],
  }),
  makeFlow({
    key: 'morpho-blue-repay-weth',
    protocol: 'Morpho Blue',
    category: 'lending',
    method: 'repay',
    signature: 'repay(tuple(address,address,address,address,uint256),uint256,uint256,address,bytes)',
    to: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    abiArgs: [MORPHO_MARKET, 100000000000000000n, 0n, RECIPIENT, '0x'],
    displayArgs: [
      stringArg('market', 'Morpho wstETH / WETH 94.5%'),
      tokenAmountArg('repay', 100000000000000000n, 18, 'WETH'),
      addressArg('debt owner', RECIPIENT),
      stringArg('callback', 'none'),
    ],
    why: 'Transfers WETH into Morpho to reduce the named account debt; empty callback data prevents an external hook.',
    sources: [
      'https://docs.morpho.org/developers/borrow/concepts/market-mechanics/',
      'https://github.com/morpho-org/morpho-blue/blob/main/src/interfaces/IMorpho.sol',
    ],
  }),
  makeFlow({
    key: 'eigenlayer-delegation-manager-delegate',
    protocol: 'EigenLayer',
    category: 'restaking',
    method: 'delegateTo',
    signature: 'delegateTo(address,tuple(bytes,uint256),bytes32)',
    to: '0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A',
    abiArgs: [SPENDER, ['0x', 1830000000n], `0x${'ab'.repeat(32)}`],
    displayArgs: [
      addressArg('operator', SPENDER),
      stringArg('approval', 'no approver signature'),
      stringArg('expiry', '2027-12-28 13:20 UTC'),
      stringArg('effect', 'delegate all EigenLayer stake'),
    ],
    why: 'Delegates the signing wallet restaked assets to one EigenLayer operator, changing who can operate that stake.',
    sources: [
      'https://github.com/Layr-Labs/eigenlayer-contracts/blob/main/src/contracts/core/DelegationManager.sol',
      'https://github.com/Layr-Labs/eigenlayer-contracts/blob/main/src/contracts/interfaces/IDelegationManager.sol',
    ],
  }),
  makeFlow({
    key: 'safe-multisend-usdc-transfer',
    protocol: 'Safe',
    category: 'account-abstraction',
    method: 'multiSend',
    signature: 'multiSend(bytes)',
    to: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
    abiArgs: [packedSafeCall],
    displayArgs: [
      stringArg('batch', '1 CALL (no delegatecall)'),
      addressArg('target', USDC),
      tokenAmountArg('transfer', 1000000n, 6, 'USDC'),
      addressArg('recipient', RECIPIENT),
    ],
    why: 'Executes a packed Safe batch containing one USDC transfer; the operation byte is CALL, not DELEGATECALL.',
    sources: [
      'https://github.com/safe-fndn/safe-smart-account/blob/main/contracts/libraries/MultiSend.sol',
      'https://raw.githubusercontent.com/safe-global/safe-deployments/main/src/assets/v1.4.1/multi_send.json',
    ],
  }),
  makeFlow({
    key: 'permit2-lockdown-usdc-dai',
    protocol: 'Uniswap Permit2',
    category: 'approvals',
    method: 'lockdown',
    signature: 'lockdown(tuple(address,address)[])',
    to: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    abiArgs: [[[USDC, SPENDER], [DAI, SPENDER]]],
    displayArgs: [
      stringArg('action', 'revoke 2 Permit2 allowances'),
      stringArg('tokens', 'USDC and DAI'),
      addressArg('spender', SPENDER),
    ],
    why: 'Batch-revokes the named spender Permit2 allowances for USDC and DAI.',
    sources: [
      'https://github.com/Uniswap/permit2/blob/main/src/interfaces/IAllowanceTransfer.sol',
      'https://github.com/Uniswap/permit2-sdk/blob/main/abis/Permit2.json',
    ],
  }),
]

module.exports = Object.fromEntries(flows.map((flow) => [flow.key, flow]))
