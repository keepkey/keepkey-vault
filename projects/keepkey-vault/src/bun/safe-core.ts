/**
 * Safe multisig primitives, computed locally so nothing a remote service says
 * about a transaction is trusted: the SafeTx EIP-712 document and its hash,
 * and which owners' signatures actually recover over that hash.
 */
import { ethers } from 'ethers'
import { SAFE_PROXY_CODE_HASHES, SAFE_SINGLETONS, SAFE_FALLBACK_HANDLERS } from '../shared/safe-deployments'

export interface SafeTxFields {
  to: string
  value: string
  data: string | null
  operation: number
  safeTxGas: string
  baseGas: string
  gasPrice: string
  gasToken: string
  refundReceiver: string
  nonce: string
}

export const SAFE_TX_TYPE = [
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' },
  { name: 'safeTxGas', type: 'uint256' },
  { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' },
  { name: 'gasToken', type: 'address' },
  { name: 'refundReceiver', type: 'address' },
  { name: 'nonce', type: 'uint256' },
]

/** Safe 1.3.0 added chainId to the domain; 1.1.1 and older sign without it. */
export function safeTxDomain(chainId: number, safe: string, version: string): ethers.TypedDataDomain {
  const [major, minor] = version.split('.').map(Number)
  const withChainId = major > 1 || (major === 1 && minor >= 3)
  return withChainId ? { chainId, verifyingContract: safe } : { verifyingContract: safe }
}

function message(tx: SafeTxFields) {
  return { ...tx, data: tx.data || '0x' }
}

/** The safeTxHash an owner signs, from the transaction's own fields. */
export function safeTxHash(chainId: number, safe: string, version: string, tx: SafeTxFields): string {
  return ethers.utils._TypedDataEncoder.hash(safeTxDomain(chainId, safe, version), { SafeTx: SAFE_TX_TYPE }, message(tx))
}

/**
 * Owners whose signature in Safe's packed format recovers over safeTxHash.
 * ECDSA (v 27/28) and eth_sign (v 31/32) are checked; contract signatures
 * (v 0) and approved hashes (v 1) cannot be checked offline and are returned
 * separately, never counted as verified.
 */
export function verifiedSigners(hash: string, signatures: string, owners: string[]): { verified: string[]; unverifiable: string[] } {
  const ownerSet = new Map(owners.map(o => [o.toLowerCase(), ethers.utils.getAddress(o)]))
  const bytes = ethers.utils.arrayify(signatures || '0x')
  const verified: string[] = []
  const unverifiable: string[] = []
  for (let i = 0; i + 65 <= bytes.length; i += 65) {
    const r = ethers.utils.hexlify(bytes.slice(i, i + 32)), s = ethers.utils.hexlify(bytes.slice(i + 32, i + 64)), v = bytes[i + 64]
    let signer: string | undefined
    if (v === 27 || v === 28) {
      signer = ethers.utils.recoverAddress(hash, { r, s, v })
    } else if (v === 31 || v === 32) {
      signer = ethers.utils.recoverAddress(ethers.utils.hashMessage(ethers.utils.arrayify(hash)), { r, s, v: v - 4 })
    } else if (v === 0 || v === 1) {
      // r holds the signer address, left-padded.
      unverifiable.push(ethers.utils.getAddress(ethers.utils.hexDataSlice(r, 12)))
      continue
    }
    const owner = signer && ownerSet.get(signer.toLowerCase())
    if (owner && !verified.includes(owner)) verified.push(owner)
  }
  return { verified, unverifiable }
}

/**
 * One confirmation from the service, checked on its own: its signature must
 * recover to the owner the service says signed. An approved hash (v 1) only
 * names the owner; the caller checks approvedHashes on chain before counting it.
 * Contract signatures (v 0) are never counted.
 */
export function checkConfirmation(hash: string, owners: string[], c: { owner: string; signature?: string | null }): 'verified' | 'approved-hash' | 'unverified' {
  const sig = ethers.utils.arrayify(c.signature || '0x')
  const claimed = c.owner.toLowerCase()
  if (sig.length < 65 || !owners.some(o => o.toLowerCase() === claimed)) return 'unverified'
  if (sig[64] === 1) return ethers.utils.hexDataSlice(sig, 12, 32).toLowerCase() === claimed ? 'approved-hash' : 'unverified'
  const { verified } = verifiedSigners(hash, ethers.utils.hexlify(sig.slice(0, 65)), owners)
  return verified.length === 1 && verified[0].toLowerCase() === claimed ? 'verified' : 'unverified'
}

const iface = new ethers.utils.Interface([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function approvedHashes(address, bytes32) view returns (uint256)',
  'function masterCopy() view returns (address)',
  'function getStorageAt(uint256 offset, uint256 length) view returns (bytes)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
])

export const SAFE_READS = {
  getOwners: iface.encodeFunctionData('getOwners'),
  getThreshold: iface.encodeFunctionData('getThreshold'),
  nonce: iface.encodeFunctionData('nonce'),
  VERSION: iface.encodeFunctionData('VERSION'),
} as const

export const approvedHashCall = (owner: string, hash: string) => iface.encodeFunctionData('approvedHashes', [owner, hash])

export function decodeSafeRead(fn: keyof typeof SAFE_READS | 'approvedHashes', result: string): any {
  return iface.decodeFunctionResult(fn, result)[0]
}

// keccak256("fallback_manager.handler.address") and keccak256("guard_manager.guard.address")
const FALLBACK_HANDLER_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
const SENTINEL = '0x0000000000000000000000000000000000000001'

export interface SafeReader {
  getCode(address: string): Promise<string>
  call(to: string, data: string): Promise<string>
}

/**
 * Whether this address runs standard Safe code: a known proxy pointing at a
 * pinned singleton whose code matches, no guard, no modules, and a standard
 * fallback handler (or none). Storage is read only after the singleton's code
 * is verified, because it is the singleton's getStorageAt that answers.
 * An empty list means standard; each entry says what is not.
 */
export async function vetSafe(chainId: number, safe: string, read: SafeReader): Promise<string[]> {
  const proxyVersion = SAFE_PROXY_CODE_HASHES[ethers.utils.keccak256(await read.getCode(safe))]
  if (!proxyVersion) return ['Its contract is not a standard Safe proxy']
  const singleton = ethers.utils.getAddress(iface.decodeFunctionResult('masterCopy', await read.call(safe, iface.encodeFunctionData('masterCopy')))[0])
  const pinned = SAFE_SINGLETONS.find(c => same(c.address, singleton) && c.chains.includes(chainId))
  if (!pinned) return [`It runs Safe code Desktop does not recognize (${singleton})`]
  if (ethers.utils.keccak256(await read.getCode(singleton)) !== pinned.codeHash) return [`The Safe code at ${singleton} does not match Safe's published build`]

  const slot = async (s: string) => {
    const [word] = iface.decodeFunctionResult('getStorageAt', await read.call(safe, iface.encodeFunctionData('getStorageAt', [s, 1])))
    return ethers.utils.getAddress(ethers.utils.hexDataSlice(word, 12, 32))
  }
  const [handler, guard, modules] = await Promise.all([
    slot(FALLBACK_HANDLER_SLOT),
    slot(GUARD_SLOT),
    read.call(safe, iface.encodeFunctionData('getModulesPaginated', [SENTINEL, 10])).then(r => iface.decodeFunctionResult('getModulesPaginated', r).array as string[]),
  ])
  const issues: string[] = []
  // ponytail: handler checked by address only; Safe's deterministic deployments make the address imply the code.
  if (handler !== ethers.constants.AddressZero && !SAFE_FALLBACK_HANDLERS.some(c => same(c.address, handler) && c.chains.includes(chainId))) {
    issues.push(`It has a non-standard fallback handler (${handler})`)
  }
  if (guard !== ethers.constants.AddressZero) issues.push(`It has a transaction guard (${guard})`)
  for (const m of modules) issues.push(`It has a module that can move funds without the owners (${ethers.utils.getAddress(m)})`)
  return issues
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
