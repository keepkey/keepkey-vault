/**
 * Creating a Safe. Everything the deploy commits to (owners, threshold,
 * contracts, the address it lands at) is computed here and checked on chain
 * before and after, because firmware 7.16 cannot show it: the device signs the
 * factory call only under AdvancedMode, as data it cannot read.
 */
import { ethers } from 'ethers'
import { SAFE_CREATE } from '../shared/safe-deployments'
import { vetSafe, SAFE_READS, decodeSafeRead, type SafeReader } from './safe-core'

const iface = new ethers.utils.Interface([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
])
const ZERO = ethers.constants.AddressZero
const SENTINEL = '0x0000000000000000000000000000000000000001'

export interface SafeCreatePlan {
  chainId: number
  owners: string[]
  threshold: number
  saltNonce: string
  factory: string
  singleton: string
  fallbackHandler: string
  /** createProxyWithNonce calldata the KeepKey signs. */
  data: string
  /** Where the Safe will be (CREATE2). */
  predicted: string
}

export function planSafeCreate(chainId: number, owners: string[], threshold: number, saltNonce: string): SafeCreatePlan {
  if (!SAFE_CREATE.chains.includes(chainId)) throw new Error(`Desktop cannot create a Safe on chain ${chainId}`)
  if (owners.length === 0) throw new Error('A Safe needs at least one owner')
  const checked = owners.map(o => {
    if (!ethers.utils.isAddress(o)) throw new Error(`Not an address: ${o}`)
    const a = ethers.utils.getAddress(o)
    if (a === ZERO || a.toLowerCase() === SENTINEL) throw new Error(`${a} cannot be an owner`)
    return a
  })
  if (new Set(checked.map(a => a.toLowerCase())).size !== checked.length) throw new Error('Each owner can be listed only once')
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > checked.length) throw new Error(`Signatures needed must be between 1 and ${checked.length}`)

  const singleton = SAFE_CREATE.singleton.address
  const initializer = iface.encodeFunctionData('setup', [checked, threshold, ZERO, '0x', SAFE_CREATE.fallbackHandler.address, ZERO, 0, ZERO])
  const salt = ethers.utils.solidityKeccak256(['bytes32', 'uint256'], [ethers.utils.keccak256(initializer), saltNonce])
  const initCode = ethers.utils.solidityPack(['bytes', 'uint256'], [SAFE_CREATE.proxyCreationCode, singleton])
  return {
    chainId, owners: checked, threshold, saltNonce,
    factory: SAFE_CREATE.factory.address, singleton, fallbackHandler: SAFE_CREATE.fallbackHandler.address,
    data: iface.encodeFunctionData('createProxyWithNonce', [singleton, initializer, saltNonce]),
    predicted: ethers.utils.getCreate2Address(SAFE_CREATE.factory.address, salt, ethers.utils.keccak256(initCode)),
  }
}

/** Before signing: the factory is Safe's, the Safe is not there yet, and a dry run lands at the predicted address. */
export async function checkBeforeCreate(plan: SafeCreatePlan, read: SafeReader): Promise<void> {
  if (ethers.utils.keccak256(await read.getCode(plan.factory)) !== SAFE_CREATE.factory.codeHash) throw new Error("Safe's factory on this chain does not match Safe's published build")
  if ((await read.getCode(plan.predicted)) !== '0x') throw new Error(`A contract already exists at ${plan.predicted}`)
  const [landed] = iface.decodeFunctionResult('createProxyWithNonce', await read.call(plan.factory, plan.data))
  if (ethers.utils.getAddress(landed) !== plan.predicted) throw new Error(`A dry run created ${landed}, not ${plan.predicted}`)
}

/** After the deploy: the Safe at the predicted address runs Safe's code with exactly the planned owners and threshold. */
export async function checkCreatedSafe(plan: SafeCreatePlan, read: SafeReader): Promise<void> {
  const vetting = await vetSafe(plan.chainId, plan.predicted, read)
  if (vetting.codeProblem) throw new Error(vetting.codeProblem)
  if (vetting.extensions.length) throw new Error(`The new Safe has extensions it should not: ${vetting.extensions.join(' ')}`)
  const owners = (decodeSafeRead('getOwners', await read.call(plan.predicted, SAFE_READS.getOwners)) as string[]).map(o => o.toLowerCase()).sort()
  const threshold = Number(decodeSafeRead('getThreshold', await read.call(plan.predicted, SAFE_READS.getThreshold)))
  if (owners.join() !== plan.owners.map(o => o.toLowerCase()).sort().join() || threshold !== plan.threshold) {
    throw new Error(`The new Safe's owners or threshold differ from the plan (${threshold} of ${owners.join(', ')})`)
  }
}
