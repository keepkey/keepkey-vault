/**
 * Standard Safe contracts, pinned from safe-global/safe-deployments
 * 685f22be940739259cfc4148db3df7048f39a4e8 for the EVM chains Desktop supports.
 * A Safe whose code does not match these is not treated as a standard Safe.
 */

/** keccak256 of the proxy's runtime code, measured by deploying each factory's
 * proxyCreationCode in an eth_call (171 bytes; no addresses are embedded). */
export const SAFE_PROXY_CODE_HASHES: Record<string, string> = {
  '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000': '1.3.0',
  '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c': '1.4.1',
}

export interface SafeContract { address: string; codeHash: string; chains: number[]; version?: string }

/** Safe and SafeL2 singletons (the code every proxy runs). */
export const SAFE_SINGLETONS: SafeContract[] = [
  { address: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552', codeHash: '0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e', version: '1.3.0', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
  { address: '0x69f4D1788e39c87893C980c06EdF4b7f686e2938', codeHash: '0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e', version: '1.3.0', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
  { address: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E', codeHash: '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f', version: '1.3.0', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
  { address: '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA', codeHash: '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f', version: '1.3.0', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
  { address: '0x41675C099F32341bf84BFc5382aF534df5C7461a', codeHash: '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4', version: '1.4.1', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
  { address: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762', codeHash: '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff', version: '1.4.1', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
]

export const SAFE_FALLBACK_HANDLERS: SafeContract[] = [
  { address: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4', codeHash: '0x03e69f7ce809e81687c69b19a7d7cca45b6d551ffdec73d9bb87178476de1abf', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
  { address: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804', codeHash: '0x03e69f7ce809e81687c69b19a7d7cca45b6d551ffdec73d9bb87178476de1abf', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
  { address: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99', codeHash: '0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9', chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114] },
]

/**
 * What Desktop deploys when it creates a Safe: SafeL2 1.4.1, canonical on every
 * chain above. SafeL2 emits the events Safe's indexer reads, and Safe{Wallet}
 * deploys it on Ethereum too.
 */
export const SAFE_CREATE = {
  version: '1.4.1',
  chains: [1, 10, 56, 100, 137, 143, 4663, 8453, 42161, 43114],
  factory: { address: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', codeHash: '0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317' },
  singleton: { address: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762', codeHash: '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff' },
  fallbackHandler: { address: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99', codeHash: '0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9' },
  /** SafeProxyFactory 1.4.1 proxyCreationCode() (486 bytes), keccak 0x1856e0ee…af5f. */
  proxyCreationCode: '0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564',
}
